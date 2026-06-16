/**
 * FilePreprocessor — routes files to the right Python processor
 * and returns extracted text or error info for PromptContext.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// --------------- types ---------------

export interface PreprocessResult {
  /** Extracted text (null if failed). */
  extractedText: string | null;
  /** MIME type guess from extension. */
  mimeType: string;
  /** Error description (null if success). */
  error: string | null;
  /** Was the text truncated? */
  truncated?: boolean;
}

type ProcessMode = "ocr" | "markitdown" | "text" | "unsupported";

// --------------- routing ---------------

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

// --------------- Python bridge ---------------

const VENV_PYTHON = path.join(process.cwd(), ".venv", "Scripts", "python.exe");
const PREPROCESS_SCRIPT = path.join(process.cwd(), "scripts", "preprocess.py");

interface PythonResult {
  ok: boolean;
  text?: string;
  error?: string;
  truncated?: boolean;
}

function runPython(mode: ProcessMode, filePath: string, timeoutMs = 60_000): Promise<PythonResult> {
  return new Promise((resolve) => {
    // Check if venv exists
    if (!fs.existsSync(VENV_PYTHON)) {
      resolve({ ok: false, error: "工具未安装: Python venv 不存在" });
      return;
    }

    const proc = spawn(VENV_PYTHON, [
      PREPROCESS_SCRIPT,
      "--mode", mode,
      "--file", filePath,
    ], {
      timeout: timeoutMs,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      // Python may exit non-zero or have stderr warnings but still produce valid JSON on stdout.
      // Only treat as failure if stdout is empty or unparseable.
      if (stdout.trim()) {
        try {
          resolve(JSON.parse(stdout.trim()) as PythonResult);
        } catch {
          resolve({ ok: false, error: `Python 输出解析失败: ${stdout.slice(0, 200)}` });
        }
      } else {
        resolve({
          ok: false,
          error: code === null
            ? `预处理超时 (${timeoutMs / 1000}s)`
            : `预处理失败 (exit=${code}): ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({ ok: false, error: `无法启动 Python: ${err.message}` });
    });
  });
}

// --------------- public API ---------------

export class FilePreprocessor {
  /**
   * Process a single file. Detects type, runs Python tool, returns result.
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
      // Read directly — no Python needed
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

    // OCR or markitdown → Python
    const result = await runPython(mode, filePath);

    return {
      extractedText: result.ok ? (result.text ?? null) : null,
      mimeType,
      error: result.ok ? null : (result.error ?? "未知错误"),
      truncated: result.truncated,
    };
  }

  /**
   * Process multiple files in parallel.
   */
  async processAll(filePaths: string[]): Promise<PreprocessResult[]> {
    return Promise.all(filePaths.map((fp) => this.process(fp)));
  }
}
