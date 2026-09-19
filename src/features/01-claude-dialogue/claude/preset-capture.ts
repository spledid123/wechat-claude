/**
 * Offline capture of the built-in Claude Code system prompt.
 *
 * The Agent SDK offers no way to read the preset prompt back — `systemPrompt`
 * is write-only and usage stats only carry section names. But the fully
 * assembled text is present in every /v1/messages request body the CLI sends.
 * So: start a one-shot local HTTP listener, point a single spawned claude.exe
 * query at it with dummy credentials, record the `system` field from the
 * largest request, and answer with a minimal synthetic response so the CLI
 * exits cleanly. Fully offline, zero API cost.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getOfficialDataDir, resolveClaudeExecutable } from "../../../runtime/paths.js";
import { getRootLogger } from "../../../runtime/logger.js";
import { ALWAYS_DENY_TOOL_NAMES } from "./permissions.js";

export interface PresetPromptCapture {
  capturedAt: string;
  claudeVersion: string;
  model: string | null;
  systemText: string;
  tools: string[];
  /** Rough chars/4 estimate — informational only. */
  approxTokens: number;
}

interface CapturedRequest {
  systemText: string;
  tools: string[];
  model: string | null;
}

const CAPTURE_TIMEOUT_MS = 30_000;

export function captureFilePath(dataDir = getOfficialDataDir()): string {
  return path.join(dataDir, "preset-prompt-capture.json");
}

export function loadCapture(dataDir = getOfficialDataDir()): PresetPromptCapture | null {
  try {
    const raw = JSON.parse(fs.readFileSync(captureFilePath(dataDir), "utf-8")) as PresetPromptCapture;
    if (typeof raw.systemText === "string" && raw.systemText.trim()) return raw;
    return null;
  } catch {
    return null;
  }
}

/**
 * Spawn one throwaway claude.exe query against a local listener and save the
 * preset system prompt it sends. Throws when nothing could be captured.
 */
export async function capturePresetPrompt(): Promise<PresetPromptCapture> {
  const captured: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = Buffer.concat(chunks).toString("utf-8");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        /* not JSON — answer generically below */
      }

      if (url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"input_tokens":1}');
        return;
      }
      if (url.includes("messages")) {
        captured.push({
          systemText: normalizeSystem(parsed.system),
          tools: Array.isArray(parsed.tools)
            ? parsed.tools
              .map((t) => (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string"
                ? (t as { name: string }).name
                : ""))
              .filter(Boolean)
            : [],
          model: typeof parsed.model === "string" ? parsed.model : null,
        });
        if (parsed.stream !== false) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(buildSyntheticStream());
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(buildSyntheticMessage());
        }
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"type":"not_found"}}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CAPTURE_TIMEOUT_MS);
  const baseUrl = `http://127.0.0.1:${port}`;

  getRootLogger().info(`开始离线捕获官方系统提示词（本地端点 ${baseUrl}）…`);
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "preset-capture-"));
    const claudeExecutable = resolveClaudeExecutable(getOfficialDataDir());
    const q = query({
      prompt: "hi",
      options: {
        cwd,
        maxTurns: 1,
        settingSources: [],
        abortController: abort,
        // Mirror the production pipeline's prompt mode: without this the SDK
        // falls back to its minimal "You are a Claude agent" default, not the
        // claude_code preset the live sessions actually use.
        systemPrompt: { type: "preset", preset: "claude_code" },
        disallowedTools: [...ALWAYS_DENY_TOOL_NAMES],
        settings: { autoMemoryEnabled: false },
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: "preset-capture-dummy",
          ANTHROPIC_AUTH_TOKEN: "preset-capture-dummy",
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    } as Parameters<typeof query>[0]);
    try {
      for await (const _msg of q) {
        /* drain — we only care about what the listener recorded */
      }
    } catch (err) {
      // Timeout abort mid-stream is expected; keep whatever was captured.
      if (captured.length === 0) throw err;
    }
  } finally {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  }

  // Auxiliary calls (topic detection etc.) carry their own tiny system prompt;
  // the main agent prompt is by far the longest one captured.
  const best = captured
    .filter((c) => c.systemText.trim())
    .sort((a, b) => b.systemText.length - a.systemText.length)[0];
  if (!best) {
    throw new Error("捕获失败：claude.exe 未向本地端点发出任何包含 system 字段的请求");
  }

  const result: PresetPromptCapture = {
    capturedAt: new Date().toISOString(),
    claudeVersion: resolveClaudeVersion(),
    model: best.model,
    systemText: best.systemText,
    tools: best.tools,
    approxTokens: Math.round(best.systemText.length / 4),
  };

  const file = captureFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2), "utf-8");
  getRootLogger().info(
    `官方系统提示词捕获完成：${result.approxTokens} 粗估 token，${result.tools.length} 个工具，claude ${result.claudeVersion}`,
  );
  return result;
}

/** The `system` field arrives as a string or an array of text blocks. */
function normalizeSystem(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** Minimal valid SSE stream so the CLI finishes its turn without tool calls. */
function buildSyntheticStream(): string {
  const events = [
    { type: "message_start", message: { id: "msg_capture", type: "message", role: "assistant", model: "capture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function buildSyntheticMessage(): string {
  return JSON.stringify({
    id: "msg_capture",
    type: "message",
    role: "assistant",
    model: "capture",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

/** Best-effort version stamp so the panel can flag a stale capture. */
function resolveClaudeVersion(): string {
  const dataDir = getOfficialDataDir();
  const candidates = [
    resolveClaudeExecutable(dataDir),
    path.join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"),
  ].filter((p): p is string => Boolean(p));
  for (const exe of candidates) {
    try {
      const out = spawnSync(exe, ["--version"], { timeout: 15_000, encoding: "utf-8" });
      const text = `${out.stdout ?? ""}${out.stderr ?? ""}`.trim();
      if (text) return text.split("\n")[0].slice(0, 60);
    } catch {
      /* try next candidate */
    }
  }
  return "unknown";
}
