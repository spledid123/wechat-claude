/**
 * ClaudeSession — wraps a single conversation with the Claude Agent SDK.
 *
 * Uses dynamic import for the SDK so that vitest aliases can redirect
 * it to the mock during tests.
 */

import type {
  ClaudeSessionOptions,
  ClaudeQueryResult,
  UserMessageContent,
  UserBlocksMessage,
} from "./types.js";
import { createClaudePermissionPolicy } from "./permissions.js";
import { getDiagnosticsFile } from "../../../runtime/logger.js";
import fs from "node:fs";
import path from "node:path";

export class ClaudeSession {
  public readonly sessionId: string;
  public readonly cwd: string;
  private abortController: AbortController;
  private isProcessing = false;
  private lastResult: ClaudeQueryResult | null = null;
  private lastQueryAtIso: string | null = null;
  private readonly model?: string;
  private readonly maxTurns?: number;
  private readonly permissionMode: ClaudeSessionOptions["permissionMode"];
  private readonly allowedTools?: string[];
  private readonly canUseTool?: ClaudeSessionOptions["canUseTool"];
  private readonly sandbox: ClaudeSessionOptions["sandbox"];
  private readonly settings: ClaudeSessionOptions["settings"];

  constructor(options: ClaudeSessionOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.abortController = new AbortController();
    this.model = options.model;
    this.maxTurns = options.maxTurns;
    const policy = createClaudePermissionPolicy(this.cwd);
    this.permissionMode = options.permissionMode ?? policy.mode;
    this.allowedTools = options.allowedTools ?? policy.allowedTools;
    this.canUseTool = options.canUseTool ?? policy.canUseTool;
    this.sandbox = options.sandbox ?? createSessionSandbox(this.cwd);
    this.settings = options.settings;
  }

  /**
   * Send a single user message and get the AI's text response.
   *
   * @param userMessage    Plain text, or a multimodal message with inline
   *                       image blocks (direct image mode).
   * @param systemAppend   Extra instructions appended to the system prompt.
   * @param mcpServers     Optional MCP server config for tools.
   */
  async querySimple(
    userMessage: UserMessageContent,
    systemAppend?: string,
    mcpServers?: Record<string, unknown>,
  ): Promise<ClaudeQueryResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // String prompts pass through unchanged; block messages are wrapped in a
    // single-item async iterable, which is the SDK's multimodal prompt form.
    const prompt: string | AsyncIterable<unknown> = typeof userMessage === "string"
      ? userMessage
      : (async function* () {
          yield toSdkUserMessage(userMessage);
        })();

    let resultText = "";
    let assistantText = "";
    let resultError: string | null = null;
    let turnCount = 0;
    let resultTurns: number | null = null;
    let resultUsage: import("./types.js").QueryUsage | undefined;
    let resultDurationMs: number | undefined;
    this.isProcessing = true;
    this.lastQueryAtIso = new Date().toISOString();

    try {
      const queryArgs = {
        prompt,
        options: {
          model: this.model,
          cwd: this.cwd,
          permissionMode: this.permissionMode,
          allowedTools: this.allowedTools,
          canUseTool: this.canUseTool,
          sandbox: this.sandbox,
          settings: this.settings,
          systemPrompt: systemAppend
            ? {
              type: "preset",
              preset: "claude_code",
              append: systemAppend,
            }
            : undefined,
          maxTurns: this.maxTurns,
          includePartialMessages: true,
          abortController: this.abortController,
          env: { ...process.env },
          settingSources: [],
          ...(mcpServers ? { mcpServers } as Record<string, unknown> : {}),
        },
      } as Parameters<typeof query>[0];

      for await (const msg of query(queryArgs)) {
        logSdkEvent(this.sessionId, this.cwd, msg);
        if (msg.type === "result") {
          const result = msg as {
            result?: unknown;
            subtype?: unknown;
            num_turns?: unknown;
            duration_ms?: unknown;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          if (typeof result.result === "string") {
            resultText = result.result;
          } else if (result.subtype && result.subtype !== "success") {
            resultError = describeResultError(msg);
          }
          // Authoritative stats from the SDK's own result message.
          if (typeof result.num_turns === "number" && result.num_turns > 0) {
            resultTurns = result.num_turns;
          }
          if (typeof result.duration_ms === "number") {
            resultDurationMs = result.duration_ms;
          }
          if (result.usage) {
            resultUsage = {
              inputTokens: result.usage.input_tokens ?? 0,
              outputTokens: result.usage.output_tokens ?? 0,
              cacheReadTokens: result.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: result.usage.cache_creation_input_tokens ?? 0,
            };
          }
        } else if (msg.type === "assistant") {
          turnCount++;
          assistantText += extractAssistantText(msg);
        }
      }
    } finally {
      this.isProcessing = false;
    }

    const text = resultText.trim()
      ? resultText
      : assistantText.trim()
        ? assistantText.trim()
        : resultError
          ? `Claude 执行失败：${resultError}`
          : "";

    this.lastResult = {
      text,
      turnCount: resultTurns ?? turnCount,
      sessionId: this.sessionId,
      usage: resultUsage,
      durationMs: resultDurationMs,
    };
    return this.lastResult;
  }

  /** Abort an in-flight query. */
  cancel(): void {
    this.abortController.abort();
    // Replace with a fresh controller for potential reuse
    this.abortController = new AbortController();
  }

  /** The model this session was created with (used to detect config changes). */
  getModel(): string | undefined {
    return this.model;
  }

  /** ISO timestamp of the most recent query start (for the admin panel). */
  getLastQueryAt(): string | null {
    return this.lastQueryAtIso;
  }

  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  getLastResult(): ClaudeQueryResult | null {
    return this.lastResult;
  }
}

/**
 * Shape of the SDK's internal user message. Built as a plain literal so we do
 * not depend on non-exported SDK internals.
 */
function toSdkUserMessage(message: UserBlocksMessage): Record<string, unknown> {
  return {
    type: "user",
    message,
    parent_tool_use_id: null,
  };
}

function createSessionSandbox(cwd: string): NonNullable<ClaudeSessionOptions["sandbox"]> {
  if (process.platform === "win32") {
    return {
      enabled: false,
      failIfUnavailable: false,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: true,
    };
  }

  const cwdRoot = path.parse(path.resolve(cwd)).root || path.resolve(cwd);
  const repoRoot = path.parse(process.cwd()).root || process.cwd();
  const allowRead = uniquePaths([cwdRoot, repoRoot, "/"]);

  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    filesystem: {
      allowWrite: [cwd],
      allowRead,
      denyRead: [],
    },
  };
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function extractAssistantText(msg: unknown): string {
  const message = (msg as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (
      block
      && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "";
}

function describeResultError(msg: unknown): string {
  const result = msg as {
    subtype?: unknown;
    errors?: unknown;
    permission_denials?: unknown;
    stop_reason?: unknown;
    terminal_reason?: unknown;
  };

  const details: string[] = [];
  if (typeof result.subtype === "string") {
    details.push(result.subtype);
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    details.push(result.errors.map((item) => String(item)).join("; "));
  }
  if (Array.isArray(result.permission_denials) && result.permission_denials.length > 0) {
    details.push(
      `permission denials: ${result.permission_denials
        .map((item) => JSON.stringify(toLoggableValue(item)))
        .join("; ")}`,
    );
  }
  if (typeof result.terminal_reason === "string") {
    details.push(`terminal=${result.terminal_reason}`);
  }
  if (typeof result.stop_reason === "string") {
    details.push(`stop=${result.stop_reason}`);
  }

  return details.join(" | ") || "unknown SDK result error";
}

function logSdkEvent(sessionId: string, cwd: string, msg: unknown): void {
  // Opt-in diagnostics dump — writes every SDK event, so it is off unless
  // explicitly requested with CLAUDE_SDK_EVENT_LOG=1.
  if (process.env.CLAUDE_SDK_EVENT_LOG !== "1") {
    return;
  }

  try {
    const logPath = getDiagnosticsFile("claude-sdk-events.jsonl");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        time: new Date().toISOString(),
        sessionId,
        cwd,
        msg: toLoggableValue(msg),
      })}\n`,
    );
  } catch {
    // SDK event logging is diagnostic only.
  }
}

function toLoggableValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}...<truncated>` : value;
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (depth >= 5) {
    return "<max-depth>";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => toLoggableValue(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    result[key] = toLoggableValue(child, depth + 1);
  }
  return result;
}
