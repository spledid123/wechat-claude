/**
 * Feature 06 Test Suite: Scheduled Tasks
 *
 * Covers:
 *   - one-time, daily, and weekly scheduled WeChat sends
 *   - scheduled Agent prompts
 *   - AI tool draft + user confirmation workflow
 *   - list/delete commands
 *   - expired draft/task cleanup
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SchedulerEngine,
  type ScheduledTaskRecord,
} from "./scheduler.js";
import {
  getTestWorkspaceBase,
  resetTestDb,
  setupTestDb,
  teardownTestDb,
} from "../../helpers/db.js";
import { queryAll } from "../01-claude-dialogue/db/connection.js";
import { Bridge } from "../04-bridge/bridge.js";
import { ClaudeManager } from "../01-claude-dialogue/claude/manager.js";
import { SessionManager } from "../01-claude-dialogue/session/manager.js";
import { ConversationManager } from "../01-claude-dialogue/conversation/manager.js";
import { FilePreprocessor } from "../03-file-preprocessing/preprocessor.js";
import {
  MessageOrchestrator,
  type TypingService,
} from "../05-message-orchestration/orchestrator.js";
import type { ParsedMessage } from "../02-wechat-connectivity/wechat/poller.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (_opts: unknown) => {
    async function* gen() {
      yield { type: "assistant" };
      yield { type: "result", result: "mock response" };
    }
    return gen();
  },
  tool: (_name: string, _desc: string, _schema: unknown, _fn: unknown) => ({
    name: _name,
    description: _desc,
    schema: _schema,
    fn: _fn,
  }),
  createSdkMcpServer: (c: unknown) => c,
}));

let now = new Date("2026-06-16T08:00:00+08:00");
let sentTexts: Array<{ toUserId: string; contextToken: string; text: string }>;
let agentCalls: Array<{
  userId: string;
  contextToken: string;
  prompt: string;
  task: ScheduledTaskRecord;
}>;
let scheduler: SchedulerEngine;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  resetTestDb();
  now = new Date("2026-06-16T08:00:00+08:00");
  sentTexts = [];
  agentCalls = [];
  scheduler = new SchedulerEngine({
    timezone: "Asia/Shanghai",
    now: () => now,
    sendText: async (params) => {
      sentTexts.push(params);
    },
    runAgent: async (params) => {
      agentCalls.push(params);
      return `AI结果：${params.prompt}`;
    },
  });
});

function makeMsg(text: string): ParsedMessage {
  return {
    raw: {
      from_user_id: "user@wechat",
      to_user_id: "bot",
      message_type: 1,
      message_state: 2,
      context_token: "ctx_1",
      item_list: [{ type: 1, msg_id: `msg-${text}`, text_item: { text } }],
    },
    text,
    itemTypes: ["text"],
    cdnUrls: [],
    aesKeys: [],
    mediaRefs: [],
    itemMeta: [],
  };
}

describe("Feature 06 - scheduled tasks", () => {
  it("1: uses the configured current timezone", () => {
    expect(scheduler.getTimezone()).toBe("Asia/Shanghai");
  });

  it("2: confirms a one-time direct text task and sends it when due", async () => {
    const draft = scheduler.createDraft({
      userId: "u1",
      contextToken: "ctx1",
      title: "开会提醒",
      mode: "send_text",
      payloadText: "你要去开会",
      schedule: { type: "once", runAt: "2026-06-16T09:00:00+08:00" },
    });

    expect(draft.confirmationText).toContain("回复“确认”创建");
    const confirmed = scheduler.confirmLatestDraft("u1");
    expect(confirmed?.text).toContain("已创建定时任务");

    now = new Date("2026-06-16T09:00:00+08:00");
    const executed = await scheduler.runDueTasks();

    expect(executed).toHaveLength(1);
    expect(sentTexts).toEqual([
      { toUserId: "u1", contextToken: "ctx1", text: "你要去开会" },
    ]);

    const rows = queryAll<{ status: string }>("SELECT status FROM scheduled_tasks");
    expect(rows[0].status).toBe("completed");
  });

  it("2b: one-time task is still executed if the scheduler tick is slightly late", async () => {
    scheduler.createDraft({
      userId: "u1b",
      contextToken: "ctx1b",
      title: "迟到 tick",
      mode: "send_text",
      payloadText: "迟到也要发",
      schedule: { type: "once", runAt: "2026-06-16T09:00:00+08:00" },
    });
    scheduler.confirmLatestDraft("u1b");

    now = new Date("2026-06-16T09:00:31+08:00");
    const executed = await scheduler.runDueTasks();

    expect(executed).toHaveLength(1);
    expect(sentTexts).toEqual([
      { toUserId: "u1b", contextToken: "ctx1b", text: "迟到也要发" },
    ]);
  });

  it("3: weekly direct text task reschedules to the next week", async () => {
    scheduler.createDraft({
      userId: "u2",
      contextToken: "ctx2",
      title: "周会",
      mode: "send_text",
      payloadText: "周会开始了",
      schedule: { type: "weekly", weekday: 2, timeOfDay: "09:30" },
    });
    const task = scheduler.confirmLatestDraft("u2")?.task;

    expect(task?.nextRunAt).toBe(new Date("2026-06-16T09:30:00+08:00").toISOString());

    now = new Date("2026-06-16T09:30:00+08:00");
    await scheduler.runDueTasks();

    expect(sentTexts.map((item) => item.text)).toEqual(["周会开始了"]);
    const active = scheduler.listTasks("u2");
    expect(active[0].nextRunAt).toBe(new Date("2026-06-23T09:30:00+08:00").toISOString());
  });

  it("3b: daily direct text task reschedules to the next day", async () => {
    scheduler.createDraft({
      userId: "u2d",
      contextToken: "ctx2d",
      title: "每日提醒",
      mode: "send_text",
      payloadText: "每天喝水",
      schedule: { type: "daily", timeOfDay: "09:15" },
    });
    const task = scheduler.confirmLatestDraft("u2d")?.task;

    expect(task?.nextRunAt).toBe(new Date("2026-06-16T09:15:00+08:00").toISOString());

    now = new Date("2026-06-16T09:15:00+08:00");
    await scheduler.runDueTasks();

    expect(sentTexts.map((item) => item.text)).toEqual(["每天喝水"]);
    const active = scheduler.listTasks("u2d");
    expect(active[0].nextRunAt).toBe(new Date("2026-06-17T09:15:00+08:00").toISOString());
  });

  it("3c: daily task scheduled earlier today starts tomorrow", () => {
    scheduler.createDraft({
      userId: "u2e",
      contextToken: "ctx2e",
      title: "早间提醒",
      mode: "send_text",
      payloadText: "早安",
      schedule: { type: "daily", timeOfDay: "07:30" },
    });

    const task = scheduler.confirmLatestDraft("u2e")?.task;

    expect(task?.nextRunAt).toBe(new Date("2026-06-17T07:30:00+08:00").toISOString());
  });

  it("4: agent task sends the prompt to Agent and returns its answer to WeChat", async () => {
    scheduler.createDraft({
      userId: "u3",
      contextToken: "ctx3",
      title: "每日新闻",
      mode: "agent_prompt",
      payloadText: "帮我找今天的新闻",
      schedule: { type: "once", runAt: "2026-06-16T10:00:00+08:00" },
    });
    scheduler.confirmLatestDraft("u3");

    now = new Date("2026-06-16T10:00:00+08:00");
    await scheduler.runDueTasks();

    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0].prompt).toBe("帮我找今天的新闻");
    expect(sentTexts).toEqual([
      { toUserId: "u3", contextToken: "ctx3", text: "AI结果：帮我找今天的新闻" },
    ]);
  });

  it("5: AI strict JSON creates a formatted draft without MCP", () => {
    const result = scheduler.createDraftFromAiJson(
      JSON.stringify({
        wechat_schedule_task: {
          title: "新闻",
          mode: "agent_prompt",
          payloadText: "帮我找今天的新闻",
          schedule: { type: "once", runAt: "2026-06-16T10:30:00+08:00" },
        },
      }),
      "u4b",
      "ctx4b",
    );

    expect(result?.confirmationText).toContain("请确认创建定时任务");
    expect(result?.confirmationText).toContain("触发 AI 后发送结果");
    expect(scheduler.confirmLatestDraft("u4b")?.task.mode).toBe("agent_prompt");
  });

  it("5b: AI strict JSON creates a daily draft", () => {
    const result = scheduler.createDraftFromAiJson(
      JSON.stringify({
        wechat_schedule_task: {
          title: "每天新闻",
          mode: "agent_prompt",
          payloadText: "帮我找今天的新闻",
          schedule: { type: "daily", timeOfDay: "08:30" },
        },
      }),
      "u4d",
      "ctx4d",
    );

    expect(result?.confirmationText).toContain("每天 08:30");
    const confirmed = scheduler.confirmLatestDraft("u4d");
    expect(confirmed?.task.scheduleType).toBe("daily");
    expect(confirmed?.task.nextRunAt).toBe(new Date("2026-06-16T08:30:00+08:00").toISOString());
  });

  it("6: commands list, delete, confirm, and cancel drafts", async () => {
    const draftText = await scheduler.handleCommand(
      "/task-draft 2026-06-16 11:00 | 你要去开会",
      "u5",
      "ctx5",
    );
    expect(draftText).toContain("请确认创建定时任务");

    const created = await scheduler.handleCommand("确认", "u5", "ctx5");
    expect(created).toContain("已创建定时任务");

    const list = await scheduler.handleCommand("/tasks", "u5", "ctx5");
    expect(list).toContain("当前定时任务");
    expect(list).toContain("你要去开会");

    const deleted = await scheduler.handleCommand("/task-del 1", "u5", "ctx5");
    expect(deleted).toContain("已删除定时任务");
    expect(await scheduler.handleCommand("/tasks", "u5", "ctx5")).toBe("暂无定时任务。");

    await scheduler.handleCommand("/task-draft weekly 1 09:00 | 每周提醒", "u5", "ctx5");
    expect(await scheduler.handleCommand("取消", "u5", "ctx5")).toBe("已取消待确认的定时任务。");
    expect(await scheduler.handleCommand("确认", "u5", "ctx5")).toBe("没有待确认的定时任务。");

    const dailyDraft = await scheduler.handleCommand("/task-draft daily 09:00 | 每天提醒", "u5", "ctx5");
    expect(dailyDraft).toContain("每天 09:00");
    expect(await scheduler.handleCommand("取消", "u5", "ctx5")).toBe("已取消待确认的定时任务。");
  });

  it("7: expired drafts and very overdue one-time tasks are cleaned up", () => {
    scheduler = new SchedulerEngine({
      timezone: "Asia/Shanghai",
      now: () => now,
      draftTtlMs: 1000,
      expireOnceTasksAfterMs: 60_000,
      sendText: async (params) => {
        sentTexts.push(params);
      },
    });

    scheduler.createDraft({
      userId: "u6",
      contextToken: "ctx6",
      title: "短草稿",
      mode: "send_text",
      payloadText: "快过期",
      schedule: { type: "once", runAt: "2026-06-16T12:00:00+08:00" },
    });

    now = new Date("2026-06-16T08:00:02+08:00");
    expect(scheduler.confirmLatestDraft("u6")).toBeNull();

    now = new Date("2026-06-16T08:00:00+08:00");
    scheduler.createDraft({
      userId: "u6",
      contextToken: "ctx6",
      title: "一次任务",
      mode: "send_text",
      payloadText: "错过了",
      schedule: { type: "once", runAt: "2026-06-16T08:30:00+08:00" },
    });
    scheduler.confirmLatestDraft("u6");

    now = new Date("2026-06-16T08:31:01+08:00");
    expect(scheduler.cleanupExpiredTasks()).toBe(1);
    expect(scheduler.listTasks("u6")).toEqual([]);
  });

  it("8: orchestrator handles scheduler commands immediately without debounce", async () => {
    const delivered: Array<{ text: string }> = [];
    const claude = new ClaudeManager(1);
    const sm = new SessionManager(getTestWorkspaceBase(), 60);
    const cm = new ConversationManager();
    const pp = new FilePreprocessor();
    const bridge = new Bridge(claude, sm, cm, pp, async (params) => {
      delivered.push({ text: params.text });
    });
    const typing: TypingService = {
      start() {
        return { stop() {} };
      },
    };
    const orchestrator = new MessageOrchestrator(
      bridge,
      sm,
      cm,
      typing,
      async (params) => {
        delivered.push({ text: params.text });
      },
      { scheduler },
    );
    const bridgeSpy = vi.spyOn(bridge, "handleMessages");

    await orchestrator.receiveMessage(makeMsg("/tasks"), "u7", "ctx7");

    expect(delivered).toEqual([{ text: "暂无定时任务。" }]);
    expect(bridgeSpy).not.toHaveBeenCalled();
    await orchestrator.flushAll();
    claude.shutdown();
  });

  it("9: orchestrator handles /list immediately and sends only once", async () => {
    const delivered: Array<{ text: string }> = [];
    const claude = new ClaudeManager(1);
    const sm = new SessionManager(getTestWorkspaceBase(), 60);
    const cm = new ConversationManager();
    const pp = new FilePreprocessor();
    const bridge = new Bridge(claude, sm, cm, pp, async (params) => {
      delivered.push({ text: params.text });
    });
    const typing: TypingService = {
      start() {
        return { stop() {} };
      },
    };
    const orchestrator = new MessageOrchestrator(
      bridge,
      sm,
      cm,
      typing,
      async (params) => {
        delivered.push({ text: params.text });
      },
      { scheduler },
    );

    await orchestrator.receiveMessage(makeMsg("/list"), "u8", "ctx8");

    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain("对话");
    await orchestrator.flushAll();
    claude.shutdown();
  });
});
