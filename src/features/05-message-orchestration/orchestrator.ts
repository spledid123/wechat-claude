import { MULTI_BUBBLE_SEPARATOR, MAX_BUBBLES } from "../01-claude-dialogue/prompt-builder.js";
import { getDb } from "../01-claude-dialogue/db/connection.js";
import { getRootLogger } from "../../runtime/logger.js";
import { DEFAULT_CONFIG, type RuntimeConfig } from "../../runtime/config.js";
import type { ConversationManager } from "../01-claude-dialogue/conversation/manager.js";
import type { SessionManager } from "../01-claude-dialogue/session/manager.js";
import type {
  Bridge,
  BridgeMessageInput,
} from "../04-bridge/bridge.js";
import type { ParsedMessage } from "../02-wechat-connectivity/wechat/poller.js";
import type { SchedulerEngine } from "../06-scheduler/scheduler.js";

export interface TypingService {
  start(params: { toUserId: string; contextToken: string }): { stop(): void };
}

export interface SendTextLike {
  (params: { toUserId: string; contextToken: string; text: string }): Promise<void>;
}

interface PendingBatch {
  key: string;
  sessionId: string;
  inputs: BridgeMessageInput[];
  timer: NodeJS.Timeout | null;
  startedAt: number;
  flushPromise?: Promise<void> | null;
}

export interface OrchestratorOptions {
  textDebounceMs?: number;
  mediaDebounceMs?: number;
  maxDebounceMs?: number;
  scheduler?: SchedulerEngine;
  /** Live config source — debounce windows are read per batch so admin
   *  panel edits apply to the next message without a restart. */
  getConfig?: () => RuntimeConfig;
}

const DEFAULT_TEXT_DEBOUNCE_MS = 3000;
const DEFAULT_MEDIA_DEBOUNCE_MS = 5000;
const DEFAULT_MAX_DEBOUNCE_MS = 15000;
const DEFAULT_TYPING_MIN_DELAY_MS = 5000;

export class MessageOrchestrator {
  private readonly textDebounceMs: number;
  private readonly mediaDebounceMs: number;
  private readonly maxDebounceMs: number;
  private readonly scheduler?: SchedulerEngine;
  private readonly getConfig?: () => RuntimeConfig;
  private readonly pending = new Map<string, PendingBatch>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private bridge: Bridge,
    private sm: SessionManager,
    private cm: ConversationManager,
    private typing: TypingService,
    private sendText: SendTextLike,
    options: OrchestratorOptions = {},
  ) {
    this.textDebounceMs = options.textDebounceMs ?? DEFAULT_TEXT_DEBOUNCE_MS;
    this.mediaDebounceMs = options.mediaDebounceMs ?? DEFAULT_MEDIA_DEBOUNCE_MS;
    this.maxDebounceMs = options.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS;
    this.scheduler = options.scheduler;
    this.getConfig = options.getConfig;
  }

  async receiveMessage(
    msg: ParsedMessage,
    fromUserId: string,
    contextToken: string,
  ): Promise<void> {
    if (this.scheduler) {
      const schedulerReply = await this.scheduler.handleCommand(msg.text, fromUserId, contextToken);
      if (schedulerReply !== null) {
        await this.sendText({ toUserId: fromUserId, contextToken, text: schedulerReply });
        return;
      }
    }

    if (this.isImmediateCommand(msg.text)) {
      const reply = await this.bridge.handleMessages(
        [{ msg, fromUserId, contextToken }],
        { deliverReply: false },
      );
      await this.sendReplyBubbles(fromUserId, contextToken, reply);
      return;
    }

    const session = this.sm.resolveSession(fromUserId);
    this.sm.updateContextToken(session.id, contextToken);

    const key = this.batchKey(fromUserId, session.id);
    const existing = this.pending.get(key);
    const input = { msg, fromUserId, contextToken };
    const now = Date.now();

    if (!existing) {
      const batch: PendingBatch = {
        key,
        sessionId: session.id,
        inputs: [input],
        timer: null,
        startedAt: now,
        flushPromise: null,
      };
      batch.timer = this.scheduleFlush(batch);
      this.pending.set(key, batch);
      this.recordBufferedTurn(batch, "buffered");
      return;
    }

    existing.inputs.push(input);
    this.clearTimer(existing);

    const age = now - existing.startedAt;
    if (age >= this.currentDebounce().max) {
      await this.flushBatch(existing);
      return;
    }

    existing.timer = this.scheduleFlush(existing);
    this.recordBufferedTurn(existing, "buffered");
  }

  async flushAll(): Promise<void> {
    const batches = Array.from(this.pending.values());
    for (const batch of batches) {
      await this.flushBatch(batch);
      await batch.flushPromise;
    }
    if (this.inFlight.size > 0) {
      await Promise.all(Array.from(this.inFlight));
    }
  }

  splitReplyForWechat(reply: string): string[] {
    const parts = reply
      .split(MULTI_BUBBLE_SEPARATOR)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, MAX_BUBBLES);

    return parts.length > 0 ? parts : [reply.trim() || "(empty response)"];
  }

  async sendReplyBubbles(
    toUserId: string,
    contextToken: string,
    reply: string,
  ): Promise<string[]> {
    const bubbles = this.splitReplyForWechat(reply);
    for (const text of bubbles) {
      await this.sendText({ toUserId, contextToken, text });
    }
    return bubbles;
  }

  private async flushBatch(batch: PendingBatch): Promise<void> {
    if (batch.flushPromise) {
      await batch.flushPromise;
      return;
    }
    if (!this.pending.has(batch.key)) return;
    this.pending.delete(batch.key);
    this.clearTimer(batch);
    batch.flushPromise = this.runFlush(batch);
    this.inFlight.add(batch.flushPromise);
    try {
      await batch.flushPromise;
    } finally {
      this.inFlight.delete(batch.flushPromise);
      batch.flushPromise = null;
    }
  }

  private scheduleFlush(batch: PendingBatch): NodeJS.Timeout {
    const last = batch.inputs[batch.inputs.length - 1];
    const debounceMs = this.windowForMessage(last.msg);
    return setTimeout(() => {
      // The timer path has no awaiting caller, so an unhandled rejection here
      // would crash the whole process. flushBatch already reports failures to
      // the user (see runFlush); swallow the rejection to stay alive.
      void this.flushBatch(batch).catch(() => undefined);
    }, debounceMs);
  }

  private windowForMessage(msg: ParsedMessage): number {
    const debounce = this.currentDebounce();
    return this.hasMedia(msg) ? debounce.media : debounce.text;
  }

  /** Debounce windows come from the live config; constructor values are the fallback. */
  private currentDebounce(): { text: number; media: number; max: number } {
    const config = this.getConfig?.();
    return {
      text: config?.debounceTextMs ?? this.textDebounceMs,
      media: config?.debounceMediaMs ?? this.mediaDebounceMs,
      max: config?.debounceMaxMs ?? this.maxDebounceMs,
    };
  }

  private hasMedia(msg: ParsedMessage): boolean {
    return msg.itemTypes.some((type) => type !== "text");
  }

  private isImmediateCommand(text: string): boolean {
    const t = text.trim();
    return (
      t === "/new"
      || t === "/help"
      || t === "/list"
      || t === "对话存档"
      || t === "存档"
      || /^(\/*switch|切换对话)\s+\d+$/.test(t)
    );
  }

  private batchKey(fromUserId: string, sessionId: string): string {
    return `${fromUserId}:${sessionId}`;
  }

  private clearTimer(batch: PendingBatch): void {
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
  }

  private async runFlush(batch: PendingBatch): Promise<void> {
    const last = batch.inputs[batch.inputs.length - 1];
    const typingHandle = this.typing.start({
      toUserId: last.fromUserId,
      contextToken: last.contextToken,
    });

    try {
      this.recordBufferedTurn(batch, "merged");
      const reply = await this.bridge.handleMessages(batch.inputs, { deliverReply: false });
      await this.sendReplyBubbles(last.fromUserId, last.contextToken, reply);
    } catch (err) {
      // Never let a batch failure become an unhandled rejection (which would
      // take down the process) or vanish silently — tell the user their
      // messages could not be processed so they can retry.
      getRootLogger().error("[orchestrator] flush failed", err);
      try {
        await this.sendText({
          toUserId: last.fromUserId,
          contextToken: last.contextToken,
          text: "抱歉，处理刚才的消息时出错了，请稍后重试。",
        });
      } catch {
        /* the send channel itself is down; nothing more we can do */
      }
    } finally {
      typingHandle.stop();
    }
  }

  private recordBufferedTurn(batch: PendingBatch, status: "buffered" | "merged"): void {
    const last = batch.inputs[batch.inputs.length - 1];
    const normalizedText = batch.inputs
      .map((input) => input.msg.text || input.msg.voiceText || `[${input.msg.itemTypes.join(",")}]`)
      .join("\n");

    // raw_payload_json intentionally not stored: it duplicated every inbound
    // payload (nothing ever read it back) while sql.js keeps the whole DB in
    // memory. Raw payloads remain in logs/quote/<user>.jsonl for debugging.
    getDb().run(
      `INSERT INTO turns (session_id, context_token, role, normalized_text, status, created_at)
       VALUES (?, ?, 'buffered_user', ?, ?, ?)`,
      [
        batch.sessionId,
        last.contextToken,
        normalizedText,
        status,
        new Date().toISOString(),
      ],
    );
  }
}

class NoopTypingHandle {
  stop(): void {}
}

export class IntervalTypingService implements TypingService {
  constructor(
    private sendTyping: (params: { toUserId: string; contextToken: string }) => Promise<void>,
    private intervalMs = DEFAULT_TYPING_MIN_DELAY_MS,
  ) {}

  start(params: { toUserId: string; contextToken: string }): { stop(): void } {
    let stopped = false;
    void this.sendTyping(params).catch(() => undefined);
    const timer = setInterval(() => {
      if (stopped) return;
      void this.sendTyping(params).catch(() => undefined);
    }, this.intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}

export class NoopTypingService implements TypingService {
  start(): { stop(): void } {
    return new NoopTypingHandle();
  }
}
