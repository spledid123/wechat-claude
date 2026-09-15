import fs from "node:fs";
import path from "node:path";

export interface RuntimePaths {
  repoRoot: string;
  dataDir: string;
  bridgeDataDir: string;
  workspaceBase: string;
  tokenFile: string;
  qrImagePath: string;
  logsDir: string;
}

export function getOfficialDataDir(repoRoot = process.cwd()): string {
  return process.env.WECHAT_CLAUDE_DATA_DIR
    ? path.resolve(process.env.WECHAT_CLAUDE_DATA_DIR)
    : path.join(repoRoot, ".wechat-claude");
}

/**
 * The claude CLI executable the Agent SDK should spawn, when it should not
 * use the SDK's own default (the platform npm package inside node_modules).
 * Order: WECHAT_CLAUDE_CLAUDE_EXE env → <dataDir>/runtime/claude/claude.exe
 * (the first-run installer's download target) → undefined (SDK default).
 */
export function resolveClaudeExecutable(dataDir: string): string | undefined {
  const fromEnv = process.env.WECHAT_CLAUDE_CLAUDE_EXE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const downloaded = path.join(dataDir, "runtime", "claude", "claude.exe");
  return fs.existsSync(downloaded) ? downloaded : undefined;
}

export function buildRuntimePaths(options: {
  repoRoot?: string;
  dataDir?: string;
} = {}): RuntimePaths {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const dataDir = path.resolve(options.dataDir ?? getOfficialDataDir(repoRoot));
  const bridgeDataDir = path.join(dataDir, "bridge-data");
  const workspaceBase = path.join(dataDir, "workspaces");
  const logsDir = path.join(dataDir, "logs");

  return {
    repoRoot,
    dataDir,
    bridgeDataDir,
    workspaceBase,
    tokenFile: path.join(dataDir, "bot_token.txt"),
    qrImagePath: path.join(dataDir, "wechat-qr.png"),
    logsDir,
  };
}
