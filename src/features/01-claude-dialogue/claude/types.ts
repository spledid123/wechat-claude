/**
 * Shared types for the Claude integration layer.
 */

import type { ClaudePermissionResult } from "./permissions.js";

/** Result returned from a Claude query. */
export interface ClaudeQueryResult {
  text: string;
  turnCount: number;
  sessionId: string;
}

/** Media types accepted by the Anthropic-compatible image content block. */
export type InlineImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A user message that carries inline image blocks (direct image mode). */
export interface UserBlocksMessage {
  role: "user";
  content: Array<
    | { type: "text"; text: string }
    | {
      type: "image";
      source: { type: "base64"; media_type: InlineImageMediaType; data: string };
    }
  >;
}

/** querySimple accepts a plain string or a multimodal blocks message. */
export type UserMessageContent = string | UserBlocksMessage;

/** Options for constructing a ClaudeSession. */
export interface ClaudeSessionOptions {
  sessionId: string;
  cwd: string;
  model?: string;
  /** Max tool-calling turns before forced stop. */
  maxTurns?: number;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  allowedTools?: string[];
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    ctx?: unknown,
  ) => Promise<ClaudePermissionResult>;
  sandbox?: ClaudeSandboxOptions;
  settings?: ClaudeSettingsOptions;
}

/** Spec passed to ClaudeManager to get or create a session. */
export interface SessionSpec {
  sessionId: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  allowedTools?: string[];
  canUseTool?: ClaudeSessionOptions["canUseTool"];
  sandbox?: ClaudeSandboxOptions;
  settings?: ClaudeSettingsOptions;
}

export interface ClaudeSettingsOptions {
  [key: string]: unknown;
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
    disableBypassPermissionsMode?: "disable";
    additionalDirectories?: string[];
  };
}

export interface ClaudeSandboxOptions {
  [key: string]: unknown;
  enabled?: boolean;
  failIfUnavailable?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  filesystem?: {
    [key: string]: unknown;
    allowWrite?: string[];
    denyWrite?: string[];
    allowRead?: string[];
    denyRead?: string[];
    allowManagedReadPathsOnly?: boolean;
  };
}

/** Context assembled by the bridge before calling AI. */
export interface PromptContext {
  /** The user's message text (required). */
  userText: string;
  /** Previous session summary, if any. */
  sessionSummary?: string | null;
  /** Recent conversation history formatted as "用户: ...\n助手: ...". */
  historyText?: string;
  /** User-defined custom system prompt. */
  userPrompt?: string | null;
  /** Attached files with extracted content. */
  files?: Array<{
    name: string;
    path: string;
    extractedText?: string;
    transcribedText?: string;
    mimeType?: string;
    /** If preprocessing failed, the error description. */
    preprocessingError?: string;
  }>;
  /** Images inlined as content blocks (direct image mode). */
  images?: Array<{
    name: string;
    base64: string;
    mediaType: InlineImageMediaType;
  }>;
}
