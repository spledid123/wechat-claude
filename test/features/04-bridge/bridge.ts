/**
 * Bridge orchestrates the full WeChat -> Claude -> WeChat pipeline.
 */

import type { ClaudeManager } from "../01-claude-dialogue/claude/manager.js";
import type { SessionManager } from "../01-claude-dialogue/session/manager.js";
import type { ConversationManager } from "../01-claude-dialogue/conversation/manager.js";
import type { PromptContext, SessionSpec } from "../01-claude-dialogue/claude/types.js";
import { FilePreprocessor } from "../03-file-preprocessing/preprocessor.js";
import { downloadFromCdn } from "../02-wechat-connectivity/wechat/media.js";
import type { ParsedMessage } from "../02-wechat-connectivity/wechat/poller.js";
import { extractMessageItemText } from "../02-wechat-connectivity/wechat/poller.js";
import { collectPendingWechatFiles, markWechatFilesSent } from "./output-weixin.js";
import type { SchedulerEngine } from "../06-scheduler/scheduler.js";
import path from "node:path";

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
}) => Promise<void>;

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
    const spec: SessionSpec = { sessionId: session.id, cwd: session.cwd };
    const fileResults: PromptContext["files"] = [];
    const userParts: string[] = [];

    for (const input of inputs) {
      const quotedResolution = this.resolveQuotedText(input.msg, session.userId);
      if (quotedResolution.ok === false) {
        await this.sendText({
          toUserId: input.fromUserId,
          contextToken: input.contextToken,
          text: quotedResolution.error,
        });
        return quotedResolution.error;
      }

      const userText = this.buildUserText(input.msg, quotedResolution.text);
      userParts.push(userText);

      this.cm.addMessage({
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

        if (dlPath) {
          const result = await this.pp.process(dlPath);
          const extractedText = ref.itemType === "voice" && input.msg.voiceText
            ? undefined
            : result.extractedText ?? undefined;
          const transcribedText = ref.itemType === "voice"
            ? input.msg.voiceText
            : undefined;

          fileResults.push({
            name: fileName,
            path: dlPath,
            extractedText,
            transcribedText,
            mimeType: result.mimeType,
            preprocessingError: result.error ?? undefined,
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
        } else {
          fileResults.push({
            name: fileName,
            path: "",
            mimeType: "",
            preprocessingError: "CDN download failed",
          });
        }
      }
    }

    const historyText = this.cm.getContextMessages(session.id, 6);
    const summary = this.sm.getLastClosedSessionSummary();
    const ctx: PromptContext = {
      userText: userParts.join("\n<<<MSG>>>\n"),
      historyText: historyText || undefined,
      sessionSummary: summary,
      files: fileResults.length > 0 ? fileResults : undefined,
    };

    if (process.env.BRIDGE_DEBUG) {
      const { buildSystemPromptAppend, buildUserMessage } = await import(
        "../01-claude-dialogue/prompt-builder.js"
      );
      console.log(`SYSTEM:\n${buildSystemPromptAppend(ctx).slice(0, 2000)}`);
      console.log(`USER:\n${buildUserMessage(ctx).slice(0, 2000)}`);
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

    await this.deliverOutputFiles(session.cwd, first.fromUserId, first.contextToken);
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

  private resolveQuotedText(
    msg: ParsedMessage,
    userId: number,
  ): { ok: true; text?: string } | { ok: false; error: string } {
    const quoted = msg.quotedMessage;
    if (!quoted) return { ok: true };

    const indexedText = this.cm.findLatestMessageTextForUser(userId, {
      msgId: quoted.msgId,
      fileName: quoted.fileName ?? quoted.text,
      mediaKey: quoted.mediaKey,
      itemType: quoted.itemType,
    });
    if (indexedText) {
      return { ok: true, text: indexedText };
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
      return {
        ok: false,
        error: `引用的${label}内容未能成功解析，无法提供给 AI。请直接重新发送原始${label}。`,
      };
    }

    return { ok: true, text: quoted.text?.trim() || undefined };
  }

  private shouldAttachMedia(msg: ParsedMessage): boolean {
    if (msg.itemTypes.length === 1 && msg.itemTypes[0] === "voice") {
      return false;
    }
    return true;
  }

  private buildUserText(msg: ParsedMessage, quotedText?: string): string {
    let userText = msg.text || `[${msg.itemTypes.join(", ")} message]`;
    if (quotedText) {
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
      if (!item.msg_id) continue;
      const textContent = extractMessageItemText(item);
      if (!textContent?.trim()) continue;
      this.cm.saveMessageText({
        msgId: item.msg_id,
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
    sessionCwd: string,
    toUserId: string,
    contextToken: string,
  ): Promise<void> {
    if (!this.sendAttachment) {
      return;
    }

    const pendingFiles = collectPendingWechatFiles(sessionCwd);
    if (pendingFiles.length === 0) {
      return;
    }

    for (const file of pendingFiles) {
      await this.sendAttachment({
        toUserId,
        contextToken,
        filePath: file.filePath,
        kind: file.kind,
      });
    }

    markWechatFilesSent(sessionCwd, pendingFiles);
  }
}
