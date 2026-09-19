/**
 * Quick check: Can we import and use @anthropic-ai/claude-agent-sdk?
 *
 * This script does a REAL call (not a mock). It verifies:
 * 1. The SDK package installed correctly
 * 2. The `query()` function is callable
 * 3. We get a response back (streaming)
 *
 * Requires ANTHROPIC_API_KEY or DEEPSEEK_API_KEY in environment.
 *
 * Usage:
 *   node scripts/check-claude-sdk.js                 # connectivity check
 *   node scripts/check-claude-sdk.js --prompt-compare # default vs custom
 *                                                    # system-prompt usage
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same precedence as the app: real env wins, then repo .env, then data .env. */
function loadEnvFiles() {
  for (const file of [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".wechat-claude", ".env"),
  ]) {
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/** The model production would pick from config.json (falls back to "sonnet"). */
function resolveModel() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, ".wechat-claude", "config.json"), "utf-8"));
    return config.imageMode === "split"
      ? (config.conversationModel || "sonnet")
      : (config.visionModel || "sonnet");
  } catch {
    return "sonnet";
  }
}

async function runQuery(sdk, label, systemPrompt) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 60_000);
  let usage = null;
  let resultText = "";
  try {
    for await (const msg of sdk.query({
      prompt: "只回复两个字：收到",
      options: {
        model: resolveModel(),
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        abortController,
        env: process.env,
        settingSources: [],
        disallowedTools: [
          "AskUserQuestion", "ExitPlanMode", "CronCreate", "CronDelete", "CronList",
          "ScheduleWakeup", "Task", "Agent", "EnterWorktree", "ExitWorktree",
        ],
        settings: { autoMemoryEnabled: false },
        systemPrompt,
      },
    })) {
      if (msg.type === "result") {
        usage = msg.usage ?? null;
        if (typeof msg.result === "string") resultText = msg.result;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  console.log(`\n--- ${label} ---`);
  console.log(`   reply: ${resultText.slice(0, 60)}`);
  if (usage) {
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    console.log(`   input_tokens: ${usage.input_tokens ?? 0}`);
    console.log(`   cache_read:   ${usage.cache_read_input_tokens ?? 0}`);
    console.log(`   cache_write:  ${usage.cache_creation_input_tokens ?? 0}`);
    console.log(`   output:       ${usage.output_tokens ?? 0}`);
    return input;
  }
  console.log("   (no usage reported)");
  return null;
}

async function promptCompare(sdk) {
  console.log("=== System-Prompt Mode Comparison (real API calls) ===");
  const model = resolveModel();
  console.log(`model: ${model}\n`);

  const wechatAppend = [
    "You are an AI relay bot connected to WeChat.",
    "Reply in Chinese (Simplified). Keep replies concise and conversational.",
  ].join("\n");

  const defaultInput = await runQuery(
    sdk,
    "默认模式：官方 claude_code 预设 + 微信功能块（现状）",
    { type: "preset", preset: "claude_code", append: wechatAppend },
  );

  const customInput = await runQuery(
    sdk,
    "替换模式：自定义 md 字符串 + 微信功能块",
    `${wechatAppend}\n\n（此处为自定义系统提示词示例：你是接入微信的 AI 助手。）`,
  );

  if (defaultInput != null && customInput != null) {
    const saved = defaultInput - customInput;
    console.log(`\n每轮输入 token 差异：默认 ${defaultInput} → 自定义 ${customInput}（省 ${saved}）`);
  }
}

async function main() {
  const compareMode = process.argv.includes("--prompt-compare");
  loadEnvFiles();

  if (compareMode) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    await promptCompare(sdk);
    return;
  }

  console.log("=== Claude Agent SDK Connectivity Check ===\n");

  // 1. Check environment
  const hasApiKey =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.ANTHROPIC_BASE_URL ||
    !!process.env.DEEPSEEK_API_KEY;

  if (!hasApiKey) {
    console.log("⚠️  No API key found in environment.");
    console.log("   Set ANTHROPIC_API_KEY or DEEPSEEK_API_KEY to run a live test.");
    console.log("   Will attempt import-only check (no API call).\n");
  }

  // 2. Try importing
  let sdk;
  try {
    sdk = await import("@anthropic-ai/claude-agent-sdk");
    console.log("✅ SDK package imported successfully");
    console.log(`   Exports: ${Object.keys(sdk).join(", ")}`);
    console.log(`   query is: ${typeof sdk.query}`);
  } catch (err) {
    console.error("❌ Failed to import @anthropic-ai/claude-agent-sdk");
    console.error(`   ${err.message}`);
    console.error("\n   Possible causes:");
    console.error("   - package not installed (run: npm install)");
    console.error("   - Node.js version too old (need >= 18)");
    process.exit(1);
  }

  // 3. If no key, skip live test
  if (!hasApiKey) {
    console.log("\n✅ Import check passed (skipped live API call — no key configured).");
    console.log("   To run a live test, set ANTHROPIC_API_KEY in your environment.");
    process.exit(0);
  }

  // 4. Live test
  console.log("\n📡 Running live query test...\n");

  try {
    const abortController = new AbortController();

    // Auto-abort after 30s
    const timer = setTimeout(() => {
      console.log("⏱️  Timeout (30s) — aborting");
      abortController.abort();
    }, 30_000);

    let resultText = "";
    let chunks = 0;

    for await (const msg of sdk.query({
      prompt: "Reply with exactly: 'SDK_OK'",
      options: {
        model: "sonnet",
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        abortController,
        env: process.env,
        settingSources: [],
      },
    })) {
      chunks++;
      if (msg.type === "result" && msg.result) {
        resultText = msg.result;
      } else if (msg.type === "assistant") {
        process.stdout.write(".");
      }
    }

    clearTimeout(timer);
    console.log("");

    if (resultText.includes("SDK_OK") || resultText.length > 0) {
      console.log("✅ Live query succeeded!");
      console.log(`   Response (${resultText.length} chars): ${resultText.slice(0, 200)}`);
      console.log(`   Stream chunks received: ${chunks}`);
    } else {
      console.log("⚠️  Query completed but no recognizable response.");
      console.log(`   Raw result: ${JSON.stringify(resultText)}`);
    }
  } catch (err) {
    console.error(`❌ Live query failed: ${err.message}`);
    process.exit(1);
  }
}

main();
