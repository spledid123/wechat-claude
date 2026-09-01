/**
 * SessionManager — manages the lifecycle of chat sessions in SQLite.
 *
 * Each session has:
 *  - A DB row (sessions table)
 *  - A workspace directory on disk (incoming/working/output)
 *
 * Sessions auto-close after a configurable timeout of inactivity.
 */

import { getDb, queryOne, queryAll } from "../db/connection.js";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

export interface SessionRecord {
  id: string;
  userId: number;
  fromUserId: string;
  contextToken: string | null;
  claudeSessionId: string | null;
  cwd: string;
  status: "active" | "closed";
  summary: string | null;
  toolMode: string;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
}

export class SessionManager {
  private readonly workspaceBase: string;
  private readonly sessionTimeoutMinutes: number;
  private readonly appRoot: string;

  constructor(workspaceBase: string, sessionTimeoutMinutes = 60, appRoot?: string) {
    this.workspaceBase = workspaceBase;
    this.sessionTimeoutMinutes = sessionTimeoutMinutes;
    this.appRoot = path.resolve(appRoot ?? process.cwd());
  }

  // ==================== session lifecycle ====================

  /**
   * Find the current active session, or create a new one.
   * If the active session has timed out, close it first.
   */
  resolveSession(fromUserId: string): SessionRecord {
    const activeSession = this.findActiveSession();
    if (activeSession) {
      const elapsed = this.elapsedMinutes(activeSession.lastActiveAt);
      if (elapsed < this.sessionTimeoutMinutes) {
        return this.ensureWorkspace(activeSession);
      }
      // Timed out — close it
      this.closeSession(activeSession.id, "timeout");
    }
    return this.createSession(fromUserId);
  }

  /**
   * The data dir can move (portable exe, folder relocation) — stored cwd
   * values go stale and would scatter files to the old location. Remap the
   * session onto the current workspace base and recreate its directories.
   */
  private ensureWorkspace(session: SessionRecord): SessionRecord {
    const dirName = session.cwd
      ? path.basename(session.cwd)
      : `session-${session.id.slice(0, 8)}`;
    const expected = path.join(this.workspaceBase, dirName);
    const stale = !session.cwd
      || path.resolve(session.cwd).toLowerCase() !== path.resolve(expected).toLowerCase();
    if (stale) {
      this.createWorkspaceDirs(expected);
      getDb().run("UPDATE sessions SET cwd = ? WHERE id = ?", [expected, session.id]);
      session.cwd = expected;
    } else {
      this.createWorkspaceDirs(session.cwd);
    }
    return session;
  }

  private createWorkspaceDirs(workspaceDir: string): void {
    for (const subdir of [
      "incoming",
      "working",
      path.join("working", "output_weixin"),
      "output",
    ]) {
      fs.mkdirSync(path.join(workspaceDir, subdir), { recursive: true });
    }
    this.seedWorkspaceAssets(workspaceDir);
  }

  /**
   * Copy the bundled agent-side assets into the workspace:
   *   skills/  — document-generation reference skills (plain files, read via Read)
   *   tools/   — preprocess.py, so the agent can render more scanned-PDF pages
   *              itself (the permission layer only runs workspace-local scripts).
   * Idempotent: skips anything already present, so existing sessions are cheap.
   */
  private seedWorkspaceAssets(workspaceDir: string): void {
    const skillsDest = path.join(workspaceDir, "skills");
    if (!fs.existsSync(skillsDest)) {
      const skillsSrc = this.findBundledAsset("skills");
      if (skillsSrc) {
        try {
          fs.cpSync(skillsSrc, skillsDest, { recursive: true });
        } catch {
          /* skills are optional — a failed copy must not break the session */
        }
      }
    }

    const toolDest = path.join(workspaceDir, "tools", "preprocess.py");
    if (!fs.existsSync(toolDest)) {
      const scriptSrc = this.findBundledAsset(path.join("scripts", "preprocess.py"));
      if (scriptSrc) {
        try {
          fs.mkdirSync(path.dirname(toolDest), { recursive: true });
          fs.copyFileSync(scriptSrc, toolDest);
        } catch {
          /* continuation reads degrade, but core preprocessing is unaffected */
        }
      }
    }
  }

  /** Repo layout in dev, resourcesPath layout in a packaged exe. */
  private findBundledAsset(relative: string): string | undefined {
    const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
    const candidates = [
      path.join(this.appRoot, relative),
      resourcesPath ? path.join(resourcesPath, relative) : "",
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  /** Create a new session + workspace directories. */
  createSession(fromUserId: string): SessionRecord {
    const db = getDb();

    // Upsert user
    let userRow = queryOne<{ id: number }>(
      "SELECT id FROM users WHERE wechat_user_id = ?",
      [fromUserId],
    );
    if (!userRow) {
      db.run("INSERT INTO users (wechat_user_id) VALUES (?)", [fromUserId]);
      const lastId = db.exec("SELECT last_insert_rowid()");
      const uid =
        lastId.length > 0 && lastId[0].values && lastId[0].values.length > 0
          ? (lastId[0].values[0][0] as number)
          : 1;
      userRow = { id: uid };
    }

    const sessionId = crypto.randomUUID();
    const workspaceDir = path.join(
      this.workspaceBase,
      `session-${sessionId.slice(0, 8)}`,
    );

    this.createWorkspaceDirs(workspaceDir);

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO sessions (id, user_id, from_user_id, cwd, status, created_at, last_active_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [sessionId, userRow.id, fromUserId, workspaceDir, now, now],
    );

    return {
      id: sessionId,
      userId: userRow.id,
      fromUserId,
      contextToken: null,
      claudeSessionId: null,
      cwd: workspaceDir,
      status: "active",
      summary: null,
      toolMode: "safe_restricted",
      messageCount: 0,
      lastActiveAt: now,
      createdAt: now,
    };
  }

  /** Mark a session as closed. */
  closeSession(sessionId: string, reason: string): void {
    getDb().run(
      `UPDATE sessions
       SET status = 'closed', closed_reason = ?, closed_at = ?
       WHERE id = ?`,
      [reason, new Date().toISOString(), sessionId],
    );
  }

  /** Delete a session and all related data + workspace directory. */
  deleteSession(sessionId: string): boolean {
    const db = getDb();
    const existing = queryOne<{ id: string; cwd: string }>(
      "SELECT id, cwd FROM sessions WHERE id = ?",
      [sessionId],
    );
    if (!existing) return false;

    // Cascade: conversations first (FK to sessions), then sessions
    db.run("DELETE FROM conversations WHERE session_id = ?", [sessionId]);
    db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);

    // Remove workspace from disk
    if (existing.cwd && fs.existsSync(existing.cwd)) {
      try {
        fs.rmSync(existing.cwd, { recursive: true, force: true });
      } catch {
        /* directory may be locked — non-fatal */
      }
    }

    return true;
  }

  // ==================== field updates ====================

  updateContextToken(sessionId: string, token: string): void {
    getDb().run(
      "UPDATE sessions SET context_token = ?, last_active_at = ? WHERE id = ?",
      [token, new Date().toISOString(), sessionId],
    );
  }

  getContextToken(sessionId: string): string {
    const row = queryOne<{ context_token: string | null }>(
      "SELECT context_token FROM sessions WHERE id = ?",
      [sessionId],
    );
    return row?.context_token ?? "";
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    getDb().run("UPDATE sessions SET claude_session_id = ? WHERE id = ?", [
      claudeSessionId,
      sessionId,
    ]);
  }

  incrementMessageCount(sessionId: string): void {
    getDb().run(
      "UPDATE sessions SET message_count = message_count + 1, last_active_at = ? WHERE id = ?",
      [new Date().toISOString(), sessionId],
    );
  }

  saveSummary(sessionId: string, summary: string): void {
    getDb().run("UPDATE sessions SET summary = ? WHERE id = ?", [
      summary,
      sessionId,
    ]);
  }

  getSummary(sessionId: string): string | null {
    const row = queryOne<{ summary: string | null }>(
      "SELECT summary FROM sessions WHERE id = ?",
      [sessionId],
    );
    return row?.summary ?? null;
  }

  getLastClosedSessionSummary(): string | null {
    const row = queryOne<{ summary: string | null }>(
      `SELECT summary FROM sessions
       WHERE status = 'closed' AND summary IS NOT NULL
       ORDER BY closed_at DESC LIMIT 1`,
    );
    return row?.summary ?? null;
  }

  // ==================== queries ====================

  getActiveSession(): SessionRecord | null {
    return this.findActiveSession();
  }

  listActiveSessions(): Array<{
    id: string;
    fromUserId: string;
    status: string;
    messageCount: number;
    lastActiveAt: string;
  }> {
    return queryAll(
      `SELECT id, from_user_id AS fromUserId, status,
              message_count AS messageCount, last_active_at AS lastActiveAt
       FROM sessions
       WHERE status = 'active'
       ORDER BY last_active_at DESC
       LIMIT 50`,
    );
  }

  listAllSessions(limit = 50): Array<{
    id: string;
    fromUserId: string;
    status: string;
    messageCount: number;
    lastActiveAt: string;
    summary: string | null;
  }> {
    return queryAll(
      `SELECT id, from_user_id AS fromUserId, status,
              message_count AS messageCount, last_active_at AS lastActiveAt,
              summary
       FROM sessions
       ORDER BY last_active_at DESC
       LIMIT ?`,
      [limit],
    );
  }

  // ==================== private ====================

  private findActiveSession(): SessionRecord | null {
    const row = queryOne<Record<string, unknown>>(
      `SELECT * FROM sessions
       WHERE status = 'active'
       ORDER BY last_active_at DESC LIMIT 1`,
    );
    return row ? this.mapRow(row) : null;
  }

  private elapsedMinutes(isoTimestamp: string): number {
    const then = new Date(isoTimestamp).getTime();
    const now = Date.now();
    return (now - then) / 60_000;
  }

  private mapRow(row: Record<string, unknown>): SessionRecord {
    return {
      id: row.id as string,
      userId: row.user_id as number,
      fromUserId: row.from_user_id as string,
      contextToken: (row.context_token as string) ?? null,
      claudeSessionId: (row.claude_session_id as string) ?? null,
      cwd: row.cwd as string,
      status: row.status as "active" | "closed",
      summary: (row.summary as string) ?? null,
      toolMode: (row.tool_mode as string) ?? "safe_restricted",
      messageCount: (row.message_count as number) ?? 0,
      lastActiveAt: row.last_active_at as string,
      createdAt: row.created_at as string,
    };
  }
}
