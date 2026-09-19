/**
 * One-off verification for the offline preset-prompt capture module.
 * Runs fully offline (local listener + dummy credentials) — no API cost.
 *   npx tsx scripts/test-preset-capture.ts
 */
import http from "node:http";
import { capturePresetPrompt, loadCapture } from "../src/features/01-claude-dialogue/claude/preset-capture.js";

const result = await capturePresetPrompt();
console.log("=== 捕获结果（生产同款 preset 配置）===");
console.log("claudeVersion:", result.claudeVersion);
console.log("model:", result.model);
console.log("approxTokens:", result.approxTokens);
console.log("tools:", result.tools.join(", "));
console.log("systemText length:", result.systemText.length, "chars");
console.log("--- systemText 前 600 字符 ---");
console.log(result.systemText.slice(0, 600));
console.log("--- systemText 末 300 字符 ---");
console.log(result.systemText.slice(-300));

const reloaded = loadCapture();
if (!reloaded || reloaded.systemText !== result.systemText) {
  throw new Error("loadCapture() 未能读回刚保存的捕获文件");
}
console.log("\n✓ 捕获文件保存/读回一致:", reloaded.capturedAt);

// --- E2E: prove the SDK's string systemPrompt mode sends OUR text verbatim ---
const CUSTOM = "你是接入微信的 AI 助手。（测试用自定义系统提示词）";
const seen: string[] = [];
const probe = http.createServer((req, res) => {
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
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = (probe.address() as { port: number }).port;
const { query } = await import("@anthropic-ai/claude-agent-sdk");
for await (const _msg of query({
  prompt: "hi",
  options: {
    cwd: process.cwd(),
    maxTurns: 1,
    settingSources: [],
    systemPrompt: CUSTOM,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: "dummy",
      ANTHROPIC_AUTH_TOKEN: "dummy",
      DISABLE_TELEMETRY: "1",
    },
  },
} as Parameters<typeof query>[0])) {
  /* drain */
}
probe.close();
const sent = seen.sort((a, b) => b.length - a.length)[0] ?? "";
if (!sent.includes(CUSTOM) || sent.includes("You are an interactive agent")) {
  throw new Error(`字符串替换模式未按预期生效，实际发送：${sent.slice(0, 200)}`);
}
console.log("✓ 字符串替换模式验证通过：自定义文本原样发送，官方预设未注入");
console.log("  实际 system 全文（%d 字符）：%s", sent.length, sent.slice(0, 120).replace(/\n/g, "\\n"));
