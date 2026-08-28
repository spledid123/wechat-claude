import crypto from "node:crypto";
import { getDb, queryAll, queryOne } from "../01-claude-dialogue/db/connection.js";

export type ScheduledTaskMode = "send_text" | "agent_prompt";
export type ScheduleType = "once" | "daily" | "weekly";
export type TaskStatus = "active" | "completed" | "cancelled" | "expired";

export interface ScheduledTaskDraftInput {
  userId: string;
  contextToken: string;
  title: string;
  mode: ScheduledTaskMode;
  payloadText: string;
  schedule:
    | { type: "once"; runAt: string }
    | { type: "daily"; timeOfDay: string }
    | { type: "weekly"; weekday: number; timeOfDay: string };
}

export interface ScheduledTaskRecord {
  id: string;
  userId: string;
  contextToken: string;
  title: string;
  mode: ScheduledTaskMode;
  payloadText: string;
  scheduleType: ScheduleType;
  runAt: string | null;
  weekday: number | null;
  timeOfDay: string | null;
  timezone: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string;
  expiresAt: string | null;
}

export interface ScheduledTaskDraftRecord {
  id: string;
  userId: string;
  contextToken: string;
  title: string;
  mode: ScheduledTaskMode;
  payloadText: string;
  scheduleType: ScheduleType;
  runAt: string | null;
  weekday: number | null;
  timeOfDay: string | null;
  timezone: string;
  createdAt: string;
  expiresAt: string;
}

export interface SchedulerSendText {
  (params: { toUserId: string; contextToken: string; text: string }): Promise<void>;
}

export interface SchedulerRunAgent {
  (params: {
    userId: string;
    contextToken: string;
    prompt: string;
    task: ScheduledTaskRecord;
  }): Promise<string>;
}

export interface SchedulerOptions {
  timezone?: string;
  now?: () => Date;
  draftTtlMs?: number;
}

export interface SchedulerEngineOptions extends SchedulerOptions {
  sendText: SchedulerSendText;
  runAgent?: SchedulerRunAgent;
  expireOnceTasksAfterMs?: number;
}

interface TaskRow {
  id: string;
  user_id: string;
  context_token: string;
  title: string;
  mode: ScheduledTaskMode;
  payload_text: string;
  schedule_type: ScheduleType;
  run_at: string | null;
  weekday: number | null;
  time_of_day: string | null;
  timezone: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string;
  expires_at: string | null;
}

interface DraftRow {
  id: string;
  user_id: string;
  context_token: string;
  title: string;
  mode: ScheduledTaskMode;
  payload_text: string;
  schedule_type: ScheduleType;
  run_at: string | null;
  weekday: number | null;
  time_of_day: string | null;
  timezone: string;
  created_at: string;
  expires_at: string;
}

const DEFAULT_DRAFT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ONCE_TASK_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export class SchedulerEngine {
  private readonly timezone: string;
  private readonly now: () => Date;
  private readonly draftTtlMs: number;
  private readonly expireOnceTasksAfterMs: number;
  private readonly sendText: SchedulerSendText;
  private readonly runAgent?: SchedulerRunAgent;
  private runningDueTasks = false;

  constructor(options: SchedulerEngineOptions) {
    ensureSchedulerTables();
    this.timezone = options.timezone ?? getCurrentTimezone();
    this.now = options.now ?? (() => new Date());
    this.draftTtlMs = options.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS;
    this.expireOnceTasksAfterMs = options.expireOnceTasksAfterMs ?? DEFAULT_ONCE_TASK_EXPIRE_AFTER_MS;
    this.sendText = options.sendText;
    this.runAgent = options.runAgent;
  }

  getTimezone(): string {
    return this.timezone;
  }

  createDraft(input: ScheduledTaskDraftInput): {
    draft: ScheduledTaskDraftRecord;
    confirmationText: string;
  } {
    const normalized = normalizeDraftInput(input, this.timezone, this.now());
    const nowIso = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.draftTtlMs).toISOString();
    const id = createId("draft");

    getDb().run(
      `INSERT INTO scheduled_task_drafts
       (id, user_id, context_token, title, mode, payload_text, schedule_type,
        run_at, weekday, time_of_day, timezone, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalized.userId,
        normalized.contextToken,
        normalized.title,
        normalized.mode,
        normalized.payloadText,
        normalized.scheduleType,
        normalized.runAt,
        normalized.weekday,
        normalized.timeOfDay,
        normalized.timezone,
        nowIso,
        expiresAt,
      ],
    );

    const draft = this.getDraft(id);
    if (!draft) {
      throw new Error("Failed to create scheduled task draft.");
    }

    return {
      draft,
      confirmationText: formatDraftConfirmation(draft),
    };
  }

  confirmLatestDraft(userId: string): { task: ScheduledTaskRecord; text: string } | null {
    this.cleanupExpiredDrafts();
    const draft = queryOne<DraftRow>(
      `SELECT * FROM scheduled_task_drafts
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (!draft) {
      return null;
    }

    return this.confirmDraftRow(draft);
  }

  confirmDraft(draftId: string): { task: ScheduledTaskRecord; text: string } | null {
    this.cleanupExpiredDrafts();
    const draft = queryOne<DraftRow>(
      `SELECT * FROM scheduled_task_drafts
       WHERE id = ?
       LIMIT 1`,
      [draftId],
    );
    if (!draft) {
      return null;
    }

    return this.confirmDraftRow(draft);
  }

  private confirmDraftRow(draft: DraftRow): { task: ScheduledTaskRecord; text: string } {
    const nowIso = this.now().toISOString();
    const taskId = createId("task");
    const nextRunAt = computeInitialNextRunAt(mapDraftRow(draft), this.now()).toISOString();

    getDb().run(
      `INSERT INTO scheduled_tasks
       (id, user_id, context_token, title, mode, payload_text, schedule_type,
        run_at, weekday, time_of_day, timezone, status, created_at, updated_at,
        next_run_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [
        taskId,
        draft.user_id,
        draft.context_token,
        draft.title,
        draft.mode,
        draft.payload_text,
        draft.schedule_type,
        draft.run_at,
        draft.weekday,
        draft.time_of_day,
        draft.timezone,
        nowIso,
        nowIso,
        nextRunAt,
        draft.schedule_type === "once"
          ? new Date(new Date(nextRunAt).getTime() + this.expireOnceTasksAfterMs).toISOString()
          : null,
      ],
    );
    getDb().run("DELETE FROM scheduled_task_drafts WHERE id = ?", [draft.id]);

    const task = this.getTask(taskId);
    if (!task) {
      throw new Error("Failed to confirm scheduled task.");
    }

    return {
      task,
      text: `已创建定时任务：\n${formatTaskLine(task)}`,
    };
  }

  cancelLatestDraft(userId: string): boolean {
    const draft = queryOne<{ id: string }>(
      `SELECT id FROM scheduled_task_drafts
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (!draft) return false;
    getDb().run("DELETE FROM scheduled_task_drafts WHERE id = ?", [draft.id]);
    return true;
  }

  listTasks(userId: string): ScheduledTaskRecord[] {
    this.cleanupExpiredTasks();
    return queryAll<TaskRow>(
      `SELECT * FROM scheduled_tasks
       WHERE user_id = ? AND status = 'active'
       ORDER BY next_run_at ASC`,
      [userId],
    ).map(mapTaskRow);
  }

  deleteTask(userId: string, idOrIndex: string): ScheduledTaskRecord | null {
    const tasks = this.listTasks(userId);
    const index = Number.parseInt(idOrIndex, 10);
    const target = Number.isInteger(index) && String(index) === idOrIndex.trim()
      ? tasks[index - 1]
      : tasks.find((task) => task.id === idOrIndex.trim());
    if (!target) {
      return null;
    }

    getDb().run(
      `UPDATE scheduled_tasks
       SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [this.now().toISOString(), target.id, userId],
    );
    return target;
  }

  async runDueTasks(): Promise<ScheduledTaskRecord[]> {
    // Re-entrancy guard: a slow task (e.g. an agent call) can outlast the tick
    // interval. Without this, the next tick re-selects the same still-active row
    // and fires it a second time (double reminders / double agent spend).
    if (this.runningDueTasks) return [];
    this.runningDueTasks = true;
    try {
      return await this.runDueTasksInner();
    } finally {
      this.runningDueTasks = false;
    }
  }

  private async runDueTasksInner(): Promise<ScheduledTaskRecord[]> {
    this.cleanupExpiredDrafts();

    const now = this.now();
    const rows = queryAll<TaskRow>(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
      [now.toISOString()],
    );

    const executed: ScheduledTaskRecord[] = [];
    for (const row of rows) {
      const task = mapTaskRow(row);
      try {
        if (task.mode === "send_text") {
          await this.sendText({
            toUserId: task.userId,
            contextToken: task.contextToken,
            text: task.payloadText,
          });
        } else {
          if (!this.runAgent) {
            await this.sendText({
              toUserId: task.userId,
              contextToken: task.contextToken,
              text: `定时任务“${task.title}”需要触发 AI，但当前未配置 Agent。`,
            });
          } else {
            const reply = await this.runAgent({
              userId: task.userId,
              contextToken: task.contextToken,
              prompt: task.payloadText,
              task,
            });
            await this.sendText({
              toUserId: task.userId,
              contextToken: task.contextToken,
              text: reply.trim() || "(empty response)",
            });
          }
        }
        executed.push(task);
      } catch (err) {
        // One failing task (e.g. an expired context token) must not block the
        // other due tasks this tick. Log and continue.
        console.error(
          `[scheduler] task "${task.title}" (${task.id}) failed: ${(err as Error).message}`,
        );
      }
      // Always advance next_run_at even on failure, so a permanently-broken
      // task does not re-fire on every single tick and starve the others.
      this.markTaskRan(task, now);
    }
    this.cleanupExpiredTasks();
    return executed;
  }

  createDraftFromAiJson(
    text: string,
    userId: string,
    contextToken: string,
  ): { draft: ScheduledTaskDraftRecord; confirmationText: string } | null {
    const payload = parseAiScheduleJson(text);
    if (!payload) {
      return null;
    }

    return this.createDraft({
      userId,
      contextToken,
      title: payload.title,
      mode: payload.mode,
      payloadText: payload.payloadText,
      schedule: payload.schedule,
    });
  }

  async handleCommand(text: string, userId: string, contextToken: string): Promise<string | null> {
    const t = text.trim();
    if (!t) return null;

    if (isConfirmCommand(t)) {
      const confirmed = this.confirmLatestDraft(userId);
      return confirmed?.text ?? "没有待确认的定时任务。";
    }

    if (isCancelDraftCommand(t)) {
      return this.cancelLatestDraft(userId)
        ? "已取消待确认的定时任务。"
        : "没有待取消的定时任务。";
    }

    if (t === "/tasks" || t === "定时任务" || t === "列出定时任务") {
      return this.formatTaskList(userId);
    }

    const deleteMatch = t.match(/^(?:\/task-del|\/task-delete|删除定时任务)\s+(.+)$/);
    if (deleteMatch) {
      const deleted = this.deleteTask(userId, deleteMatch[1]);
      return deleted
        ? `已删除定时任务：${deleted.title}`
        : "没有找到这个定时任务。请先用 /tasks 查看序号或 ID。";
    }

    const draftMatch = t.match(/^(?:\/task-draft|创建定时任务)\s+(.+)$/);
    if (draftMatch) {
      return this.createSimpleTextDraft(userId, contextToken, draftMatch[1]);
    }

    return null;
  }

  formatTaskList(userId: string): string {
    const tasks = this.listTasks(userId);
    if (tasks.length === 0) {
      return "暂无定时任务。";
    }

    return [
      "当前定时任务：",
      ...tasks.map((task, index) => `${index + 1}. ${formatTaskLine(task)}`),
      "删除：/task-del 序号",
    ].join("\n");
  }

  getDraft(id: string): ScheduledTaskDraftRecord | null {
    const row = queryOne<DraftRow>("SELECT * FROM scheduled_task_drafts WHERE id = ?", [id]);
    return row ? mapDraftRow(row) : null;
  }

  getTask(id: string): ScheduledTaskRecord | null {
    const row = queryOne<TaskRow>("SELECT * FROM scheduled_tasks WHERE id = ?", [id]);
    return row ? mapTaskRow(row) : null;
  }

  cleanupExpiredDrafts(): number {
    getDb().run("DELETE FROM scheduled_task_drafts WHERE expires_at <= ?", [
      this.now().toISOString(),
    ]);
    return getDb().getRowsModified();
  }

  cleanupExpiredTasks(): number {
    getDb().run(
      `UPDATE scheduled_tasks
       SET status = 'expired', updated_at = ?
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
      [this.now().toISOString(), this.now().toISOString()],
    );
    return getDb().getRowsModified();
  }

  private createSimpleTextDraft(userId: string, contextToken: string, raw: string): string {
    const parsed = parseSimpleDraft(raw, this.now());
    if (!parsed) {
      return [
        "无法解析定时任务。",
        "格式：/task-draft 2026-06-16 18:30 | 你要去开会",
        "或：/task-draft daily 09:00 | 每天提醒",
        "或：/task-draft weekly 1 09:00 | 每周一提醒",
      ].join("\n");
    }

    return this.createDraft({
      userId,
      contextToken,
      title: parsed.title,
      mode: "send_text",
      payloadText: parsed.payloadText,
      schedule: parsed.schedule,
    }).confirmationText;
  }

  private markTaskRan(task: ScheduledTaskRecord, ranAt: Date): void {
    if (task.scheduleType === "once") {
      getDb().run(
        `UPDATE scheduled_tasks
         SET status = 'completed', last_run_at = ?, updated_at = ?
         WHERE id = ?`,
        [ranAt.toISOString(), ranAt.toISOString(), task.id],
      );
      return;
    }

    const nextRunAt = task.scheduleType === "daily"
      ? computeNextDailyRun(task.timeOfDay ?? "09:00", ranAt)
      : computeNextWeeklyRun(task.weekday ?? 0, task.timeOfDay ?? "09:00", ranAt);
    getDb().run(
      `UPDATE scheduled_tasks
       SET last_run_at = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [ranAt.toISOString(), nextRunAt.toISOString(), ranAt.toISOString(), task.id],
    );
  }
}

export function ensureSchedulerTables(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      context_token TEXT NOT NULL,
      title TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('send_text','agent_prompt')),
      payload_text TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once','daily','weekly')),
      run_at TEXT,
      weekday INTEGER,
      time_of_day TEXT,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled','expired')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_at TEXT,
      next_run_at TEXT NOT NULL,
      expires_at TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_task_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      context_token TEXT NOT NULL,
      title TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('send_text','agent_prompt')),
      payload_text TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once','daily','weekly')),
      run_at TEXT,
      weekday INTEGER,
      time_of_day TEXT,
      timezone TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
}

function normalizeDraftInput(
  input: ScheduledTaskDraftInput,
  timezone: string,
  now: Date,
): Omit<ScheduledTaskDraftRecord, "id" | "createdAt" | "expiresAt"> {
  const title = input.title.trim();
  const payloadText = input.payloadText.trim();
  if (!input.userId.trim()) throw new Error("userId is required.");
  if (!input.contextToken.trim()) throw new Error("contextToken is required.");
  if (!title) throw new Error("title is required.");
  if (!payloadText) throw new Error("payloadText is required.");

  if (input.schedule.type === "once") {
    const runAt = parseDate(input.schedule.runAt);
    if (runAt.getTime() <= now.getTime()) {
      throw new Error("runAt must be in the future.");
    }
    return {
      userId: input.userId,
      contextToken: input.contextToken,
      title,
      mode: input.mode,
      payloadText,
      scheduleType: "once",
      runAt: runAt.toISOString(),
      weekday: null,
      timeOfDay: null,
      timezone,
    };
  }

  if (input.schedule.type === "daily") {
    if (!isTimeOfDay(input.schedule.timeOfDay)) {
      throw new Error("timeOfDay must be HH:mm.");
    }

    return {
      userId: input.userId,
      contextToken: input.contextToken,
      title,
      mode: input.mode,
      payloadText,
      scheduleType: "daily",
      runAt: null,
      weekday: null,
      timeOfDay: input.schedule.timeOfDay,
      timezone,
    };
  }

  if (!Number.isInteger(input.schedule.weekday) || input.schedule.weekday < 0 || input.schedule.weekday > 6) {
    throw new Error("weekday must be an integer from 0 to 6.");
  }
  if (!isTimeOfDay(input.schedule.timeOfDay)) {
    throw new Error("timeOfDay must be HH:mm.");
  }

  return {
    userId: input.userId,
    contextToken: input.contextToken,
    title,
    mode: input.mode,
    payloadText,
    scheduleType: "weekly",
    runAt: null,
    weekday: input.schedule.weekday,
    timeOfDay: input.schedule.timeOfDay,
    timezone,
  };
}

function computeInitialNextRunAt(
  draft: ScheduledTaskDraftRecord,
  now: Date,
): Date {
  if (draft.scheduleType === "once") {
    return parseDate(draft.runAt ?? "");
  }
  if (draft.scheduleType === "daily") {
    return computeNextDailyRun(draft.timeOfDay ?? "09:00", now);
  }
  return computeNextWeeklyRun(draft.weekday ?? 0, draft.timeOfDay ?? "09:00", now);
}

function computeNextDailyRun(timeOfDay: string, after: Date): Date {
  const [hour, minute] = timeOfDay.split(":").map((part) => Number.parseInt(part, 10));
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= after.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function computeNextWeeklyRun(weekday: number, timeOfDay: string, after: Date): Date {
  const [hour, minute] = timeOfDay.split(":").map((part) => Number.parseInt(part, 10));
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  const currentDay = next.getDay();
  let dayDelta = weekday - currentDay;
  if (dayDelta < 0 || (dayDelta === 0 && next.getTime() <= after.getTime())) {
    dayDelta += 7;
  }
  next.setDate(next.getDate() + dayDelta);
  return next;
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function parseAiScheduleJson(text: string): ScheduledTaskDraftInput | null {
  const raw = extractJsonText(text);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const wrapper = asRecord(parsed)?.wechat_schedule_task;
  const task = asRecord(wrapper);
  if (!task) return null;

  const title = typeof task.title === "string" ? task.title : "";
  const mode: ScheduledTaskMode = task.mode === "agent_prompt" ? "agent_prompt" : "send_text";
  const payloadText = typeof task.payloadText === "string" ? task.payloadText : "";
  const scheduleRaw = asRecord(task.schedule);
  if (!scheduleRaw) return null;

  if (scheduleRaw.type === "weekly") {
    return {
      userId: "",
      contextToken: "",
      title,
      mode,
      payloadText,
      schedule: {
        type: "weekly",
        weekday: Number(scheduleRaw.weekday),
        timeOfDay: typeof scheduleRaw.timeOfDay === "string" ? scheduleRaw.timeOfDay : "",
      },
    };
  }

  if (scheduleRaw.type === "daily") {
    return {
      userId: "",
      contextToken: "",
      title,
      mode,
      payloadText,
      schedule: {
        type: "daily",
        timeOfDay: typeof scheduleRaw.timeOfDay === "string" ? scheduleRaw.timeOfDay : "",
      },
    };
  }

  if (scheduleRaw.type === "once") {
    return {
      userId: "",
      contextToken: "",
      title,
      mode,
      payloadText,
      schedule: {
        type: "once",
        runAt: typeof scheduleRaw.runAt === "string" ? scheduleRaw.runAt : "",
      },
    };
  }

  return null;
}

function extractJsonText(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isTimeOfDay(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function formatDraftConfirmation(draft: ScheduledTaskDraftRecord): string {
  return [
    "请确认创建定时任务：",
    `标题：${draft.title}`,
    `类型：${draft.mode === "send_text" ? "直接发送微信文本" : "触发 AI 后发送结果"}`,
    `时间：${formatSchedule(draft)}`,
    `内容：${draft.payloadText}`,
    "",
    "回复“确认”创建，回复“取消”放弃。",
  ].join("\n");
}

function formatTaskLine(task: ScheduledTaskRecord): string {
  return [
    `${task.title}`,
    `ID=${task.id}`,
    task.mode === "send_text" ? "直接发送" : "触发AI",
    formatSchedule(task),
    `下次=${formatDateTime(task.nextRunAt)}`,
  ].join(" | ");
}

function formatSchedule(task: Pick<ScheduledTaskRecord | ScheduledTaskDraftRecord, "scheduleType" | "runAt" | "weekday" | "timeOfDay" | "timezone">): string {
  if (task.scheduleType === "once") {
    return `${formatDateTime(task.runAt ?? "")} (${task.timezone})`;
  }
  if (task.scheduleType === "daily") {
    return `每天 ${task.timeOfDay} (${task.timezone})`;
  }
  return `每${WEEKDAY_NAMES[task.weekday ?? 0]} ${task.timeOfDay} (${task.timezone})`;
}

function formatDateTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function parseSimpleDraft(
  raw: string,
  now: Date,
): {
  title: string;
  payloadText: string;
  schedule: ScheduledTaskDraftInput["schedule"];
} | null {
  const [left, ...rightParts] = raw.split("|");
  const payloadText = rightParts.join("|").trim();
  if (!left?.trim() || !payloadText) return null;

  const weekly = left.trim().match(/^weekly\s+([0-6])\s+(\d{2}:\d{2})$/i);
  if (weekly) {
    return {
      title: payloadText.slice(0, 24),
      payloadText,
      schedule: {
        type: "weekly",
        weekday: Number.parseInt(weekly[1], 10),
        timeOfDay: weekly[2],
      },
    };
  }

  const daily = left.trim().match(/^daily\s+(\d{2}:\d{2})$/i);
  if (daily) {
    return {
      title: payloadText.slice(0, 24),
      payloadText,
      schedule: {
        type: "daily",
        timeOfDay: daily[1],
      },
    };
  }

  const once = left.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (!once) return null;

  const runAt = new Date(`${once[1]}T${once[2]}:00`);
  if (Number.isNaN(runAt.getTime()) || runAt.getTime() <= now.getTime()) return null;

  return {
    title: payloadText.slice(0, 24),
    payloadText,
    schedule: {
      type: "once",
      runAt: runAt.toISOString(),
    },
  };
}

function mapTaskRow(row: TaskRow): ScheduledTaskRecord {
  return {
    id: row.id,
    userId: row.user_id,
    contextToken: row.context_token,
    title: row.title,
    mode: row.mode,
    payloadText: row.payload_text,
    scheduleType: row.schedule_type,
    runAt: row.run_at,
    weekday: row.weekday,
    timeOfDay: row.time_of_day,
    timezone: row.timezone,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    expiresAt: row.expires_at,
  };
}

function mapDraftRow(row: DraftRow): ScheduledTaskDraftRecord {
  return {
    id: row.id,
    userId: row.user_id,
    contextToken: row.context_token,
    title: row.title,
    mode: row.mode,
    payloadText: row.payload_text,
    scheduleType: row.schedule_type,
    runAt: row.run_at,
    weekday: row.weekday,
    timeOfDay: row.time_of_day,
    timezone: row.timezone,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function isConfirmCommand(value: string): boolean {
  return value === "确认" || value === "确定" || value.toLowerCase() === "/confirm";
}

function isCancelDraftCommand(value: string): boolean {
  return value === "取消" || value.toLowerCase() === "/cancel";
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function getCurrentTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}
