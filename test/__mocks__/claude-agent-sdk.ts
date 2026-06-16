// Mock for @anthropic-ai/claude-agent-sdk
// Prevents real API calls during tests.

export interface QueryOptions {
  model?: string;
  cwd?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: (
    toolName: string,
    args: Record<string, unknown>,
    ctx?: unknown,
  ) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
  systemPrompt?: { type: "preset"; preset: string; append?: string };
  maxTurns?: number;
  includePartialMessages?: boolean;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  settingSources?: string[];
  settings?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
}

let lastQueryOptions: QueryOptions | undefined;

export async function query(
  opts: unknown,
): Promise<AsyncIterable<{ type: string; result?: string }>> {
  lastQueryOptions = (opts as { options?: QueryOptions }).options;

  async function* gen() {
    // Simulate a single assistant turn then a result
    yield { type: "assistant" };
    yield { type: "result", result: "mock response" };
  }
  return gen();
}

export function getLastQueryOptions(): QueryOptions | undefined {
  return lastQueryOptions;
}

export function tool(
  _name: string,
  _desc: string,
  _schema: unknown,
  _fn: unknown,
): unknown {
  return { name: _name, description: _desc, schema: _schema, fn: _fn };
}

export function createSdkMcpServer(config: unknown): unknown {
  return config;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export type CanUseTool = (
  toolName: string,
  args: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
