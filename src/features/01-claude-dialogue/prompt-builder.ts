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
      } else if (f.extractedText) {
        const chars = f.extractedText.length;
        lines.push(`  - ${f.name} (${type}) — text extracted, ${chars} chars`);
      } else {
        lines.push(`  - ${f.name} (${type})`);
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
        "Do NOT read the raw image files from disk with Read/Bash — the inline blocks"
          + " are the authoritative copy.",
      ].join("\n"),
    );
  }

  // 6. Recent conversation history
  if (ctx.historyText) {
    blocks.push(
      [
        "Recent conversation history (oldest first):",
        ctx.historyText,
      ].join("\n"),
    );
  }

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
      // Voice messages: prefer transcribed text
      if (file.transcribedText) {
        parts.push(
          `[Voice message: ${file.name}]\nTranscription: ${file.transcribedText}`,
        );
      } else if (file.extractedText) {
        parts.push(
          `[File: ${file.name}]\nContent:\n${file.extractedText}`,
        );
      } else {
        parts.push(
          `[File received: ${file.name} (${file.mimeType ?? "unknown type"})]\n` +
            `The file is available at: ${file.path}`,
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
