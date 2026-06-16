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

    if (opts.itemType === "image") {
      candidates.push({
        sql: `SELECT text_content
              FROM message_text_index
              WHERE user_id = ? AND item_type = 'image'
              ORDER BY created_at DESC
              LIMIT 1`,
        params: [userId],
      });
    }

    for (const candidate of candidates) {
      const row = queryOne<{ text_content: string | null }>(candidate.sql, candidate.params);
      const text = row?.text_content?.trim();
      if (text) return text;
    }

    return null;
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
