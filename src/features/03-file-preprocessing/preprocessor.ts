/**
 * Routes files to text extraction, OCR, or document conversion before they
 * are given to Claude. Text files are handled in-process; images/PDF/Office
 * files use the optional Python preprocessing environment.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface PreprocessResult {
  /** Extracted text, null if extraction failed. */
  extractedText: string | null;
  /** MIME type guessed from the file extension. */
  mimeType: string;
  /** Error description, null on success. */
  error: string | null;
  /** Whether the extracted text was truncated. */
  truncated?: boolean;
}

export interface FilePreprocessorOptions {
  appRoot?: string;
  dataDir?: string;
  pythonPath?: string;
  preprocessScript?: string;
  timeoutMs?: number;
}

type ProcessMode = "ocr" | "markitdown" | "text" | "unsupported";

const OCR_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp",
]);

const MARKITDOWN_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".m", ".py", ".js", ".ts", ".json", ".csv",
  ".xml", ".html", ".css", ".md", ".yml", ".yaml",
  ".sh", ".bat", ".ps1", ".c", ".cpp", ".h", ".java",
  ".rs", ".go", ".rb", ".php", ".sql", ".log",
]);

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
};

interface PythonResult {
  ok: boolean;
  text?: string;
  error?: string;
  truncated?: boolean;
}

export class FilePreprocessor {
  private readonly appRoot: string;
  private readonly dataDir?: string;
  private readonly pythonPath?: string;
  private readonly preprocessScript?: string;
  private readonly timeoutMs: number;

  constructor(options: FilePreprocessorOptions = {}) {
    this.appRoot = path.resolve(options.appRoot ?? process.cwd());
    this.dataDir = options.dataDir ? path.resolve(options.dataDir) : undefined;
    this.timeoutMs = options.timeoutMs ?? readNumberEnv("WECHAT_CLAUDE_PREPROCESS_TIMEOUT_MS", 60_000);
    this.pythonPath = options.pythonPath ?? findPythonPath(this.appRoot, this.dataDir);
    this.preprocessScript = options.preprocessScript ?? findPreprocessScript(this.appRoot);
  }

  /**
   * Process a single file. Detects type, runs the appropriate extractor,
   * and returns extracted text or a user-facing error.
   */
  async process(filePath: string): Promise<PreprocessResult> {
    if (!fs.existsSync(filePath)) {
      return {
        extractedText: null,
        mimeType: "application/octet-stream",
        error: "文件不存在",
      };
    }

    const mode = detectMode(filePath);
    const mimeType = getMimeType(filePath);

    if (mode === "unsupported") {
      return {
        extractedText: null,
        mimeType,
        error: "不支持此文件类型",
      };
    }

    if (mode === "text") {
      return readTextFile(filePath, mimeType);
    }

    const result = mode === "ocr"
      ? await this.runOcrWithRetry(filePath)
      : await this.runPython(mode, filePath);
    return {
      extractedText: result.ok ? (result.text ?? null) : null,
      mimeType,
      error: result.ok ? null : (result.error ?? "未知预处理错误"),
      truncated: result.truncated,
    };
  }

  async processAll(filePaths: string[]): Promise<PreprocessResult[]> {
    return Promise.all(filePaths.map((fp) => this.process(fp)));
  }

  private runPython(mode: Exclude<ProcessMode, "text" | "unsupported">, filePath: string): Promise<PythonResult> {
    return new Promise((resolve) => {
      if (!this.preprocessScript || !fs.existsSync(this.preprocessScript)) {
        resolve({
          ok: false,
          error: "文件预处理脚本不存在。请确认使用最新 exe，或检查 scripts/preprocess.py 是否存在。",
        });
        return;
      }

      if (!this.pythonPath) {
        resolve({
          ok: false,
          error: "Python 预处理环境未配置。请在 exe 同目录创建 .venv，或设置 WECHAT_CLAUDE_PYTHON。",
        });
        return;
      }

      const proc = spawn(this.pythonPath, [
        this.preprocessScript,
        "--mode", mode,
        "--file", filePath,
      ], {
        timeout: this.timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
        },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf-8");
      });
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf-8");
      });

      proc.on("close", (code) => {
        const parsed = parsePythonJson(stdout);
        if (parsed) {
          resolve(parsed);
          return;
        }

        resolve({
          ok: false,
          error: code === null
            ? `预处理超时 (${Math.round(this.timeoutMs / 1000)}s)`
            : `预处理失败 (exit=${code}): ${firstUsefulLine(stderr) || firstUsefulLine(stdout) || "无输出"}`,
        });
      });

      proc.on("error", (err) => {
        resolve({ ok: false, error: `无法启动 Python: ${err.message}` });
      });
    });
  }

  private async runOcrWithRetry(filePath: string): Promise<PythonResult> {
    const first = await this.runPython("ocr", filePath);
    if (first.ok || !shouldRetryOcr(first.error)) {
      return first;
    }

    const second = await this.runPython("ocr", filePath);
    if (second.ok) {
      return second;
    }

    return {
      ...second,
      error: second.error ?? first.error ?? "OCR 无法识别文字",
    };
  }
}

function detectMode(filePath: string): ProcessMode {
  const ext = path.extname(filePath).toLowerCase();
  if (OCR_EXTENSIONS.has(ext)) return "ocr";
  if (MARKITDOWN_EXTENSIONS.has(ext)) return "markitdown";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function readTextFile(filePath: string, mimeType: string): PreprocessResult {
  try {
    for (const enc of ["utf-8", "gbk", "latin1"] as BufferEncoding[]) {
      const text = fs.readFileSync(filePath, enc);
      if (text.trim()) {
        const truncated = text.length > 50_000;
        return {
          extractedText: text.slice(0, 50_000),
          mimeType,
          error: null,
          truncated,
        };
      }
    }
    return { extractedText: null, mimeType, error: "无法解码文件编码" };
  } catch (err) {
    return { extractedText: null, mimeType, error: `读取失败: ${(err as Error).message}` };
  }
}

function findPythonPath(appRoot: string, dataDir?: string): string | undefined {
  if (process.env.WECHAT_CLAUDE_PYTHON) {
    return path.resolve(process.env.WECHAT_CLAUDE_PYTHON);
  }

  const candidates = [
    path.join(appRoot, ".venv", "Scripts", "python.exe"),
    path.join(appRoot, "python", "python.exe"),
    dataDir ? path.join(dataDir, ".venv", "Scripts", "python.exe") : "",
    path.join(process.cwd(), ".venv", "Scripts", "python.exe"),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ?? "python";
}

function findPreprocessScript(appRoot: string): string | undefined {
  if (process.env.WECHAT_CLAUDE_PREPROCESS_SCRIPT) {
    return path.resolve(process.env.WECHAT_CLAUDE_PREPROCESS_SCRIPT);
  }

  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  const candidates = [
    path.join(appRoot, "scripts", "preprocess.py"),
    resourcesPath ? path.join(resourcesPath, "scripts", "preprocess.py") : "",
    path.join(process.cwd(), "scripts", "preprocess.py"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function parsePythonJson(stdout: string): PythonResult | null {
  const lines = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line) as PythonResult;
    } catch {
      // Keep scanning; third-party tools can print noise before JSON.
    }
  }
  return null;
}

function firstUsefulLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ")
    .slice(0, 300);
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldRetryOcr(error?: string): boolean {
  if (!error) return false;
  return error.includes("OCR") || error.includes("超时") || error.includes("timeout");
}
