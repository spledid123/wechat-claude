/**
 * First-run bootstrap installer.
 *
 * When the packaged app ships without the 218MB claude.exe platform binary
 * (and without the optional Python venv), the service enters "bootstrap"
 * mode: the admin server serves an installer page whose buttons drive the
 * installs managed here.
 *
 *  - Claude Agent runtime (required): downloads the win32-x64 platform npm
 *    tarball matching the installed @anthropic-ai/claude-agent-sdk version
 *    (npmmirror primary, npmjs fallback) and extracts claude.exe into
 *    <dataDir>/runtime/claude/. The SDK picks it up via
 *    resolveClaudeExecutable() → options.pathToClaudeCodeExecutable.
 *  - Python preprocessing env (optional): downloads uv (GitHub release zip)
 *    into <dataDir>/runtime/uv/, creates <dataDir>/.venv and installs the
 *    preprocess requirements into it — the same commands setup-deps.ps1 uses,
 *    all per-user, no admin rights.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import tar from "tar-fs";
import { resolveClaudeExecutable, type RuntimePaths } from "./paths.js";
import type { RuntimeLogger } from "./logger.js";

const UV_ZIP_URL = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip";

export type ComponentStatus =
  | "not_installed"
  | "downloading"
  | "extracting"
  | "installing"
  | "installed"
  | "error";

export interface ComponentState {
  status: ComponentStatus;
  receivedBytes: number;
  totalBytes: number;
  /** Human-readable phase / last install output line. */
  message: string;
  error: string | null;
  version: string | null;
}

export interface BootstrapStatus {
  needed: boolean;
  claude: ComponentState;
  python: ComponentState;
  /** True once the required component (claude) is installed and python is idle. */
  ready: boolean;
}

function freshComponentState(): ComponentState {
  return {
    status: "not_installed",
    receivedBytes: 0,
    totalBytes: 0,
    message: "",
    error: null,
    version: null,
  };
}

/** Path of the claude.exe shipped inside node_modules, if present. */
function findBundledClaudeCli(): string | undefined {
  try {
    const resolved = createRequire(import.meta.url)
      .resolve("@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
    return fs.existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function getSdkVersion(): string {
  // The SDK's exports map hides ./package.json, so resolve the entry point
  // and read the package.json sitting next to it.
  const entryPath = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const pkgPath = path.join(path.dirname(entryPath), "package.json");
  return String(JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "");
}

/** Read the version marker written when the runtime was downloaded. */
function readInstalledRuntimeVersion(claudeDir: string): string | null {
  try {
    const marker = path.join(claudeDir, "version.json");
    return String(JSON.parse(fs.readFileSync(marker, "utf-8")).version ?? "") || null;
  } catch {
    return null;
  }
}

/**
 * Bootstrap is needed when there is no usable claude executable at all:
 * neither the first-run download nor the bundled node_modules platform
 * package. WECHAT_CLAUDE_BOOTSTRAP_FORCE=1 forces the installer page (dev
 * knob, also the documented way to add the Python env later).
 */
export function needsBootstrap(dataDir: string): boolean {
  if (process.env.WECHAT_CLAUDE_BOOTSTRAP_FORCE === "1") return true;
  if (resolveClaudeExecutable(dataDir)) return false;
  return !findBundledClaudeCli();
}

export function pythonVenvInstalled(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, ".venv", "Scripts", "python.exe"));
}

export class BootstrapManager {
  private readonly claudeState: ComponentState = freshComponentState();
  private readonly pythonState: ComponentState = freshComponentState();
  private readonly readyWaiters: Array<() => void> = [];

  constructor(
    private readonly paths: RuntimePaths,
    private readonly logger: RuntimeLogger,
    /** The service's abort signal: stopping the service cancels installs. */
    private readonly signal: AbortSignal,
  ) {
    // Reflect pre-installed components so the installer page shows ✓ for
    // them (relevant for WECHAT_CLAUDE_BOOTSTRAP_FORCE or a claude download
    // that completed on a previous attempt).
    if (resolveClaudeExecutable(paths.dataDir)) {
      this.claudeState.status = "installed";
      this.claudeState.version = readInstalledRuntimeVersion(this.claudeDir());
    }
    if (pythonVenvInstalled(paths.dataDir)) {
      this.pythonState.status = "installed";
      this.pythonState.message = ".venv（markitdown + pymupdf）";
    }
  }

  getStatus(): BootstrapStatus {
    return {
      needed: true,
      claude: { ...this.claudeState },
      python: { ...this.pythonState },
      ready: this.isReady(),
    };
  }

  /** Required runtime present and optional python install not mid-flight. */
  isReady(): boolean {
    const claudeDone = this.claudeState.status === "installed";
    const pythonBusy = ["downloading", "extracting", "installing"]
      .includes(this.pythonState.status);
    return claudeDone && !pythonBusy;
  }

  /** Resolves when isReady() first holds (or immediately if it already does). */
  waitUntilReady(signal: AbortSignal): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        this.readyWaiters.splice(this.readyWaiters.indexOf(done), 1);
        resolve();
      };
      const done = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.readyWaiters.push(done);
    });
  }

  private notifyReady(): void {
    const waiters = this.readyWaiters.splice(0);
    for (const done of waiters) done();
  }

  startClaudeInstall(): void {
    if (["downloading", "extracting", "installing"].includes(this.claudeState.status)) return;
    if (this.claudeState.status === "installed") return;
    void this.installClaude(this.signal).catch(() => undefined);
  }

  startPythonInstall(): void {
    if (["downloading", "extracting", "installing"].includes(this.pythonState.status)) return;
    if (this.pythonState.status === "installed") return;
    void this.installPython(this.signal).catch(() => undefined);
  }

  // ---------------------------------------------------------------- claude

  private claudeDir(): string {
    return path.join(this.paths.dataDir, "runtime", "claude");
  }

  private async installClaude(signal: AbortSignal): Promise<void> {
    const state = this.claudeState;
    state.error = null;
    try {
      let version: string;
      try {
        version = getSdkVersion();
      } catch (err) {
        throw new Error(`无法读取 Claude Agent SDK 版本：${String(err)}`);
      }

      const pkg = "@anthropic-ai/claude-agent-sdk-win32-x64";
      const tarball = `claude-agent-sdk-win32-x64-${version}.tgz`;
      const urls = [
        `https://registry.npmmirror.com/${pkg}/-/${tarball}`,
        `https://registry.npmjs.org/${pkg}/-/${tarball}`,
      ];

      state.status = "downloading";
      state.message = `正在下载 Claude 运行时（v${version}，约 218MB）`;
      const downloadsDir = path.join(this.paths.dataDir, "runtime", "downloads");
      fs.mkdirSync(downloadsDir, { recursive: true });
      const tgzPath = path.join(downloadsDir, tarball);
      await this.downloadFile(urls, tgzPath, signal, (received, total) => {
        state.receivedBytes = received;
        state.totalBytes = total;
      });

      state.status = "extracting";
      state.message = "正在解压 claude.exe…";
      const tempDir = path.join(downloadsDir, `extract-${Date.now()}`);
      await pipeline(
        fs.createReadStream(tgzPath),
        zlib.createGunzip(),
        tar.extract(tempDir),
      );
      const extracted = path.join(tempDir, "package", "claude.exe");
      if (!fs.existsSync(extracted)) {
        throw new Error("压缩包内未找到 claude.exe");
      }
      fs.mkdirSync(this.claudeDir(), { recursive: true });
      const dest = path.join(this.claudeDir(), "claude.exe");
      fs.rmSync(dest, { force: true });
      fs.renameSync(extracted, dest);
      fs.writeFileSync(
        path.join(this.claudeDir(), "version.json"),
        JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2),
        "utf-8",
      );
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(tgzPath, { force: true });

      state.status = "installed";
      state.version = version;
      state.message = `Claude 运行时就绪（v${version}）`;
      this.logger.info(`Bootstrap: claude runtime installed (v${version}) at ${dest}`);
      this.notifyReady();
    } catch (err) {
      if (signal.aborted) return;
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      state.message = "下载失败，可重试";
      this.logger.error(`Bootstrap: claude install failed: ${state.error}`);
    }
  }

  // --------------------------------------------------------------- python

  private async installPython(signal: AbortSignal): Promise<void> {
    const state = this.pythonState;
    state.error = null;
    try {
      const venvDir = path.join(this.paths.dataDir, ".venv");
      const pythonExe = path.join(venvDir, "Scripts", "python.exe");

      // 1) uv: bundled in the data dir, else system PATH, else downloaded.
      let uvPath = path.join(this.paths.dataDir, "runtime", "uv", "uv.exe");
      if (!fs.existsSync(uvPath)) {
        const systemUv = await findCommandOnPath("uv");
        if (systemUv) {
          uvPath = systemUv;
        } else {
          state.status = "downloading";
          state.message = "正在下载 uv（约 20MB）";
          const downloadsDir = path.join(this.paths.dataDir, "runtime", "downloads");
          fs.mkdirSync(downloadsDir, { recursive: true });
          const zipPath = path.join(downloadsDir, "uv.zip");
          await this.downloadFile([UV_ZIP_URL], zipPath, signal, (received, total) => {
            state.receivedBytes = received;
            state.totalBytes = total;
          });
          state.status = "extracting";
          state.message = "正在解压 uv…";
          const uvDir = path.join(this.paths.dataDir, "runtime", "uv");
          new AdmZip(zipPath).extractAllTo(uvDir, true);
          fs.rmSync(zipPath, { force: true });
          if (!fs.existsSync(uvPath)) {
            throw new Error(`uv 解压后未找到 ${uvPath}`);
          }
        }
      }

      // 2) venv (skip when a previous attempt already created one).
      if (!fs.existsSync(pythonExe)) {
        state.status = "installing";
        state.message = "正在创建 Python 虚拟环境（uv 自动下载 CPython）…";
        await runCommand(uvPath, ["venv", venvDir], {
          signal,
          onLine: (line) => (state.message = line.slice(0, 200)),
        });
      }

      // 3) requirements: markitdown + pymupdf (~300MB of wheels).
      const requirements = path.join(this.paths.repoRoot, "scripts", "preprocess-requirements.txt");
      if (!fs.existsSync(requirements)) {
        throw new Error(`未找到依赖清单：${requirements}`);
      }
      state.status = "installing";
      state.message = "正在安装 markitdown + pymupdf（约 300MB，耗时数分钟）…";
      await runCommand(uvPath, [
        "pip", "install", "-r", requirements, "--python", pythonExe,
      ], {
        signal,
        onLine: (line) => (state.message = line.slice(0, 200)),
      });

      state.status = "installed";
      state.message = "Python 环境就绪（.venv）";
      this.logger.info(`Bootstrap: python env installed at ${venvDir}`);
      this.notifyReady();
    } catch (err) {
      if (signal.aborted) return;
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      state.message = "安装失败，可重试";
      this.logger.error(`Bootstrap: python install failed: ${state.error}`);
    }
  }

  // -------------------------------------------------------------- shared

  /**
   * Stream a remote file to disk with byte progress. Tries URLs in order;
   * cleans the partial file up on failure so a retry starts clean.
   */
  private async downloadFile(
    urls: string[],
    destPath: string,
    signal: AbortSignal,
    onProgress: (received: number, total: number) => void,
  ): Promise<void> {
    let lastError: unknown = null;
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal, redirect: "follow" });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get("content-length") ?? 0);
        const out = fs.createWriteStream(destPath);
        const reader = res.body.getReader();
        let received = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            onProgress(received, total);
            if (!out.write(Buffer.from(value))) {
              await new Promise<void>((resolve) => out.once("drain", resolve));
            }
          }
        } finally {
          await new Promise<void>((resolve) => out.end(resolve));
        }
        if (received === 0) throw new Error("空响应");
        return;
      } catch (err) {
        lastError = err;
        fs.rmSync(destPath, { force: true });
        if (signal.aborted) throw err;
        this.logger.warn(`Bootstrap: download failed from ${url}: ${String(err)}`);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "下载失败"));
  }
}

/** Resolve a command via `where`-style probing on Windows. */
async function findCommandOnPath(command: string): Promise<string | null> {
  try {
    await runCommand(command, ["--version"], { signal: new AbortController().signal });
    return command;
  } catch {
    return null;
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { signal: AbortSignal; onLine?: (line: string) => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const handleChunk = (data: Buffer | string) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) options.onLine?.(line.trim());
      }
    };
    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    const onAbort = () => child.kill();
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      options.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} 退出码 ${code}`));
    });
  });
}
