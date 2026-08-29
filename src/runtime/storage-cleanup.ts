/**
 * Startup storage cleanup — bounded retention for orchestration audit rows,
 * conversation history, and closed-session workspaces. Without this the data
 * dir grows forever (turns rows with raw payloads, empty workspace shells,
 * closed-session files).
 *
 * message_text_index is NEVER pruned: cross-session quote lookup depends on
 * it keeping every successfully parsed message.
 *
 * Controlled by WECHAT_CLAUDE_RETENTION_DAYS (default 30; 0 disables cleanup).
 */

import fs from "node:fs";
import path from "node:path";
import { getDb, queryAll } from "../features/01-claude-dialogue/db/connection.js";
import { getRootLogger } from "./logger.js";

/** Audit rows are worthless quickly; prune them faster than conversations. */
const TURNS_RETENTION_DAYS = 7;

export interface CleanupResult {
  turnsDeleted: number;
  closedSessionsDeleted: number;
  workspacesRemoved: number;
}

export function runStartupStorageCleanup(workspaceBase: string): CleanupResult {
  const result: CleanupResult = {
    turnsDeleted: 0,
    closedSessionsDeleted: 0,
    workspacesRemoved: 0,
  };

  const retentionDays = readRetentionDays();
  if (retentionDays <= 0) return result;

  try {
    const db = getDb();

    // 1. Orchestration audit rows (any session, incl. active).
    const turnsCutoff = isoDaysAgo(Math.min(TURNS_RETENTION_DAYS, retentionDays));
    db.run("DELETE FROM turns WHERE created_at < ?", [turnsCutoff]);
    result.turnsDeleted = db.getRowsModified();

    // 2. Closed sessions past retention: drop rows and their workspace dirs.
    //    The dir is derived from the session id — the stored cwd may be stale
    //    if the whole data dir was relocated.
    const sessionCutoff = isoDaysAgo(retentionDays);
    const expired = queryAll<{ id: string }>(
      `SELECT id AS id FROM sessions
       WHERE status = 'closed'
         AND closed_at IS NOT NULL AND closed_at < ?`,
      [sessionCutoff],
    );
    for (const row of expired) {
      const sessionId = row.id;
      db.run("DELETE FROM conversations WHERE session_id = ?", [sessionId]);
      db.run("DELETE FROM turns WHERE session_id = ?", [sessionId]);
      db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
      result.closedSessionsDeleted++;
      const dir = path.join(workspaceBase, `session-${sessionId.slice(0, 8)}`);
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          result.workspacesRemoved++;
        } catch {
          // directory locked (agent still running?) — retry on next start.
        }
      }
    }

    // 3. Orphan workspace dirs (no DB session anymore) past retention.
    try {
      if (fs.existsSync(workspaceBase)) {
        const known = new Set(
          queryAll<{ id: string }>("SELECT id FROM sessions")
            .map((row) => `session-${row.id.slice(0, 8)}`.toLowerCase()),
        );
        const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        for (const entry of fs.readdirSync(workspaceBase, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
          if (known.has(entry.name.toLowerCase())) continue;
          const full = path.join(workspaceBase, entry.name);
          try {
            if (fs.statSync(full).mtimeMs < cutoffMs) {
              fs.rmSync(full, { recursive: true, force: true });
              result.workspacesRemoved++;
            }
          } catch {
            // unreadable entry — skip
          }
        }
      }
    } catch {
      // orphan sweep is best-effort
    }
  } catch (err) {
    getRootLogger().warn(`storage cleanup failed (non-fatal): ${(err as Error).message}`);
  }

  return result;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function readRetentionDays(): number {
  const raw = process.env.WECHAT_CLAUDE_RETENTION_DAYS;
  if (!raw) return 30;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
}
