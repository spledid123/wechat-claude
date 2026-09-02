/**
 * Live agent-processing events for the admin panel's real-time view.
 *
 * session.ts already receives every SDK message (includePartialMessages is
 * on); this module is just a small sanitized ring buffer it can push into.
 * The admin panel pulls increments via GET /api/agent-events?since=<seq>.
 *
 * Write failures are swallowed by the callers — the buffer is observability
 * only and must never affect the message pipeline.
 */

export type AgentEventType =
  | "query_start"
  | "assistant_text"
  | "assistant_thinking"
  | "tool_use"
  | "tool_result"
  | "result"
  | "query_end"
  /** Bridge-level events: WeChat traffic and file preprocessing. */
  | "msg_in"
  | "file_done"
  | "msg_out"
  | "file_out";

export interface AgentEvent {
  seq: number;
  time: string;
  sessionId: string;
  type: AgentEventType;
  detail: string;
  data?: Record<string, unknown>;
}

const MAX_EVENTS = 500;
const MAX_DETAIL_CHARS = 2_000;

const events: AgentEvent[] = [];
let seqCounter = 0;

export function recordAgentEvent(
  sessionId: string,
  type: AgentEventType,
  detail: string,
  data?: Record<string, unknown>,
): void {
  try {
    events.push({
      seq: ++seqCounter,
      time: new Date().toISOString(),
      sessionId,
      type,
      detail: truncateText(detail),
      data: data ? sanitizeValue(data, 0) as Record<string, unknown> : undefined,
    });
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
  } catch {
    // Observability only — never throw into the query loop.
  }
}

/** Events with seq > sinceSeq, newest last; optionally filtered by session. */
export function drainAgentEvents(sinceSeq: number, sessionId?: string): { events: AgentEvent[]; lastSeq: number } {
  const filtered = events.filter(
    (event) => event.seq > sinceSeq && (!sessionId || event.sessionId === sessionId),
  );
  return { events: filtered, lastSeq: seqCounter };
}

export function latestAgentEventSeq(): number {
  return seqCounter;
}

function truncateText(value: string): string {
  return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…<截断>` : value;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return truncateText(value);
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (depth >= 4) {
    return "<max-depth>";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    result[key] = sanitizeValue(child, depth + 1);
  }
  return result;
}
