/**
 * Runtime configuration stored in the data dir as config.json.
 *
 * Model selection lives here (not in .env) so the admin panel can read and
 * write it while .env stays reserved for secrets.
 */

import fs from "node:fs";
import path from "node:path";

export type ImageMode = "direct" | "split";

export interface RuntimeConfig {
  /** direct = images inline in the main conversation; split = vision pre-extraction. */
  imageMode: ImageMode;
  /** Model that sees images (direct: also the conversation model). */
  visionModel: string;
  /** Conversation model for split mode. */
  conversationModel: string;
  /** Wait after a text message before flushing the batch (ms). */
  debounceTextMs: number;
  /** Wait after a media message before flushing the batch (ms). */
  debounceMediaMs: number;
  /** Hard cap on total batch accumulation before a forced flush (ms). */
  debounceMaxMs: number;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  imageMode: "direct",
  visionModel: "deepseek-v4-flash-vision-exp",
  conversationModel: "deepseek-v4-flash",
  // Env vars act as deployment-level defaults until config.json overrides them.
  debounceTextMs: readPositiveIntEnv("WECHAT_CLAUDE_TEXT_DEBOUNCE_MS", 3000),
  debounceMediaMs: readPositiveIntEnv("WECHAT_CLAUDE_MEDIA_DEBOUNCE_MS", 5000),
  debounceMaxMs: readPositiveIntEnv("WECHAT_CLAUDE_MAX_DEBOUNCE_MS", 15000),
};

export function configFilePath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

const cache = new Map<string, { mtimeMs: number; config: RuntimeConfig }>();

/** Read config.json with defaults for missing fields; tolerates a corrupt file. */
export function readConfig(dataDir: string): RuntimeConfig {
  const file = configFilePath(dataDir);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  const cached = cache.get(dataDir);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.config;
  }

  let config = { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<RuntimeConfig>;
    config = {
      imageMode: raw.imageMode === "split" ? "split" : "direct",
      visionModel: typeof raw.visionModel === "string" && raw.visionModel.trim()
        ? raw.visionModel.trim()
        : DEFAULT_CONFIG.visionModel,
      conversationModel: typeof raw.conversationModel === "string" && raw.conversationModel.trim()
        ? raw.conversationModel.trim()
        : DEFAULT_CONFIG.conversationModel,
      debounceTextMs: positiveIntOr(raw.debounceTextMs, DEFAULT_CONFIG.debounceTextMs),
      debounceMediaMs: positiveIntOr(raw.debounceMediaMs, DEFAULT_CONFIG.debounceMediaMs),
      debounceMaxMs: positiveIntOr(raw.debounceMaxMs, DEFAULT_CONFIG.debounceMaxMs),
    };
  } catch {
    // Corrupt or partially written file — fall back to defaults.
    config = { ...DEFAULT_CONFIG };
  }

  cache.set(dataDir, { mtimeMs, config });
  return config;
}

/** Persist config.json (write-then-rename so a crash cannot leave it half-written). */
export function writeConfig(dataDir: string, config: RuntimeConfig): void {
  const file = configFilePath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  cache.delete(dataDir);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}
