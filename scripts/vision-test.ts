/**
 * Offline/online verification for the vision image pipeline.
 *
 *   npx tsx scripts/vision-test.ts <image-path> [--extract] [--direct]
 *
 * Without flags it only checks local gating: magic-byte sniffing, size
 * limits, and the image block structure (no network needed).
 * With --extract it additionally calls the configured vision model and
 * prints the description + transcript (requires .env credentials).
 * With --direct it sends the blocks message through the Claude Agent SDK
 * exactly like direct image mode does (end-to-end, slowest).
 */

import { loadRuntimeEnv } from "../src/runtime/env.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import {
  prepareImagePayload,
  extractImageWithVision,
} from "../src/features/03-file-preprocessing/vision.js";
import { readConfig, configFilePath } from "../src/runtime/config.js";
import { ClaudeSession } from "../src/features/01-claude-dialogue/claude/session.js";
import type { UserBlocksMessage } from "../src/features/01-claude-dialogue/claude/types.js";

const args = process.argv.slice(2);
const doExtract = args.includes("--extract");
const doDirect = args.includes("--direct");
const imagePath = args.find((a) => !a.startsWith("--"));

if (!imagePath) {
  console.error("usage: npx tsx scripts/vision-test.ts <image-path> [--extract]");
  process.exit(1);
}

const appRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
loadRuntimeEnv({ appRoot });
const dataDir = path.join(appRoot, ".wechat-claude");
const config = readConfig(dataDir);

console.log(`config file : ${configFilePath(dataDir)}`);
console.log(`imageMode   : ${config.imageMode}`);
console.log(`visionModel : ${config.visionModel}`);
console.log(`convModel   : ${config.conversationModel}`);
console.log(`base URL    : ${process.env.ANTHROPIC_BASE_URL ?? "(default deepseek)"}`);
console.log(`auth        : ${process.env.ANTHROPIC_API_KEY ? "x-api-key" : ""}${process.env.ANTHROPIC_AUTH_TOKEN ? " + bearer" : ""}${!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN ? " (none!)" : ""}`);
console.log("");

const prepared = prepareImagePayload(path.resolve(imagePath), path.basename(imagePath));
if (!prepared.ok) {
  console.error(`PREPARE FAILED: ${prepared.error}`);
  process.exit(1);
}

const { payload } = prepared;
console.log(`sniffed type: ${payload.mediaType}`);
console.log(`size        : ${(payload.byteSize / 1024).toFixed(1)} KB (base64 ~${(payload.base64.length / 1024).toFixed(0)} KB)`);

// Assemble the same blocks message the direct mode would send.
const blocksMessage: UserBlocksMessage = {
  role: "user",
  content: [
    { type: "text", text: `[Image from WeChat: ${payload.name}]` },
    {
      type: "image",
      source: { type: "base64", media_type: payload.mediaType, data: payload.base64 },
    },
    { type: "text", text: "这张图里有什么？" },
  ],
};
console.log(`blocks ok   : ${blocksMessage.content.length} blocks (${blocksMessage.content.filter((b) => b.type === "image").length} image)`);

if (!doExtract && !doDirect) {
  console.log("\nLocal checks passed. Re-run with --extract (vision HTTP) or --direct (full SDK) to go online.");
  process.exit(0);
}

if (doExtract) {
  console.log("\ncalling vision model...");
  const result = await extractImageWithVision(payload, { model: config.visionModel });
  if (!result.ok) {
    console.error(`EXTRACT FAILED: ${result.error}`);
    process.exit(1);
  }
  console.log("\n--- extraction result ---");
  console.log(result.text);
  console.log("-------------------------");
}

if (doDirect) {
  console.log("\nsending blocks message through the Agent SDK (direct mode)...");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vision-test-"));
  const session = new ClaudeSession({
    sessionId: `vision-test-${Date.now()}`,
    cwd,
    model: config.visionModel,
  });
  const question: UserBlocksMessage = {
    role: "user",
    content: [
      { type: "text", text: `[Image from WeChat: ${payload.name}]` },
      {
        type: "image",
        source: { type: "base64", media_type: payload.mediaType, data: payload.base64 },
      },
      { type: "text", text: "用一句话说明这张图片是什么。" },
    ],
  };
  const result = await session.querySimple(
    question,
    "You are a test harness. Answer in Chinese, one sentence, no tools.",
  );
  console.log("\n--- direct mode reply ---");
  console.log(result.text);
  console.log("-------------------------");
  console.log(`turns: ${result.turnCount}`);
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Sanity: the input file should still be around after all this.
if (!fs.existsSync(imagePath)) {
  console.error("input image vanished?");
  process.exit(1);
}
console.log("\nDONE OK");
