/**
 * Feature 04 Test Suite: Bridge Integration (unit tests, all mocked)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (_opts: unknown) => {
    async function* gen() {
      yield { type: "assistant" };
      yield { type: "result", result: "mock AI response" };
    }
    return gen();
  },
  tool: () => ({}),
  createSdkMcpServer: (c: unknown) => c,
}));

import { Bridge } from "./bridge.js";
import type { SendAttachmentFunc, SendFunc } from "./bridge.js";
import { ClaudeManager } from "../01-claude-dialogue/claude/manager.js";
import { SessionManager } from "../01-claude-dialogue/session/manager.js";
import { ConversationManager } from "../01-claude-dialogue/conversation/manager.js";
import { FilePreprocessor } from "../03-file-preprocessing/preprocessor.js";
import { setupTestDb, teardownTestDb, resetTestDb, getTestWorkspaceBase } from "../../helpers/db.js";
import type { ParsedMessage } from "../02-wechat-connectivity/wechat/poller.js";
import fs from "node:fs";
import path from "node:path";

let bridge: Bridge;
let claude: ClaudeManager;
let sm: SessionManager;
let cm: ConversationManager;
let pp: FilePreprocessor;
let sentMessages: Array<{ toUserId: string; contextToken: string; text: string }> = [];
let sentAttachments: Array<{
  toUserId: string;
  contextToken: string;
  filePath: string;
  kind: "image" | "file";
}> = [];
let sendText: SendFunc;
let sendAttachment: SendAttachmentFunc;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  resetTestDb();
  sentMessages = [];
  sentAttachments = [];
  claude = new ClaudeManager(1);
  sm = new SessionManager(getTestWorkspaceBase(), 60);
  cm = new ConversationManager();
  pp = new FilePreprocessor();

  sendText = async (params) => {
    sentMessages.push(params);
  };

  sendAttachment = async (params) => {
    sentAttachments.push(params);
  };

  bridge = new Bridge(claude, sm, cm, pp, sendText, sendAttachment);
});

function makeParsedMsg(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    raw: {
      from_user_id: "test@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "ctx_123",
      item_list: [{ type: 1, text_item: { text: overrides.text ?? "hello" } }],
    },
    text: "hello",
    itemTypes: ["text"],
    cdnUrls: [],
    aesKeys: [],
    mediaRefs: [] as Array<{ downloadUrl: string; aesKey: string; itemType: string; msgId?: string }>,
    itemMeta: [],
    ...overrides,
  };
}

describe("Bridge text message", () => {
  it("1: plain text routes to Claude and sends reply", async () => {
    const msg = makeParsedMsg({ text: "你好", itemTypes: ["text"] });
    const reply = await bridge.handleMessage(msg, "user1", "ctx_1");

    expect(reply).toBe("mock AI response");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toBe("mock AI response");
    expect(sentMessages[0].toUserId).toBe("user1");
    expect(sentMessages[0].contextToken).toBe("ctx_1");
  });

  it("2: records inbound and outbound in conversations table", async () => {
    const msg = makeParsedMsg({ text: "测试消息" });
    await bridge.handleMessage(msg, "user1", "ctx_1");

    const session = sm.getActiveSession();
    expect(session).not.toBeNull();

    const history = cm.getHistory(session!.id, 10);
    expect(history.length).toBe(2);
    expect(history[0].direction).toBe("outbound");
    expect(history[0].textContent).toBe("mock AI response");
    expect(history[1].direction).toBe("inbound");
    expect(history[1].textContent).toBe("测试消息");
  });
});

describe("Bridge file preprocessing", () => {
  it("3: image path still reaches Claude", async () => {
    const msg = makeParsedMsg({
      text: "分析这张图",
      itemTypes: ["image"],
    });
    msg.raw.item_list = [{ type: 2, image_item: {} }];

    const reply = await bridge.handleMessage(msg, "img-user", "ctx_2");
    expect(reply).toBe("mock AI response");
    expect(sentMessages.length).toBe(1);
  });

  it("4: OCR failure still replies", async () => {
    const msg = makeParsedMsg({
      text: "这张图是什么",
      itemTypes: ["image"],
    });
    msg.raw.item_list = [{ type: 2, image_item: {} }];

    const reply = await bridge.handleMessage(msg, "ocr-fail-user", "ctx_3");
    expect(reply).toBe("mock AI response");
    expect(sentMessages.length).toBe(1);
  });

  it("5: unsupported file type still replies", async () => {
    const msg = makeParsedMsg({
      text: "打开这个文件",
      itemTypes: ["file"],
      fileName: "data.bin",
    });

    const reply = await bridge.handleMessage(msg, "file-user", "ctx_4");
    expect(reply).toBe("mock AI response");
    expect(sentMessages.length).toBe(1);
  });

  it("6: history context is passed through conversation log", async () => {
    await bridge.handleMessage(makeParsedMsg({ text: "第一条消息" }), "hist-user", "ctx_h1");
    await bridge.handleMessage(makeParsedMsg({ text: "第二条消息" }), "hist-user", "ctx_h2");

    const session = sm.getActiveSession();
    expect(session).not.toBeNull();
    const history = cm.getHistory(session!.id, 10);
    expect(history.length).toBe(4);
  });

  it("7: consecutive messages from same user share one active session", async () => {
    await bridge.handleMessage(makeParsedMsg({ text: "msg1" }), "same-user", "ctx_a");
    await bridge.handleMessage(makeParsedMsg({ text: "msg2" }), "same-user", "ctx_b");

    const active = sm.listActiveSessions();
    expect(active.length).toBe(1);
  });

  it("8: /new command closes old session and creates new", async () => {
    await bridge.handleMessage(makeParsedMsg({ text: "msg1" }), "new-user", "ctx_1");
    const active1 = sm.getActiveSession();
    expect(active1).not.toBeNull();

    const replyNew = await bridge.handleMessage(
      makeParsedMsg({ text: "/new" }),
      "new-user",
      "ctx_new",
    );
    expect(replyNew).toContain("已新建会话");

    const sessions = sm.listAllSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    const active2 = sm.getActiveSession();
    expect(active2).not.toBeNull();
    expect(active2!.id).not.toBe(active1!.id);
  });

  it("8b: /help includes scheduled task commands", async () => {
    const reply = await bridge.handleMessage(makeParsedMsg({ text: "/help" }), "cmd-user", "ctx_help");

    expect(reply).toContain("/tasks");
    expect(reply).toContain("/task-del");
    expect(reply).toContain("确认");
    expect(sentMessages).toHaveLength(1);
  });

  it("9: direct voice message records transcription and still replies", async () => {
    const msg = makeParsedMsg({
      text: "",
      itemTypes: ["voice"],
      voiceText: "明天下午三点开会",
      mediaRefs: [
        { downloadUrl: "https://cdn/voice.silk", aesKey: "abc", itemType: "voice", msgId: "voice-1" },
      ],
    });
    msg.raw.item_list = [
      {
        type: 3,
        msg_id: "voice-1",
        voice_item: {
          trans_text: "明天下午三点开会",
        },
      },
    ];

    const reply = await bridge.handleMessage(msg, "voice-user", "ctx_v1");
    expect(reply).toBe("mock AI response");
    expect(sentMessages.length).toBe(1);

    const session = sm.getActiveSession();
    expect(session).not.toBeNull();
    const history = cm.getHistory(session!.id, 10);
    expect(history[1].textContent).toContain("明天下午三点开会");
    expect(cm.findMessageText("voice-1")).toBe("明天下午三点开会");
  });

  it("9b: direct voice keeps literal transcription and still does not attach silk file context", async () => {
    const processSpy = vi.spyOn(pp, "process");
    const msg = makeParsedMsg({
      text: "",
      itemTypes: ["voice"],
      voiceText: "我发了一段语音",
      mediaRefs: [
        { downloadUrl: "https://cdn/voice.silk", aesKey: "abc", itemType: "voice", msgId: "voice-2" },
      ],
    });
    msg.raw.item_list = [
      {
        type: 3,
        msg_id: "voice-2",
        voice_item: {
          trans_text: "我发了一段语音",
        },
      },
    ];

    const reply = await bridge.handleMessage(msg, "voice-user-2", "ctx_v2");
    expect(reply).toBe("mock AI response");
    expect(processSpy).not.toHaveBeenCalled();

    const session = sm.getActiveSession();
    const history = cm.getHistory(session!.id, 10);
    expect(history[1].textContent).toContain("我发了一段语音");
  });

  it("10: quoted voice uses indexed text only in the same conversation", async () => {
    const seeded = sm.createSession("quote-user");
    cm.saveMessageText({
      msgId: "voice-msg-1",
      userId: seeded.userId,
      sessionId: seeded.id,
      fromUserId: "quote-user",
      itemType: "voice",
      textContent: "这是之前语音里的文字",
    });

    const msg = makeParsedMsg({
      text: "你总结一下",
      quotedMessage: {
        msgId: "voice-msg-1",
        text: "[语音]",
        fromUser: "quote-user",
      },
    });

    const reply = await bridge.handleMessage(msg, "quote-user", "ctx_q1");
    expect(reply).toBe("mock AI response");

    const session = sm.getActiveSession();
    const history = cm.getHistory(session!.id, 10);
    expect(history[1].textContent).toContain("这是之前语音里的文字");
    expect(history[1].textContent).not.toContain("[语音]");
  });

  it("11: quoted media can resolve text across conversations", async () => {
    const first = sm.createSession("cross-user");
    cm.saveMessageText({
      msgId: "image-msg-1",
      userId: first.userId,
      sessionId: first.id,
      fromUserId: "cross-user",
      itemType: "image",
      textContent: "图片里的关键信息是明天上午十点签到",
    });
    sm.closeSession(first.id, "test");

    const replyNew = await bridge.handleMessage(
      makeParsedMsg({ text: "/new" }),
      "cross-user",
      "ctx_new",
    );
    expect(replyNew).toContain("已新建会话");

    const msg = makeParsedMsg({
      text: "提醒我一下",
      quotedMessage: {
        msgId: "image-msg-1",
        text: "[图片]",
        fromUser: "cross-user",
      },
    });

    const reply = await bridge.handleMessage(msg, "cross-user", "ctx_cross");
    expect(reply).toBe("mock AI response");

    const session = sm.getActiveSession();
    const history = cm.getHistory(session!.id, 10);
    expect(history[1].textContent).toContain("图片里的关键信息是明天上午十点签到");
    expect(history[1].textContent).not.toContain("[图片]");
  });

  it("12: quoted file resolves stored extracted text by file name across conversations", async () => {
    const first = sm.createSession("file-user");
    cm.saveMessageText({
      msgId: "file-msg-1",
      userId: first.userId,
      sessionId: first.id,
      fromUserId: "file-user",
      itemType: "file",
      fileName: "tpmc.pdf",
      textContent: "这份 PDF 主要研究自由分子流中的双平板作用。",
    });
    sm.closeSession(first.id, "test");

    await bridge.handleMessage(makeParsedMsg({ text: "/new" }), "file-user", "ctx_new");

    const msg = makeParsedMsg({
      text: "我引用了什么内容？",
      quotedMessage: {
        text: "tpmc.pdf",
        itemType: "file",
        fileName: "tpmc.pdf",
      },
    });

    const reply = await bridge.handleMessage(msg, "file-user", "ctx_file");
    expect(reply).toBe("mock AI response");

    const session = sm.getActiveSession();
    const history = cm.getHistory(session!.id, 10);
    expect(history[1].textContent).toContain("这份 PDF 主要研究自由分子流中的双平板作用。");
  });

  it("13: quoted media without stored text fails before reaching AI", async () => {
    const msg = makeParsedMsg({
      text: "你能看到我引用的消息吗？",
      quotedMessage: {
        text: "[图片]",
        itemType: "image",
      },
    });

    const reply = await bridge.handleMessage(msg, "fail-user", "ctx_fail");
    expect(reply).toContain("引用的图片内容未能成功解析");
    expect(sentMessages[sentMessages.length - 1].text).toContain("引用的图片内容未能成功解析");

    const session = sm.getActiveSession();
    const history = cm.getHistory(session!.id, 10);
    expect(history.length).toBe(0);
  });

  it("14: task '去网上照一张猫的图发我' auto-sends a new image from output_weixin", async () => {
    const processSpy = vi.spyOn(claude, "processMessage").mockImplementation(async (spec) => {
      const outDir = path.join(spec.cwd, "working", "output_weixin");
      fs.writeFileSync(path.join(outDir, "cat.png"), "fake image");
      return { text: "猫图已准备好", turnCount: 1, sessionId: spec.sessionId };
    });

    const reply = await bridge.handleMessage(
      makeParsedMsg({ text: "去网上照一张猫的图发我" }),
      "cat-user",
      "ctx_cat",
    );

    expect(reply).toBe("猫图已准备好");
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentAttachments).toEqual([
      {
        toUserId: "cat-user",
        contextToken: "ctx_cat",
        filePath: expect.stringContaining(path.join("output_weixin", "cat.png")),
        kind: "image",
      },
    ]);
  });

  it("15: task '用python计算pi^pi,发我%.5e的结果' auto-sends a new result file once", async () => {
    const processSpy = vi.spyOn(claude, "processMessage");
    processSpy.mockImplementationOnce(async (spec) => {
      const outDir = path.join(spec.cwd, "working", "output_weixin");
      fs.writeFileSync(path.join(outDir, "pi-result.txt"), "3.64159e+01");
      return { text: "结果已写入文件", turnCount: 1, sessionId: spec.sessionId };
    });
    processSpy.mockImplementationOnce(async (spec) => {
      return { text: "结果已写入文件", turnCount: 1, sessionId: spec.sessionId };
    });

    const first = await bridge.handleMessage(
      makeParsedMsg({ text: "用python计算pi^pi,发我%.5e的结果" }),
      "math-user",
      "ctx_math_1",
    );
    const second = await bridge.handleMessage(
      makeParsedMsg({ text: "再确认一下" }),
      "math-user",
      "ctx_math_2",
    );

    expect(first).toBe("结果已写入文件");
    expect(second).toBe("结果已写入文件");
    expect(sentAttachments).toHaveLength(1);
    expect(sentAttachments[0]).toMatchObject({
      toUserId: "math-user",
      contextToken: "ctx_math_1",
      kind: "file",
    });
    expect(sentAttachments[0].filePath).toContain(path.join("output_weixin", "pi-result.txt"));
  });
});
