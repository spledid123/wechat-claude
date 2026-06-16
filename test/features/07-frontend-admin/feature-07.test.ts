/**
 * Feature 07 Test Suite: Frontend Admin Panel
 *
 * Covers:
 *   - local status page and JSON API
 *   - QR image management without real WeChat network calls
 *   - full conversation history, not just the five recent sessions
 *   - session deletion with workspace cleanup
 *   - scheduled task list/create/delete from the admin UI API
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createAdminServer, type AdminAuthProvider, type AdminServer } from "./admin.js";
import { SchedulerEngine } from "../06-scheduler/scheduler.js";
import {
  getTestDataDir,
  getTestWorkspaceBase,
  resetTestDb,
  setupTestDb,
  teardownTestDb,
} from "../../helpers/db.js";
import { SessionManager } from "../01-claude-dialogue/session/manager.js";
import { ConversationManager } from "../01-claude-dialogue/conversation/manager.js";
import { queryAll, queryOne } from "../01-claude-dialogue/db/connection.js";

let now = new Date("2026-06-16T08:00:00+08:00");
let scheduler: SchedulerEngine;
let server: AdminServer | null = null;
let sm: SessionManager;
let cm: ConversationManager;
let authProvider: AdminAuthProvider;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  resetTestDb();
  now = new Date("2026-06-16T08:00:00+08:00");
  scheduler = new SchedulerEngine({
    timezone: "Asia/Shanghai",
    now: () => now,
    sendText: async () => undefined,
    runAgent: async ({ prompt }) => `AI: ${prompt}`,
  });
  sm = new SessionManager(getTestWorkspaceBase(), 60);
  cm = new ConversationManager();
  authProvider = {
    getQrCode: async () => ({
      qrcode: "qr-test-token",
      qrcode_img_content: Buffer.from("fake-png").toString("base64"),
    }),
    getQrCodeStatus: async () => ({
      status: "confirmed",
      bot_token: "bot_token_from_test",
      baseurl: "https://ilinkai.weixin.qq.com",
    }),
    saveQrImage: async (content, outputDir) => {
      fs.mkdirSync(outputDir, { recursive: true });
      const filePath = path.join(outputDir, "wechat-qr.png");
      fs.writeFileSync(filePath, Buffer.from(content, "base64"));
      return filePath;
    },
  };
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe("Feature 07 - frontend admin panel", () => {
  it("1: serves the admin page with the required sections", async () => {
    const base = await startServer();

    const html = await fetchText(`${base}/`);

    expect(html).toContain("WeChat Claude");
    expect(html).toContain("程序运行状态");
    expect(html).toContain("登录二维码");
    expect(html).toContain("历史对话");
    expect(html).toContain("定时任务");
  });

  it("2: exposes program status, local timezone time, counts, and real paths", async () => {
    const session = sm.createSession("user-status");
    cm.addMessage({
      sessionId: session.id,
      userId: session.userId,
      direction: "inbound",
      messageType: 1,
      textContent: "hello status",
      contextToken: "ctx-status",
    });
    const base = await startServer();

    const body = await fetchJson<{ status: Record<string, any> }>(`${base}/api/status`);

    expect(body.status.running).toBe(true);
    expect(body.status.timezone).toBe("Asia/Shanghai");
    expect(body.status.localTime).toContain("2026");
    expect(body.status.counts.sessions).toBe(1);
    expect(body.status.counts.conversations).toBe(1);
    expect(body.status.paths.dataDir).toBe(getTestDataDir());
    expect(body.status.paths.workspaceBase).toBe(getTestWorkspaceBase());
    expect(body.status.paths.dbPath).toBe(path.join(getTestDataDir(), "relay.sqlite"));
  });

  it("3: manages QR image state and saves confirmed bot token", async () => {
    const base = await startServer();

    const created = await fetchJson<{ qrcode: string; auth: Record<string, any> }>(
      `${base}/api/auth/qr`,
      { method: "POST", body: "{}" },
    );
    const qrPath = path.join(getTestDataDir(), "wechat-qr.png");

    expect(created.qrcode).toBe("qr-test-token");
    expect(created.auth.qrImageExists).toBe(true);
    expect(created.auth.qrImageDataUrl).toContain("data:image/png;base64,");
    expect(fs.existsSync(qrPath)).toBe(true);

    const status = await fetchJson<{ tokenSaved: boolean; requiresRestart: boolean }>(
      `${base}/api/auth/qr-status`,
    );

    expect(status.tokenSaved).toBe(true);
    expect(status.requiresRestart).toBe(true);
    expect(fs.readFileSync(path.join(getTestDataDir(), "bot_token.txt"), "utf-8")).toBe(
      "bot_token_from_test",
    );
  });

  it("4: lists all sessions and all conversation messages, not just five", async () => {
    for (let i = 1; i <= 7; i += 1) {
      const session = sm.createSession(`history-user-${i}`);
      sm.updateContextToken(session.id, `ctx-${i}`);
      cm.addMessage({
        sessionId: session.id,
        userId: session.userId,
        direction: "inbound",
        messageType: 1,
        textContent: `用户消息 ${i}`,
        contextToken: `ctx-${i}`,
      });
      cm.addMessage({
        sessionId: session.id,
        userId: session.userId,
        direction: "outbound",
        messageType: 2,
        textContent: `助手回复 ${i}`,
        contextToken: `ctx-${i}`,
      });
    }
    const base = await startServer();

    const body = await fetchJson<{
      sessions: Array<{ id: string; cwd: string; contextToken: string }>;
      conversations: Array<{ textContent: string }>;
    }>(`${base}/api/conversations`);

    expect(body.sessions).toHaveLength(7);
    expect(body.conversations).toHaveLength(14);
    expect(body.sessions.every((item) => item.cwd.includes("session-"))).toBe(true);
    expect(body.sessions.map((item) => item.contextToken)).toContain("ctx-7");
    expect(body.conversations.map((item) => item.textContent)).toContain("助手回复 7");
  });

  it("5: deletes a session and removes its workspace", async () => {
    const session = sm.createSession("delete-user");
    cm.addMessage({
      sessionId: session.id,
      userId: session.userId,
      direction: "inbound",
      messageType: 1,
      textContent: "delete me",
    });
    expect(fs.existsSync(session.cwd)).toBe(true);
    const base = await startServer();

    const deleted = await fetchJson<{ deleted: boolean }>(
      `${base}/api/sessions/${encodeURIComponent(session.id)}`,
      { method: "DELETE" },
    );

    expect(deleted.deleted).toBe(true);
    expect(queryOne("SELECT id FROM sessions WHERE id = ?", [session.id])).toBeNull();
    expect(queryAll("SELECT id FROM conversations WHERE session_id = ?", [session.id])).toHaveLength(0);
    expect(fs.existsSync(session.cwd)).toBe(false);
  });

  it("6: creates, lists, and hides deleted scheduled tasks from the admin API", async () => {
    const base = await startServer();

    const created = await fetchJson<{ task: { id: string; status: string; mode: string } }>(
      `${base}/api/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          userId: "task-user",
          contextToken: "ctx-task",
          title: "新闻任务",
          mode: "agent_prompt",
          payloadText: "帮我找今天的新闻",
          schedule: { type: "once", runAt: "2026-06-16T09:00:00+08:00" },
        }),
      },
    );

    expect(created.task.status).toBe("active");
    expect(created.task.mode).toBe("agent_prompt");

    const listed = await fetchJson<{
      tasks: Array<{ id: string; title: string; status: string; payloadText: string }>;
      drafts: unknown[];
    }>(`${base}/api/tasks`);

    expect(listed.tasks).toHaveLength(1);
    expect(listed.drafts).toHaveLength(0);
    expect(listed.tasks[0]).toMatchObject({
      id: created.task.id,
      title: "新闻任务",
      status: "active",
      payloadText: "帮我找今天的新闻",
    });

    const deleted = await fetchJson<{ deleted: boolean }>(
      `${base}/api/tasks/${encodeURIComponent(created.task.id)}`,
      { method: "DELETE" },
    );

    expect(deleted.deleted).toBe(true);
    const visibleAfterDelete = await fetchJson<{
      tasks: Array<{ id: string; status: string }>;
    }>(`${base}/api/tasks`);
    expect(visibleAfterDelete.tasks).toHaveLength(0);

    const auditList = await fetchJson<{
      tasks: Array<{ id: string; status: string }>;
    }>(`${base}/api/tasks?includeInactive=1`);
    expect(auditList.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: created.task.id,
        status: "cancelled",
      }),
    ]));

    const row = queryOne<{ status: string }>(
      "SELECT status FROM scheduled_tasks WHERE id = ?",
      [created.task.id],
    );
    expect(row?.status).toBe("cancelled");
  });

  it("7: creates weekly direct-send tasks with the current timezone", async () => {
    const base = await startServer();

    const created = await fetchJson<{ task: { timezone: string; scheduleType: string; weekday: number } }>(
      `${base}/api/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          userId: "weekly-user",
          contextToken: "ctx-weekly",
          title: "周会提醒",
          mode: "send_text",
          payloadText: "你要去开会",
          schedule: { type: "weekly", weekday: 2, timeOfDay: "09:30" },
        }),
      },
    );

    expect(created.task.timezone).toBe("Asia/Shanghai");
    expect(created.task.scheduleType).toBe("weekly");
    expect(created.task.weekday).toBe(2);
  });

  it("8: creates daily tasks from the admin API", async () => {
    const base = await startServer();

    const created = await fetchJson<{
      task: {
        timezone: string;
        scheduleType: string;
        timeOfDay: string;
        nextRunAt: string;
      };
    }>(
      `${base}/api/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          userId: "daily-user",
          contextToken: "ctx-daily",
          title: "每日新闻",
          mode: "agent_prompt",
          payloadText: "帮我找今天的新闻",
          schedule: { type: "daily", timeOfDay: "08:30" },
        }),
      },
    );

    expect(created.task.timezone).toBe("Asia/Shanghai");
    expect(created.task.scheduleType).toBe("daily");
    expect(created.task.timeOfDay).toBe("08:30");
    expect(created.task.nextRunAt).toBe(new Date("2026-06-16T08:30:00+08:00").toISOString());
  });
});

async function startServer(): Promise<string> {
  server = createAdminServer({
    dataDir: getTestDataDir(),
    bridgeDataDir: getTestDataDir(),
    workspaceBase: getTestWorkspaceBase(),
    tokenFile: path.join(getTestDataDir(), "bot_token.txt"),
    scheduler,
    startedAt: new Date("2026-06-16T07:55:00+08:00"),
    now: () => now,
    authProvider,
  });
  await server.listen(0);
  return server.url;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await response.text();
  const body = JSON.parse(text) as T & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? text);
  }
  return body;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return text;
}
