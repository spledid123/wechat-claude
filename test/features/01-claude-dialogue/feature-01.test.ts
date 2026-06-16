/**
 * Feature 01 Test Suite: Claude Code Dialogue + Record Management
 *
 * Tests the foundational modules:
 *   - Database initialization & migrations
 *   - SessionManager (CRUD lifecycle)
 *   - ConversationManager (message recording & history)
 *   - ClaudeSession (SDK wrapper — mock-based)
 *   - ClaudeManager (session multiplexing + concurrency)
 *   - Prompt builder (system prompt & user message assembly)
 *   - End-to-end dialogue flow
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ——— Mock the Claude Agent SDK ———
// vi.mock is hoisted above all imports (including dynamic ones inside ClaudeSession),
// so ALL code paths that import "@anthropic-ai/claude-agent-sdk" get the mock.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: unknown) => {
    (globalThis as { __lastClaudeQueryOptions?: unknown }).__lastClaudeQueryOptions =
      (opts as { options?: unknown }).options;
    const mockMessages = (globalThis as {
      __claudeMockMessages?: Array<Record<string, unknown>>;
    }).__claudeMockMessages;
    // Must return an AsyncIterable (not a Promise<AsyncIterable>)
    // because the mock factory cannot use async/await.
    async function* gen() {
      if (mockMessages) {
        for (const msg of mockMessages) {
          yield msg;
        }
        return;
      }
      yield { type: "assistant" };
      yield { type: "result", result: "mock response" };
    }
    return gen();
  },
  tool: (_name: string, _desc: string, _schema: unknown, _fn: unknown) => ({
    name: _name, description: _desc, schema: _schema, fn: _fn,
  }),
  createSdkMcpServer: (config: unknown) => config,
  getLastQueryOptions: () => (globalThis as { __lastClaudeQueryOptions?: unknown }).__lastClaudeQueryOptions,
}));

// Test helpers
import { setupTestDb, teardownTestDb, resetTestDb, getTestWorkspaceBase, getTestDataDir } from "../../helpers/db.js";

// Modules under test
import { getDb, queryAll, queryOne, saveDatabase, closeDatabase, initializeDatabase } from "./db/connection.js";
import { SessionManager } from "./session/manager.js";
import { ConversationManager } from "./conversation/manager.js";
import { ClaudeSession } from "./claude/session.js";
import { ClaudeManager } from "./claude/manager.js";
import {
  createClaudePermissionPolicy,
  evaluateBashCommand,
  evaluateScriptContent,
  extractPaths,
  isWithinWorkspace,
} from "./claude/permissions.js";
import {
  buildSystemPromptAppend,
  buildUserMessage,
  buildMultiBubbleInstruction,
  MULTI_BUBBLE_SEPARATOR,
  MAX_BUBBLES,
} from "./prompt-builder.js";
import type { PromptContext, SessionSpec } from "./claude/types.js";

// ---------------------------------------------------------------------------
// Suite lifecycle — one temp DB for all tests in this file
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(() => {
  delete (globalThis as { __claudeMockMessages?: unknown }).__claudeMockMessages;
});

afterAll(() => {
  teardownTestDb();
});

// Note: each describe block that writes data has its own beforeEach(resetTestDb).
// Group A tests run WITHOUT reset to keep migration records intact.

// ===========================================================================
// GROUP A: Database Initialization & Migrations
// ===========================================================================

describe("Group A — Database Initialization & Migrations", () => {
  it("A1: creates all expected tables", () => {
    const db = getDb();
    const result = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    expect(result.length).toBeGreaterThan(0);
    const tables = result[0].values.map((r) => r[0] as string);
    expect(tables).toContain("users");
    expect(tables).toContain("sessions");
    expect(tables).toContain("conversations");
    expect(tables).toContain("message_text_index");
    expect(tables).toContain("schema_migrations");
  });

  it("A2: records migration 001 in schema_migrations", () => {
    const rows = queryAll<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].name).toContain("001");
  });

  it("A3: users table has expected columns", () => {
    const cols = queryAll<{ name: string }>(
      "PRAGMA table_info('users')",
    );
    const names = cols.map((c) => c.name);
    expect(names).toContain("wechat_user_id");
    expect(names).toContain("nickname");
    expect(names).toContain("id");
  });

  it("A4: sessions table has expected columns", () => {
    const cols = queryAll<{ name: string }>(
      "PRAGMA table_info('sessions')",
    );
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("cwd");
    expect(names).toContain("status");
    expect(names).toContain("summary");
    expect(names).toContain("message_count");
  });

  it("A5: DB file exists on disk after save", () => {
    saveDatabase(); // sql.js is in-memory until explicit save
    const dbPath = path.join(getTestDataDir(), "relay.sqlite");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("A6: re-initialization is idempotent (no crash on second call)", async () => {
    // close first, re-init in same dir
    saveDatabase();
    const dataDir = getTestDataDir();
    await initializeDatabase(dataDir);
    // Should not throw — tables already exist
    const rows = queryAll<{ version: number }>(
      "SELECT version FROM schema_migrations",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("A7: DB persistence roundtrip — save → reopen → data intact", async () => {
    // Create data in the current DB
    const db = getDb();
    db.run(
      "INSERT INTO users (wechat_user_id, nickname) VALUES (?, ?)",
      ["persist-test@im.wechat", "PersistenceTest"],
    );
    saveDatabase();
    const dataDir = getTestDataDir();

    // Close and reopen
    const { closeDatabase: closeDb } = await import("./db/connection.js");
    closeDb();

    const { initializeDatabase: reinit } = await import("./db/connection.js");
    await reinit(dataDir);

    // Verify data survived
    const user = queryOne<{ wechat_user_id: string; nickname: string }>(
      "SELECT wechat_user_id, nickname FROM users WHERE wechat_user_id = ?",
      ["persist-test@im.wechat"],
    );
    expect(user).not.toBeNull();
    expect(user!.nickname).toBe("PersistenceTest");
  });

  it("A8: turns table exists (reserved for Feature 6 message debounce)", () => {
    const cols = queryAll<{ name: string }>("PRAGMA table_info('turns')");
    const names = cols.map((c) => c.name);
    expect(names).toContain("session_id");
    expect(names).toContain("status");
    expect(names).toContain("normalized_text");
    expect(names).toContain("raw_payload_json");
  });

  it("A9: scheduled task schema allows daily tasks", () => {
    const migrations = queryAll<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    expect(migrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 4, name: "004_daily_scheduled_tasks.sql" }),
    ]));

    getDb().run(
      `INSERT INTO scheduled_tasks
       (id, user_id, context_token, title, mode, payload_text, schedule_type,
        time_of_day, timezone, status, created_at, updated_at, next_run_at)
       VALUES
       ('task_daily_schema', 'u', 'ctx', '每日提醒', 'send_text', '每天提醒', 'daily',
        '09:00', 'Asia/Shanghai', 'active', '2026-06-16T00:00:00.000Z',
        '2026-06-16T00:00:00.000Z', '2026-06-16T01:00:00.000Z')`,
    );

    const row = queryOne<{ schedule_type: string }>(
      "SELECT schedule_type FROM scheduled_tasks WHERE id = ?",
      ["task_daily_schema"],
    );
    expect(row?.schedule_type).toBe("daily");
  });
});

// ===========================================================================
// GROUP B: SessionManager CRUD Lifecycle
// ===========================================================================

describe("Group B — SessionManager CRUD", () => {
  let sm: SessionManager;

  beforeEach(() => {
    resetTestDb();
    sm = new SessionManager(getTestWorkspaceBase(), 60);
  });

  it("B1: createSession creates user row and returns SessionRecord", () => {
    const s = sm.createSession("user-abc@im.wechat");
    expect(s.id).toBeTruthy();
    expect(s.fromUserId).toBe("user-abc@im.wechat");
    expect(s.status).toBe("active");
    expect(s.userId).toBeGreaterThan(0);

    // Verify user row
    const user = queryOne<{ id: number }>(
      "SELECT id FROM users WHERE wechat_user_id = ?",
      ["user-abc@im.wechat"],
    );
    expect(user).not.toBeNull();
  });

  it("B2: createSession reuses existing user row", () => {
    sm.createSession("user-abc@im.wechat");
    sm.createSession("user-abc@im.wechat"); // second session
    const users = queryAll<{ id: number }>(
      "SELECT id FROM users WHERE wechat_user_id = ?",
      ["user-abc@im.wechat"],
    );
    expect(users.length).toBe(1); // still one user
  });

  it("B3: createSession creates workspace directories", () => {
    const s = sm.createSession("user-x");
    expect(fs.existsSync(s.cwd)).toBe(true);
    expect(fs.existsSync(path.join(s.cwd, "incoming"))).toBe(true);
    expect(fs.existsSync(path.join(s.cwd, "working"))).toBe(true);
    expect(fs.existsSync(path.join(s.cwd, "working", "output_weixin"))).toBe(true);
    expect(fs.existsSync(path.join(s.cwd, "output"))).toBe(true);
  });

  it("B4: resolveSession returns active session", () => {
    const created = sm.createSession("user-1");
    const resolved = sm.resolveSession("user-1");
    expect(resolved.id).toBe(created.id);
  });

  it("B5: resolveSession creates new when none active", () => {
    const s = sm.resolveSession("user-2");
    expect(s.status).toBe("active");
    expect(s.fromUserId).toBe("user-2");
  });

  it("B6: resolveSession times out expired session", () => {
    const short = new SessionManager(getTestWorkspaceBase(), 0.01); // ~0.6 sec timeout
    const s = short.createSession("user-3");

    // Manually age the session by updating last_active_at
    const db = getDb();
    const oldTime = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    db.run("UPDATE sessions SET last_active_at = ? WHERE id = ?", [
      oldTime,
      s.id,
    ]);

    // Resolve should close old and create new
    const resolved = short.resolveSession("user-3");
    expect(resolved.id).not.toBe(s.id); // new session

    const oldSession = queryOne<{ status: string }>(
      "SELECT status FROM sessions WHERE id = ?",
      [s.id],
    );
    expect(oldSession?.status).toBe("closed");
  });

  it("B7: closeSession marks status and reason", () => {
    const s = sm.createSession("user-4");
    sm.closeSession(s.id, "user_request");
    const row = queryOne<{ status: string; closed_reason: string }>(
      "SELECT status, closed_reason FROM sessions WHERE id = ?",
      [s.id],
    );
    expect(row?.status).toBe("closed");
    expect(row?.closed_reason).toBe("user_request");
  });

  it("B8: deleteSession removes session + conversations + workspace", () => {
    const s = sm.createSession("user-5");
    const wsDir = s.cwd;

    // Add a conversation to verify cascade
    getDb().run(
      `INSERT INTO conversations (session_id, user_id, seq_in_session, direction, message_type)
       VALUES (?, ?, 1, 'inbound', 1)`,
      [s.id, s.userId],
    );

    const result = sm.deleteSession(s.id);
    expect(result).toBe(true);

    // Session gone
    const sess = queryOne("SELECT id FROM sessions WHERE id = ?", [s.id]);
    expect(sess).toBeNull();

    // Conversation cascade-deleted
    const conv = queryOne(
      "SELECT id FROM conversations WHERE session_id = ?",
      [s.id],
    );
    expect(conv).toBeNull();

    // Workspace removed
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  it("B9: deleteSession on non-existent returns false", () => {
    expect(sm.deleteSession("nonexistent-id")).toBe(false);
  });

  it("B10: incrementMessageCount increases count", () => {
    const s = sm.createSession("user-6");
    sm.incrementMessageCount(s.id);
    sm.incrementMessageCount(s.id);
    sm.incrementMessageCount(s.id);

    const row = queryOne<{ message_count: number }>(
      "SELECT message_count FROM sessions WHERE id = ?",
      [s.id],
    );
    expect(row?.message_count).toBe(3);
  });

  it("B11: saveSummary / getSummary roundtrip", () => {
    const s = sm.createSession("user-7");
    sm.saveSummary(s.id, "用户讨论了 Q4 财报分析");
    expect(sm.getSummary(s.id)).toBe("用户讨论了 Q4 财报分析");
  });

  it("B12: getLastClosedSessionSummary returns most recent closed summary", () => {
    const s1 = sm.createSession("user-8");
    sm.saveSummary(s1.id, "Summary A");
    sm.closeSession(s1.id, "done");

    const s2 = sm.createSession("user-8");
    sm.saveSummary(s2.id, "Summary B");
    sm.closeSession(s2.id, "done");

    expect(sm.getLastClosedSessionSummary()).toBe("Summary B");
  });

  it("B13: updateContextToken / getContextToken roundtrip", () => {
    const s = sm.createSession("user-9");
    sm.updateContextToken(s.id, "tok_abc123");
    expect(sm.getContextToken(s.id)).toBe("tok_abc123");
  });

  it("B14: listActiveSessions only returns active", () => {
    sm.createSession("user-a");
    const s2 = sm.createSession("user-b");
    sm.closeSession(s2.id, "test");

    const active = sm.listActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].status).toBe("active");
  });

  it("B15: listAllSessions returns all", () => {
    sm.createSession("user-c");
    sm.createSession("user-d");
    expect(sm.listAllSessions().length).toBe(2);
  });

  it("B16: updateClaudeSessionId persists to DB", () => {
    const s = sm.createSession("user-e");
    sm.updateClaudeSessionId(s.id, "claude-sess-12345");
    const row = queryOne<{ claude_session_id: string }>(
      "SELECT claude_session_id FROM sessions WHERE id = ?",
      [s.id],
    );
    expect(row?.claude_session_id).toBe("claude-sess-12345");
  });
});

// ===========================================================================
// GROUP C: ConversationManager Recording
// ===========================================================================

describe("Group C — ConversationManager", () => {
  let sm: SessionManager;
  let cm: ConversationManager;
  let sessionId: string;
  let userId: number;

  beforeEach(() => {
    sm = new SessionManager(getTestWorkspaceBase());
    cm = new ConversationManager();
    const s = sm.createSession("test-user");
    sessionId = s.id;
    userId = s.userId;
  });

  it("C1: addMessage auto-increments seq_in_session", () => {
    cm.addMessage({
      sessionId,
      userId,
      direction: "inbound",
      messageType: 1,
      textContent: "msg1",
    });
    cm.addMessage({
      sessionId,
      userId,
      direction: "outbound",
      messageType: 1,
      textContent: "msg2",
    });
    cm.addMessage({
      sessionId,
      userId,
      direction: "inbound",
      messageType: 1,
      textContent: "msg3",
    });

    const rows = queryAll<{ seq_in_session: number; text_content: string }>(
      "SELECT seq_in_session, text_content FROM conversations WHERE session_id = ? ORDER BY seq_in_session",
      [sessionId],
    );
    expect(rows.length).toBe(3);
    expect(rows[0].seq_in_session).toBe(1);
    expect(rows[1].seq_in_session).toBe(2);
    expect(rows[2].seq_in_session).toBe(3);
  });

  it("C2: addMessage stores all fields correctly", () => {
    cm.addMessage({
      sessionId,
      userId,
      direction: "inbound",
      messageType: 1,
      textContent: "你好",
      contextToken: "ctx_123",
    });

    const row = queryOne<Record<string, unknown>>(
      "SELECT * FROM conversations WHERE session_id = ?",
      [sessionId],
    );
    expect(row).not.toBeNull();
    expect(row!.direction).toBe("inbound");
    expect(row!.text_content).toBe("你好");
    expect(row!.message_type).toBe(1);
    expect(row!.context_token).toBe("ctx_123");
  });

  it("C3: getHistory respects limit and order", () => {
    for (let i = 0; i < 5; i++) {
      cm.addMessage({
        sessionId,
        userId,
        direction: i % 2 === 0 ? "inbound" : "outbound",
        messageType: 1,
        textContent: `msg${i}`,
      });
    }

    const history = cm.getHistory(sessionId, 3);
    expect(history.length).toBe(3);
    // Most recent first (DESC order)
    expect(history[0].textContent).toBe("msg4");
    expect(history[1].textContent).toBe("msg3");
  });

  it('C4: getContextMessages formats as 用户:/助手:', () => {
    cm.addMessage({
      sessionId,
      userId,
      direction: "inbound",
      messageType: 1,
      textContent: "你好",
    });
    cm.addMessage({
      sessionId,
      userId,
      direction: "outbound",
      messageType: 1,
      textContent: "你好！有什么可以帮忙的？",
    });

    const ctx = cm.getContextMessages(sessionId, 6);
    expect(ctx).toContain("用户: 你好");
    expect(ctx).toContain("助手: 你好！有什么可以帮忙的？");
  });

  it("C5: getContextMessages clips long text at 500 chars", () => {
    const longText = "A".repeat(600);
    cm.addMessage({
      sessionId,
      userId,
      direction: "inbound",
      messageType: 1,
      textContent: longText,
    });

    const ctx = cm.getContextMessages(sessionId, 6);
    expect(ctx.length).toBeLessThanOrEqual(510); // "用户: " + up to 500
    expect(ctx).not.toContain("A".repeat(600));
  });

  it("C6: getContextMessages returns empty string for no messages", () => {
    expect(cm.getContextMessages(sessionId)).toBe("");
  });

  it("C7: pruneOldConversations removes old messages, keeps recent", () => {
    // Add an "old" message by directly inserting with an old timestamp
    const db = getDb();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
    db.run(
      `INSERT INTO conversations (session_id, user_id, seq_in_session, direction, message_type, text_content, created_at)
       VALUES (?, ?, 1, 'inbound', 1, 'old message', ?)`,
      [sessionId, userId, oldDate],
    );

    // Add a recent message via the normal API
    cm.addMessage({
      sessionId, userId,
      direction: "outbound", messageType: 1,
      textContent: "recent message",
    });

    // Prune older than 30 days
    const deleted = cm.pruneOldConversations(30);
    expect(deleted).toBe(1);

    // Old message gone
    const old = queryOne(
      "SELECT id FROM conversations WHERE text_content = ?",
      ["old message"],
    );
    expect(old).toBeNull();

    // Recent message still there
    const recent = queryOne<{ text_content: string }>(
      "SELECT text_content FROM conversations WHERE text_content = ?",
      ["recent message"],
    );
    expect(recent).not.toBeNull();
  });

  it("C8: saveMessageText and findMessageText work across sessions", () => {
    cm.saveMessageText({
      msgId: "msg-quoted-1",
      userId,
      sessionId,
      fromUserId: "test-user",
      itemType: "voice",
      textContent: "这是缓存下来的引用文字",
    });

    expect(cm.findMessageText("msg-quoted-1")).toBe("这是缓存下来的引用文字");

    sm.closeSession(sessionId, "test");
    const next = sm.createSession("test-user");
    expect(next.id).not.toBe(sessionId);
    expect(cm.findMessageText("msg-quoted-1")).toBe("这是缓存下来的引用文字");
  });

  it("C9: findLatestMessageTextForUser can resolve by file name", () => {
    cm.saveMessageText({
      msgId: "msg-file-1",
      userId,
      sessionId,
      fromUserId: "test-user",
      itemType: "file",
      fileName: "report.pdf",
      textContent: "这是 report.pdf 的正文",
    });

    expect(
      cm.findLatestMessageTextForUser(userId, {
        fileName: "report.pdf",
        itemType: "file",
      }),
    ).toBe("这是 report.pdf 的正文");
  });
});

// ===========================================================================
// GROUP D: ClaudeSession + ClaudeManager (mock-based)
// ===========================================================================

describe("Group D — ClaudeSession (mock SDK)", () => {
  it("D1: creates session with options", () => {
    const s = new ClaudeSession({
      sessionId: "sess-1",
      cwd: "/tmp/test",
      model: "sonnet",
    });
    expect(s.sessionId).toBe("sess-1");
    expect(s.cwd).toBe("/tmp/test");
    expect(s.getIsProcessing()).toBe(false);
  });

  it("D2: querySimple returns mock response", async () => {
    const s = new ClaudeSession({ sessionId: "sess-2", cwd: "/tmp" });
    const result = await s.querySimple("Hello");
    expect(result.text).toBe("mock response");
    expect(result.sessionId).toBe("sess-2");
    expect(result.turnCount).toBeGreaterThanOrEqual(0);
  });

  it("D3: querySimple passes systemAppend", async () => {
    const s = new ClaudeSession({ sessionId: "sess-3", cwd: "/tmp" });
    const result = await s.querySimple(
      "test",
      "You are a helpful bot.",
    );
    // Mock always returns "mock response", but it shouldn't crash
    expect(result.text).toBe("mock response");
  });

  it("D4: getIsProcessing is false after query completes", async () => {
    const s = new ClaudeSession({ sessionId: "sess-4", cwd: "/tmp" });
    await s.querySimple("test");
    expect(s.getIsProcessing()).toBe(false);
  });

  it("D5: cancel creates fresh abort controller", () => {
    const s = new ClaudeSession({ sessionId: "sess-5", cwd: "/tmp" });
    s.cancel();
    // After cancel, session should not be processing
    expect(s.getIsProcessing()).toBe(false);
  });

  it("D6: getLastResult returns null before first query", () => {
    const s = new ClaudeSession({ sessionId: "sess-6", cwd: "/tmp" });
    expect(s.getLastResult()).toBeNull();
  });

  it("D7: getLastResult returns last result after query", async () => {
    const s = new ClaudeSession({ sessionId: "sess-7", cwd: "/tmp" });
    await s.querySimple("test");
    const last = s.getLastResult();
    expect(last).not.toBeNull();
    expect(last!.text).toBe("mock response");
  });

  it("D7a: querySimple falls back to assistant text when result text is empty", async () => {
    (globalThis as { __claudeMockMessages?: Array<Record<string, unknown>> }).__claudeMockMessages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "assistant fallback text" },
          ],
        },
      },
      { type: "result", subtype: "success", result: "" },
    ];

    const s = new ClaudeSession({ sessionId: "sess-7a", cwd: "/tmp" });
    const result = await s.querySimple("test");
    expect(result.text).toBe("assistant fallback text");
  });

  it("D7c: querySimple surfaces SDK result errors instead of empty text", async () => {
    (globalThis as { __claudeMockMessages?: Array<Record<string, unknown>> }).__claudeMockMessages = [
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["permission setup failed"],
        permission_denials: [],
      },
    ];

    const s = new ClaudeSession({ sessionId: "sess-7c", cwd: "/tmp" });
    const result = await s.querySimple("test");
    expect(result.text).toContain("Claude 执行失败");
    expect(result.text).toContain("permission setup failed");
  });

  it("D7b: querySimple enables workspace-only sandbox writes", async () => {
    const cwd = "/tmp/sandboxed-session";
    const s = new ClaudeSession({ sessionId: "sess-7b", cwd });
    await s.querySimple("test");
    const sdk = await import("@anthropic-ai/claude-agent-sdk") as unknown as {
      getLastQueryOptions: () => {
        sandbox?: unknown;
        settings?: unknown;
        canUseTool?: unknown;
      } | undefined;
    };
    const queryOptions = sdk.getLastQueryOptions();
    if (process.platform === "win32") {
      expect(queryOptions?.sandbox).toMatchObject({
        enabled: false,
        failIfUnavailable: false,
        allowUnsandboxedCommands: true,
      });
    } else {
      expect(queryOptions?.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: false,
        allowUnsandboxedCommands: true,
        filesystem: {
          allowWrite: [cwd],
          denyRead: [],
        },
      });
    }
    const sandbox = queryOptions?.sandbox as {
      filesystem?: { allowRead?: string[]; denyWrite?: string[] };
    } | undefined;
    if (process.platform !== "win32") {
      expect(sandbox?.filesystem?.allowRead?.length).toBeGreaterThan(0);
    }
    expect(sandbox?.filesystem?.denyWrite).toBeUndefined();
    expect(queryOptions?.settings).toBeUndefined();
    expect(queryOptions?.canUseTool).toEqual(expect.any(Function));
  });
});

describe("Group D — ClaudeManager (mock SDK)", () => {
  let manager: ClaudeManager;
  const baseSpec: SessionSpec = {
    sessionId: "sess-mgr-1",
    cwd: "/tmp/claude-test",
  };

  beforeEach(() => {
    manager = new ClaudeManager(1);
  });

  it("D8: getOrCreateSession creates new session", () => {
    const s = manager.getOrCreateSession(baseSpec);
    expect(s.sessionId).toBe("sess-mgr-1");
    expect(s.cwd).toBe("/tmp/claude-test");
  });

  it("D9: getOrCreateSession reuses existing", () => {
    const s1 = manager.getOrCreateSession(baseSpec);
    const s2 = manager.getOrCreateSession(baseSpec);
    expect(s1).toBe(s2); // same instance
  });

  it("D10: processMessage builds prompt and queries", async () => {
    const ctx: PromptContext = {
      userText: "测试消息",
      historyText: "用户: 你好\n助手: 你好！",
    };

    const result = await manager.processMessage(baseSpec, ctx);
    expect(result.text).toBe("mock response");
    expect(result.sessionId).toBe("sess-mgr-1");
  });

  it("D11: semaphore limits concurrency to 1", async () => {
    const manager2 = new ClaudeManager(1); // max 1 concurrent
    const spec: SessionSpec = { sessionId: "conc-test", cwd: "/tmp" };

    let firstDone = false;

    // Start first query (mock returns immediately, but semaphore is held)
    const p1 = manager2.processMessage(spec, { userText: "first" });
    p1.then(() => {
      firstDone = true;
    });

    // Start second — should queue
    const p2 = manager2.processMessage(spec, { userText: "second" });

    await Promise.all([p1, p2]);

    // Both completed
    expect(firstDone).toBe(true);
  });

  it("D12: closeSession removes from manager", () => {
    manager.getOrCreateSession(baseSpec);
    expect(manager.activeSessionCount).toBe(1);
    manager.closeSession("sess-mgr-1");
    expect(manager.activeSessionCount).toBe(0);
  });

  it("D13: shutdown clears all sessions", () => {
    manager.getOrCreateSession({ sessionId: "a", cwd: "/tmp" });
    manager.getOrCreateSession({ sessionId: "b", cwd: "/tmp" });
    manager.shutdown();
    expect(manager.activeSessionCount).toBe(0);
  });
});

describe("Group D - Claude permission helpers", () => {
  const cwd = path.resolve("/tmp/claude-policy");

  it("D14: policy auto-decides permissions and denies AskUserQuestion", async () => {
    const policy = createClaudePermissionPolicy(cwd);
    expect(policy.mode).toBe("default");
    expect(policy.allowedTools).toEqual(
      expect.arrayContaining(["WebSearch", "WebFetch", "Read", "Grep", "LS"]),
    );
    expect(policy.allowedTools).not.toEqual(
      expect.arrayContaining(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]),
    );
    await expect(policy.canUseTool("Read", { file_path: "/etc/hosts" })).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: "/etc/hosts" },
    });
    await expect(policy.canUseTool("Write", { file_path: path.join(cwd, "ok.txt") })).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: path.join(cwd, "ok.txt") },
    });
    await expect(policy.canUseTool("Bash", { command: "echo ok > result.txt" })).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { command: "echo ok > result.txt" },
    });
    await expect(policy.canUseTool("Write", { file_path: path.resolve(cwd, "..", "no.txt") })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(policy.canUseTool("AskUserQuestion", {})).resolves.toMatchObject({
      behavior: "deny",
    });
  });

  it("D15: edit paths must stay inside workspace", () => {
    expect(extractPaths("Edit", { file_path: path.join(cwd, "a.txt") })).toEqual([
      path.resolve(cwd, "a.txt").toLowerCase(),
    ]);
    expect(isWithinWorkspace(path.join(cwd, "nested.txt"), cwd)).toBe(true);
    expect(isWithinWorkspace(path.resolve(cwd, "..", "other.txt"), cwd)).toBe(false);
  });

  it("D16: bash can write inside workspace", () => {
    expect(
      evaluateBashCommand(
        `python -c "open('${path.join(cwd, "result.txt").replace(/\\/g, "\\\\")}', 'w').write('ok')"`,
        cwd,
      ),
    ).toEqual({ behavior: "allow" });
  });

  it("D17: bash cannot write outside workspace", () => {
    expect(
      evaluateBashCommand(
        `python -c "open('C:\\\\outside.txt', 'w').write('no')"`,
        cwd,
      ).behavior,
    ).toBe("deny");
  });

  it("D18: bash cannot write to parent or sibling workspaces", () => {
    expect(
      evaluateBashCommand("Set-Content -Path ..\\sibling\\leak.txt -Value nope", cwd).behavior,
    ).toBe("deny");
    expect(
      evaluateBashCommand("echo nope > ../sibling/leak.txt", cwd).behavior,
    ).toBe("deny");
    expect(
      evaluateBashCommand("echo nope>../sibling/leak.txt", cwd).behavior,
    ).toBe("deny");
    expect(
      evaluateBashCommand(
        "node -e \"require('fs').writeFileSync('../sibling/leak.txt','nope')\"",
        cwd,
      ).behavior,
    ).toBe("deny");
  });

  it("D19: bash can read outside workspace", () => {
    expect(evaluateBashCommand("Get-ChildItem ..", cwd)).toEqual({ behavior: "allow" });
    expect(evaluateBashCommand("type C:\\\\Windows\\\\win.ini", cwd)).toEqual({ behavior: "allow" });
    expect(evaluateBashCommand("ls .. 2>&1", cwd)).toEqual({ behavior: "allow" });
  });

  it("D20: bash write commands must name an in-workspace target", () => {
    expect(evaluateBashCommand("mkdir working\\results", cwd)).toEqual({ behavior: "allow" });
    expect(evaluateBashCommand("touch working/result.txt", cwd)).toEqual({ behavior: "allow" });
    expect(evaluateBashCommand("touch result.txt", cwd)).toEqual({ behavior: "allow" });
    expect(
      evaluateBashCommand("python -c \"open('result.txt', 'w').write('ok')\"", cwd),
    ).toEqual({ behavior: "allow" });
    expect(
      evaluateBashCommand("node -e \"require('fs').writeFileSync('result.txt','ok')\"", cwd),
    ).toEqual({ behavior: "allow" });
    expect(evaluateBashCommand("mkdir", cwd).behavior).toBe("deny");
  });

  it("D21: bash delete commands are allowed only inside workspace", () => {
    expect(evaluateBashCommand("rm -f working/result.txt", cwd)).toEqual({ behavior: "allow" });
    expect(evaluateBashCommand("del working\\result.txt", cwd)).toEqual({ behavior: "allow" });
    expect(evaluateBashCommand("Remove-Item -LiteralPath working\\result.txt -Force", cwd)).toEqual({
      behavior: "allow",
    });
    expect(evaluateBashCommand("rm -f ../sibling/result.txt", cwd).behavior).toBe("deny");
    expect(evaluateBashCommand("Remove-Item -LiteralPath ..\\sibling\\result.txt -Force", cwd).behavior).toBe("deny");
    expect(evaluateBashCommand("rm -rf", cwd).behavior).toBe("deny");
  });

  it("D22: runnable scripts cannot write outside workspace", () => {
    const scriptPath = path.join(cwd, "working", "leaky.py");
    const script = "from pathlib import Path\nPath('../sibling/test_write.txt').write_text('nope')\n";
    expect(evaluateScriptContent(script, scriptPath, cwd).behavior).toBe("deny");

    const safeScript = "from pathlib import Path\nPath('result.txt').write_text('ok')\n";
    expect(evaluateScriptContent(safeScript, scriptPath, cwd)).toEqual({ behavior: "allow" });
  });

  it("D23: bash scans runnable workspace scripts before execution", () => {
    const tempWorkspace = fs.mkdtempSync(path.join(getTestWorkspaceBase(), "policy-"));
    const workingDir = path.join(tempWorkspace, "working");
    fs.mkdirSync(workingDir, { recursive: true });

    const leakyScript = path.join(workingDir, "leaky.py");
    fs.writeFileSync(
      leakyScript,
      "from pathlib import Path\nPath('../sibling/test_write.txt').write_text('nope')\n",
    );
    expect(evaluateBashCommand(`python "${leakyScript}"`, tempWorkspace).behavior).toBe("deny");

    const safeScript = path.join(workingDir, "safe.py");
    fs.writeFileSync(
      safeScript,
      "from pathlib import Path\nPath('result.txt').write_text('ok')\n",
    );
    expect(evaluateBashCommand(`python "${safeScript}"`, tempWorkspace)).toEqual({ behavior: "allow" });
  });
});

// ===========================================================================
// GROUP E: Prompt Builder
// ===========================================================================

describe("Group E — Prompt Builder", () => {
  it("E1: buildSystemPromptAppend includes WeChat relay identity", () => {
    const result = buildSystemPromptAppend({ userText: "hello" });
    expect(result).toContain("WeChat");
    expect(result).toContain("Chinese");
  });

  it("E2: buildSystemPromptAppend includes workspace instructions", () => {
    const result = buildSystemPromptAppend({ userText: "hello" });
    expect(result).toContain("output_weixin");
  });

  it("E3: buildSystemPromptAppend injects session summary", () => {
    const result = buildSystemPromptAppend({
      userText: "hi",
      sessionSummary: "上一段对话讨论了 Python 数据分析。",
    });
    expect(result).toContain("Previous session summary");
    expect(result).toContain("Python 数据分析");
  });

  it("E4: buildSystemPromptAppend does NOT include summary block when null", () => {
    const result = buildSystemPromptAppend({
      userText: "hi",
      sessionSummary: null,
    });
    expect(result).not.toContain("Previous session summary");
  });

  it("E5: buildSystemPromptAppend injects user prompt", () => {
    const result = buildSystemPromptAppend({
      userText: "hi",
      userPrompt: "你是一个 Python 专家。",
    });
    expect(result).toContain("User's custom instructions");
    expect(result).toContain("Python 专家");
  });

  it("E6: buildSystemPromptAppend includes file list", () => {
    const result = buildSystemPromptAppend({
      userText: "分析",
      files: [
        { name: "report.pdf", path: "/tmp/report.pdf", mimeType: "application/pdf" },
      ],
    });
    expect(result).toContain("Files received from WeChat");
    expect(result).toContain("report.pdf");
  });

  it("E7: buildUserMessage returns plain text when no files", () => {
    const result = buildUserMessage({ userText: "你好" });
    expect(result).toBe("你好");
  });

  it("E8: buildUserMessage includes extracted file content", () => {
    const result = buildUserMessage({
      userText: "分析这个文件",
      files: [
        {
          name: "data.csv",
          path: "/tmp/data.csv",
          extractedText: "col1,col2\n1,2\n3,4",
          mimeType: "text/csv",
        },
      ],
    });
    expect(result).toContain("[File: data.csv]");
    expect(result).toContain("col1,col2");
    expect(result).toContain("分析这个文件");
  });

  it("E9: buildUserMessage prefers transcribedText over extractedText for voice", () => {
    const result = buildUserMessage({
      userText: "",
      files: [
        {
          name: "voice.silk",
          path: "/tmp/voice.silk",
          transcribedText: "明天下午三点开会",
          extractedText: "noise data",
          mimeType: "audio/silk",
        },
      ],
    });
    expect(result).toContain("明天下午三点开会");
    expect(result).not.toContain("noise data");
  });

  it("E10: buildMultiBubbleInstruction contains separator and limit", () => {
    const result = buildMultiBubbleInstruction();
    expect(result).toContain(MULTI_BUBBLE_SEPARATOR);
    expect(result).toContain(String(MAX_BUBBLES));
  });
});

// ===========================================================================
// GROUP F: End-to-End Dialogue Flow
// ===========================================================================

describe("Group F — End-to-End Dialogue Flow", () => {
  it("F1: complete cycle: user msg → AI → record → history", async () => {
    // Setup
    const workspaceBase = getTestWorkspaceBase();
    const sm = new SessionManager(workspaceBase, 60);
    const cm = new ConversationManager();
    const claude = new ClaudeManager(1);

    // Step 1: Create session
    const session = sm.createSession("e2e-user@im.wechat");
    expect(session.status).toBe("active");
    expect(fs.existsSync(session.cwd)).toBe(true);

    // Step 2: Record inbound message
    const inboundId = cm.addMessage({
      sessionId: session.id,
      userId: session.userId,
      direction: "inbound",
      messageType: 1,
      textContent: "你好，帮我查一下今天的天气",
    });
    expect(inboundId).toBeGreaterThan(0);

    // Step 3: Build prompt context
    const historyText = cm.getContextMessages(session.id, 6);
    const ctx: PromptContext = {
      userText: "你好，帮我查一下今天的天气",
      historyText,
      sessionSummary: null,
    };

    // Step 4: Call Claude (mock)
    const spec: SessionSpec = {
      sessionId: session.id,
      cwd: session.cwd,
    };
    const aiResult = await claude.processMessage(spec, ctx);
    expect(aiResult.text).toBe("mock response");
    expect(aiResult.sessionId).toBe(session.id);

    // Step 5: Record outbound message
    sm.incrementMessageCount(session.id);
    const outboundId = cm.addMessage({
      sessionId: session.id,
      userId: session.userId,
      direction: "outbound",
      messageType: 1,
      textContent: aiResult.text,
    });
    expect(outboundId).toBeGreaterThan(0);

    // Step 6: Verify full history
    const history = cm.getHistory(session.id, 10);
    expect(history.length).toBe(2);
    // Most recent first (DESC)
    expect(history[0].direction).toBe("outbound");
    expect(history[0].textContent).toBe("mock response");
    expect(history[1].direction).toBe("inbound");
    expect(history[1].textContent).toBe("你好，帮我查一下今天的天气");

    // Step 7: Verify context messages
    const contextStr = cm.getContextMessages(session.id, 6);
    expect(contextStr).toContain("用户:");
    expect(contextStr).toContain("助手:");

    // Step 8: Close session
    sm.closeSession(session.id, "test_complete");
    const closed = queryOne<{ status: string }>(
      "SELECT status FROM sessions WHERE id = ?",
      [session.id],
    );
    expect(closed?.status).toBe("closed");

    // Step 9: Cleanup
    claude.shutdown();
  });
});
