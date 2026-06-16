/**
 * Load .env file into process.env.
 * Import this FIRST in any script that needs API keys.
 *
 * Usage: import "./load-env.js";
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const envPath = join(import.meta.dirname, "..", ".env");

try {
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env file not found — env vars must be set in shell
}
