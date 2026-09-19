/**
 * Offline probe: does disabling auto-memory remove the "# auto memory"
 * section from the assembled system prompt? Runs against a local listener
 * (dummy credentials, zero API cost).
 *   npx tsx scripts/test-memory-off.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALWAYS_DENY = [
  "AskUserQuestion", "ExitPlanMode", "CronCreate", "CronDelete", "CronList",
  "ScheduleWakeup", "Task", "Agent", "EnterWorktree", "ExitWorktree",
];

interface ProbeResult {
  label: string;
  systemText: string;
}

async function probe(label: string, extraOptions: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<ProbeResult> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let system = "";
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { system?: unknown };
        if (typeof parsed.system === "string") system = parsed.system;
        else if (Array.isArray(parsed.system)) {
          system = (parsed.system as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n\n");
        }
      } catch { /* ignore */ }
      if (system) seen.push(system);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "memory-probe-"));
  try {
    for await (const _msg of query({
      prompt: "hi",
      options: {
        cwd,
        maxTurns: 1,
        settingSources: [],
        systemPrompt: { type: "preset", preset: "claude_code" },
        disallowedTools: ALWAYS_DENY,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: "dummy",
          ANTHROPIC_AUTH_TOKEN: "dummy",
          DISABLE_TELEMETRY: "1",
          ...extraEnv,
        },
        ...extraOptions,
      },
    } as Parameters<typeof query>[0])) {
      /* drain */
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  const best = seen.sort((a, b) => b.length - a.length)[0] ?? "";
  return { label, systemText: best };
}

function report(r: ProbeResult) {
  const hasMemory = r.systemText.includes("# auto memory");
  const hasModelFamily = r.systemText.includes("most recent Claude model family");
  console.log(`${r.label}: ${r.systemText.length} chars | auto memory 段: ${hasMemory ? "存在 ⚠" : "已消失 ✓"} | 模型家族行: ${hasModelFamily ? "存在" : "无"}`);
  return { hasMemory, hasModelFamily };
}

const baseline = await probe("A 基线（当前生产配置）           ", {});
report(baseline);

const bySettings = await probe("B settings.autoMemoryEnabled=false", { settings: { autoMemoryEnabled: false } });
report(bySettings);

const byEnv = await probe("C env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", {}, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
report(byEnv);
