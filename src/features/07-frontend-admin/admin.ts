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
import { readConfig, writeConfig, applyAnthropicEnvOverrides, type RuntimeConfig } from "../../runtime/config.js";
import type { AgentStatusSnapshot } from "../01-claude-dialogue/claude/manager.js";
import { drainAgentEvents } from "../01-claude-dialogue/claude/events.js";
import { applyVisionEndpointOverride } from "../03-file-preprocessing/vision.js";
import type { BootstrapManager } from "../../runtime/bootstrap.js";
import type { SystemSnapshot } from "../../runtime/system-monitor.js";
import { listSkills } from "../01-claude-dialogue/skills.js";

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
  /**
   * Attached via attachScheduler() once the service finishes initializing —
   * the admin server now comes up before the heavier startup phases so the
   * bootstrap installer page is reachable on first run.
   */
  scheduler?: SchedulerEngine | null;
  /** Live Claude-manager status for the admin panel; null before startup. */
  agentStatus?: () => AgentStatusSnapshot | null;
  /** Live service state ("bootstrap"/"starting"/"waiting_for_login"/"running"/…) for route gating. */
  serviceState?: () => string;
  /** First-run installer manager; present only in bootstrap mode. */
  bootstrap?: BootstrapManager | null;
  /** Lazily provides/creates the installer manager so the /install page can
   *  add components (e.g. Python) long after the service is running. */
  ensureBootstrap?: () => BootstrapManager;
  /** Live resource usage (service/claude/system) for the overview card. */
  systemStatus?: () => SystemSnapshot | null;
  /** Bundled reference-skills root (repo/exe-side skills/), for the settings card. */
  skillsDir?: string;
  /** Graceful shutdown hook backing POST /api/shutdown (used by the app shell). */
  onShutdown?: () => void;
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

function nonEmptyOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** For secrets: absent/empty input keeps the stored value (may be undefined). */
function keepSecretOr(value: unknown, fallback: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

/** Masked tail of a secret for display, e.g. "…d930". Empty when unset. */
function tail(secret: string | undefined): string {
  if (!secret) return "";
  return "…" + secret.slice(-4);
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function createAdminServer(options: AdminServerOptions): AdminServer {
  return new AdminServer(options);
}

export class AdminServer {
  private readonly server: http.Server;
  private readonly startedAt: Date;
  private readonly now: () => Date;
  private readonly authProvider: AdminAuthProvider;
  private scheduler: SchedulerEngine | null = null;
  private lastQrCode = "";

  constructor(private readonly options: AdminServerOptions) {
    this.startedAt = options.startedAt ?? new Date();
    this.now = options.now ?? (() => new Date());
    this.authProvider = options.authProvider ?? {
      getQrCode: getBotQrCode,
      getQrCodeStatus,
      saveQrImage,
    };
    this.scheduler = options.scheduler ?? null;
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        this.sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  /** Wire the scheduler in once the service creates it (post-bootstrap). */
  attachScheduler(scheduler: SchedulerEngine): void {
    this.scheduler = scheduler;
  }

  /** Existing installer manager, or a lazily-created one for /install. */
  private resolveBootstrap(): BootstrapManager | null {
    if (this.options.bootstrap) return this.options.bootstrap;
    return this.options.ensureBootstrap?.() ?? null;
  }

  private requireScheduler(): SchedulerEngine {
    if (!this.scheduler) throw new Error("Scheduler is not ready yet.");
    return this.scheduler;
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
    const serviceState = this.options.serviceState?.() ?? "running";
    const ready = serviceState === "running" || serviceState === "waiting_for_login";

    // Before the service finishes initializing (bootstrap installer,
    // starting), only the installer/shutdown routes are live.
    if (!ready) {
      const bootstrapApi =
        (method === "GET" && (url.pathname === "/api/bootstrap" || url.pathname === "/install")) ||
        (method === "POST"
          && (url.pathname === "/api/bootstrap/claude"
            || url.pathname === "/api/bootstrap/python"
            || url.pathname === "/api/shutdown"));
      const statusPage = method === "GET" && (url.pathname === "/" || url.pathname === "/api/status");
      if (!bootstrapApi && !statusPage) {
        this.sendJson(res, 503, { ok: false, error: `服务正在初始化（${serviceState}），请稍候。` });
        return;
      }
    }

    if (method === "GET" && url.pathname === "/") {
      if (ready) {
        this.sendHtml(res, renderAdminPage());
      } else {
        this.sendHtml(res, renderInstallerPage({ redirectWhenReady: true }));
      }
      return;
    }

    // Stable installer URL: always available (bootstrap flow and the tray
    // "组件安装" entry alike); never auto-navigates away.
    if (method === "GET" && url.pathname === "/install") {
      this.sendHtml(res, renderInstallerPage({ redirectWhenReady: false }));
      return;
    }

    if (method === "GET" && url.pathname === "/api/status") {
      if (ready) {
        this.sendJson(res, 200, { ok: true, status: this.buildStatus() });
      } else {
        // Minimal status for the app shell's health poll: no DB access yet.
        this.sendJson(res, 200, {
          ok: true,
          status: {
            running: false,
            serviceState,
            startedAt: this.startedAt.toISOString(),
            auth: this.buildAuthState(),
          },
        });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/api/bootstrap") {
      this.sendJson(res, 200, {
        ok: true,
        serviceState,
        bootstrap: this.resolveBootstrap()?.getStatus() ?? null,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/bootstrap/claude") {
      this.resolveBootstrap()?.startClaudeInstall();
      this.sendJson(res, 200, { ok: true, bootstrap: this.resolveBootstrap()?.getStatus() ?? null });
      return;
    }

    if (method === "POST" && url.pathname === "/api/bootstrap/python") {
      this.resolveBootstrap()?.startPythonInstall();
      this.sendJson(res, 200, { ok: true, bootstrap: this.resolveBootstrap()?.getStatus() ?? null });
      return;
    }

    if (method === "GET" && url.pathname === "/api/system") {
      this.sendJson(res, 200, { ok: true, system: this.options.systemStatus?.() ?? null });
      return;
    }

    if (method === "GET" && url.pathname === "/api/skills") {
      const skillsDir = this.options.skillsDir ?? "";
      this.sendJson(res, 200, {
        ok: true,
        dir: skillsDir,
        skills: skillsDir ? listSkills(skillsDir) : [],
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/shutdown") {
      this.sendJson(res, 200, { ok: true });
      const onShutdown = this.options.onShutdown;
      if (onShutdown) setImmediate(() => onShutdown());
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

    const sessionMessages = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (method === "GET" && sessionMessages) {
      this.sendJson(res, 200, {
        ok: true,
        ...this.listSessionMessages(decodeURIComponent(sessionMessages[1]), {
          limit: parsePositiveInt(url.searchParams.get("limit")),
          before: parsePositiveInt(url.searchParams.get("before")),
        }),
      });
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

    if (method === "GET" && url.pathname === "/api/settings") {
      const config = readConfig(this.options.dataDir);
      this.sendJson(res, 200, {
        ok: true,
        settings: {
          imageMode: config.imageMode,
          visionModel: config.visionModel,
          conversationModel: config.conversationModel,
          debounceTextMs: config.debounceTextMs,
          debounceMediaMs: config.debounceMediaMs,
          debounceMaxMs: config.debounceMaxMs,
          preprocessMaxChars: config.preprocessMaxChars,
          preprocessBatchMaxChars: config.preprocessBatchMaxChars,
          visionConcurrency: config.visionConcurrency,
          // Secrets are never echoed back — only masked tails.
          anthropic: {
            baseUrl: config.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "",
            apiKeyTail: tail(config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY),
            authTokenTail: tail(config.anthropicAuthToken ?? process.env.ANTHROPIC_AUTH_TOKEN),
          },
          vision: {
            baseUrl: config.visionBaseUrl ?? "",
            apiKeyTail: tail(config.visionApiKey),
            authTokenTail: tail(config.visionAuthToken),
          },
        },
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/settings") {
      const body = await readJsonBody(req) as Partial<RuntimeConfig>;
      const current = readConfig(this.options.dataDir);
      const next: RuntimeConfig = {
        imageMode: body.imageMode === "split" ? "split" : "direct",
        visionModel: nonEmptyOr(body.visionModel, current.visionModel),
        conversationModel: nonEmptyOr(body.conversationModel, current.conversationModel),
        debounceTextMs: boundedInt(body.debounceTextMs, current.debounceTextMs, 200, 600_000),
        debounceMediaMs: boundedInt(body.debounceMediaMs, current.debounceMediaMs, 200, 600_000),
        debounceMaxMs: boundedInt(body.debounceMaxMs, current.debounceMaxMs, 1_000, 1_800_000),
        preprocessMaxChars: boundedInt(body.preprocessMaxChars, current.preprocessMaxChars, 1_000, 500_000),
        preprocessBatchMaxChars: boundedInt(
          body.preprocessBatchMaxChars,
          current.preprocessBatchMaxChars,
          1_000,
          1_000_000,
        ),
        visionConcurrency: boundedInt(body.visionConcurrency, current.visionConcurrency, 1, 20),
        // Absent/empty means "keep the stored value" — the panel never sees secrets.
        anthropicBaseUrl: keepSecretOr(body.anthropicBaseUrl, current.anthropicBaseUrl),
        anthropicApiKey: keepSecretOr(body.anthropicApiKey, current.anthropicApiKey),
        anthropicAuthToken: keepSecretOr(body.anthropicAuthToken, current.anthropicAuthToken),
        visionBaseUrl: keepSecretOr(body.visionBaseUrl, current.visionBaseUrl),
        visionApiKey: keepSecretOr(body.visionApiKey, current.visionApiKey),
        visionAuthToken: keepSecretOr(body.visionAuthToken, current.visionAuthToken),
      };
      writeConfig(this.options.dataDir, next);
      // API overrides take effect immediately (vision HTTP + SDK subprocess env).
      applyAnthropicEnvOverrides(next);
      applyVisionEndpointOverride(next);
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/agent-events") {
      const since = Number.parseInt(String(url.searchParams.get("since") ?? "0"), 10) || 0;
      const sessionId = url.searchParams.get("sessionId") ?? "";
      this.sendJson(res, 200, {
        ok: true,
        ...drainAgentEvents(since, sessionId || undefined),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/agent-status") {
      let baseUrlHost = "";
      try {
        baseUrlHost = new URL(
          process.env.ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic",
        ).host;
      } catch {
        baseUrlHost = "";
      }
      this.sendJson(res, 200, {
        ok: true,
        agent: {
          config: readConfig(this.options.dataDir),
          baseUrlHost,
          manager: this.options.agentStatus?.() ?? null,
        },
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/quote-files") {
      this.sendJson(res, 200, { ok: true, files: this.listQuoteFiles() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/storage") {
      this.sendJson(res, 200, { ok: true, storage: this.buildStorageInfo() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/recent-errors") {
      this.sendJson(res, 200, { ok: true, entries: this.readRecentLogIssues() });
      return;
    }

    const quoteDelete = url.pathname.match(/^\/api\/quote-files\/([^/]+)$/);
    if (method === "DELETE" && quoteDelete) {
      this.sendJson(res, 200, {
        ok: true,
        deleted: this.deleteQuoteFile(decodeURIComponent(quoteDelete[1])),
      });
      return;
    }

    this.sendJson(res, 404, { ok: false, error: "Not found." });
  }

  /** Data-dir footprint for the overview storage card. */
  private buildStorageInfo(): Record<string, number> {
    const dirSize = (p: string): number => {
      try {
        const stat = fs.statSync(p);
        if (!stat.isDirectory()) return stat.size;
        return fs.readdirSync(p).reduce((sum, name) => sum + dirSize(path.join(p, name)), 0);
      } catch {
        return 0;
      }
    };
    const mb = (bytes: number): number => Math.round(bytes / 104857.6) / 10;
    const rawRetention = Number.parseInt(process.env.WECHAT_CLAUDE_RETENTION_DAYS ?? "30", 10);

    return {
      totalMb: mb(dirSize(this.options.dataDir)),
      workspacesMb: mb(dirSize(this.options.workspaceBase)),
      logsMb: mb(dirSize(path.join(this.options.dataDir, "logs"))),
      dbMb: mb(dirSize(this.options.bridgeDataDir)),
      sessions: scalar("SELECT COUNT(*) AS count FROM sessions"),
      closedSessions: scalar("SELECT COUNT(*) AS count FROM sessions WHERE status = 'closed'"),
      quoteIndexed: scalar("SELECT COUNT(*) AS count FROM message_text_index"),
      retentionDays: Number.isFinite(rawRetention) && rawRetention >= 0 ? rawRetention : 30,
    };
  }

  /** Latest WARN/ERROR lines from service.log for the overview issues card. */
  private readRecentLogIssues(): Array<{ time: string; level: string; text: string }> {
    try {
      const logFile = path.join(this.options.dataDir, "logs", "service.log");
      const stat = fs.statSync(logFile);
      const fh = fs.openSync(logFile, "r");
      const readBytes = Math.min(stat.size, 128 * 1024);
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(fh, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
      fs.closeSync(fh);

      return buffer
        .toString("utf-8")
        .split(/\r?\n/)
        .filter((line) => /\b(ERROR|WARN)\b/.test(line))
        .slice(-12)
        .map((line) => {
          const match = line.match(/^(\S+)\s+(ERROR|WARN)\s+(.*)$/);
          return match
            ? { time: formatLogClock(match[1], this.requireScheduler().getTimezone()), level: match[2], text: match[3].slice(0, 160) }
            : { time: "", level: "WARN", text: line.slice(0, 160) };
        });
    } catch {
      return [];
    }
  }

  /** Raw-message debug records, one jsonl per sender under logs/quote/. */
  private listQuoteFiles(): Array<{ user: string; file: string; sizeBytes: number }> {
    const dir = path.join(this.options.dataDir, "logs", "quote");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => {
        const full = path.join(dir, entry.name);
        return {
          user: entry.name.replace(/\.jsonl$/, ""),
          file: entry.name,
          sizeBytes: fs.statSync(full).size,
        };
      })
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
  }

  private deleteQuoteFile(user: string): boolean {
    const safe = user.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) return false;
    const file = path.join(this.options.dataDir, "logs", "quote", `${safe}.jsonl`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  private buildStatus(): Record<string, unknown> {
    const now = this.now();
    const timezone = this.requireScheduler().getTimezone();
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
    hasMore: boolean;
    totalSessions: number;
  } {
    const totalRow = queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM sessions");
    const limit = 20;

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
       ORDER BY last_active_at DESC
       LIMIT ?`,
      [limit + 1],
    );

    const hasMore = sessions.length > limit;
    if (hasMore) sessions.length = limit;

    return {
      sessions,
      hasMore,
      totalSessions: totalRow?.count ?? sessions.length,
    };
  }

  /** Lazy-loaded messages for one session (newest first, keyset pagination). */
  private listSessionMessages(
    sessionId: string,
    options: { limit?: number; before?: number } = {},
  ): {
    sessionId: string;
    messages: Array<{
      seqInSession: number;
      direction: string;
      textContent: string | null;
      createdAt: string;
    }>;
    hasMore: boolean;
  } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const before = options.before && options.before > 0 ? options.before : Number.MAX_SAFE_INTEGER;

    const rows = queryAll<{
      seqInSession: number;
      direction: string;
      textContent: string | null;
      createdAt: string;
    }>(
      `SELECT seq_in_session AS seqInSession,
              direction,
              text_content AS textContent,
              created_at AS createdAt
       FROM conversations
       WHERE session_id = ? AND seq_in_session < ?
       ORDER BY seq_in_session DESC
       LIMIT ?`,
      [sessionId, before, limit + 1],
    );

    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;

    return { sessionId, messages: rows, hasMore };
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
    const draft = this.requireScheduler().createDraft(input);
    const confirmed = this.requireScheduler().confirmDraft(draft.draft.id);
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

/** Service log lines carry UTC ISO stamps — render them in the scheduler's zone. */
function formatLogClock(stamp: string, timezone: string): string {
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return stamp.slice(11, 19);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
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

function parsePositiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function renderInstallerPage(options: { redirectWhenReady: boolean }): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WeChat Claude · 组件安装</title>
  <style>
    :root {
      --ink: #18221d;
      --muted: #657369;
      --paper: #f7f1e3;
      --panel: rgba(255,252,241,.92);
      --line: rgba(32,58,45,.16);
      --green: #2f6b4f;
      --green-dark: #17452f;
      --gold: #c7892d;
      --red: #b94835;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; color: var(--ink);
      font: 14px/1.55 "Aptos", "Segoe UI", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(1100px 500px at 85% -10%, rgba(199,137,45,.10), transparent 60%),
        linear-gradient(180deg, #f9f4e7 0%, var(--paper) 45%, #f2ead6 100%);
      min-height: 100vh;
    }
    header {
      display: flex; justify-content: space-between; align-items: center; gap: 16px;
      max-width: 720px; margin: 0 auto; padding: 20px 20px 8px;
    }
    h1 { margin: 0; font: 700 20px/1.2 Georgia, "Times New Roman", serif; color: var(--green-dark); }
    h1 small { font: 400 12px/1 "Aptos","Segoe UI",sans-serif; color: var(--muted); margin-left: 8px; }
    main { max-width: 720px; margin: 0 auto; padding: 10px 20px 48px; display: grid; gap: 14px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; }
    .step { display: grid; grid-template-columns: 44px 1fr; gap: 14px; align-items: start; }
    .badge {
      width: 34px; height: 34px; border-radius: 50%; margin-top: 2px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(47,107,79,.12); color: var(--green-dark); font: 700 15px/1 inherit;
    }
    .badge.done { background: var(--green); color: #fff; }
    .step h2 { margin: 2px 0 4px; font: 700 15px/1.3 Georgia, serif; color: var(--green-dark); }
    .step h2 .tag {
      font: 600 11px/1 "Aptos","Segoe UI",sans-serif; vertical-align: 2px; margin-left: 8px;
      color: var(--gold); border: 1px solid rgba(199,137,45,.4); border-radius: 6px; padding: 2px 6px;
    }
    .step h2 .tag.optional { color: var(--muted); border-color: var(--line); }
    .desc { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
    .progress {
      height: 8px; border-radius: 4px; overflow: hidden;
      background: rgba(32,58,45,.12); margin: 10px 0 6px;
    }
    .progress i { display: block; height: 100%; width: 0; background: var(--green); transition: width .3s; }
    .progress.indeterminate i { width: 40%; animation: slide 1.2s infinite linear; }
    @keyframes slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
    .state-line { min-height: 18px; font-size: 12.5px; color: var(--muted); }
    .state-line.error { color: var(--red); }
    button.primary {
      background: var(--green); color: #fff; border: 0; border-radius: 9px;
      padding: 8px 16px; font: 600 13px/1 inherit; cursor: pointer;
    }
    button.primary:disabled { opacity: .55; cursor: default; }
    .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .meta { text-align: center; color: var(--muted); font-size: 12.5px; }
    #startup-card { text-align: center; color: var(--muted); padding: 40px 18px; }
    #startup-card .spin {
      display: inline-block; width: 22px; height: 22px; border-radius: 50%;
      border: 3px solid rgba(47,107,79,.2); border-top-color: var(--green);
      animation: rot 1s infinite linear; margin-bottom: 10px;
    }
    @keyframes rot { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
<header><h1>WeChat Claude <small>组件安装</small></h1></header>
<main>
  <div class="card" id="startup-card" hidden><span class="spin"></span><div>服务正在启动，请稍候…</div></div>

  <div id="steps" style="display:grid; gap:14px;">
    <div class="card step" id="card-claude">
      <div class="badge">1</div>
      <div>
        <h2>Claude Agent 运行时<span class="tag">必需</span></h2>
        <p class="desc">AI 对话与工具调用的核心（claude.exe，约 218MB）。首次使用需下载一次，之后常驻本机。</p>
        <div class="row"><button class="primary" id="btn-claude">下载并安装</button></div>
        <div class="progress" hidden><i></i></div>
        <div class="state-line"></div>
      </div>
    </div>

    <div class="card step" id="card-python">
      <div class="badge">2</div>
      <div>
        <h2>Python 文档解析环境<span class="tag optional">可选</span></h2>
        <p class="desc">启用 PDF / Office 文档解析与扫描版识别（markitdown + PyMuPDF，约 360MB）。不安装不影响聊天与图片理解；装完即生效，无需重启。</p>
        <div class="row"><button class="primary" id="btn-python">安装（可选）</button></div>
        <div class="progress" hidden><i></i></div>
        <div class="state-line"></div>
      </div>
    </div>
  </div>

  <div class="card" id="ready-card" hidden style="text-align:center">
    <div style="margin-bottom:10px">✅ 核心组件已就绪，服务正在运行。</div>
    <a href="/" style="display:inline-block;background:var(--green);color:#fff;border-radius:9px;padding:9px 18px;font:600 13px/1 inherit;text-decoration:none">打开管理面板</a>
    <div class="meta" style="margin-top:10px">本窗口可随时关闭（托盘菜单"组件安装"可重新打开）。</div>
  </div>

  <div class="meta" id="overall">① 下载完成后自动继续启动；② 为可选项，现在或以后安装均可。</div>
</main>
<script>
  const REDIRECT_WHEN_READY = ${options.redirectWhenReady ? "true" : "false"};
  const BUSY = ["downloading", "extracting", "installing"];
  const $ = (id) => document.getElementById(id);
  function fmtBytes(n) {
    if (!n) return "";
    const mb = n / 1048576;
    return mb >= 1 ? mb.toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
  }
  function setCard(cardId, st, label) {
    const card = $(cardId);
    const progress = card.querySelector(".progress");
    const line = card.querySelector(".state-line");
    const button = card.querySelector("button.primary");
    const busy = BUSY.includes(st.status);
    const done = st.status === "installed";
    card.querySelector(".badge").classList.toggle("done", done);
    card.querySelector(".badge").textContent = done ? "✓" : (cardId === "card-claude" ? "1" : "2");
    button.disabled = busy || done;
    button.textContent = done ? "已安装"
      : st.status === "downloading" ? "下载中…"
      : st.status === "extracting" ? "解压中…"
      : st.status === "installing" ? "安装中…"
      : st.status === "error" ? "重试"
      : label;
    progress.hidden = !busy;
    progress.classList.toggle("indeterminate", busy && st.status !== "downloading");
    progress.firstElementChild.style.width =
      st.status === "downloading" && st.totalBytes > 0
        ? Math.min(100, Math.round(st.receivedBytes / st.totalBytes * 100)) + "%"
        : "100%";
    line.classList.toggle("error", st.status === "error");
    line.textContent = st.status === "downloading" && st.totalBytes > 0
      ? fmtBytes(st.receivedBytes) + " / " + fmtBytes(st.totalBytes)
      : (st.error ? "出错：" + st.error : (st.message || ""));
  }
  async function tick() {
    try {
      const s = await (await fetch("/api/status")).json();
      const state = s.status?.serviceState ?? (s.status?.running ? "running" : "");
      const serviceReady = state === "running" || state === "waiting_for_login";
      if (serviceReady && REDIRECT_WHEN_READY) { location.reload(); return; }
      const b = await (await fetch("/api/bootstrap")).json();
      if (!b.bootstrap) {
        $("steps").hidden = true; $("startup-card").hidden = false;
        return;
      }
      $("steps").hidden = false; $("startup-card").hidden = true;
      $("ready-card").hidden = !serviceReady;
      setCard("card-claude", b.bootstrap.claude, "下载并安装");
      setCard("card-python", b.bootstrap.python, "安装（可选）");
      $("overall").textContent = b.bootstrap.ready
        ? "全部组件就绪。"
        : "① Claude 运行时下载完成后将自动继续启动；② Python 环境可选，装完即生效。";
    } catch { /* service restarting between polls; keep trying */ }
  }
  document.addEventListener("click", async (ev) => {
    const id = ev.target.closest("button.primary")?.id;
    if (id !== "btn-claude" && id !== "btn-python") return;
    await fetch("/api/bootstrap/" + (id === "btn-claude" ? "claude" : "python"), { method: "POST" });
    tick();
  });
  tick();
  setInterval(tick, 1000);
</script>
</body>
</html>`;
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WeChat Claude 管理面板</title>
  <style>
    :root {
      --ink: #18221d;
      --muted: #657369;
      --paper: #f7f1e3;
      --panel: rgba(255,252,241,.92);
      --line: rgba(32,58,45,.16);
      --green: #2f6b4f;
      --green-dark: #17452f;
      --gold: #c7892d;
      --red: #b94835;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font: 14px/1.55 "Aptos", "Segoe UI", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(1100px 500px at 85% -10%, rgba(199,137,45,.10), transparent 60%),
        linear-gradient(180deg, #f9f4e7 0%, var(--paper) 45%, #f2ead6 100%);
      min-height: 100vh;
    }
    header {
      display: flex; justify-content: space-between; align-items: center; gap: 16px;
      max-width: 1080px; margin: 0 auto; padding: 16px 20px 8px;
    }
    h1 { margin: 0; font: 700 20px/1.2 Georgia, "Times New Roman", serif; color: var(--green-dark); }
    h1 small { font: 400 12px/1 "Aptos","Segoe UI",sans-serif; color: var(--muted); margin-left: 8px; }
    h2 { margin: 0 0 10px; font: 700 15px/1.3 Georgia, serif; color: var(--green-dark); }
    h3 { margin: 14px 0 6px; font: 600 12.5px/1.3 inherit; color: var(--muted); }
    nav.tabs {
      position: sticky; top: 0; z-index: 10;
      display: flex; gap: 4px;
      max-width: 1080px; margin: 0 auto; padding: 0 20px;
      background: rgba(247,241,227,.94); backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--line);
    }
    nav.tabs button {
      border: 0; background: transparent; cursor: pointer;
      padding: 10px 14px; font: 600 14px/1 inherit; color: var(--muted);
      border-bottom: 2px solid transparent;
    }
    nav.tabs button.active { color: var(--green-dark); border-bottom-color: var(--green); }
    main { max-width: 1080px; margin: 0 auto; padding: 14px 20px 48px; }
    section[data-tab] { display: none; }
    section[data-tab].active { display: grid; gap: 14px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    button.primary, .toolbar > button, form button[type=submit] {
      background: var(--green); color: #fff; border: 0; border-radius: 9px;
      padding: 8px 14px; font: 600 13px/1 inherit; cursor: pointer;
    }
    button.secondary { background: #fff8e8; color: var(--green-dark); border: 1px solid var(--line); }
    button.danger { background: var(--red); color: #fff; border: 0; }
    button.minor { background: transparent; color: var(--green); border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; font: 600 12px/1.4 inherit; cursor: pointer; }
    input, select, textarea {
      width: 100%; background: rgba(255,255,255,.75); border: 1px solid var(--line);
      border-radius: 8px; padding: 8px 10px; color: var(--ink); font: inherit;
    }
    textarea { min-height: 74px; resize: vertical; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
    code {
      display: inline-block; max-width: 100%; overflow-wrap: anywhere;
      color: var(--green-dark); background: rgba(47,107,79,.08);
      padding: 1px 5px; border-radius: 6px; font-size: 12px;
    }
    .stack { display: grid; gap: 10px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 14px; }
    .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
    .grid3 { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
    .metric { padding: 10px 12px; border-radius: 12px; background: rgba(255,255,255,.6); border: 1px solid var(--line); }
    .metric strong { display: block; font-size: 22px; letter-spacing: -0.02em; }
    .muted { color: var(--muted); }
    .pill { display:inline-flex; gap:6px; align-items:center; padding: 2px 8px; border-radius:999px; background:rgba(47,107,79,.1); color:var(--green-dark); font-size:12px; font-weight:700; }
    .row { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:10px 0; border-top:1px solid var(--line); }
    .row:first-child { border-top:0; }
    .row-main { min-width:0; flex:1; }
    .row-main p { margin: 3px 0 0; color: var(--muted); overflow-wrap:anywhere; font-size:12.5px; }
    .messages { margin-top: 4px; }
    .message { padding:7px 10px; border-radius:10px; background:rgba(255,255,255,.55); margin:6px 0; }
    .message.outbound { border-left:3px solid var(--gold); }
    .message.inbound { border-left:3px solid var(--green); }
    .tiny { font-size:12px; color:var(--muted); }
    .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#9db3a5; margin-right:6px; vertical-align:1px; }
    .dot.on { background: #2e9e5b; box-shadow: 0 0 0 3px rgba(46,158,91,.18); }
    table.plain { width:100%; border-collapse:collapse; font-size:12.5px; }
    table.plain th { text-align:left; color:var(--muted); font-weight:600; padding:4px 8px; border-bottom:1px solid var(--line); }
    table.plain td { padding:5px 8px; border-bottom:1px solid rgba(32,58,45,.08); overflow-wrap:anywhere; }
    .qr { width: 190px; max-width:100%; border-radius:12px; background:#fff; padding:6px; border:1px solid var(--line); }
    @media (max-width: 760px) {
      header { flex-direction:column; align-items:flex-start; }
      .grid, .grid2, .grid3 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>WeChat Claude <small>管理面板</small></h1>
    <div class="toolbar">
      <button id="refresh">刷新当前页</button>
      <button id="refreshQr" class="secondary">刷新二维码</button>
      <button id="pollQr" class="secondary">轮询扫码状态</button>
      <button id="openInstall" class="secondary" title="下载/补装 Claude 运行时与 Python 解析环境">组件安装</button>
    </div>
  </header>

  <nav class="tabs">
    <button data-tab="overview" class="active">概览</button>
    <button data-tab="conversations">对话</button>
    <button data-tab="tasks">任务</button>
    <button data-tab="settings">设置</button>
  </nav>

  <main>
    <section data-tab="overview" class="active">
      <div class="card"><div class="grid3" id="metrics" class="muted">加载中…</div></div>
      <div class="card">
        <h2>AI 后端</h2>
        <div id="agent" class="stack muted">加载中…</div>
      </div>
      <div class="card">
        <h2>Agent 处理流程（实时）</h2>
        <div id="agentEvents" class="stack muted" style="max-height:340px;overflow-y:auto">空闲</div>
      </div>
      <div class="grid">
        <div class="card"><h2>登录二维码</h2><div id="auth" class="stack muted">加载中…</div></div>
        <div class="card"><h2>运行详情</h2><div id="status" class="stack muted">加载中…</div></div>
      </div>
      <div class="grid">
        <div class="card"><h2>存储概览</h2><div id="storage" class="stack muted">加载中…</div></div>
        <div class="card"><h2>资源占用</h2><div id="system" class="stack muted">加载中…</div></div>
      </div>
      <div class="grid">
        <div class="card"><h2>最近异常</h2><div id="errors" class="stack muted">加载中…</div></div>
      </div>
    </section>

    <section data-tab="conversations">
      <div class="card">
        <div class="toolbar" style="justify-content:space-between">
          <div class="toolbar">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)">
              <input type="checkbox" id="selectAll" style="width:auto"> 全选
            </label>
            <button class="danger" id="deleteSelected" disabled>删除选中（0）</button>
            <input id="sessionSearch" placeholder="过滤：用户 / 会话ID / 摘要" style="max-width:280px">
          </div>
          <span class="tiny" id="sessionCount"></span>
        </div>
        <div id="sessions" class="stack muted" style="margin-top:10px">加载中…</div>
      </div>
    </section>

    <section data-tab="tasks">
      <div class="card">
        <h2>创建定时任务</h2>
        <form id="taskForm" class="stack">
          <div class="grid2">
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
      </div>
      <div class="card"><h2>任务列表</h2><div id="tasks" class="stack muted">加载中…</div></div>
    </section>

    <section data-tab="settings">
      <div class="card">
        <h2>模型、图片与消息合并</h2>
        <form id="settingsForm" class="stack">
          <div class="grid2">
            <label>图片模式<select name="imageMode"><option value="direct">直连：图片直接进对话（对话模型=视觉模型）</option><option value="split">分离：图片先转文字，对话用对话模型</option></select></label>
            <label>视觉模型<input name="visionModel" placeholder="deepseek-v4-flash-vision-exp"></label>
            <label>对话模型（分离模式使用）<input name="conversationModel" placeholder="deepseek-v4-flash"></label>
          </div>
          <div class="grid2">
            <label>文本合并窗口（毫秒）<input name="debounceTextMs" type="number" min="200" max="600000" step="100" placeholder="3000"></label>
            <label>媒体合并窗口（毫秒）<input name="debounceMediaMs" type="number" min="200" max="600000" step="100" placeholder="5000"></label>
            <label>最大累计上限（毫秒）<input name="debounceMaxMs" type="number" min="1000" max="1800000" step="500" placeholder="15000"></label>
          </div>
          <div class="grid2">
            <label>单文件提取上限（字符）<input name="preprocessMaxChars" type="number" min="1000" max="500000" step="1000" placeholder="50000"></label>
            <label>单批总提取上限（字符）<input name="preprocessBatchMaxChars" type="number" min="1000" max="1000000" step="1000" placeholder="150000"></label>
            <label>视觉转录并发数<input name="visionConcurrency" type="number" min="1" max="20" step="1" placeholder="20" title="扫描版 PDF 逐页识别的并发请求数，越高越快、越多偶发失败（会自动重试）"></label>
          </div>
          <div class="grid2">
            <label>API Base URL<input name="anthropicBaseUrl" placeholder="https://api.deepseek.com/anthropic"></label>
            <label>API Key（x-api-key）<input name="anthropicApiKey" type="password" autocomplete="off" placeholder="留空保持不变"></label>
            <label>Auth Token（Bearer）<input name="anthropicAuthToken" type="password" autocomplete="off" placeholder="留空保持不变"></label>
          </div>
          <div class="grid2">
            <label>视觉通道 Base URL<input name="visionBaseUrl" placeholder="留空跟随主接入（可填不同供应商）"></label>
            <label>视觉通道 API Key<input name="visionApiKey" type="password" autocomplete="off" placeholder="留空跟随主接入"></label>
            <label>视觉通道 Auth Token<input name="visionAuthToken" type="password" autocomplete="off" placeholder="留空跟随主接入"></label>
          </div>
          <div class="tiny">窗口：消息发出后等待合并的时间，来新消息会重新计时；上限：一批消息累计多久后强制发送。对下一条消息生效，无需重启。</div>
          <div class="tiny">API 接入：保存在本机 config.json，优先于 .env，保存后立即生效。密钥不回显，仅显示末 4 位。视觉通道（图片/扫描页识别）可指向不同供应商，留空时与主接入共用。</div>
          <button type="submit">保存设置</button>
        </form>
      </div>
      <div class="card"><h2>报文记录（按发送者）</h2><div id="quoteFiles" class="stack muted">加载中…</div></div>
      <div class="card">
        <h2>参考技能（skills/）</h2>
        <div id="skills" class="stack muted">加载中…</div>
      </div>
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
      return text.length > 160 ? text.slice(0, 157) + "..." : text;
    };
    // 后端存的 ISO 时间戳一律是 UTC——先 new Date() 解析再取本地字段，
    // 直接截字符串会把所有时间显示成 UTC（慢 8 小时）。
    const fmtLocal = (d) => {
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    };
    const clock = (iso) => {
      const d = new Date(iso);
      return isNaN(d.getTime()) ? safe(String(iso ?? "")) : safe(fmtLocal(d));
    };
    const hm = (v) => {
      const d = new Date(v);
      if (isNaN(d.getTime())) return String(v ?? "").slice(11, 19);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    };
    const fmtNum = (n) => (typeof n === "number" && n > 0) ? (n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n)) : "-";
    const fmtTokens = (inp, out) => "入 " + fmtNum(inp) + " / 出 " + fmtNum(out);

    let activeTab = "overview";
    const loadedTabs = new Set();
    const state = { sessions: [], open: new Map(), selected: new Set() };

    document.querySelectorAll("nav.tabs button").forEach((btn) => btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll("section[data-tab]").forEach((s) => s.classList.toggle("active", s.dataset.tab === activeTab));
      loadTab(activeTab, false).catch(alert);
    }));

    function loadTab(tab, force) {
      if (!force && loadedTabs.has(tab)) return Promise.resolve();
      loadedTabs.add(tab);
      const jobs = {
        overview: () => Promise.all([loadStatus(), loadAgent(), loadAuth(), loadStorage(), loadSystem(), loadErrors(), pollAgentEvents()]),
        conversations: () => loadSessions(),
        tasks: () => loadTasks(),
        settings: () => Promise.all([loadSettings(), loadQuoteFiles(), loadSkills()]),
      };
      return (jobs[tab] || (() => {}))();
    }

    async function loadStatus() {
      const { status } = await api("/api/status");
      $("metrics").innerHTML = \`
        <div class="metric"><span class="tiny">会话</span><strong>\${status.counts.sessions}</strong></div>
        <div class="metric"><span class="tiny">消息</span><strong>\${status.counts.conversations}</strong></div>
        <div class="metric"><span class="tiny">任务</span><strong>\${status.counts.activeTasks}</strong></div>\`;
      $("status").innerHTML = \`
        <div><span class="pill">运行中</span> <strong>\${safe(status.localTime)}</strong> <span class="muted">(\${safe(status.timezone)})</span></div>
        <div class="tiny">启动：\${clock(status.startedAt)} · PID <code>\${safe(status.pid)}</code></div>
        <div class="tiny">数据目录：<code>\${safe(status.paths.dataDir)}</code></div>
        <div class="tiny">数据库：<code>\${safe(status.paths.dbPath)}</code></div>
        <div class="tiny">工作区：<code>\${safe(status.paths.workspaceBase)}</code></div>\`;
    }

    async function loadAgent() {
      const { agent } = await api("/api/agent-status");
      const m = agent.manager;
      const cfg = agent.config;
      let html = \`
        <div>图片模式 <strong>\${safe(cfg.imageMode)}</strong> · 视觉 <code>\${safe(cfg.visionModel)}</code> · 对话 <code>\${safe(cfg.conversationModel)}</code></div>
        <div class="tiny">端点 <code>\${safe(agent.baseUrlHost)}</code> · 并发 \${safe(m ? m.maxConcurrent : "-")} · 忙碌 \${safe(m ? m.busyCount : 0)} · 排队 \${safe(m ? m.queueDepth : 0)}</div>\`;
      if (m && m.sessions.length) {
        html += "<h3>会话</h3><table class='plain'><tr><th>会话</th><th>模型</th><th>状态</th><th>最近查询</th><th>轮次</th><th>上次 tokens</th></tr>"
          + m.sessions.map((s) => \`<tr><td><code>\${safe(s.sessionId.slice(0, 8))}</code></td><td>\${safe(s.model || "-")}</td><td><span class="dot \${s.isProcessing ? "on" : ""}"></span>\${s.isProcessing ? "处理中" : "空闲"}</td><td>\${clock(s.lastQueryAt) || "-"}</td><td>\${safe(s.lastTurnCount ?? "-")}</td><td>\${s.lastUsage ? fmtTokens(s.lastUsage.inputTokens, s.lastUsage.outputTokens) : "-"}</td></tr>\`).join("")
          + "</table>";
      }
      if (m && m.recent.length) {
        html += "<h3>最近请求</h3><table class='plain'><tr><th>时间</th><th>耗时</th><th>会话</th><th>轮次</th><th>输入</th><th>输出</th><th>结果</th></tr>"
          + m.recent.slice(0, 10).map((q) => \`<tr><td>\${clock(q.startedAt)}</td><td>\${(q.durationMs / 1000).toFixed(1)}s</td><td><code>\${safe(q.sessionId.slice(0, 8))}</code></td><td>\${safe(q.turnCount)}</td><td>\${fmtNum(q.inputTokens)}</td><td>\${fmtNum(q.outputTokens)}</td><td>\${q.ok ? "成功" : "<span style='color:#b94835'>" + safe(q.error || "失败") + "</span>"}</td></tr>\`).join("")
          + "</table>";
      }
      if (!m) html += "<div class='tiny'>AI 管理器尚未初始化。</div>";
      $("agent").innerHTML = html;
      $("agent").classList.remove("muted");
    }

    async function loadStorage() {
      const { storage } = await api("/api/storage");
      $("storage").innerHTML = \`
        <div>数据目录合计 <strong>\${safe(storage.totalMb)} MB</strong>（工作区 \${safe(storage.workspacesMb)} · 日志 \${safe(storage.logsMb)} · 数据库 \${safe(storage.dbMb)}）</div>
        <div class="tiny">会话 \${safe(storage.sessions)} 个（已关闭 \${safe(storage.closedSessions)}，超 \${safe(storage.retentionDays)} 天自动清理）· 引用索引 \${safe(storage.quoteIndexed)} 条（永不清）</div>\`;
      $("storage").classList.remove("muted");
    }

    async function loadSystem() {
      const { system } = await api("/api/system");
      if (!system) {
        $("system").innerHTML = '<span class="tiny">资源信息不可用</span>';
        return;
      }
      const pct = (v) => (v == null ? "-" : v + "%");
      const upMin = Math.round(system.node.uptimeSec / 60);
      const claude = system.claude.count
        ? "<strong>" + safe(system.claude.rssMb) + " MB × " + safe(system.claude.count) + " 个进程</strong> · CPU " + pct(system.claude.cpuPercent)
        : "空闲（AI 处理时启动）";
      $("system").innerHTML = \`
        <div>服务进程 <strong>\${safe(system.node.rssMb)} MB</strong> · CPU \${pct(system.node.cpuPercent)} <span class="tiny">PID \${safe(system.node.pid)} · 已运行 \${upMin} 分钟</span></div>
        <div class="tiny">Node 堆内存 \${safe(system.node.heapUsedMb)} MB</div>
        <div>Claude 运行时：\${claude}</div>
        <div class="tiny">系统内存 \${Math.round(system.system.freeMemMb)} MB 可用 / \${Math.round(system.system.totalMemMb)} MB · 系统 CPU \${pct(system.system.cpuPercent)}</div>
        <div class="tiny">CPU 为单核口径（单核 = 100%）；后台每 5 秒采样一次，面板仅读取缓存。</div>\`;
      $("system").classList.remove("muted");
    }

    async function loadErrors() {
      const { entries } = await api("/api/recent-errors");
      $("errors").innerHTML = entries.length
        ? entries.map((e) => \`<div class="tiny" style="border-left:3px solid \${e.level === "ERROR" ? "#b94835" : "#c7892d"};padding-left:8px;margin:4px 0">\${safe(e.time)} [\${safe(e.level)}] \${safe(e.text)}</div>\`).join("")
        : '<span class="tiny">没有异常记录 ✓</span>';
      $("errors").classList.remove("muted");
    }

    async function loadAuth() {
      const { auth } = await api("/api/auth");
      $("auth").innerHTML = \`
        <div>Token：\${auth.tokenPresent ? '<span class="pill">已存在</span> <code>' + safe(auth.tokenPreview) + '</code>' : '<span class="pill">未配置</span>'}</div>
        \${auth.qrImageDataUrl ? '<img class="qr" src="' + safe(auth.qrImageDataUrl) + '" alt="WeChat QR">' : '<div class="tiny">暂无二维码，点击"刷新二维码"。</div>'}
        \${auth.lastQrCode ? '<div class="tiny">当前 qrcode：<code>' + safe(auth.lastQrCode) + '</code></div>' : ''}\`;
      $("auth").classList.remove("muted");
    }

    async function loadSessions() {
      const data = await api("/api/conversations");
      state.sessions = data.sessions;
      $("sessionCount").textContent = "最近 " + data.sessions.length + " / 共 " + data.totalSessions + " 个会话";
      renderSessions();
    }

    function msgHtml(m) {
      return \`<div class="message \${safe(m.direction)}"><span class="tiny">#\${safe(m.seqInSession)} \${safe(m.direction === "outbound" ? "AI" : "用户")} · \${clock(m.createdAt)}</span><br>\${safe(short(m.textContent || ""))}</div>\`;
    }

    function renderSessions() {
      const q = $("sessionSearch").value.trim().toLowerCase();
      const list = state.sessions.filter((s) =>
        !q || (s.fromUserId + " " + s.id + " " + (s.summary || "")).toLowerCase().includes(q));
      $("sessions").innerHTML = list.length ? list.map((s) => {
        const open = state.open.get(s.id);
        const body = open
          ? open.messages.slice().reverse().map(msgHtml).join("")
            + (open.hasMore ? \`<div style="margin-top:6px"><button class="minor" data-more="\${safe(s.id)}">加载更早消息</button></div>\` : "")
          : \`<span class="tiny">点击"展开"查看该会话的消息</span>\`;
        return \`
          <div class="row">
            <input type="checkbox" data-check="\${safe(s.id)}" style="width:auto;margin-top:4px" \${state.selected.has(s.id) ? "checked" : ""}>
            <div class="row-main">
              <strong>\${safe(s.fromUserId.slice(0, 22))}</strong> <span class="pill">\${safe(s.status)}</span>
              <span class="tiny">\${safe(s.messageCount)} 条 · \${clock(s.lastActiveAt)}\${s.summary ? " · " + safe(s.summary.slice(0, 30)) : ""}</span>
              <div class="messages">\${body}</div>
            </div>
            <div class="toolbar">
              <button class="secondary" data-toggle="\${safe(s.id)}">\${open ? "收起" : "展开"}</button>
              <button class="danger" data-delete-session="\${safe(s.id)}">删除</button>
            </div>
          </div>\`;
      }).join("") : "没有匹配的会话";
      $("sessions").classList.remove("muted");
      updateSelectionUi();
    }

    function updateSelectionUi() {
      const visible = state.sessions.filter((s) => {
        const q = $("sessionSearch").value.trim().toLowerCase();
        return !q || (s.fromUserId + " " + s.id + " " + (s.summary || "")).toLowerCase().includes(q);
      });
      const visibleSelected = visible.filter((s) => state.selected.has(s.id)).length;
      const btn = $("deleteSelected");
      btn.disabled = state.selected.size === 0;
      btn.textContent = "删除选中（" + state.selected.size + "）";
      $("selectAll").checked = visible.length > 0 && visibleSelected === visible.length;
    }

    $("selectAll").addEventListener("change", () => {
      const q = $("sessionSearch").value.trim().toLowerCase();
      const visible = state.sessions.filter((s) =>
        !q || (s.fromUserId + " " + s.id + " " + (s.summary || "")).toLowerCase().includes(q));
      if ($("selectAll").checked) {
        visible.forEach((s) => state.selected.add(s.id));
      } else {
        visible.forEach((s) => state.selected.delete(s.id));
      }
      renderSessions();
    });

    $("sessions").addEventListener("change", (event) => {
      const id = event.target?.dataset?.check;
      if (!id) return;
      if (event.target.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateSelectionUi();
    });

    $("deleteSelected").addEventListener("click", async () => {
      const ids = [...state.selected];
      if (!ids.length) return;
      if (!confirm("删除选中的 " + ids.length + " 个会话及其工作目录？不可恢复。")) return;
      for (const id of ids) {
        await api("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => undefined);
        state.selected.delete(id);
        state.open.delete(id);
      }
      await loadSessions().catch(alert);
    });

    async function toggleSession(id) {
      if (state.open.has(id)) { state.open.delete(id); renderSessions(); return; }
      const data = await api("/api/sessions/" + encodeURIComponent(id) + "/messages?limit=50");
      state.open.set(id, { messages: data.messages, hasMore: data.hasMore });
      renderSessions();
    }

    async function loadMoreMessages(id) {
      const open = state.open.get(id);
      if (!open || !open.messages.length) return;
      const oldest = open.messages[open.messages.length - 1].seqInSession;
      const data = await api("/api/sessions/" + encodeURIComponent(id) + "/messages?limit=50&before=" + oldest);
      open.messages.push(...data.messages);
      open.hasMore = data.hasMore;
      renderSessions();
    }

    async function loadTasks() {
      const { tasks, drafts } = await api("/api/tasks");
      const taskHtml = tasks.length ? tasks.map((t) => \`
        <div class="row">
          <div class="row-main">
            <strong>\${safe(t.title)}</strong> <span class="pill">\${safe(t.status)}</span> <span class="pill">\${safe(t.mode)}</span>
            <p>计划：\${t.scheduleType === "once" ? clock(t.runAt) : t.scheduleType === "daily" ? "每天 " + safe(t.timeOfDay) : "每周 " + safe(t.weekday) + " " + safe(t.timeOfDay)}；下次：<code>\${clock(t.nextRunAt)}</code></p>
            <p>\${safe(short(t.payloadText))}</p>
          </div>
          <button class="danger" data-delete-task="\${safe(t.id)}">删除</button>
        </div>\`).join("") : "暂无定时任务";
      const draftHtml = drafts.length ? "<h3>待确认草稿</h3>" + drafts.map((d) => \`<div class="message"><strong>\${safe(d.title)}</strong><br><span class="tiny">\${safe(d.userId)}，过期：\${safe(d.expiresAt)}</span></div>\`).join("") : "";
      $("tasks").innerHTML = taskHtml + draftHtml;
      $("tasks").classList.remove("muted");
    }

    async function loadSettings() {
      const { settings } = await api("/api/settings");
      const form = $("settingsForm");
      form.elements.imageMode.value = settings.imageMode;
      form.elements.visionModel.value = settings.visionModel;
      form.elements.conversationModel.value = settings.conversationModel;
      form.elements.debounceTextMs.value = settings.debounceTextMs;
      form.elements.debounceMediaMs.value = settings.debounceMediaMs;
      form.elements.debounceMaxMs.value = settings.debounceMaxMs;
      form.elements.preprocessMaxChars.value = settings.preprocessMaxChars;
      form.elements.preprocessBatchMaxChars.value = settings.preprocessBatchMaxChars;
      form.elements.visionConcurrency.value = settings.visionConcurrency;
      form.elements.anthropicBaseUrl.value = settings.anthropic.baseUrl || "";
      form.elements.anthropicApiKey.placeholder = settings.anthropic.apiKeyTail
        ? "已配置 " + settings.anthropic.apiKeyTail + "，留空保持不变" : "未配置，留空保持不变";
      form.elements.anthropicAuthToken.placeholder = settings.anthropic.authTokenTail
        ? "已配置 " + settings.anthropic.authTokenTail + "，留空保持不变" : "未配置，留空保持不变";
      form.elements.visionBaseUrl.value = settings.vision.baseUrl || "";
      form.elements.visionApiKey.placeholder = settings.vision.apiKeyTail
        ? "已配置 " + settings.vision.apiKeyTail + "，留空跟随主接入" : "留空跟随主接入";
      form.elements.visionAuthToken.placeholder = settings.vision.authTokenTail
        ? "已配置 " + settings.vision.authTokenTail + "，留空跟随主接入" : "留空跟随主接入";
    }

    async function loadQuoteFiles() {
      const { files } = await api("/api/quote-files");
      $("quoteFiles").innerHTML = files.length ? files.map((f) => \`
        <div class="row">
          <div class="row-main">
            <strong>\${safe(f.user)}</strong>
            <p>大小：\${(f.sizeBytes / 1024).toFixed(1)} KB</p>
          </div>
          <button class="danger" data-delete-quote="\${safe(f.user)}">删除</button>
        </div>\`).join("") : "暂无报文记录";
      $("quoteFiles").classList.remove("muted");
    }

    async function loadSkills() {
      const { skills, dir } = await api("/api/skills");
      const list = skills.length
        ? skills.map((s) => \`<div><strong>\${safe(s.name)}</strong><span class="tiny"> — \${safe(s.description || "（SKILL.md 未写 description）")}</span></div>\`).join("")
        : '<span class="tiny">skills/ 目录为空。</span>';
      $("skills").innerHTML = list
        + \`<div class="tiny" style="margin-top:8px">把新技能文件夹（内含 SKILL.md，frontmatter 写 description）放到 <code>\${safe(dir)}</code> 即可——对下一条消息自动生效；修改已有技能需在微信发 /new 重建会话。</div>\`;
      $("skills").classList.remove("muted");
    }

    $("refresh").addEventListener("click", () => loadTab(activeTab, true).catch(alert));
    $("openInstall").addEventListener("click", () => { location.href = "/install"; });
    $("refreshQr").addEventListener("click", async () => {
      await api("/api/auth/qr", { method: "POST", body: "{}" });
      await loadAuth();
    });
    $("pollQr").addEventListener("click", async () => {
      const result = await api("/api/auth/qr-status");
      alert(result.tokenSaved ? "扫码确认成功，token 已保存；请重启服务让发送链路使用新 token。" : "当前状态：" + result.qrStatus);
      await loadAuth();
    });
    $("sessionSearch").addEventListener("input", renderSessions);
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
    $("settingsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await api("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          imageMode: form.get("imageMode"),
          visionModel: form.get("visionModel"),
          conversationModel: form.get("conversationModel"),
          debounceTextMs: Number(form.get("debounceTextMs")),
          debounceMediaMs: Number(form.get("debounceMediaMs")),
          debounceMaxMs: Number(form.get("debounceMaxMs")),
          preprocessMaxChars: Number(form.get("preprocessMaxChars")),
          preprocessBatchMaxChars: Number(form.get("preprocessBatchMaxChars")),
          visionConcurrency: Number(form.get("visionConcurrency")),
          anthropicBaseUrl: form.get("anthropicBaseUrl") || undefined,
          anthropicApiKey: form.get("anthropicApiKey") || undefined,
          anthropicAuthToken: form.get("anthropicAuthToken") || undefined,
          visionBaseUrl: form.get("visionBaseUrl") || undefined,
          visionApiKey: form.get("visionApiKey") || undefined,
          visionAuthToken: form.get("visionAuthToken") || undefined,
        }),
      });
      await loadSettings();
      alert("设置已保存，对下一条消息生效。");
    });
    document.body.addEventListener("click", async (event) => {
      const el = event.target;
      const toggleId = el?.dataset?.toggle;
      const moreId = el?.dataset?.more;
      const sessionId = el?.dataset?.deleteSession;
      const taskId = el?.dataset?.deleteTask;
      const quoteUser = el?.dataset?.deleteQuote;
      if (toggleId) { await toggleSession(toggleId).catch(alert); return; }
      if (moreId) { await loadMoreMessages(moreId).catch(alert); return; }
      if (sessionId && confirm("删除这个会话及其工作目录？")) {
        await api("/api/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
        state.open.delete(sessionId);
        await loadSessions().catch(alert);
      }
      if (taskId && confirm("删除这个定时任务？")) {
        await api("/api/tasks/" + encodeURIComponent(taskId), { method: "DELETE" });
        await loadTasks().catch(alert);
      }
      if (quoteUser && confirm("删除该发送者的报文记录？")) {
        await api("/api/quote-files/" + encodeURIComponent(quoteUser), { method: "DELETE" });
        await loadQuoteFiles().catch(alert);
      }
    });

    // 概览页的 AI 状态与资源占用局部自动刷新
    setInterval(() => {
      if (activeTab === "overview" && document.visibilityState === "visible") {
        loadAgent().catch(() => undefined);
        loadSystem().catch(() => undefined);
      }
    }, 5000);

    // Agent 处理流程实时视图：1 秒增量拉取（仅概览页激活且页面可见时）
    const eventLabels = {
      query_start: "开始", assistant_text: "文本", assistant_thinking: "思考",
      tool_use: "工具调用", tool_result: "工具结果", result: "完成", query_end: "结束",
      msg_in: "收到消息", file_done: "文件处理", msg_out: "已发消息", file_out: "已发文件",
    };
    let agentEventSince = 0;
    const agentEventRows = [];
    const expandedEvents = new Set();

    function renderAgentEvents() {
      const box = $("agentEvents");
      if (!agentEventRows.length) {
        box.classList.add("muted");
        box.innerHTML = '<span class="tiny">空闲</span>';
        return;
      }
      box.classList.remove("muted");
      // 重渲染会销毁节点——先记下各展开块的滚动位置，渲染后按 seq 恢复，
      // 否则调试时正在看的段落每秒被顶回顶部。
      const scrollMemory = new Map();
      box.querySelectorAll("pre[data-event-seq]").forEach((pre) => {
        scrollMemory.set(pre.dataset.eventSeq, pre.scrollTop);
      });
      box.innerHTML = agentEventRows.slice(0, 50).map((e) => {
        const time = hm(e.time);
        const label = eventLabels[e.type] || e.type;
        const session = String(e.sessionId).slice(0, 8);
        const detail = String(e.detail || "").split("\\n")[0].slice(0, 160) || "—";
        const open = expandedEvents.has(e.seq);
        let html = '<div data-event-seq="' + e.seq + '" class="tiny" style="display:flex;gap:8px;align-items:baseline;min-width:0;cursor:pointer" title="点击展开/收起完整内容">'
          + '<span style="color:var(--muted);flex:none">' + safe(time) + "</span>"
          + '<span style="flex:none">' + (open ? "▾" : "▸") + " [" + safe(label) + "]</span>"
          + '<span style="flex:none;color:var(--muted)">' + safe(session) + "</span>"
          + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + safe(detail) + "</span></div>";
        if (open) {
          const full = "[" + label + "] " + String(e.detail || "")
            + (e.data ? "\\n\\n--- data ---\\n" + JSON.stringify(e.data, null, 2) : "");
          html += '<pre data-event-seq="' + e.seq + '" class="tiny" style="margin:2px 0 10px;padding:8px;background:rgba(127,127,127,.08);border-radius:6px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto">' + safe(full) + "</pre>";
        }
        return html;
      }).join("");
      box.querySelectorAll("pre[data-event-seq]").forEach((pre) => {
        const top = scrollMemory.get(pre.dataset.eventSeq);
        if (top != null) pre.scrollTop = top;
      });
    }

    $("agentEvents").addEventListener("click", (event) => {
      const row = event.target.closest("[data-event-seq]");
      if (!row) return;
      const seq = Number(row.dataset.eventSeq);
      if (expandedEvents.has(seq)) expandedEvents.delete(seq);
      else expandedEvents.add(seq);
      renderAgentEvents();
    });

    async function pollAgentEvents() {
      const payload = await api("/api/agent-events?since=" + agentEventSince);
      agentEventSince = payload.lastSeq;
      if (!payload.events.length) return; // 无新事件不重渲染，别打断正在看的滚动位置
      for (const event of payload.events) agentEventRows.unshift(event);
      if (agentEventRows.length > 50) agentEventRows.length = 50;
      renderAgentEvents();
    }

    setInterval(() => {
      if (activeTab === "overview" && document.visibilityState === "visible") {
        pollAgentEvents().catch(() => undefined);
      }
    }, 1000);

    loadTab("overview").catch((err) => {
      document.body.insertAdjacentHTML("afterbegin", '<pre style="margin:20px;color:#b94835">' + safe(err.message) + '</pre>');
    });
  </script>
</body>
</html>`;
}
