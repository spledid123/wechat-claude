/**
 * Bridge orchestrates the full WeChat -> Claude -> WeChat pipeline.
 */

import type { ClaudeManager } from "../01-claude-dialogue/claude/manager.js";
import type { SessionManager } from "../01-claude-dialogue/session/manager.js";
import type { ConversationManager } from "../01-claude-dialogue/conversation/manager.js";
import type { PromptContext, SessionSpec } from "../01-claude-dialogue/claude/types.js";
import { FilePreprocessor } from "../03-file-preprocessing/preprocessor.js";
import type {
  PreprocessResult,
  RenderPdfPagesResult,
} from "../03-file-preprocessing/preprocessor.js";
import {
  prepareImagePayload,
  extractImageFileWithVision,
  extractImageWithVision,
  type ImagePayload,
} from "../03-file-preprocessing/vision.js";
import { DEFAULT_CONFIG, type RuntimeConfig } from "../../runtime/config.js";
import { getRootLogger } from "../../runtime/logger.js";
import { downloadFromCdn } from "../02-wechat-connectivity/wechat/media.js";
import type { ParsedMessage } from "../02-wechat-connectivity/wechat/poller.js";
import { extractMessageItemText } from "../02-wechat-connectivity/wechat/poller.js";
import { collectPendingWechatFiles, markWechatFilesSent } from "./output-weixin.js";
import type { SchedulerEngine } from "../06-scheduler/scheduler.js";
import path from "node:path";

/** DeepSeek accepts many more; this keeps single requests lean. */
const MAX_IMAGES_PER_REQUEST = 10;

/** Scanned-PDF vision fallback: never transcribe more than this many pages. */
const SCANNED_PDF_PAGE_CAP = 20;

/** Below this many extracted characters per page, a PDF counts as scanned. */
const SCANNED_PDF_MIN_CHARS_PER_PAGE = 100;

/** Indexed/stored placeholders that carry no real content — treat as unresolved. */
const PLACEHOLDER_TEXTS = new Set(["[图片]", "[语音]", "[视频]", "[文件]", "[混合消息]"]);

interface PendingImageExtraction {
  payload: ImagePayload;
  msgId?: string;
  aesKey: string;
  convRowId: number;
}

export type SendFunc = (params: {
  toUserId: string;
  contextToken: string;
  text: string;
}) => Promise<void>;

export type SendAttachmentFunc = (params: {
  toUserId: string;
  contextToken: string;
  filePath: string;
  kind: "image" | "file";
}) => Promise<{ msgId?: string } | void>;

export interface BridgeMessageInput {
  msg: ParsedMessage;
  fromUserId: string;
  contextToken: string;
}

export interface HandleMessagesOptions {
  deliverReply?: boolean;
}

export type CreateMcpServersFunc = (params: {
  fromUserId: string;
  contextToken: string;
  session: SessionSpec;
}) => Record<string, unknown> | undefined;

export class Bridge {
  private botToken: string;

  constructor(
    private claude: ClaudeManager,
    private sm: SessionManager,
    private cm: ConversationManager,
    private pp: FilePreprocessor,
    private sendText: SendFunc,
    private sendAttachment?: SendAttachmentFunc,
    botToken = "",
    private createMcpServers?: CreateMcpServersFunc,
    private scheduler?: SchedulerEngine,
    private getConfig?: () => RuntimeConfig,
  ) {
    this.botToken = botToken;
  }

  setBotToken(token: string) {
    this.botToken = token;
  }

  async handleMessage(
    msg: ParsedMessage,
    fromUserId: string,
    contextToken: string,
  ): Promise<string> {
    return this.handleMessages([{ msg, fromUserId, contextToken }], { deliverReply: true });
  }

  async handleMessages(
    inputs: BridgeMessageInput[],
    options: HandleMessagesOptions = {},
  ): Promise<string> {
    if (inputs.length === 0) {
      throw new Error("handleMessages requires at least one input");
    }
    const deliverReply = options.deliverReply ?? false;

    const first = inputs[0];
    const cmdResult = await this.handleCommand(first.msg.text, first.fromUserId);
    if (cmdResult !== null) {
      if (deliverReply) {
        await this.sendText({
          toUserId: first.fromUserId,
          contextToken: first.contextToken,
          text: cmdResult,
        });
      }
      return cmdResult;
    }

    const session = this.sm.resolveSession(first.fromUserId);
    const config = this.getRuntimeConfig();
    const spec: SessionSpec = {
      sessionId: session.id,
      cwd: session.cwd,
      model: config.imageMode === "direct" ? config.visionModel : config.conversationModel,
    };
    const fileResults: PromptContext["files"] = [];
    const inlineImages: NonNullable<PromptContext["images"]> = [];
    const pendingExtractions: PendingImageExtraction[] = [];
    const userParts: string[] = [];

    for (const input of inputs) {
      // Quote resolution never blocks the message: an unresolvable quote is
      // downgraded to a hint so the AI can ask the user to re-send the
      // original instead of dropping what the user actually typed.
      const quoted = this.resolveQuotedText(input.msg, session.userId);
      const userText = this.buildUserText(input.msg, quoted.text, quoted.unresolvedLabel);
      userParts.push(userText);

      const convRowId = this.cm.addMessage({
        sessionId: session.id,
        userId: session.userId,
        direction: "inbound",
        messageType: 1,
        textContent: userText,
      });
      this.recordInboundMessageText(input.msg, session.id, session.userId, input.fromUserId);

      for (const ref of this.shouldAttachMedia(input.msg) ? input.msg.mediaRefs : []) {
        const fileName = this.pickFileName(input.msg, ref);
        const dlPath = await downloadFromCdn(
          ref.downloadUrl,
          ref.aesKey,
          path.join(session.cwd, "incoming"),
          fileName,
        );

        if (!dlPath) {
          fileResults.push({
            name: fileName,
            path: "",
            mimeType: "",
            preprocessingError: "CDN download failed",
          });
          continue;
        }

        if (ref.itemType === "image") {
          await this.handleImageRef({
            ref,
            fileName,
            dlPath,
            convRowId,
            session,
            fromUserId: input.fromUserId,
            fileResults,
            inlineImages,
            pendingExtractions,
          });
          continue;
        }

        const result = await this.pp.process(dlPath);

        let extractedText: string | undefined;
        let preprocessingError: string | undefined = result.error ?? undefined;
        let truncated = result.truncated;
        let scannedNotice: string | undefined;

        if (this.looksScannedPdf(fileName, result)) {
          const fallback = await this.runScannedPdfExtraction(dlPath, session.cwd);
          if (fallback.text) {
            extractedText = fallback.text;
            truncated = fallback.truncated;
            scannedNotice = fallback.notice;
            preprocessingError = undefined;
          } else {
            scannedNotice = fallback.notice;
            preprocessingError = `扫描版 PDF 视觉识别失败: ${fallback.error ?? "未知错误"}`;
          }
        } else {
          extractedText = ref.itemType === "voice" && input.msg.voiceText
            ? undefined
            : result.extractedText ?? undefined;
        }
        const transcribedText = ref.itemType === "voice"
          ? input.msg.voiceText
          : undefined;

        fileResults.push({
          name: fileName,
          path: dlPath,
          extractedText,
          transcribedText,
          mimeType: result.mimeType,
          preprocessingError,
          truncated,
          scannedNotice,
        });

        const indexedText = transcribedText ?? extractedText;
        if (ref.msgId && indexedText?.trim()) {
          this.cm.saveMessageText({
            msgId: ref.msgId,
            userId: session.userId,
            sessionId: session.id,
            fromUserId: input.fromUserId,
            itemType: ref.itemType,
            fileName: ref.itemType === "file" ? fileName : undefined,
            mediaKey: ref.aesKey || undefined,
            textContent: indexedText,
          });
        }
      }
    }

    // Aggregate budget across all files in this batch: later files lose their
    // inline text first (the model can still Read them from disk by path).
    this.applyBatchCharBudget(fileResults, this.getRuntimeConfig().preprocessBatchMaxChars);

    const historyText = this.cm.getContextMessages(session.id, 6);
    const summary = this.sm.getLastClosedSessionSummary();
    const ctx: PromptContext = {
      userText: userParts.join("\n<<<MSG>>>\n"),
      historyText: historyText || undefined,
      sessionSummary: summary,
      files: fileResults.length > 0 ? fileResults : undefined,
      images: inlineImages.length > 0 ? inlineImages : undefined,
    };

    if (process.env.BRIDGE_DEBUG) {
      const { buildSystemPromptAppend, buildUserMessage } = await import(
        "../01-claude-dialogue/prompt-builder.js"
      );
      getRootLogger().debug(`SYSTEM:\n${buildSystemPromptAppend(ctx).slice(0, 2000)}`);
      getRootLogger().debug(`USER:\n${buildUserMessage(ctx).slice(0, 2000)}`);
    }

    const mcpServers = this.createMcpServers?.({
      fromUserId: first.fromUserId,
      contextToken: first.contextToken,
      session: spec,
    });
    const result = await this.claude.processMessage(spec, ctx, mcpServers);
    let reply = result.text.trim() || "(empty response)";
    if (this.scheduler) {
      const scheduledDraft = this.scheduler.createDraftFromAiJson(
        reply,
        first.fromUserId,
        first.contextToken,
      );
      if (scheduledDraft) {
        reply = scheduledDraft.confirmationText;
      }
    }

    this.cm.addMessage({
      sessionId: session.id,
      userId: session.userId,
      direction: "outbound",
      messageType: 1,
      textContent: reply,
    });
    this.sm.incrementMessageCount(session.id);

    if (deliverReply) {
      await this.sendText({
        toUserId: first.fromUserId,
        contextToken: first.contextToken,
        text: reply,
      });
    }

    await this.deliverOutputFiles(session, first.fromUserId, first.contextToken);

    // Fire-and-forget: in direct mode the inline image lives only in this
    // API call. Extract its content afterwards so the quote index and the
    // injected conversation history keep it for later turns.
    this.runImageMemoryWriteBack(pendingExtractions, session, first.fromUserId);

    return reply;
  }

  private async handleCommand(text: string, fromUserId: string): Promise<string | null> {
    const t = text.trim();

    if (t === "/new" || t === "新对话" || t === "开始新对话") {
      const active = this.sm.getActiveSession();
      if (active) this.sm.closeSession(active.id, "user_command");
      this.sm.createSession(fromUserId);
      return "已新建会话。";
    }

    if (t === "/help" || t === "帮助" || t === "help") {
      return [
        "可用命令：",
        "/new - 新建会话",
        "/list - 显示对话存档列表",
        "/switch <序号> - 切换到指定对话",
        "/tasks - 显示定时任务列表",
        "/task-del <序号或ID> - 删除定时任务",
        "确认 - 确认最近的定时任务草稿",
        "取消 - 取消最近的定时任务草稿",
        "/help - 显示此帮助",
      ].join("\n");
    }

    if (t === "/list" || t === "对话存档" || t === "存档") {
      const all = this.sm.listAllSessions(5);
      if (all.length === 0) return "暂无对话存档。";

      const lines = ["最近对话（/switch 序号 切换）："];
      const active = this.sm.getActiveSession();
      for (let i = 0; i < all.length; i++) {
        const s = all[i];
        const marker = active && s.id === active.id ? " <- 当前" : "";
        const summary = s.summary ? ` - ${s.summary.slice(0, 30)}` : "";
        const time = (s.lastActiveAt || "").slice(5, 16);
        lines.push(
          `${i + 1}. [${s.status === "active" ? "活跃" : "关闭"}] ${s.messageCount}条 ${time}${summary}${marker}`,
        );
      }
      return lines.join("\n");
    }

    const switchMatch = t.match(/^(\/switch|切换对话)\s+(\d+)$/);
    if (switchMatch) {
      const idx = parseInt(switchMatch[2], 10) - 1;
      const all = this.sm.listAllSessions(20);
      if (idx < 0 || idx >= all.length) {
        return `无效的序号。请先用 /list 查看可用对话（1-${all.length}）。`;
      }

      const target = all[idx];
      const active = this.sm.getActiveSession();
      if (active && active.id === target.id) {
        return "这已经是当前对话了。";
      }

      if (active) this.sm.closeSession(active.id, "user_switched");

      const { getDb } = await import("../01-claude-dialogue/db/connection.js");
      getDb().run(
        "UPDATE sessions SET status = 'active', last_active_at = ? WHERE id = ?",
        [new Date().toISOString(), target.id],
      );

      const summary = target.summary
        ? `\n上一段摘要：${target.summary.slice(0, 200)}`
        : "";
      return `已切换到对话 #${idx + 1}（${target.messageCount}条消息）。${summary}`;
    }

    return null;
  }

  private pickFileName(
    msg: ParsedMessage,
    ref: { aesKey: string; itemType: string; encryptQueryParam?: string; msgId?: string },
  ): string {
    if (msg.fileName) return msg.fileName;

    const ext = ref.itemType === "image"
      ? ".jpg"
      : ref.itemType === "voice"
        ? ".silk"
        : ref.itemType === "video"
          ? ".mp4"
          : ".bin";

    return `${ref.itemType}_${Date.now()}${ext}`;
  }

  private getRuntimeConfig(): RuntimeConfig {
    return this.getConfig?.() ?? DEFAULT_CONFIG;
  }

  /** A PDF whose text layer is empty or near-empty — vision fallback applies. */
  private looksScannedPdf(fileName: string, result: PreprocessResult): boolean {
    if (!fileName.toLowerCase().endsWith(".pdf")) return false;
    const pages = result.pdfPages ?? 0;
    if (pages <= 0) return false;
    if (result.error) return true;
    return (result.charsPerPage ?? Number.POSITIVE_INFINITY) < SCANNED_PDF_MIN_CHARS_PER_PAGE;
  }

  /**
   * Scanned-PDF fallback: render pages to PNG with PyMuPDF, transcribe each
   * through the existing vision pipeline, and stitch the per-page transcripts.
   */
  private async runScannedPdfExtraction(
    pdfPath: string,
    workspaceRoot: string,
  ): Promise<{ text?: string; notice?: string; error?: string; truncated?: boolean }> {
    const outDir = path.join(workspaceRoot, "working", "pdf_pages");
    const render = await this.pp.renderPdfPages(pdfPath, outDir, {
      start: 1,
      maxPages: SCANNED_PDF_PAGE_CAP,
    });
    if (!render.ok) {
      return { error: render.error ?? "PDF 页面渲染失败" };
    }

    const model = this.getRuntimeConfig().visionModel;
    const parts: string[] = [];
    for (let i = 0; i < render.pagePaths.length; i++) {
      const pageNumber = render.start + i;
      const pagePath = render.pagePaths[i];
      const extracted = await extractImageFileWithVision(
        pagePath,
        path.basename(pagePath),
        { model },
      );
      parts.push(`[第${pageNumber}页]\n${extracted.ok ? extracted.text : `(识别失败: ${extracted.error})`}`);
    }

    const text = parts.join("\n\n").trim();
    if (!text) {
      return { error: "所有页面均识别失败" };
    }

    return {
      text,
      truncated: render.rendered < render.total,
      notice: this.buildScannedNotice(pdfPath, workspaceRoot, render),
    };
  }

  /** Tell the model what was recognized and how to read more pages itself. */
  private buildScannedNotice(
    pdfPath: string,
    workspaceRoot: string,
    render: RenderPdfPagesResult,
  ): string {
    const rel = (p: string) => path.relative(workspaceRoot, p).split(path.sep).join("/");
    const lastPage = render.start + render.rendered - 1;
    const lines = [
      `该 PDF 为扫描版（无文本层），已用视觉识别转录第 ${render.start}-${lastPage} 页（共 ${render.total} 页）。`,
    ];

    const nextPage = lastPage + 1;
    if (nextPage <= render.total) {
      const python = this.pp.getPythonPath();
      const command = python
        ? `"${python}" tools/preprocess.py --mode pdf-pages --file ${rel(pdfPath)} `
          + `--start ${nextPage} --max-pages ${render.total - nextPage + 1} --out-dir working/pdf_pages`
        : "（Python 环境未配置，无法续读剩余页面）";
      lines.push(
        `如需其余页面，先运行: ${command}`,
        "渲染出的 PNG 位于 working/pdf_pages/，之后逐页用 Read 工具查看即可（需对话模型具备视觉能力）。",
      );
    } else {
      lines.push("全部页面均已转录；如需重看某页，直接用 Read 打开 working/pdf_pages/ 下对应的 PNG。");
    }
    if (this.getRuntimeConfig().imageMode === "split") {
      lines.push("注意：当前为分离模式，对话模型无视觉能力，Read PNG 无效；如需按页查看请在管理面板切换为直连模式。");
    }
    return lines.join("\n");
  }

  /** Enforce the aggregate character budget across all files in one batch. */
  private applyBatchCharBudget(
    files: NonNullable<PromptContext["files"]>,
    budget: number,
  ): void {
    let used = 0;
    for (const file of files) {
      const len = (file.extractedText?.length ?? 0) + (file.transcribedText?.length ?? 0);
      if (len === 0) continue;

      const remaining = budget - used;
      if (remaining <= 0) {
        file.extractedText = undefined;
        file.truncated = true;
        continue;
      }
      if (len <= remaining) {
        used += len;
        continue;
      }

      // Voice transcripts are kept first; the file text takes what is left.
      const voiceLen = file.transcribedText?.length ?? 0;
      if (voiceLen > remaining) {
        file.transcribedText = file.transcribedText?.slice(0, remaining);
        file.extractedText = undefined;
      } else if (file.extractedText) {
        file.extractedText = file.extractedText.slice(0, Math.max(remaining - voiceLen, 0));
      }
      file.truncated = true;
      used = budget;
    }
  }

  /**
   * Route one downloaded image according to the configured image mode:
   *  split  — vision pre-extraction, text goes into extractedText + index
   *  direct — inline image block for this turn + async memory write-back
   */
  private async handleImageRef(args: {
    ref: { aesKey: string; itemType: string; msgId?: string };
    fileName: string;
    dlPath: string;
    convRowId: number;
    session: { id: string; userId: number };
    fromUserId: string;
    fileResults: NonNullable<PromptContext["files"]>;
    inlineImages: NonNullable<PromptContext["images"]>;
    pendingExtractions: PendingImageExtraction[];
  }): Promise<void> {
    const config = this.getRuntimeConfig();

    if (config.imageMode === "split") {
      const result = await extractImageFileWithVision(args.dlPath, args.fileName, {
        model: config.visionModel,
      });
      if (result.ok) {
        args.fileResults.push({
          name: args.fileName,
          path: args.dlPath,
          extractedText: result.text,
          mimeType: "image/*",
        });
        this.saveImageIndex(args.ref, args.session, args.fromUserId, result.text);
      } else {
        args.fileResults.push({
          name: args.fileName,
          path: args.dlPath,
          mimeType: "image/*",
          preprocessingError: result.error,
        });
      }
      return;
    }

    const prepared = prepareImagePayload(args.dlPath, args.fileName);
    if (!prepared.ok) {
      args.fileResults.push({
        name: args.fileName,
        path: args.dlPath,
        mimeType: "image/*",
        preprocessingError: prepared.error,
      });
      return;
    }
    if (args.inlineImages.length >= MAX_IMAGES_PER_REQUEST) {
      args.fileResults.push({
        name: args.fileName,
        path: args.dlPath,
        mimeType: "image/*",
        preprocessingError: `单次最多 ${MAX_IMAGES_PER_REQUEST} 张图片，此图已忽略`,
      });
      return;
    }

    args.inlineImages.push({
      name: args.fileName,
      base64: prepared.payload.base64,
      mediaType: prepared.payload.mediaType,
    });
    args.pendingExtractions.push({
      payload: prepared.payload,
      msgId: args.ref.msgId,
      aesKey: args.ref.aesKey,
      convRowId: args.convRowId,
    });
  }

  private saveImageIndex(
    ref: { aesKey: string; msgId?: string },
    session: { id: string; userId: number },
    fromUserId: string,
    text: string,
  ): void {
    if (!ref.msgId || !text.trim()) return;
    this.cm.saveMessageText({
      msgId: ref.msgId,
      userId: session.userId,
      sessionId: session.id,
      fromUserId,
      itemType: "image",
      mediaKey: ref.aesKey || undefined,
      textContent: text,
    });
  }

  /**
   * Direct mode keeps an image only inside the API call that carried it.
   * After the reply is sent, extract its content asynchronously and persist
   * it to the quote index and the stored conversation row, so later turns
   * and quoted references still "see" the image.
   */
  private runImageMemoryWriteBack(
    items: PendingImageExtraction[],
    session: { id: string; userId: number },
    fromUserId: string,
  ): void {
    if (items.length === 0) return;
    const model = this.getRuntimeConfig().visionModel;
    for (const item of items) {
      void extractImageWithVision(item.payload, { model })
        .then((result) => {
          if (!result.ok) {
            getRootLogger().warn(`image memory extraction failed: ${result.error}`);
            return;
          }
          this.saveImageIndex(item, session, fromUserId, result.text);
          this.cm.appendTextToRow(item.convRowId, result.text);
        })
        .catch((err) => {
          getRootLogger().warn(`image memory extraction error: ${String(err)}`);
        });
    }
  }

  private resolveQuotedText(
    msg: ParsedMessage,
    userId: number,
  ): { text?: string; unresolvedLabel?: string } {
    const quoted = msg.quotedMessage;
    if (!quoted) return {};

    const indexedText = this.cm.findLatestMessageTextForUser(userId, {
      msgId: quoted.msgId,
      fileName: quoted.fileName ?? quoted.text,
      mediaKey: quoted.mediaKey,
      itemType: quoted.itemType,
    });
    if (indexedText && !PLACEHOLDER_TEXTS.has(indexedText.trim())) {
      return { text: indexedText };
    }

    const strictTypes = new Set(["image", "file", "voice", "video"]);
    if (quoted.itemType && strictTypes.has(quoted.itemType)) {
      const label = quoted.itemType === "image"
        ? "图片"
        : quoted.itemType === "file"
          ? "文件"
          : quoted.itemType === "voice"
            ? "语音"
            : "视频";
      return { unresolvedLabel: label };
    }

    const summary = quoted.text?.trim();
    if (summary && !PLACEHOLDER_TEXTS.has(summary)) {
      return { text: summary };
    }
    // We know WHAT was quoted (we have its id) but cannot recover its
    // content — say so instead of silently dropping the reference.
    if (quoted.msgId) {
      return { unresolvedLabel: "消息" };
    }
    return {};
  }

  private shouldAttachMedia(msg: ParsedMessage): boolean {
    if (msg.itemTypes.length === 1 && msg.itemTypes[0] === "voice") {
      return false;
    }
    return true;
  }

  private buildUserText(
    msg: ParsedMessage,
    quotedText?: string,
    unresolvedLabel?: string,
  ): string {
    let userText = msg.text || `[${msg.itemTypes.join(", ")} message]`;
    if (unresolvedLabel) {
      userText = `[引用的${unresolvedLabel}内容未能解析，你看不到它的内容；请建议用户重新发送原始${unresolvedLabel}] ${userText}`;
    } else if (quotedText) {
      userText = `[引用内容: ${quotedText}] ${userText}`;
    }
    if (msg.voiceText) {
      userText = userText
        ? `[语音转写: ${msg.voiceText}]\n${userText}`
        : `[语音转写: ${msg.voiceText}]`;
    } else if (!msg.text && msg.itemTypes.includes("voice")) {
      userText = "[语音消息]";
    }
    return userText;
  }

  private recordInboundMessageText(
    msg: ParsedMessage,
    sessionId: string,
    userId: number,
    fromUserId: string,
  ): void {
    for (const item of msg.raw.item_list ?? []) {
      // Prefer the server-side message id: it is what a later quote will
      // reference. The v1:-scoped item id never matches a quote.
      const itemId = msg.messageId ?? item.msg_id;
      if (!itemId) continue;
      const textContent = extractMessageItemText(item);
      if (!textContent?.trim()) continue;
      this.cm.saveMessageText({
        msgId: itemId,
        userId,
        sessionId,
        fromUserId,
        itemType: this.itemTypeName(item.type),
        fileName: item.file_item?.file_name,
        mediaKey: this.extractMediaKey(item),
        textContent,
      });
    }
  }

  private extractMediaKey(item: ParsedMessage["raw"]["item_list"][number]): string | undefined {
    if (item.type === 2) {
      return item.image_item?.aeskey ?? item.image_item?.media?.aes_key;
    }
    if (item.type === 3) {
      return item.voice_item?.media?.aes_key;
    }
    if (item.type === 4) {
      return item.file_item?.media?.aes_key;
    }
    if (item.type === 5) {
      return item.video_item?.media?.aes_key;
    }
    return undefined;
  }

  private itemTypeName(type?: number): string {
    switch (type) {
      case 1:
        return "text";
      case 2:
        return "image";
      case 3:
        return "voice";
      case 4:
        return "file";
      case 5:
        return "video";
      default:
        return "unknown";
    }
  }

  private async deliverOutputFiles(
    session: { id: string; userId: number; cwd: string },
    toUserId: string,
    contextToken: string,
  ): Promise<void> {
    if (!this.sendAttachment) {
      return;
    }

    const pendingFiles = collectPendingWechatFiles(session.cwd);
    if (pendingFiles.length === 0) {
      return;
    }

    for (const file of pendingFiles) {
      const sent = await this.sendAttachment({
        toUserId,
        contextToken,
        filePath: file.filePath,
        kind: file.kind,
      });

      // Index outbound images so the user can quote them back later. The
      // file is still on disk in the workspace; extraction is fire-and-forget
      // so it never delays the send loop.
      const msgId = sent?.msgId;
      if (file.kind === "image" && msgId) {
        void extractImageFileWithVision(file.filePath, file.fileName, {
          model: this.getRuntimeConfig().visionModel,
        })
          .then((result) => {
            if (!result.ok) {
              getRootLogger().warn(`outbound image indexing failed: ${result.error}`);
              return;
            }
            this.cm.saveMessageText({
              msgId,
              userId: session.userId,
              sessionId: session.id,
              fromUserId: toUserId,
              itemType: "image",
              fileName: file.fileName,
              textContent: result.text,
            });
          })
          .catch((err) => {
            getRootLogger().warn(`outbound image indexing error: ${String(err)}`);
          });
      }
    }

    markWechatFilesSent(session.cwd, pendingFiles);
  }
}
