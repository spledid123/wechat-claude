import fs from "node:fs";
import {
  initializeDatabase,
  closeDatabase,
  startAutoSave,
} from "../features/01-claude-dialogue/db/connection.js";
import { ClaudeManager } from "../features/01-claude-dialogue/claude/manager.js";
import { SessionManager } from "../features/01-claude-dialogue/session/manager.js";
import { ConversationManager } from "../features/01-claude-dialogue/conversation/manager.js";
import { FilePreprocessor } from "../features/03-file-preprocessing/preprocessor.js";
import { Bridge } from "../features/04-bridge/bridge.js";
import { MessageOrchestrator } from "../features/05-message-orchestration/orchestrator.js";
import { SchedulerEngine } from "../features/06-scheduler/scheduler.js";
import { createAdminServer, type AdminServer } from "../features/07-frontend-admin/admin.js";
import { startPolling, type ParsedMessage } from "../features/02-wechat-connectivity/wechat/poller.js";
import {
  createWechatSendAttachment,
  createWechatSendText,
  createWechatTypingService,
} from "./wechat-runtime.js";
import { buildRuntimePaths, type RuntimePaths } from "./paths.js";
import { createRuntimeLogger, setRootLogger, setDiagnosticsDir, type RuntimeLogger } from "./logger.js";
import { readConfig, applyAnthropicEnvOverrides } from "./config.js";
import { appendQuoteDebugRecord, quoteFilePathForUser } from "./quote-debug.js";
import { runStartupStorageCleanup } from "./storage-cleanup.js";

export type WechatClaudeServiceState =
  | "idle"
  | "starting"
  | "waiting_for_login"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface WechatClaudeServiceOptions {
  repoRoot?: string;
  dataDir?: string;
  adminPort?: number;
  sessionTimeoutMinutes?: number;
  autoSaveIntervalMs?: number;
  schedulerTickMs?: number;
  maxClaudeConcurrency?: number;
}

export interface WechatClaudeServiceStatus {
  state: WechatClaudeServiceState;
  startedAt: string | null;
  adminUrl: string | null;
  tokenPresent: boolean;
  paths: RuntimePaths;
  logFile: string;
}

export class WechatClaudeService {
  private readonly paths: RuntimePaths;
  private readonly logger: RuntimeLogger;
  private readonly adminPort: number;
  private readonly sessionTimeoutMinutes: number;
  private readonly autoSaveIntervalMs: number;
  private readonly schedulerTickMs: number;
  private readonly maxClaudeConcurrency: number;
  private state: WechatClaudeServiceState = "idle";
  private startedAt: Date | null = null;
  private abortController: AbortController | null = null;
  private adminServer: AdminServer | null = null;
  private claude: ClaudeManager | null = null;
  private orchestrator: MessageOrchestrator | null = null;
  private scheduler: SchedulerEngine | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private servicePromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(options: WechatClaudeServiceOptions = {}) {
    this.paths = buildRuntimePaths({
      repoRoot: options.repoRoot,
      dataDir: options.dataDir,
    });
    this.logger = createRuntimeLogger(this.paths.logsDir);
    setRootLogger(this.logger);
    setDiagnosticsDir(this.paths.logsDir);
    this.adminPort = options.adminPort ?? readPortFromEnv(8787);
    this.sessionTimeoutMinutes = options.sessionTimeoutMinutes ?? 60;
    this.autoSaveIntervalMs = options.autoSaveIntervalMs ?? 30_000;
    this.schedulerTickMs = options.schedulerTickMs ?? 30_000;
    this.maxClaudeConcurrency = options.maxClaudeConcurrency ?? 1;
  }

  async start(): Promise<void> {
    if (this.servicePromise) return;
    this.servicePromise = this.run();
    await waitForState(this, (state) => state !== "starting");
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  async waitUntilStopped(): Promise<void> {
    await this.servicePromise;
  }

  getStatus(): WechatClaudeServiceStatus {
    const token = readToken(this.paths.tokenFile);
    return {
      state: this.state,
      startedAt: this.startedAt?.toISOString() ?? null,
      adminUrl: this.adminServer ? `${this.adminServer.url}/` : null,
      tokenPresent: Boolean(token),
      paths: this.paths,
      logFile: this.logger.getLogFile(),
    };
  }

  private async run(): Promise<void> {
    this.state = "starting";
    this.startedAt = new Date();
    this.abortController = new AbortController();
    fs.mkdirSync(this.paths.dataDir, { recursive: true });
    fs.mkdirSync(this.paths.logsDir, { recursive: true });

    const botToken = readToken(this.paths.tokenFile);
    this.logger.info(`WeChat Claude service starting at ${this.startedAt.toISOString()}`);
    this.logger.info(`Data dir: ${this.paths.dataDir}`);
    this.logger.info(`Workspace base: ${this.paths.workspaceBase}`);
    this.logger.info(`Token: ${botToken ? "(configured)" : "(not configured)"}`);

    try {
      await initializeDatabase(this.paths.bridgeDataDir);
      startAutoSave(this.autoSaveIntervalMs);

      // config.json's API overrides (if any) take effect over .env values.
      applyAnthropicEnvOverrides(readConfig(this.paths.dataDir));

      const cleanup = runStartupStorageCleanup(this.paths.workspaceBase);
      if (cleanup.turnsDeleted > 0 || cleanup.closedSessionsDeleted > 0 || cleanup.workspacesRemoved > 0) {
        this.logger.info(
          `Storage cleanup: ${cleanup.turnsDeleted} audit turns, `
            + `${cleanup.closedSessionsDeleted} expired sessions, `
            + `${cleanup.workspacesRemoved} workspaces removed.`,
        );
      }

      this.claude = new ClaudeManager(this.maxClaudeConcurrency);
      const sm = new SessionManager(this.paths.workspaceBase, this.sessionTimeoutMinutes, this.paths.repoRoot);
      const cm = new ConversationManager();
      const pp = new FilePreprocessor({
        appRoot: this.paths.repoRoot,
        dataDir: this.paths.dataDir,
        getMaxChars: () => readConfig(this.paths.dataDir).preprocessMaxChars,
      });
      const sendWechatText: ReturnType<typeof createWechatSendText> = botToken
        ? createWechatSendText(botToken)
        : async () => {
          throw new Error("Bot token is not configured. Open the admin panel and scan a login QR first.");
        };

      this.scheduler = new SchedulerEngine({
        sendText: sendWechatText,
        runAgent: async ({ userId, contextToken, prompt }) => {
          if (!this.claude) throw new Error("Claude manager is not running.");
          const session = sm.resolveSession(userId);
          sm.updateContextToken(session.id, contextToken);
          const agentConfig = readConfig(this.paths.dataDir);
          const result = await this.claude.processMessage(
            {
              sessionId: session.id,
              cwd: session.cwd,
              model: agentConfig.imageMode === "direct"
                ? agentConfig.visionModel
                : agentConfig.conversationModel,
            },
            { userText: prompt },
          );
          return result.text;
        },
      });

      this.adminServer = createAdminServer({
        dataDir: this.paths.dataDir,
        bridgeDataDir: this.paths.bridgeDataDir,
        workspaceBase: this.paths.workspaceBase,
        tokenFile: this.paths.tokenFile,
        scheduler: this.scheduler,
        agentStatus: () => this.claude?.snapshot() ?? null,
      });
      await this.adminServer.listen(this.adminPort);
      this.logger.info(`Admin panel: ${this.adminServer.url}/`);

      if (!botToken) {
        this.state = "waiting_for_login";
        this.logger.warn(`Token file not found or empty: ${this.paths.tokenFile}`);
        this.logger.warn("Admin panel is running. Refresh the QR code, scan it, then restart the service.");
        await waitForAbort(this.abortController.signal);
        return;
      }

      const sendWechatAttachment = createWechatSendAttachment(botToken);
      const bridge = new Bridge(
        this.claude,
        sm,
        cm,
        pp,
        sendWechatText,
        sendWechatAttachment,
        botToken,
        undefined,
        this.scheduler,
        () => readConfig(this.paths.dataDir),
      );
      const typingService = await createWechatTypingService(botToken);
      this.orchestrator = new MessageOrchestrator(
        bridge,
        sm,
        cm,
        typingService,
        sendWechatText,
        {
          scheduler: this.scheduler,
          getConfig: () => readConfig(this.paths.dataDir),
        },
      );
      this.schedulerTimer = setInterval(() => {
        void this.scheduler?.runDueTasks().catch((err) => {
          this.logger.error("Scheduler error:", err);
        });
      }, this.schedulerTickMs);

      // No separate keep-alive heartbeat: the long poll itself is a
      // continuous authenticated call (~every 30s, and at most a 30s backoff
      // on errors), which keeps the iLink token far warmer than a periodic
      // ping ever could. Token staleness is still handled reactively by the
      // poller's stale→live recovery.

      this.state = "running";
      this.logger.info("Listening for WeChat messages.");
      await startPolling(
        botToken,
        {
          onMessage: async (msg: ParsedMessage) => {
            const quoteRecord = appendQuoteDebugRecord(
              msg,
              quoteFilePathForUser(this.paths.logsDir, msg.raw.from_user_id),
            );
            const time = new Date().toLocaleTimeString();
            this.logger.info(`[${time}] inbound ${msg.itemTypes.join("/")} from ${msg.raw.from_user_id}`);
            if (msg.text) this.logger.info(`text: ${msg.text.slice(0, 120)}`);
            if (msg.voiceText) this.logger.info(`voice: ${msg.voiceText}`);
            if (msg.quotedMessage) this.logger.info(`quoted: ${JSON.stringify(msg.quotedMessage)}`);
            if (quoteRecord.rawRefMsgs.length > 0) {
              this.logger.info(`quoted(raw): ${JSON.stringify(quoteRecord.rawRefMsgs)}`);
            }

            try {
              await this.orchestrator?.receiveMessage(
                msg,
                msg.raw.from_user_id,
                msg.raw.context_token,
              );
              this.logger.info("queued for orchestration");
            } catch (err) {
              this.logger.error("Bridge error:", err);
            }
          },
          onError: (err) => {
            this.logger.error(`Poller error: ${err.message}`);
          },
          onReconnect: (delayMs) => {
            this.logger.info(`Reconnect in ${delayMs / 1000}s`);
          },
          onAuthError: (err, stale) => {
            // The iLink token goes stale on inactivity but revives on activity
            // (the user sending a message, or our keep-alive heartbeat) without
            // re-scanning the QR. The poller keeps running, so we only log the
            // stale↔live transitions — the service stays "running".
            if (stale) {
              this.logger.warn(`Bot token went stale: ${err.message}. Keeping poll alive; will recover on next activity.`);
            } else {
              this.logger.info("Bot token recovered; polling normally.");
            }
          },
        },
        this.abortController.signal,
      );
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        this.state = "failed";
        this.logger.error("Service failed:", err);
        throw err;
      }
    } finally {
      await this.cleanup(botToken);
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") return;
    this.state = "stopping";
    this.logger.info("Stopping WeChat Claude service.");
    this.abortController?.abort();
    await this.servicePromise?.catch(() => undefined);
  }

  private async cleanup(botToken: string): Promise<void> {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    await this.adminServer?.close().catch(() => undefined);
    this.adminServer = null;
    await this.orchestrator?.flushAll().catch((err) => this.logger.error("Flush error:", err));
    this.orchestrator = null;
    if (botToken) {
      await this.scheduler?.runDueTasks().catch((err) => this.logger.error("Final scheduler tick failed:", err));
    }
    this.scheduler = null;
    this.claude?.shutdown();
    this.claude = null;
    closeDatabase();
    this.state = "stopped";
    this.logger.info("WeChat Claude service stopped.");
  }
}

function readToken(tokenFile: string): string {
  try {
    return fs.readFileSync(tokenFile, "utf-8").trim();
  } catch {
    return "";
  }
}

function readPortFromEnv(defaultPort: number): number {
  const raw = process.env.WECHAT_ADMIN_PORT;
  if (!raw) return defaultPort;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultPort;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function waitForState(
  service: WechatClaudeService,
  predicate: (state: WechatClaudeServiceState) => boolean,
): Promise<void> {
  if (predicate(service.getStatus().state)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (predicate(service.getStatus().state)) {
        clearInterval(timer);
        resolve();
      }
    }, 25);
  });
}
