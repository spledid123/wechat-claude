/**
 * Feature 05 Test Suite: Message Orchestration
 *
 * Covers:
 *   - message debounce / merge windows
 *   - typing lifecycle
 *   - multi-bubble reply splitting
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Bridge } from "../04-bridge/bridge.js";
import { ClaudeManager } from "../01-claude-dialogue/claude/manager.js";
import { SessionManager } from "../01-claude-dialogue/session/manager.js";
import { ConversationManager } from "../01-claude-dialogue/conversation/manager.js";
import { FilePreprocessor } from "../03-file-preprocessing/preprocessor.js";
import {
  MessageOrchestrator,
  IntervalTypingService,
  type TypingService,
} from "./orchestrator.js";
import {
  setupTestDb,
  teardownTestDb,
  resetTestDb,
  getTestWorkspaceBase,
} from "../../helpers/db.js";
import { queryAll } from "../01-claude-dialogue/db/connection.js";
import type { ParsedMessage } from "../02-wechat-connectivity/wechat/poller.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (_opts: unknown) => {
    async function* gen() {
      yield { type: "assistant" };
      yield { type: "result", result: "mock response" };
    }
    return gen();
  },
  tool: () => ({}),
  createSdkMcpServer: (c: unknown) => c,
}));

let claude: ClaudeManager;
let sm: SessionManager;
let cm: ConversationManager;
let pp: FilePreprocessor;
let bridge: Bridge;
let orchestrator: MessageOrchestrator;
let deliveredTexts: Array<{ toUserId: string; contextToken: string; text: string }>;
let typingEvents: Array<{ type: "start" | "stop"; toUserId: string; contextToken: string }>;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

afterEach(async () => {
  await orchestrator.flushAll();
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  resetTestDb();
  deliveredTexts = [];
  typingEvents = [];

  claude = new ClaudeManager(1);
  sm = new SessionManager(getTestWorkspaceBase(), 60);
  cm = new ConversationManager();
  pp = new FilePreprocessor();

  bridge = new Bridge(
    claude,
    sm,
    cm,
    pp,
    async (params) => {
      deliveredTexts.push(params);
    },
  );

  const typing: TypingService = {
    start(params) {
      typingEvents.push({ type: "start", ...params });
      return {
        stop() {
          typingEvents.push({ type: "stop", ...params });
        },
      };
    },
  };

  orchestrator = new MessageOrchestrator(
    bridge,
    sm,
    cm,
    typing,
    async (params) => {
      deliveredTexts.push(params);
    },
    {
      textDebounceMs: 3000,
      mediaDebounceMs: 5000,
      maxDebounceMs: 15000,
    },
  );
});

function makeParsedMsg(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    raw: {
      from_user_id: "test@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "ctx_123",
      item_list: [{ type: 1, msg_id: "msg-1", text_item: { text: overrides.text ?? "hello" } }],
    },
    text: "hello",
    itemTypes: ["text"],
    cdnUrls: [],
    aesKeys: [],
    mediaRefs: [],
    itemMeta: [],
    ...overrides,
  };
}

describe("Feature 05 - message orchestration", () => {
  it("1: text messages within 3s are merged into one AI turn", async () => {
    const handleSpy = vi.spyOn(bridge, "handleMessages");

    await orchestrator.receiveMessage(
      makeParsedMsg({ text: "第一句", raw: { from_user_id: "u1", to_user_id: "bot", message_type: 1, message_state: 2, context_token: "ctx1", item_list: [{ type: 1, msg_id: "m1", text_item: { text: "第一句" } }] } }),
      "u1",
      "ctx1",
    );
    await orchestrator.receiveMessage(
      makeParsedMsg({ text: "第二句", raw: { from_user_id: "u1", to_user_id: "bot", message_type: 1, message_state: 2, context_token: "ctx1", item_list: [{ type: 1, msg_id: "m2", text_item: { text: "第二句" } }] } }),
      "u1",
      "ctx1",
    );

    expect(handleSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(handleSpy.mock.calls[0][0]).toHaveLength(2);

    const turns = queryAll<{ status: string }>("SELECT status FROM turns ORDER BY id");
    expect(turns.some((row) => row.status === "merged")).toBe(true);
  });

  it("2: media message uses 5s debounce window", async () => {
    const handleSpy = vi.spyOn(bridge, "handleMessages");

    const mediaMsg = makeParsedMsg({
      text: "看图",
      itemTypes: ["image"],
      raw: {
        from_user_id: "u2",
        to_user_id: "bot",
        message_type: 1,
        message_state: 2,
        context_token: "ctx2",
        item_list: [{ type: 2, msg_id: "img1", image_item: {} }],
      },
    });

    await orchestrator.receiveMessage(mediaMsg, "u2", "ctx2");

    await vi.advanceTimersByTimeAsync(3000);
    expect(handleSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(handleSpy).toHaveBeenCalledTimes(1);
  });

  it("3: /new bypasses debounce and is handled immediately", async () => {
    const handleSpy = vi.spyOn(bridge, "handleMessages");

    await orchestrator.receiveMessage(
      makeParsedMsg({
        text: "/new",
        raw: {
          from_user_id: "u3",
          to_user_id: "bot",
          message_type: 1,
          message_state: 2,
          context_token: "ctx3",
          item_list: [{ type: 1, msg_id: "cmd1", text_item: { text: "/new" } }],
        },
      }),
      "u3",
      "ctx3",
    );

    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(deliveredTexts).toEqual([{ toUserId: "u3", contextToken: "ctx3", text: "已新建会话。" }]);
  });

  it("4: typing starts before processing and stops after flush", async () => {
    vi.spyOn(bridge, "handleMessages").mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(10);
      return "mock response";
    });

    await orchestrator.receiveMessage(
      makeParsedMsg({
        text: "长一点",
        raw: {
          from_user_id: "u4",
          to_user_id: "bot",
          message_type: 1,
          message_state: 2,
          context_token: "ctx4",
          item_list: [{ type: 1, msg_id: "t1", text_item: { text: "长一点" } }],
        },
      }),
      "u4",
      "ctx4",
    );

    await vi.advanceTimersByTimeAsync(3000);

    expect(typingEvents[0]).toEqual({
      type: "start",
      toUserId: "u4",
      contextToken: "ctx4",
    });
    expect(typingEvents[typingEvents.length - 1]).toEqual({
      type: "stop",
      toUserId: "u4",
      contextToken: "ctx4",
    });
  });

  it("5: multi-bubble replies split on <<<MSG>>> and cap at 4", async () => {
    const bubbles = orchestrator.splitReplyForWechat(
      "第一条\n<<<MSG>>>\n第二条\n<<<MSG>>>\n第三条\n<<<MSG>>>\n第四条\n<<<MSG>>>\n第五条",
    );

    expect(bubbles).toEqual(["第一条", "第二条", "第三条", "第四条"]);
  });

  it("6: sendReplyBubbles sends each bubble separately", async () => {
    await orchestrator.sendReplyBubbles(
      "u5",
      "ctx5",
      "A\n<<<MSG>>>\nB\n<<<MSG>>>\nC",
    );

    expect(deliveredTexts.map((item) => item.text)).toEqual(["A", "B", "C"]);
  });

  it("7: interval typing sends immediately on start", async () => {
    const sends: Array<{ toUserId: string; contextToken: string }> = [];
    const service = new IntervalTypingService(async (params) => {
      sends.push(params);
    }, 5000);

    const handle = service.start({ toUserId: "u6", contextToken: "ctx6" });

    expect(sends).toEqual([{ toUserId: "u6", contextToken: "ctx6" }]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sends).toEqual([
      { toUserId: "u6", contextToken: "ctx6" },
      { toUserId: "u6", contextToken: "ctx6" },
    ]);

    handle.stop();
  });
});
