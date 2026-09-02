/**
 * ConversationManager — records and queries conversation messages.
 *
 * Each message belongs to a session, has a sequence number within
 * that session, and a direction (inbound = from user, outbound = from AI).
 */

import { getDb, queryAll, queryOne } from "../db/connection.js";

export interface ConversationRecord {
  sessionId: string;
  userId: number;
  direction: "inbound" | "outbound";
  messageType: number;
  textContent?: string;
  fileRefs?: string;
  contextToken?: string;
}

export interface MessageTextRecord {
  msgId: string;
  userId: number;
  sessionId?: string | null;
  fromUserId?: string | null;
  itemType?: string | null;
  fileName?: string | null;
  mediaKey?: string | null;
  textContent: string;
}

export class ConversationManager {
  /** Internal numeric user id for an external WeChat user id (null if unknown). */
  findUserIdByWechatId(wechatUserId: string): number | null {
    const row = queryOne<{ id: number }>(
      "SELECT id FROM users WHERE wechat_user_id = ?",
      [wechatUserId],
    );
    return row?.id ?? null;
  }

  /** The user's latest active session id, if any (used to tag index rows). */
  findActiveSessionIdForUser(userId: number): string | null {
    const row = queryOne<{ id: string }>(
      `SELECT id FROM sessions
       WHERE user_id = ? AND status = 'active'
       ORDER BY last_active_at DESC
       LIMIT 1`,
      [userId],
    );
    return row?.id ?? null;
  }

  /**
   * Closest conversation row (ANY direction) to the given server-side
   * timestamp. The send API returns no msg_id, so quotes of OUR OWN replies
   * and sent media cannot resolve by id; instead the quote carries the quoted
   * message's create_time_ms, which lands within seconds of the conversations
   * row (written just before the send / just after the receive). Window
   * [-30s, +10s] absorbs multi-bubble replies. The caller must classify the
   * matched row: a media row may not be returned as quoted TEXT.
   */
  findConversationRowNear(
    userId: number,
    epochMs: number,
  ): {
    direction: "inbound" | "outbound";
    messageType: number;
    textContent: string | null;
    fileRefs: string | null;
  } | null {
    const epochSec = Math.floor(epochMs / 1000);
    const row = queryOne<{
      direction: "inbound" | "outbound";
      message_type: number;
      text_content: string | null;
      file_refs: string | null;
    }>(
      `SELECT direction, message_type, text_content, file_refs
       FROM conversations
       WHERE user_id = ?
         AND created_at >= ? AND created_at <= ?
       ORDER BY ABS(CAST(strftime('%s', created_at) AS INTEGER) - ?)
       LIMIT 1`,
      [
        userId,
        new Date(epochMs - 30_000).toISOString(),
        new Date(epochMs + 10_000).toISOString(),
        epochSec,
      ],
    );
    if (!row) return null;
    return {
      direction: row.direction,
      messageType: row.message_type,
      textContent: row.text_content,
      fileRefs: row.file_refs,
    };
  }

  /**
   * Add a message to the conversation log.
   * Auto-increments `seq_in_session` for the session.
   * Returns the new row's id.
   */
  addMessage(record: ConversationRecord): number {
    const db = getDb();

    // Find the next sequence number
    const maxRow = queryOne<{ max_seq: number }>(
      `SELECT COALESCE(MAX(seq_in_session), 0) AS max_seq
       FROM conversations
       WHERE session_id = ?`,
      [record.sessionId],
    );
    const nextSeq = (maxRow?.max_seq ?? 0) + 1;

    db.run(
      `INSERT INTO conversations
       (session_id, user_id, seq_in_session, direction, message_type,
        text_content, file_refs, context_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.sessionId,
        record.userId,
        nextSeq,
        record.direction,
        record.messageType,
        record.textContent ?? null,
        record.fileRefs ?? null,
        record.contextToken ?? null,
        new Date().toISOString(),
      ],
    );

    // Get the last inserted row id
    const result = db.exec("SELECT last_insert_rowid()");
    if (
      result.length > 0 &&
      result[0].values &&
      result[0].values.length > 0
    ) {
      return result[0].values[0][0] as number;
    }
    return 0;
  }

  saveMessageText(record: MessageTextRecord): void {
    if (!record.msgId || !record.textContent.trim()) return;
    const db = getDb();
    db.run(
      `INSERT INTO message_text_index
       (msg_id, user_id, session_id, from_user_id, item_type, file_name, media_key, text_content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(msg_id) DO UPDATE SET
         user_id = excluded.user_id,
         session_id = excluded.session_id,
         from_user_id = excluded.from_user_id,
         item_type = excluded.item_type,
         file_name = excluded.file_name,
         media_key = excluded.media_key,
         text_content = excluded.text_content`,
      [
        record.msgId,
        record.userId,
        record.sessionId ?? null,
        record.fromUserId ?? null,
        record.itemType ?? null,
        record.fileName ?? null,
        record.mediaKey ?? null,
        record.textContent.trim(),
        new Date().toISOString(),
      ],
    );
  }

  findMessageText(msgId: string): string | null {
    if (!msgId) return null;
    const row = queryOne<{ text_content: string | null }>(
      `SELECT text_content
       FROM message_text_index
       WHERE msg_id = ?`,
      [msgId],
    );
    const text = row?.text_content?.trim();
    return text ? text : null;
  }

  findLatestMessageTextForUser(
    userId: number,
    opts: {
      msgId?: string | null;
      fileName?: string | null;
      mediaKey?: string | null;
      itemType?: string | null;
    },
  ): string | null {
    const candidates: Array<{ sql: string; params: Array<string | number> }> = [];

    if (opts.msgId) {
      candidates.push({
        sql: `SELECT text_content
              FROM message_text_index
              WHERE user_id = ? AND msg_id = ?
              LIMIT 1`,
        params: [userId, opts.msgId],
      });
    }

    if (opts.mediaKey) {
      candidates.push({
        sql: `SELECT text_content
              FROM message_text_index
              WHERE user_id = ? AND media_key = ?
              ORDER BY created_at DESC
              LIMIT 1`,
        params: [userId, opts.mediaKey],
      });
    }

    if (opts.fileName) {
      candidates.push({
        sql: `SELECT text_content
              FROM message_text_index
              WHERE user_id = ? AND file_name = ?
              ORDER BY created_at DESC
              LIMIT 1`,
        params: [userId, opts.fileName],
      });
    }

    // No item_type fallback: matching "the user's latest image" can silently
    // return the wrong image's content. Prefer an honest miss.

    for (const candidate of candidates) {
      const row = queryOne<{ text_content: string | null }>(candidate.sql, candidate.params);
      const text = row?.text_content?.trim();
      if (text) return text;
    }

    return null;
  }

  /**
   * Append late-arriving content to a stored message row. Used by direct
   * image mode: the async vision extraction lands after the reply was sent,
   * and the next turn's history injection should carry the image content.
   */
  appendTextToRow(rowId: number, text: string): void {
    if (rowId <= 0 || !text.trim()) return;
    const row = queryOne<{ text_content: string | null }>(
      `SELECT text_content FROM conversations WHERE id = ?`,
      [rowId],
    );
    if (!row) return;
    const combined = `${row.text_content ?? ""}\n${text}`.slice(0, 1000);
    getDb().run(
      `UPDATE conversations SET text_content = ? WHERE id = ?`,
      [combined, rowId],
    );
  }

  /** Get the most recent messages for a session. */
  getHistory(
    sessionId: string,
    limit = 20,
  ): Array<{
    direction: string;
    textContent: string | null;
    createdAt: string;
  }> {
    return queryAll(
      `SELECT direction, text_content AS textContent, created_at AS createdAt
       FROM conversations
       WHERE session_id = ?
       ORDER BY seq_in_session DESC
       LIMIT ?`,
      [sessionId, limit],
    );
  }

  /**
   * Build a formatted context string for the AI prompt.
   * Returns the last `maxMessages` messages as:
   *   用户: <text>
   *   助手: <text>
   *
   * Each message is clipped to 500 characters.
   */
  getContextMessages(sessionId: string, maxMessages = 6): string {
    const rows = queryAll<{ direction: string; text_content: string }>(
      `SELECT direction, text_content
       FROM conversations
       WHERE session_id = ? AND text_content IS NOT NULL
       ORDER BY seq_in_session DESC
       LIMIT ?`,
      [sessionId, maxMessages],
    );

    if (rows.length === 0) return "";

    // Restore chronological order
    const reversed = [...rows].reverse();
    const lines: string[] = [];
    for (const row of reversed) {
      const prefix = row.direction === "inbound" ? "用户" : "助手";
      const clipped = (row.text_content ?? "").slice(0, 500);
      lines.push(`${prefix}: ${clipped}`);
    }
    return lines.join("\n");
  }

  /** Remove conversations older than `days`. Returns count of deleted rows. */
  pruneOldConversations(days = 30): number {
    const db = getDb();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString();
    db.run(
      `DELETE FROM conversations WHERE created_at < ?`,
      [cutoff],
    );
    return db.getRowsModified();
  }
}
