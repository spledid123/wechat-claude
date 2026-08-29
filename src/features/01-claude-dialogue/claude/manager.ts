/**
 * ClaudeManager — multiplexes ClaudeSession instances with concurrency control.
 *
 * Ensures only `maxConcurrent` sessions are actively querying the AI at once.
 * Additional requests queue up and are served in FIFO order.
 */

import { ClaudeSession } from "./session.js";
import type { SessionSpec, PromptContext, ClaudeQueryResult, UserMessageContent } from "./types.js";
import {
  buildSystemPromptAppend,
  buildUserMessage,
  buildUserBlocksMessage,
} from "../prompt-builder.js";

export interface AgentQueryRecord {
  startedAt: string;
  durationMs: number;
  sessionId: string;
  model: string | undefined;
  turnCount: number;
  ok: boolean;
  error: string | null;
}

export interface AgentStatusSnapshot {
  maxConcurrent: number;
  busyCount: number;
  queueDepth: number;
  sessions: Array<{
    sessionId: string;
    model: string | undefined;
    isProcessing: boolean;
    lastQueryAt: string | null;
    lastTurnCount: number | null;
  }>;
  recent: AgentQueryRecord[];
}

export class ClaudeManager {
  private sessions = new Map<string, ClaudeSession>();
  private semaphore: number;
  private activeCount = 0;
  private queue: Array<() => void> = [];
  private readonly recentQueries: AgentQueryRecord[] = [];

  constructor(maxConcurrent = 1) {
    this.semaphore = maxConcurrent;
  }

  /** Get an existing session or create a new one. */
  getOrCreateSession(spec: SessionSpec): ClaudeSession {
    const existing = this.sessions.get(spec.sessionId);
    if (existing) {
      // The model is a per-query attribute. When the runtime config switches
      // models, replace the cached session so the next query picks it up.
      // Sessions are lightweight wrappers — conversation context comes from
      // the DB history injection, so recreation loses nothing.
      if ((spec.model ?? undefined) === existing.getModel()) return existing;
      existing.cancel();
      this.sessions.delete(spec.sessionId);
    }

    const session = new ClaudeSession({
      sessionId: spec.sessionId,
      cwd: spec.cwd,
      model: spec.model,
      maxTurns: spec.maxTurns,
      permissionMode: spec.permissionMode,
      allowedTools: spec.allowedTools,
      canUseTool: spec.canUseTool,
      sandbox: spec.sandbox,
      settings: spec.settings,
    });

    this.sessions.set(spec.sessionId, session);
    return session;
  }

  /**
   * Full pipeline:
   *   1. Build system prompt + user message from context
   *   2. Acquire concurrency slot
   *   3. Run Claude query
   *   4. Release slot
   */
  async processMessage(
    spec: SessionSpec,
    ctx: PromptContext,
    mcpServers?: Record<string, unknown>,
  ): Promise<ClaudeQueryResult> {
    const session = this.getOrCreateSession(spec);

    const systemAppend = buildSystemPromptAppend(ctx);
    const userMessage: UserMessageContent = (ctx.images?.length ?? 0) > 0
      ? buildUserBlocksMessage(ctx)
      : buildUserMessage(ctx);

    const startedAt = new Date();
    await this.acquire();
    try {
      const result = await session.querySimple(userMessage, systemAppend, mcpServers);
      this.recordQuery(startedAt, session, result.turnCount, null);
      return result;
    } catch (err) {
      this.recordQuery(startedAt, session, null, (err as Error).message);
      throw err;
    } finally {
      this.release();
    }
  }

  /** Live status for the admin panel (safe to call at any time). */
  snapshot(): AgentStatusSnapshot {
    return {
      maxConcurrent: this.semaphore,
      busyCount: this.activeCount,
      queueDepth: this.queue.length,
      sessions: Array.from(this.sessions.values()).map((session) => ({
        sessionId: session.sessionId,
        model: session.getModel(),
        isProcessing: session.getIsProcessing(),
        lastQueryAt: session.getLastQueryAt(),
        lastTurnCount: session.getLastResult()?.turnCount ?? null,
      })),
      recent: [...this.recentQueries],
    };
  }

  private recordQuery(
    startedAt: Date,
    session: ClaudeSession,
    turnCount: number | null,
    error: string | null,
  ): void {
    this.recentQueries.unshift({
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      sessionId: session.sessionId,
      model: session.getModel(),
      turnCount: turnCount ?? 0,
      ok: error === null,
      error: error ? error.slice(0, 200) : null,
    });
    if (this.recentQueries.length > 20) {
      this.recentQueries.length = 20;
    }
  }

  /** Cancel an in-flight query for a session. */
  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.cancel();
  }

  /** Remove a session from the manager. */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cancel();
      this.sessions.delete(sessionId);
    }
  }

  getSessionStatus(sessionId: string): {
    exists: boolean;
    isProcessing: boolean;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) return { exists: false, isProcessing: false };
    return { exists: true, isProcessing: session.getIsProcessing() };
  }

  /** Cancel all sessions and clear state. */
  shutdown(): void {
    for (const [, session] of this.sessions) {
      session.cancel();
    }
    this.sessions.clear();
    this.queue = [];
    this.activeCount = 0;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  // ---- private ----

  private async acquire(): Promise<void> {
    if (this.activeCount < this.semaphore) {
      this.activeCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) {
      this.activeCount++;
      next();
    }
  }
}
