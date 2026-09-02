/**
 * Prompt builder — assembles system prompts and user messages
 * from the PromptContext provided by the bridge.
 */

import type { PromptContext, UserBlocksMessage } from "./claude/types.js";

/** Magic separator for multi-bubble splitting (Feature #8 in the spec). */
export const MULTI_BUBBLE_SEPARATOR = "<<<MSG>>>";

/** Maximum number of bubbles to split into. */
export const MAX_BUBBLES = 4;

/**
 * Build the system prompt append block.
 * This is added to the default claude_code system prompt.
 */
export function buildSystemPromptAppend(ctx: PromptContext): string {
  const blocks: string[] = [];

  // 1. Core relay identity
  blocks.push(
    [
      "You are an AI relay bot connected to WeChat.",
      "Reply in Chinese (Simplified).",
      "Keep replies concise and conversational — WeChat is a chat app.",
      "Use plain text only. No markdown formatting unless absolutely necessary.",
    ].join("\n"),
  );

  // 2. Working directory instructions
  blocks.push(
    [
      "WORKING DIRECTORY:",
      "- Your cwd contains: incoming/ (files from user), working/ (scratch space),",
      "  working/output_weixin/ (files to send back to WeChat), output/ (final outputs).",
    ].join("\n"),
  );

  // 3. Previous session summary (if continuing)
  if (ctx.sessionSummary) {
    blocks.push(
      [
        "Previous session summary:",
        ctx.sessionSummary,
        "You may refer to this context in your response.",
      ].join("\n"),
    );
  }

  // 4. User's custom system prompt
  if (ctx.userPrompt) {
    blocks.push(
      ["User's custom instructions:", ctx.userPrompt].join("\n"),
    );
  }

  // 5. Files attached
  if (ctx.files && ctx.files.length > 0) {
    const lines: string[] = [];
    for (const f of ctx.files) {
      const type = f.mimeType ?? "unknown";
      if (f.preprocessingError) {
        lines.push(`  - ${f.name} (${type}) — ⚠️ ${f.preprocessingError}`);
      } else if (f.extractedText !== undefined || f.transcribedText !== undefined) {
        const chars = (f.extractedText?.length ?? 0) + (f.transcribedText?.length ?? 0);
        lines.push(`  - ${f.name} (${type}) — text extracted, ${chars} chars${f.truncated ? "，已截断" : ""}`);
      } else {
        lines.push(`  - ${f.name} (${type})${f.path ? ` — on disk at ${f.path}` : ""}`);
      }
    }
    const hasInlineImages = (ctx.images?.length ?? 0) > 0;
    blocks.push(
      [
        "Files received from WeChat:",
        ...lines,
        "",
        hasInlineImages
          ? "For non-image files (PDF, DOCX, XLSX, etc.) the extracted text is already"
            + " inline in the user message; do not parse the raw binaries yourself."
          : "Do NOT try to read or process raw files (PDF, DOCX, images, etc.) yourself.",
        "File contents are already extracted in the user message below.",
        "Exception: PNG pages rendered under working/pdf_pages/ may be Read directly",
        "when you need to look at more pages of a scanned PDF.",
        "If a file has a ⚠️ marker, tell the user — do not attempt to fix it with Bash.",
      ].join("\n"),
    );
  }

  // 5b. Inline images (direct image mode)
  if (ctx.images && ctx.images.length > 0) {
    const lines = ctx.images.map((img) => `  - ${img.name} (attached inline as image block)`);
    blocks.push(
      [
        "Images received from WeChat:",
        ...lines,
        "",
        "Analyze the images directly from the attached image blocks in the user message.",
        "Do NOT re-read the user's original image files from disk — the inline blocks",
        "are the authoritative copy. Rendered PDF pages under working/pdf_pages/ are",
        "the exception: Read those directly when you need more pages of a scanned PDF.",
      ].join("\n"),
    );
  }

  // 5c. Bundled document-generation references (plain files, no skill tooling)
  blocks.push(buildDocumentSkillsInstruction());

  // 6. Recent conversation history
  if (ctx.historyText) {
    blocks.push(
      [
        "Recent conversation history (oldest first):",
        ctx.historyText,
      ].join("\n"),
    );
  }

  // 6b. How to treat quoted WeChat messages
  blocks.push(
    [
      "QUOTED MESSAGES:",
      'When a user message starts with "[引用内容: ...]", that text IS the content',
      "of the message the user quoted — use it directly. Do NOT search the",
      "filesystem for the quoted item.",
      "When a message notes the quoted content could not be parsed, the quote is",
      "unavailable — ask the user to re-send the original instead of hunting for files.",
    ].join("\n"),
  );

  // 7. Teach the model how to create multi-bubble WeChat replies.
  blocks.push(buildScheduledTaskInstruction());

  // 8. Teach the model how to create multi-bubble WeChat replies.
  blocks.push(buildMultiBubbleInstruction());

  return blocks.join("\n\n");
}

export function buildScheduledTaskInstruction(): string {
  return [
    "SCHEDULED TASKS:",
    "If the user wants to create a reminder or scheduled task, do not use CronCreate, CronList, CronDelete, ScheduleWakeup, MCP tools, Bash, or files.",
    "Instead, reply with ONLY one strict JSON object. Do not wrap it in prose.",
    "The bridge software will parse this JSON, show a confirmation message, and create the task only after the user confirms.",
    "",
    "JSON shape:",
    "{",
    '  "wechat_schedule_task": {',
    '    "title": "short title",',
    '    "mode": "send_text" | "agent_prompt",',
    '    "payloadText": "text to send, or prompt for the agent",',
    '    "schedule": { "type": "once", "runAt": "2026-06-16T18:30:00+08:00" }',
    "  }",
    "}",
    "",
    "For daily tasks, use:",
    '{ "type": "daily", "timeOfDay": "09:00" }',
    "",
    "For weekly tasks, use:",
    '{ "type": "weekly", "weekday": 1, "timeOfDay": "09:00" }',
    "weekday: 0=Sunday, 1=Monday, ... 6=Saturday.",
    "Use the current local timezone for all runAt values.",
  ].join("\n");
}

/**
 * Build the user-facing message that gets sent as the prompt.
 * Includes file content inline when available.
 */
export function buildUserMessage(ctx: PromptContext): string {
  return buildTextPortion(ctx) || "(empty message)";
}

/**
 * Build the multimodal user message for direct image mode: each image as an
 * inline image block (with a text anchor), then the text portion.
 */
export function buildUserBlocksMessage(ctx: PromptContext): UserBlocksMessage {
  const content: UserBlocksMessage["content"] = [];

  for (const image of ctx.images ?? []) {
    content.push({ type: "text", text: `[Image from WeChat: ${image.name}]` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.base64 },
    });
  }

  content.push({ type: "text", text: buildTextPortion(ctx) || "(empty message)" });
  return { role: "user", content };
}

/** Textual portion of the user message: non-image file content + user text. */
function buildTextPortion(ctx: PromptContext): string {
  const parts: string[] = [];

  if (ctx.files) {
    for (const file of ctx.files) {
      const truncationNote = file.truncated
        ? `\n[注意：内容超长已截断，完整文件在 ${file.path}，可用 Read 工具继续读取剩余部分]`
        : "";
      const scannedNote = file.scannedNotice ? `${file.scannedNotice}\n` : "";

      // Voice messages: prefer transcribed text
      if (file.transcribedText) {
        parts.push(
          `[Voice message: ${file.name}]\nTranscription: ${file.transcribedText}${truncationNote}`,
        );
      } else if (file.extractedText) {
        parts.push(
          `[File: ${file.name}] (完整文件位于工作区: ${file.path})\n`
            + `${scannedNote}Content:\n${file.extractedText}${truncationNote}`,
        );
      } else {
        const droppedNote = file.truncated
          ? "\n[注意：本条消息附件总量超长，此文件内容未内联；请用 Read 工具按需读取。]"
          : "";
        parts.push(
          `[File received: ${file.name} (${file.mimeType ?? "unknown type"})]\n`
            + `${scannedNote}The file is available at: ${file.path}${droppedNote}`,
        );
      }
    }
  }

  // User text last (after file context)
  if (ctx.userText) {
    parts.push(ctx.userText);
  }

  return parts.join("\n\n");
}

/**
 * Static pointer to the bundled generation references in the workspace.
 * They are plain files — no Skill tooling involved, just Read + Bash.
 */
export function buildDocumentSkillsInstruction(): string {
  return [
    "DOCUMENT GENERATION REFERENCES:",
    "The workspace skills/ directory bundles reference skills for generating",
    "Excel (skills/minimax-xlsx), PowerPoint (skills/pptx-generator) and Word",
    "(skills/docx) files — each has a SKILL.md plus helper scripts, and",
    "tools/preprocess.py is available for PDF page rendering.",
    "Bridge MCP tools are also available for on-demand document reading:",
    "extract_document (markitdown text), read_scanned_pdf (vision transcript",
    "of scanned pages), render_pdf_pages, extract_pdf_images (embedded",
    "figures as files), transcribe_image — prefer them over manual python/Bash",
    "when reading documents or images. Tool outputs always land inside the",
    "workspace (working/pdf_pages/, working/pdf_images/).",
    "When the user asks you to create or edit such a document, first Read the",
    "matching SKILL.md and follow its guidance. Install any needed node/python",
    "packages inside the workspace (e.g. npm install pptxgenjs).",
    "Save the finished file into working/output_weixin/ — the bridge sends",
    "everything placed there back to the WeChat user automatically.",
    "Office hygiene: after generating .docx/.xlsx/.pptx, run the skill's",
    "postcheck script when available; never stuff stray files into an OOXML",
    "zip — repack only with the skill's unpack/pack scripts. The bridge",
    "validates Office packages before sending and blocks broken ones.",
  ].join("\n");
}

/**
 * Instruction block teaching the AI how to use the multi-bubble separator.
 */
export function buildMultiBubbleInstruction(): string {
  return [
    "MULTI-BUBBLE OUTPUT:",
    `You can split long replies into multiple WeChat messages by inserting`,
    `"${MULTI_BUBBLE_SEPARATOR}" on its own line between message parts.`,
    `Max ${MAX_BUBBLES} bubbles. Use this to create a natural chat pacing.`,
    "",
    `Example:`,
    `好的，让我看看这个问题。`,
    MULTI_BUBBLE_SEPARATOR,
    `查询完成，这是结果...`,
    MULTI_BUBBLE_SEPARATOR,
    `还有其他需要吗？`,
  ].join("\n");
}
