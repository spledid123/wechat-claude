import path from "node:path";

export interface RuntimePaths {
  repoRoot: string;
  dataDir: string;
  bridgeDataDir: string;
  workspaceBase: string;
  tokenFile: string;
  qrImagePath: string;
  logsDir: string;
  quoteJsonlPath: string;
}

export function getOfficialDataDir(repoRoot = process.cwd()): string {
  return process.env.WECHAT_CLAUDE_DATA_DIR
    ? path.resolve(process.env.WECHAT_CLAUDE_DATA_DIR)
    : path.join(repoRoot, ".wechat-claude");
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
    quoteJsonlPath: path.join(logsDir, "quote-listener.jsonl"),
  };
}
