import fs from "node:fs";
import path from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { getDiagnosticsFile } from "../../../runtime/logger.js";

export interface ClaudePermissionPolicy {
  mode: "default";
  allowedTools: string[];
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    ctx?: unknown,
  ) => Promise<ClaudePermissionResult>;
}

export type ClaudePermissionResult = PermissionResult;

const ALWAYS_DENY_TOOLS = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "Task",
  "Agent",
  "EnterWorktree",
  "ExitWorktree",
]);

/** In-process bridge MCP tools — handler-side effects are workspace-confined. */
const BRIDGE_MCP_TOOLS = [
  "mcp__bridge__extract_document",
  "mcp__bridge__render_pdf_pages",
  "mcp__bridge__read_scanned_pdf",
  "mcp__bridge__transcribe_image",
  "mcp__bridge__extract_pdf_images",
];

const ALWAYS_ALLOW_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "TaskOutput",
  "TaskGet",
  "TaskList",
  "ListMcpResources",
  "ReadMcpResource",
  "Mcp",
  ...BRIDGE_MCP_TOOLS,
]);

const WRITE_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

const PREAPPROVED_TOOLS = [
  ...ALWAYS_ALLOW_TOOLS,
];

const BASH_ALWAYS_DENY_PATTERNS = [
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\b/,
  /\bmkfs\b/,
  /\bformat\b/,
];

const BASH_WRITE_INTENT_PATTERNS = [
  /(?:^|[^=>&])(?:\d*)>{1,2}(?![=>&])/,
  /\b(?:out-file|set-content|add-content|copy-item|move-item|new-item|rename-item|remove-item)\b/,
  /\b(?:copy|move|mkdir|md|touch|tee|rm|del|erase|rmdir|rd)\b/,
  /\b(?:curl|wget|invoke-webrequest|iwr)\b.*(?:\s-o\s|\s-outfile\s|--output(?:-document)?\b)/,
  /\bopen\s*\([^)]*,\s*["'][wax+]/,
  /\bpath\s*\([^)]+\)\s*\.\s*(?:write_text|write_bytes)\s*\(/,
  /\b(?:writefile|writefilesync|appendfile|appendfilesync|createwritestream|mkdirsync)\b/,
  /\b(?:write_text|write_bytes|savefig|imwrite|tofile|urlretrieve)\b/,
];

const BASH_PATH_OPTION_PATTERN =
  /\b(?:path|literalpath|destination|filepath|file_path|outfile|output)\s+([^\s"'|&;<>]+)/gi;

export function createClaudePermissionPolicy(cwd: string): ClaudePermissionPolicy {
  const workspaceRoot = normalizePath(cwd);

  return {
    mode: "default",
    allowedTools: PREAPPROVED_TOOLS,
    async canUseTool(toolName, input) {
      let result: ClaudePermissionResult;
      try {
        if (ALWAYS_DENY_TOOLS.has(toolName)) {
          result = deny("This permission mode does not allow extra user interaction.");
        } else if (ALWAYS_ALLOW_TOOLS.has(toolName)) {
          result = allow();
        } else if (WRITE_TOOLS.has(toolName)) {
          const paths = extractPaths(toolName, input, workspaceRoot);
          if (paths.length === 0) {
            result = deny("Cannot confirm the write target path.");
          } else {
            result = paths.every((candidate) => isWithinWorkspace(candidate, workspaceRoot))
              ? allow()
              : deny("Writes are only allowed inside the current session workspace.");
          }
        } else if (toolName === "Bash") {
          const command = typeof input.command === "string" ? input.command : "";
          if (input.dangerouslyDisableSandbox === true) {
            result = deny("Disabling the command sandbox is not allowed.");
          } else {
            result = evaluateBashCommand(command, workspaceRoot);
          }
        } else {
          result = deny(`Tool is not allowed in this permission mode: ${toolName}.`);
        }
      } catch (err) {
        result = deny(`Permission check failed: ${(err as Error).message}`);
      }

      const sdkResult = withSdkAllowInput(result, input);
      logPermissionDecision(toolName, input, workspaceRoot, sdkResult);
      return sdkResult;
    },
  };
}

export function extractPaths(
  toolName: string,
  input: Record<string, unknown>,
  baseDir = process.cwd(),
): string[] {
  const values: string[] = [];

  if (toolName === "Read" || toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    pushString(values, input.file_path);
    pushString(values, input.filePath);
    pushString(values, input.notebook_path);
    pushString(values, input.path);
  }

  if (toolName === "MultiEdit") {
    pushString(values, input.file_path);
    pushString(values, input.filePath);
  }

  if (toolName === "Glob" || toolName === "Grep" || toolName === "LS") {
    pushString(values, input.path);
  }

  return values.map((value) => normalizePath(value, baseDir));
}

export function isWithinWorkspace(candidatePath: string, workspaceRoot: string): boolean {
  const candidate = normalizePath(candidatePath, workspaceRoot);
  const root = normalizePath(workspaceRoot, workspaceRoot);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function evaluateBashCommand(
  command: string,
  workspaceRoot: string,
): ClaudePermissionResult {
  const normalized = command.toLowerCase();

  if (!normalized.trim()) {
    return deny("Empty commands are not allowed.");
  }

  if (BASH_ALWAYS_DENY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return deny("This command contains a blocked destructive operation.");
  }

  const scriptDecision = evaluateRunnableScripts(command, workspaceRoot);
  if (scriptDecision) {
    return scriptDecision;
  }

  if (!hasBashWriteIntent(command)) {
    return allow();
  }

  const writeTargets = extractBashWriteTargets(command, workspaceRoot);
  if (writeTargets.length === 0) {
    return deny("Bash write commands must name a workspace-local target path.");
  }

  if (writeTargets.some((candidate) => !isWithinWorkspace(candidate, workspaceRoot))) {
    return deny("Bash write targets must stay inside the current session workspace.");
  }

  return allow();
}

export function hasBashWriteIntent(command: string): boolean {
  const normalized = command.toLowerCase();
  return BASH_WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function extractBashWriteTargets(command: string, workspaceRoot: string): string[] {
  const targets = new Set<string>();
  for (const value of collectCommandPathCandidates(command)) {
    const clean = stripTrailingPunctuation(value);
    if (looksLikePath(clean)) {
      targets.add(normalizePath(clean, workspaceRoot));
    }
  }

  for (const value of collectRedirectionTargets(command)) {
    const clean = stripTrailingPunctuation(value);
    if (clean) {
      targets.add(normalizePath(clean, workspaceRoot));
    }
  }
  for (const value of collectPythonPathWriteTargets(command)) {
    const clean = stripTrailingPunctuation(value);
    if (clean) {
      targets.add(normalizePath(clean, workspaceRoot));
    }
  }
  for (const value of collectCodeWriteTargets(command)) {
    const clean = stripTrailingPunctuation(value);
    if (clean) {
      targets.add(normalizePath(clean, workspaceRoot));
    }
  }
  for (const value of collectShellWriteTargets(command)) {
    const clean = stripTrailingPunctuation(value);
    if (clean) {
      targets.add(normalizePath(clean, workspaceRoot));
    }
  }

  return [...targets];
}

export function evaluateScriptContent(
  content: string,
  scriptPath: string,
  workspaceRoot: string,
): ClaudePermissionResult {
  void scriptPath;

  if (!hasBashWriteIntent(content)) {
    return allow();
  }

  const writeTargets = extractBashWriteTargets(content, workspaceRoot);
  if (writeTargets.length === 0) {
    return deny("Runnable scripts with write operations must use explicit local target paths.");
  }

  if (writeTargets.some((candidate) => !isWithinWorkspace(candidate, workspaceRoot))) {
    return deny("Runnable scripts may not write outside the current session workspace.");
  }

  return allow();
}

function evaluateRunnableScripts(
  command: string,
  workspaceRoot: string,
): ClaudePermissionResult | null {
  for (const scriptPath of collectRunnableScriptPaths(command, workspaceRoot)) {
    if (!isWithinWorkspace(scriptPath, workspaceRoot)) {
      return deny("Runnable script files must stay inside the current session workspace.");
    }

    if (!fs.existsSync(scriptPath)) {
      continue;
    }

    const stat = fs.statSync(scriptPath);
    if (!stat.isFile() || stat.size > 2_000_000) {
      return deny("Runnable script files must be regular files under 2 MB.");
    }

    const result = evaluateScriptContent(
      fs.readFileSync(scriptPath, "utf8"),
      scriptPath,
      workspaceRoot,
    );
    if (result.behavior === "deny") {
      return result;
    }
  }

  return null;
}

function collectRunnableScriptPaths(command: string, workspaceRoot: string): string[] {
  const tokens = tokenizeCommand(command);
  const scripts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const executable = normalizeExecutableName(tokens[i]);

    if (["python", "python3", "py"].includes(executable)) {
      const script = findScriptArgument(tokens, i + 1, new Set(["-c", "-m"]));
      if (script) {
        scripts.push(normalizePath(script, workspaceRoot));
      }
      continue;
    }

    if (["node", "bun"].includes(executable)) {
      const script = findScriptArgument(tokens, i + 1, new Set(["-e", "--eval", "-p", "--print"]));
      if (script && script !== "run") {
        scripts.push(normalizePath(script, workspaceRoot));
      }
      continue;
    }

    if (executable === "deno") {
      const runIndex = tokens.slice(i + 1).findIndex((token) => token.toLowerCase() === "run");
      if (runIndex >= 0) {
        const script = findScriptArgument(tokens, i + runIndex + 2, new Set(["-e", "--eval"]));
        if (script) {
          scripts.push(normalizePath(script, workspaceRoot));
        }
      }
      continue;
    }

    if (["powershell", "pwsh"].includes(executable)) {
      const fileIndex = tokens.slice(i + 1).findIndex((token) => token.toLowerCase() === "-file");
      if (fileIndex >= 0) {
        const script = tokens[i + fileIndex + 2];
        if (script) {
          scripts.push(normalizePath(script, workspaceRoot));
        }
      }
    }
  }

  return scripts.filter((candidate) => /\.(?:py|js|mjs|cjs|ts|tsx|ps1)$/i.test(candidate));
}

function findScriptArgument(
  tokens: string[],
  startIndex: number,
  stopOptions: Set<string>,
): string | null {
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (stopOptions.has(lower)) {
      return null;
    }
    if (lower.startsWith("-")) {
      continue;
    }
    return token;
  }

  return null;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function normalizeExecutableName(value: string): string {
  const base = value.replace(/^.*[\\/]/, "");
  return base.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function collectCommandPathCandidates(command: string): string[] {
  const candidates: string[] = [];

  for (const match of command.matchAll(/"([^"]+)"/g)) {
    candidates.push(match[1]);
  }
  for (const match of command.matchAll(/'([^']+)'/g)) {
    candidates.push(match[1]);
  }
  for (const match of command.matchAll(/\b[A-Za-z]:\\[^\s"'|&;<>),]+/g)) {
    candidates.push(match[0]);
  }
  for (const match of command.matchAll(/(?:^|[\s=(])((?:\.{1,2}[\\/])?[A-Za-z0-9_.-]+(?:[\\/][^\s"'|&;<>),]+)+)/g)) {
    candidates.push(match[1]);
  }
  for (const match of command.matchAll(BASH_PATH_OPTION_PATTERN)) {
    candidates.push(match[1]);
  }

  return candidates;
}

function collectRedirectionTargets(command: string): string[] {
  const targets: string[] = [];

  for (const match of command.matchAll(/(?:^|[^=>&])>{1,2}(?![=>&])\s*([^\s"'|&;<>]+)/g)) {
    targets.push(match[1]);
  }
  for (const match of command.matchAll(/(?:^|[^=>&])>{1,2}(?![=>&])\s*"([^"]+)"/g)) {
    targets.push(match[1]);
  }
  for (const match of command.matchAll(/(?:^|[^=>&])>{1,2}(?![=>&])\s*'([^']+)'/g)) {
    targets.push(match[1]);
  }

  return targets;
}

function collectPythonPathWriteTargets(command: string): string[] {
  const targets: string[] = [];

  for (const match of command.matchAll(/\bpath\s*\(\s*"([^"]+)"\s*\)\s*\.\s*(?:write_text|write_bytes)\s*\(/gi)) {
    targets.push(match[1]);
  }
  for (const match of command.matchAll(/\bpath\s*\(\s*'([^']+)'\s*\)\s*\.\s*(?:write_text|write_bytes)\s*\(/gi)) {
    targets.push(match[1]);
  }

  return targets;
}

function collectCodeWriteTargets(command: string): string[] {
  const targets: string[] = [];

  for (const match of command.matchAll(/\bopen\s*\(\s*"([^"]+)"\s*,\s*["'][wax+]/gi)) {
    targets.push(match[1]);
  }
  for (const match of command.matchAll(/\bopen\s*\(\s*'([^']+)'\s*,\s*["'][wax+]/gi)) {
    targets.push(match[1]);
  }
  for (const match of command.matchAll(/\b(?:writefile|writefilesync|appendfile|appendfilesync|createwritestream)\s*\(\s*"([^"]+)"/gi)) {
    targets.push(match[1]);
  }
  for (const match of command.matchAll(/\b(?:writefile|writefilesync|appendfile|appendfilesync|createwritestream)\s*\(\s*'([^']+)'/gi)) {
    targets.push(match[1]);
  }

  return targets;
}

function collectShellWriteTargets(command: string): string[] {
  const tokens = tokenizeCommand(command);
  const targets: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].toLowerCase();

    if (["touch", "mkdir", "md", "tee"].includes(token)) {
      const target = findFirstPathArgument(tokens, i + 1);
      if (target) {
        targets.push(target);
      }
      continue;
    }

    if (["set-content", "add-content", "out-file", "new-item"].includes(token)) {
      const target = findOptionValue(tokens, i + 1, ["-path", "-literalpath", "-filepath"]);
      if (target) {
        targets.push(target);
      } else if (tokens[i + 1]) {
        targets.push(tokens[i + 1]);
      }
      continue;
    }

    if (["rm", "del", "erase", "rmdir", "rd", "remove-item"].includes(token)) {
      const target =
        findOptionValue(tokens, i + 1, ["-path", "-literalpath"])
        ?? findFirstPathArgument(tokens, i + 1);
      if (target) {
        targets.push(target);
      }
      continue;
    }

    if (["copy", "move", "copy-item", "move-item"].includes(token)) {
      const destination = findOptionValue(tokens, i + 1, ["-destination"]);
      if (destination) {
        targets.push(destination);
      } else if (tokens[i + 2]) {
        targets.push(tokens[i + 2]);
      }
      continue;
    }

    if (["curl", "wget", "invoke-webrequest", "iwr"].includes(token)) {
      const output = findOptionValue(tokens, i + 1, ["-o", "-outfile", "--output", "--output-document"]);
      if (output) {
        targets.push(output);
      }
    }
  }

  return targets;
}

function findOptionValue(
  tokens: string[],
  startIndex: number,
  options: string[],
): string | null {
  const optionSet = new Set(options);
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i].toLowerCase();
    if (optionSet.has(token) && tokens[i + 1]) {
      return tokens[i + 1];
    }
  }

  return null;
}

function findFirstPathArgument(tokens: string[], startIndex: number): string | null {
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i];
    if (isShellOptionToken(token)) {
      continue;
    }
    return token;
  }

  return null;
}

function isShellOptionToken(token: string): boolean {
  return (
    token.startsWith("-")
    || /^\/[A-Za-z?]+$/.test(token)
  );
}

function looksLikePath(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }

  return (
    /^[A-Za-z]:\\/.test(value)
    || value.startsWith("/")
    || value.startsWith("\\")
    || value.startsWith("./")
    || value.startsWith(".\\")
    || value.startsWith("../")
    || value.startsWith("..\\")
    || value.includes("/")
    || value.includes("\\")
  );
}

function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/[),.;]+$/g, "");
}

function pushString(target: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    target.push(value);
  }
}

function normalizePath(value: string, baseDir = process.cwd()): string {
  return path.resolve(baseDir, value).toLowerCase();
}

function allow(): ClaudePermissionResult {
  return { behavior: "allow" };
}

function withSdkAllowInput(
  result: ClaudePermissionResult,
  input: Record<string, unknown>,
): ClaudePermissionResult {
  if (result.behavior !== "allow") {
    return result;
  }

  return {
    ...result,
    updatedInput: result.updatedInput ?? input,
  };
}

function deny(message: string): ClaudePermissionResult {
  return { behavior: "deny", message, interrupt: false };
}

function logPermissionDecision(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
  result: ClaudePermissionResult,
): void {
  // Opt-in diagnostics dump; off unless CLAUDE_PERMISSION_LOG=1.
  if (process.env.CLAUDE_PERMISSION_LOG !== "1") {
    return;
  }

  try {
    const logPath = getDiagnosticsFile("claude-permissions.jsonl");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        time: new Date().toISOString(),
        workspaceRoot,
        toolName,
        input: toLoggableValue(input),
        result,
      })}\n`,
    );
  } catch {
    // Permission logging is diagnostic only; never block a user request on it.
  }
}

function toLoggableValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}...<truncated>` : value;
  }

  if (value == null || typeof value !== "object") {
    return value;
  }

  if (depth >= 4) {
    return "<max-depth>";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => toLoggableValue(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    result[key] = toLoggableValue(child, depth + 1);
  }
  return result;
}
