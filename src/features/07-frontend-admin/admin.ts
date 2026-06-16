import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  execute,
  queryAll,
  queryOne,
} from "../01-claude-dialogue/db/connection.js";
import {
  SchedulerEngine,
  type ScheduleType,
  type ScheduledTaskDraftInput,
  type ScheduledTaskMode,
  type ScheduledTaskRecord,
  type TaskStatus,
} from "../06-scheduler/scheduler.js";
import { getBotQrCode, getQrCodeStatus } from "../02-wechat-connectivity/wechat/api.js";
import { saveQrImage } from "../02-wechat-connectivity/wechat/auth.js";
import type {
  QrCodeResponse,
  QrCodeStatusResponse,
} from "../02-wechat-connectivity/wechat/types.js";

export interface AdminAuthProvider {
  getQrCode(): Promise<QrCodeResponse>;
  getQrCodeStatus(qrcode: string): Promise<QrCodeStatusResponse>;
  saveQrImage(content: string, outputDir: string): Promise<string>;
}

export interface AdminServerOptions {
  dataDir: string;
  bridgeDataDir: string;
  workspaceBase: string;
  tokenFile: string;
  scheduler: SchedulerEngine;
  startedAt?: Date;
  now?: () => Date;
  authProvider?: AdminAuthProvider;
}

interface CountRow {
  count: number;
}

interface SessionRow {
  id: string;
  userId: number;
  fromUserId: string;
  contextToken: string | null;
  claudeSessionId: string | null;
  cwd: string;
  status: string;
  summary: string | null;
  toolMode: string | null;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
  closedAt: string | null;
  closedReason: string | null;
}

interface ConversationRow {
  id: number;
  sessionId: string;
  seqInSession: number;
  direction: string;
  messageType: number;
  textContent: string | null;
  fileRefs: string | null;
  contextToken: string | null;
  createdAt: string;
}

interface TaskRow {
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

interface DraftRow {
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

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

export function createAdminServer(options: AdminServerOptions): AdminServer {
  return new AdminServer(options);
}

export class AdminServer {
  private readonly server: http.Server;
  private readonly startedAt: Date;
  private readonly now: () => Date;
  private readonly authProvider: AdminAuthProvider;
  private lastQrCode = "";

  constructor(private readonly options: AdminServerOptions) {
    this.startedAt = options.startedAt ?? new Date();
    this.now = options.now ?? (() => new Date());
    this.authProvider = options.authProvider ?? {
      getQrCode: getBotQrCode,
      getQrCodeStatus,
      saveQrImage,
    };
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        this.sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  listen(port = DEFAULT_PORT, host = DEFAULT_HOST): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address ? (address as AddressInfo).port : 0;
  }

  get url(): string {
    return `http://${DEFAULT_HOST}:${this.port}`;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/") {
      this.sendHtml(res, renderAdminPage());
      return;
    }

    if (method === "GET" && url.pathname === "/api/status") {
      this.sendJson(res, 200, { ok: true, status: this.buildStatus() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/auth") {
      this.sendJson(res, 200, { ok: true, auth: this.buildAuthState() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/qr") {
      const qr = await this.authProvider.getQrCode();
      if (!qr.qrcode) {
        this.sendJson(res, 502, { ok: false, error: "WeChat did not return qrcode." });
        return;
      }
      this.lastQrCode = qr.qrcode;
      if (qr.qrcode_img_content) {
        await this.authProvider.saveQrImage(qr.qrcode_img_content, this.options.dataDir);
      }
      this.sendJson(res, 200, {
        ok: true,
        qrcode: qr.qrcode,
        auth: this.buildAuthState(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/auth/qr-status") {
      const qrcode = url.searchParams.get("qrcode") || this.lastQrCode;
      if (!qrcode) {
        this.sendJson(res, 400, { ok: false, error: "qrcode is required." });
        return;
      }
      const status = await this.authProvider.getQrCodeStatus(qrcode);
      let tokenSaved = false;
      if (status.status === "confirmed" && status.bot_token) {
        fs.mkdirSync(path.dirname(this.options.tokenFile), { recursive: true });
        fs.writeFileSync(this.options.tokenFile, status.bot_token, "utf-8");
        tokenSaved = true;
      }
      this.sendJson(res, 200, {
        ok: true,
        qrStatus: status.status,
        tokenSaved,
        requiresRestart: tokenSaved,
        auth: this.buildAuthState(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/conversations") {
      this.sendJson(res, 200, { ok: true, ...this.listConversations() });
      return;
    }

    const sessionDelete = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === "DELETE" && sessionDelete) {
      this.sendJson(res, 200, {
        ok: true,
        deleted: this.deleteSession(decodeURIComponent(sessionDelete[1])),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/tasks") {
      this.sendJson(res, 200, {
        ok: true,
        ...this.listTasks({
          includeInactive: isTruthy(url.searchParams.get("includeInactive")),
        }),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/tasks") {
      const body = await readJsonBody(req);
      this.sendJson(res, 201, {
        ok: true,
        ...this.createTask(body),
      });
      return;
    }

    const taskDelete = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === "DELETE" && taskDelete) {
      this.sendJson(res, 200, {
        ok: true,
        deleted: this.cancelTask(decodeURIComponent(taskDelete[1])),
      });
      return;
    }

    this.sendJson(res, 404, { ok: false, error: "Not found." });
  }

  private buildStatus(): Record<string, unknown> {
    const now = this.now();
    const timezone = this.options.scheduler.getTimezone();
    const dbPath = path.join(this.options.bridgeDataDir, "relay.sqlite");
    const sessionCount = scalar("SELECT COUNT(*) AS count FROM sessions");
    const activeSessionCount = scalar("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'");
    const conversationCount = scalar("SELECT COUNT(*) AS count FROM conversations");
    const activeTaskCount = scalar("SELECT COUNT(*) AS count FROM scheduled_tasks WHERE status = 'active'");
    const pendingDraftCount = scalar("SELECT COUNT(*) AS count FROM scheduled_task_drafts");

    return {
      running: true,
      pid: process.pid,
      node: process.version,
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Math.max(0, now.getTime() - this.startedAt.getTime()),
      now: now.toISOString(),
      localTime: formatLocalDateTime(now, timezone),
      timezone,
      paths: {
        cwd: process.cwd(),
        dataDir: this.options.dataDir,
        bridgeDataDir: this.options.bridgeDataDir,
        dbPath,
        workspaceBase: this.options.workspaceBase,
        tokenFile: this.options.tokenFile,
        qrImagePath: getQrImagePath(this.options.dataDir),
      },
      counts: {
        sessions: sessionCount,
        activeSessions: activeSessionCount,
        conversations: conversationCount,
        activeTasks: activeTaskCount,
        pendingDrafts: pendingDraftCount,
      },
      auth: this.buildAuthState(),
    };
  }

  private buildAuthState(): Record<string, unknown> {
    const qrImagePath = getQrImagePath(this.options.dataDir);
    const token = readTrimmedFile(this.options.tokenFile);
    const qrExists = fs.existsSync(qrImagePath);

    return {
      tokenPresent: Boolean(token),
      tokenPreview: token ? `${token.slice(0, 10)}...` : "",
      tokenFile: this.options.tokenFile,
      qrImagePath,
      qrImageExists: qrExists,
      qrImageDataUrl: qrExists ? fileToPngDataUrl(qrImagePath) : "",
      lastQrCode: this.lastQrCode,
    };
  }

  private listConversations(): {
    sessions: SessionRow[];
    conversations: ConversationRow[];
  } {
    const sessions = queryAll<SessionRow>(
      `SELECT id,
              user_id AS userId,
              from_user_id AS fromUserId,
              context_token AS contextToken,
              claude_session_id AS claudeSessionId,
              cwd,
              status,
              summary,
              tool_mode AS toolMode,
              message_count AS messageCount,
              last_active_at AS lastActiveAt,
              created_at AS createdAt,
              closed_at AS closedAt,
              closed_reason AS closedReason
       FROM sessions
       ORDER BY last_active_at DESC`,
    );

    const conversations = queryAll<ConversationRow>(
      `SELECT id,
              session_id AS sessionId,
              seq_in_session AS seqInSession,
              direction,
              message_type AS messageType,
              text_content AS textContent,
              file_refs AS fileRefs,
              context_token AS contextToken,
              created_at AS createdAt
       FROM conversations
       ORDER BY created_at ASC, id ASC`,
    );

    return { sessions, conversations };
  }

  private deleteSession(sessionId: string): boolean {
    const row = queryOne<{ cwd: string }>("SELECT cwd FROM sessions WHERE id = ?", [sessionId]);
    if (!row) return false;

    execute("DELETE FROM conversations WHERE session_id = ?", [sessionId]);
    execute("DELETE FROM turns WHERE session_id = ?", [sessionId]);
    execute("DELETE FROM sessions WHERE id = ?", [sessionId]);

    if (row.cwd && fs.existsSync(row.cwd)) {
      fs.rmSync(row.cwd, { recursive: true, force: true });
    }
    return true;
  }

  private listTasks(options: { includeInactive?: boolean } = {}): {
    tasks: TaskRow[];
    drafts: DraftRow[];
  } {
    const taskWhere = options.includeInactive ? "" : "WHERE status = 'active'";
    const tasks = queryAll<TaskRow>(
      `SELECT id,
              user_id AS userId,
              context_token AS contextToken,
              title,
              mode,
              payload_text AS payloadText,
              schedule_type AS scheduleType,
              run_at AS runAt,
              weekday,
              time_of_day AS timeOfDay,
              timezone,
              status,
              created_at AS createdAt,
              updated_at AS updatedAt,
              last_run_at AS lastRunAt,
              next_run_at AS nextRunAt,
              expires_at AS expiresAt
       FROM scheduled_tasks
       ${taskWhere}
       ORDER BY status ASC, next_run_at ASC`,
    );

    const drafts = queryAll<DraftRow>(
      `SELECT id,
              user_id AS userId,
              context_token AS contextToken,
              title,
              mode,
              payload_text AS payloadText,
              schedule_type AS scheduleType,
              run_at AS runAt,
              weekday,
              time_of_day AS timeOfDay,
              timezone,
              created_at AS createdAt,
              expires_at AS expiresAt
       FROM scheduled_task_drafts
       ORDER BY created_at DESC`,
    );

    return { tasks, drafts };
  }

  private createTask(value: unknown): {
    confirmationText: string;
    task: ScheduledTaskRecord;
  } {
    const input = parseTaskInput(value);
    const draft = this.options.scheduler.createDraft(input);
    const confirmed = this.options.scheduler.confirmDraft(draft.draft.id);
    if (!confirmed) {
      throw new Error("Failed to confirm scheduled task.");
    }
    return {
      confirmationText: draft.confirmationText,
      task: confirmed.task,
    };
  }

  private cancelTask(taskId: string): boolean {
    const existing = queryOne<{ id: string }>(
      "SELECT id FROM scheduled_tasks WHERE id = ?",
      [taskId],
    );
    if (!existing) return false;

    execute(
      `UPDATE scheduled_tasks
       SET status = 'cancelled', updated_at = ?
       WHERE id = ?`,
      [this.now().toISOString(), taskId],
    );
    return true;
  }

  private sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body, null, 2));
  }
}

function scalar(sql: string): number {
  return Number(queryOne<CountRow>(sql)?.count ?? 0);
}

function getQrImagePath(dataDir: string): string {
  return path.join(dataDir, "wechat-qr.png");
}

function readTrimmedFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

function fileToPngDataUrl(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return `data:image/png;base64,${content.toString("base64")}`;
}

function formatLocalDateTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function parseTaskInput(value: unknown): ScheduledTaskDraftInput {
  const raw = asRecord(value);
  if (!raw) throw new Error("Task payload must be an object.");

  const userId = requiredString(raw.userId, "userId");
  const contextToken = requiredString(raw.contextToken, "contextToken");
  const title = requiredString(raw.title, "title");
  const payloadText = requiredString(raw.payloadText, "payloadText");
  const mode = raw.mode === "agent_prompt" ? "agent_prompt" : "send_text";
  const scheduleRaw = asRecord(raw.schedule);
  if (!scheduleRaw) throw new Error("schedule is required.");

  if (scheduleRaw.type === "weekly") {
    return {
      userId,
      contextToken,
      title,
      mode,
      payloadText,
      schedule: {
        type: "weekly",
        weekday: Number(scheduleRaw.weekday),
        timeOfDay: requiredString(scheduleRaw.timeOfDay, "schedule.timeOfDay"),
      },
    };
  }

  if (scheduleRaw.type === "daily") {
    return {
      userId,
      contextToken,
      title,
      mode,
      payloadText,
      schedule: {
        type: "daily",
        timeOfDay: requiredString(scheduleRaw.timeOfDay, "schedule.timeOfDay"),
      },
    };
  }

  if (scheduleRaw.type === "once") {
    return {
      userId,
      contextToken,
      title,
      mode,
      payloadText,
      schedule: {
        type: "once",
        runAt: requiredString(scheduleRaw.runAt, "schedule.runAt"),
      },
    };
  }

  throw new Error("schedule.type must be once, daily, or weekly.");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isTruthy(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WeChat Claude Admin</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #18221d;
      --muted: #657369;
      --paper: #f7f1e3;
      --panel: rgba(255, 252, 241, 0.88);
      --line: rgba(32, 58, 45, 0.16);
      --green: #2f6b4f;
      --green-dark: #17452f;
      --gold: #c7892d;
      --red: #b94835;
      --shadow: 0 22px 60px rgba(24, 34, 29, 0.16);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: "Aptos", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 12% 10%, rgba(199, 137, 45, 0.28), transparent 34rem),
        radial-gradient(circle at 85% 5%, rgba(47, 107, 79, 0.22), transparent 30rem),
        linear-gradient(135deg, #f6ecd6 0%, #edf3e4 55%, #f8f4e8 100%);
    }
    header {
      padding: 44px min(5vw, 64px) 22px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 24px;
    }
    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(34px, 5vw, 64px);
      letter-spacing: -0.05em;
      line-height: 0.9;
    }
    .subtitle { color: var(--muted); max-width: 700px; margin-top: 14px; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    main {
      display: grid;
      grid-template-columns: minmax(300px, 0.9fr) minmax(360px, 1.4fr);
      gap: 18px;
      padding: 0 min(5vw, 64px) 54px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      padding: 22px;
      backdrop-filter: blur(18px);
      animation: rise 420ms ease both;
    }
    section:nth-child(2) { animation-delay: 60ms; }
    section:nth-child(3) { animation-delay: 120ms; }
    section:nth-child(4) { animation-delay: 180ms; }
    h2 { margin: 0 0 16px; font-size: 18px; }
    button, input, select, textarea {
      font: inherit;
      border-radius: 14px;
      border: 1px solid var(--line);
    }
    button {
      cursor: pointer;
      background: var(--green);
      color: #fffdf4;
      border: 0;
      padding: 10px 14px;
      font-weight: 700;
    }
    button.secondary { background: #fff8e8; color: var(--green-dark); border: 1px solid var(--line); }
    button.danger { background: var(--red); }
    input, select, textarea {
      width: 100%;
      background: rgba(255,255,255,0.72);
      padding: 10px 12px;
      color: var(--ink);
    }
    textarea { min-height: 82px; resize: vertical; }
    label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
    code {
      display: inline-block;
      max-width: 100%;
      overflow-wrap: anywhere;
      color: var(--green-dark);
      background: rgba(47, 107, 79, 0.08);
      padding: 2px 6px;
      border-radius: 8px;
    }
    .stack { display: grid; gap: 12px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { padding: 12px; border-radius: 18px; background: rgba(255,255,255,0.54); border: 1px solid var(--line); }
    .metric strong { display:block; font-size: 24px; letter-spacing: -0.03em; }
    .muted { color: var(--muted); }
    .pill { display:inline-flex; gap:6px; align-items:center; padding: 4px 9px; border-radius:999px; background:rgba(47,107,79,.1); color:var(--green-dark); font-size:12px; font-weight:700; }
    .row { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 0; border-top:1px solid var(--line); }
    .row:first-child { border-top:0; }
    .row-main { min-width:0; }
    .row-main p { margin: 4px 0 0; color: var(--muted); overflow-wrap:anywhere; }
    .qr { width: 210px; max-width:100%; border-radius:20px; background:#fff; padding:8px; border:1px solid var(--line); }
    .wide { grid-column: 1 / -1; }
    .message { padding:10px 12px; border-radius:16px; background:rgba(255,255,255,.55); margin:8px 0; }
    .message.outbound { border-left:4px solid var(--gold); }
    .message.inbound { border-left:4px solid var(--green); }
    .tiny { font-size:12px; color:var(--muted); }
    @keyframes rise { from { opacity:0; transform: translateY(12px); } to { opacity:1; transform: translateY(0); } }
    @media (max-width: 900px) {
      header { display:block; }
      .toolbar { justify-content:flex-start; margin-top:18px; }
      main { grid-template-columns: 1fr; }
      .grid, .metric-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>WeChat Claude<br>Control Room</h1>
      <p class="subtitle">本地管理面板：查看运行状态、登录二维码、真实路径、全部历史对话，以及创建/删除定时任务。</p>
    </div>
    <div class="toolbar">
      <button id="refresh">刷新全部</button>
      <button id="refreshQr" class="secondary">刷新二维码</button>
      <button id="pollQr" class="secondary">轮询扫码状态</button>
    </div>
  </header>

  <main>
    <section>
      <h2>程序运行状态</h2>
      <div id="status" class="stack muted">加载中...</div>
    </section>

    <section>
      <h2>登录二维码</h2>
      <div id="auth" class="stack muted">加载中...</div>
    </section>

    <section class="wide">
      <h2>历史对话（全部）</h2>
      <div id="conversations" class="stack muted">加载中...</div>
    </section>

    <section class="wide">
      <h2>定时任务</h2>
      <form id="taskForm" class="stack">
        <div class="grid">
          <label>用户 ID<input name="userId" placeholder="from_user_id" required></label>
          <label>context_token<input name="contextToken" placeholder="微信 context_token" required></label>
          <label>标题<input name="title" placeholder="开会提醒" required></label>
          <label>模式<select name="mode"><option value="send_text">直接发微信文本</option><option value="agent_prompt">触发 AI 后发送结果</option></select></label>
          <label>计划类型<select name="scheduleType"><option value="once">一次性</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
          <label>一次性时间<input name="runAt" type="datetime-local"></label>
          <label>每周星期<select name="weekday"><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select></label>
          <label>每天/每周时间<input name="timeOfDay" type="time" value="09:00"></label>
        </div>
        <label>文本 / Agent 提示词<textarea name="payloadText" placeholder="你要去开会 / 帮我找今天的新闻" required></textarea></label>
        <button type="submit">创建定时任务</button>
      </form>
      <div id="tasks" class="stack muted" style="margin-top:18px;">加载中...</div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const api = async (path, options = {}) => {
      const res = await fetch(path, {
        headers: { "content-type": "application/json", ...(options.headers || {}) },
        ...options,
      });
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || "request failed");
      return body;
    };
    const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    const short = (value) => {
      const text = String(value ?? "");
      return text.length > 120 ? text.slice(0, 117) + "..." : text;
    };

    async function loadStatus() {
      const { status } = await api("/api/status");
      $("status").innerHTML = \`
        <div class="metric-grid">
          <div class="metric"><span class="tiny">会话</span><strong>\${status.counts.sessions}</strong></div>
          <div class="metric"><span class="tiny">消息</span><strong>\${status.counts.conversations}</strong></div>
          <div class="metric"><span class="tiny">任务</span><strong>\${status.counts.activeTasks}</strong></div>
        </div>
        <div><span class="pill">运行中</span> 本地时间：<strong>\${safe(status.localTime)}</strong> <span class="muted">(\${safe(status.timezone)})</span></div>
        <div>启动时间：<code>\${safe(status.startedAt)}</code></div>
        <div>PID：<code>\${safe(status.pid)}</code></div>
        <div>数据目录：<code>\${safe(status.paths.dataDir)}</code></div>
        <div>数据库：<code>\${safe(status.paths.dbPath)}</code></div>
        <div>工作区根目录：<code>\${safe(status.paths.workspaceBase)}</code></div>
      \`;
    }

    async function loadAuth() {
      const { auth } = await api("/api/auth");
      $("auth").innerHTML = \`
        <div>Token：\${auth.tokenPresent ? '<span class="pill">已存在</span> <code>' + safe(auth.tokenPreview) + '</code>' : '<span class="pill">未配置</span>'}</div>
        <div>Token 文件：<code>\${safe(auth.tokenFile)}</code></div>
        <div>二维码文件：<code>\${safe(auth.qrImagePath)}</code></div>
        \${auth.qrImageDataUrl ? '<img class="qr" src="' + safe(auth.qrImageDataUrl) + '" alt="WeChat QR">' : '<div class="muted">暂无二维码，点击“刷新二维码”。</div>'}
        \${auth.lastQrCode ? '<div class="tiny">当前 qrcode：<code>' + safe(auth.lastQrCode) + '</code></div>' : ''}
      \`;
    }

    async function loadConversations() {
      const { sessions, conversations } = await api("/api/conversations");
      const bySession = new Map();
      conversations.forEach((msg) => {
        if (!bySession.has(msg.sessionId)) bySession.set(msg.sessionId, []);
        bySession.get(msg.sessionId).push(msg);
      });
      $("conversations").innerHTML = sessions.length ? sessions.map((s) => {
        const msgs = bySession.get(s.id) || [];
        return \`
          <div class="row">
            <div class="row-main">
              <strong>\${safe(s.fromUserId)}</strong> <span class="pill">\${safe(s.status)}</span>
              <p>ID：<code>\${safe(s.id)}</code></p>
              <p>实际工作目录：<code>\${safe(s.cwd)}</code></p>
              <p>context_token：<code>\${safe(s.contextToken || "")}</code></p>
              <p>最后活动：\${safe(s.lastActiveAt)}，消息数：\${safe(s.messageCount)}</p>
              <div>\${msgs.map((m) => \`<div class="message \${safe(m.direction)}"><span class="tiny">#\${safe(m.seqInSession)} \${safe(m.direction)} \${safe(m.createdAt)}</span><br>\${safe(short(m.textContent || m.fileRefs || ""))}</div>\`).join("")}</div>
            </div>
            <button class="danger" data-delete-session="\${safe(s.id)}">删除</button>
          </div>
        \`;
      }).join("") : "暂无历史对话";
    }

    async function loadTasks() {
      const { tasks, drafts } = await api("/api/tasks");
      const taskHtml = tasks.length ? tasks.map((t) => \`
        <div class="row">
          <div class="row-main">
            <strong>\${safe(t.title)}</strong> <span class="pill">\${safe(t.status)}</span> <span class="pill">\${safe(t.mode)}</span>
            <p>ID：<code>\${safe(t.id)}</code></p>
            <p>用户：<code>\${safe(t.userId)}</code> context：<code>\${safe(t.contextToken)}</code></p>
            <p>计划：\${t.scheduleType === "once" ? safe(t.runAt) : t.scheduleType === "daily" ? "每天 " + safe(t.timeOfDay) : "每周 " + safe(t.weekday) + " " + safe(t.timeOfDay)}；下次：<code>\${safe(t.nextRunAt)}</code></p>
            <p>\${safe(short(t.payloadText))}</p>
          </div>
          <button class="danger" data-delete-task="\${safe(t.id)}">删除</button>
        </div>
      \`).join("") : "暂无定时任务";
      const draftHtml = drafts.length ? \`<h3>待确认草稿</h3>\${drafts.map((d) => \`<div class="message"><strong>\${safe(d.title)}</strong><br><span class="tiny">\${safe(d.userId)}，过期：\${safe(d.expiresAt)}</span></div>\`).join("")}\` : "";
      $("tasks").innerHTML = taskHtml + draftHtml;
    }

    async function refreshAll() {
      await Promise.all([loadStatus(), loadAuth(), loadConversations(), loadTasks()]);
    }

    $("refresh").addEventListener("click", () => refreshAll().catch(alert));
    $("refreshQr").addEventListener("click", async () => {
      await api("/api/auth/qr", { method: "POST", body: "{}" });
      await loadAuth();
    });
    $("pollQr").addEventListener("click", async () => {
      const result = await api("/api/auth/qr-status");
      alert(result.tokenSaved ? "扫码确认成功，token 已保存；请重启 bridge 让发送链路使用新 token。" : "当前状态：" + result.qrStatus);
      await loadAuth();
    });
    $("taskForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const scheduleType = form.get("scheduleType");
      const payload = {
        userId: form.get("userId"),
        contextToken: form.get("contextToken"),
        title: form.get("title"),
        mode: form.get("mode"),
        payloadText: form.get("payloadText"),
        schedule: scheduleType === "weekly"
          ? { type: "weekly", weekday: Number(form.get("weekday")), timeOfDay: form.get("timeOfDay") }
          : scheduleType === "daily"
            ? { type: "daily", timeOfDay: form.get("timeOfDay") }
            : { type: "once", runAt: new Date(String(form.get("runAt"))).toISOString() },
      };
      await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
      event.currentTarget.reset();
      await loadTasks();
      await loadStatus();
    });
    document.body.addEventListener("click", async (event) => {
      const sessionId = event.target?.dataset?.deleteSession;
      const taskId = event.target?.dataset?.deleteTask;
      if (sessionId && confirm("删除这个会话及其工作目录？")) {
        await api("/api/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
        await refreshAll();
      }
      if (taskId && confirm("删除这个定时任务？")) {
        await api("/api/tasks/" + encodeURIComponent(taskId), { method: "DELETE" });
        await refreshAll();
      }
    });
    refreshAll().catch((err) => {
      document.body.insertAdjacentHTML("afterbegin", '<pre style="margin:20px;color:#b94835">' + safe(err.message) + '</pre>');
    });
  </script>
</body>
</html>`;
}
