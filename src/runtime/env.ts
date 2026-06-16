import fs from "node:fs";
import path from "node:path";

export interface RuntimeEnvLoadOptions {
  appRoot?: string;
  dataDir?: string;
}

export interface RuntimeEnvLoadResult {
  candidateFiles: string[];
  loadedFiles: string[];
}

export function loadRuntimeEnv(options: RuntimeEnvLoadOptions = {}): RuntimeEnvLoadResult {
  const appRoot = path.resolve(options.appRoot ?? process.cwd());
  const candidateFiles: string[] = [path.join(appRoot, ".env")];

  for (const file of candidateFiles) {
    loadEnvFile(file);
  }

  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : process.env.WECHAT_CLAUDE_DATA_DIR
      ? path.resolve(process.env.WECHAT_CLAUDE_DATA_DIR)
      : path.join(appRoot, ".wechat-claude");
  const dataEnv = path.join(dataDir, ".env");
  if (!samePath(candidateFiles[0], dataEnv)) {
    candidateFiles.push(dataEnv);
  }

  const loadedFiles: string[] = [];
  for (const file of candidateFiles) {
    if (loadEnvFile(file)) loadedFiles.push(file);
  }

  return { candidateFiles, loadedFiles };
}

function loadEnvFile(filePath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = unquote(trimmed.slice(eqIndex + 1).trim());
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }

  return true;
}

function unquote(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
