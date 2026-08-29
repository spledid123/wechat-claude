import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  error(message: string, err: unknown): void;
  getLogFile(): string;
}

const FALLBACK_LOGGER: RuntimeLogger = {
  debug: (m) => console.log(m),
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m: string, err?: unknown) =>
    console.error(err !== undefined ? `${m} ${formatError(err)}` : m),
  getLogFile: () => "",
};

let rootLogger: RuntimeLogger | null = null;

/**
 * Process-wide default logger. Feature modules that historically used
 * console.* call this; until the service sets a real logger they fall back
 * to the console.
 */
export function getRootLogger(): RuntimeLogger {
  return rootLogger ?? FALLBACK_LOGGER;
}

/** Called once by the service after it creates the file logger. */
export function setRootLogger(logger: RuntimeLogger): void {
  rootLogger = logger;
}

let diagnosticsDir: string | null = null;

/**
 * Where opt-in diagnostic dumps (SDK events, permission decisions) go.
 * Falls back to ./.tmp until the service points it at the data dir.
 */
export function setDiagnosticsDir(dir: string): void {
  diagnosticsDir = dir;
}

export function getDiagnosticsFile(fileName: string): string {
  return path.join(diagnosticsDir ?? path.join(process.cwd(), ".tmp"), fileName);
}

export function createRuntimeLogger(
  logsDir: string,
  name = "service",
  options: { maxFileMb?: number } = {},
): RuntimeLogger {
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${name}.log`);
  const maxBytes = (options.maxFileMb ?? readMaxMbEnv()) * 1024 * 1024;
  let bytesSinceCheck = 0;
  let checkedOnce = false;

  const maybeRotate = () => {
    // stat on every line is wasteful; check on first write and then once we
    // have written at least maxBytes since the last check.
    if (checkedOnce && bytesSinceCheck < maxBytes) return;
    checkedOnce = true;
    bytesSinceCheck = 0;
    try {
      const stats = fs.statSync(logFile);
      if (stats.size < maxBytes) return;
      const previous = `${logFile}.1`;
      try {
        if (fs.existsSync(previous)) fs.rmSync(previous);
        fs.renameSync(logFile, previous);
      } catch {
        // rename failure (file locked?) — keep appending; next check retries.
      }
    } catch {
      // no file yet — nothing to rotate.
    }
  };

  const write = (level: LogLevel, message: string, err?: unknown) => {
    const line = [
      new Date().toISOString(),
      level.toUpperCase().padEnd(5, " "),
      message,
      err ? formatError(err) : "",
    ].filter(Boolean).join(" ");
    maybeRotate();
    fs.appendFileSync(logFile, `${line}\n`, "utf-8");
    bytesSinceCheck += line.length;

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message, err?: unknown) => write("error", message, err),
    getLogFile: () => logFile,
  };
}

function readMaxMbEnv(): number {
  const raw = process.env.WECHAT_CLAUDE_LOG_MAX_MB;
  if (!raw) return 5;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}
