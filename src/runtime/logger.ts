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

export function createRuntimeLogger(logsDir: string, name = "service"): RuntimeLogger {
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${name}.log`);

  const write = (level: LogLevel, message: string, err?: unknown) => {
    const line = [
      new Date().toISOString(),
      level.toUpperCase().padEnd(5, " "),
      message,
      err ? formatError(err) : "",
    ].filter(Boolean).join(" ");
    fs.appendFileSync(logFile, `${line}\n`, "utf-8");

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

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}
