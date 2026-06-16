import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WechatClaudeService } from "../../src/runtime/service.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("official runtime service", () => {
  it("starts the admin panel without a token and stores data in the configured project folder", async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, ".wechat-claude");
    const service = new WechatClaudeService({
      repoRoot: root,
      dataDir,
      adminPort: 0,
      schedulerTickMs: 1_000,
      autoSaveIntervalMs: 1_000,
    });

    await service.start();
    const status = service.getStatus();

    expect(status.state).toBe("waiting_for_login");
    expect(status.adminUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(status.paths.dataDir).toBe(dataDir);
    expect(status.paths.bridgeDataDir).toBe(path.join(dataDir, "bridge-data"));
    expect(status.paths.workspaceBase).toBe(path.join(dataDir, "workspaces"));
    expect(status.paths.tokenFile).toBe(path.join(dataDir, "bot_token.txt"));
    expect(status.paths.logsDir).toBe(path.join(dataDir, "logs"));
    expect(fs.existsSync(status.logFile)).toBe(true);

    const response = await fetch(`${status.adminUrl}api/status`);
    expect(response.ok).toBe(true);
    const body = await response.json() as { status: { paths: { dataDir: string } } };
    expect(body.status.paths.dataDir).toBe(dataDir);

    await service.stop();
    expect(service.getStatus().state).toBe("stopped");
  });

  it("uses .wechat-claude under repo root by default", () => {
    const root = makeTempDir();
    const service = new WechatClaudeService({ repoRoot: root, adminPort: 0 });

    const status = service.getStatus();

    expect(status.paths.dataDir).toBe(path.join(root, ".wechat-claude"));
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claude-runtime-"));
  tempDirs.push(dir);
  return dir;
}
