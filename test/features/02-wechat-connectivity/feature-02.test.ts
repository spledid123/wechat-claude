/**
 * Feature 02 Test Suite: WeChat iLink Bot Connectivity
 */

import { describe, it, expect } from "vitest";

import {
  encryptAesEcb,
  decryptAesEcb,
  generateAesKeyHex,
  hexToKey,
  md5Hex,
  sha256Hex,
  randomWechatUin,
} from "./wechat/crypto.js";
import { splitLongText } from "./wechat/sender.js";
import type {
  SendMessageRequest,
  GetUpdatesRequest,
  GetUploadUrlRequest,
  WeixinMessage,
} from "./wechat/types.js";
import { parseMessage, normalizeVoiceText } from "./wechat/poller.js";

describe("Group A - Crypto utilities", () => {
  it("A1: encryptAesEcb + decryptAesEcb roundtrip", () => {
    const key = hexToKey(generateAesKeyHex());
    const plaintext = Buffer.from("Hello WeChat! 你好微信");
    const encrypted = encryptAesEcb(plaintext, key);
    const decrypted = decryptAesEcb(encrypted, key);

    const trimmed = Buffer.from(decrypted.subarray(0, plaintext.length));
    expect(trimmed.equals(plaintext)).toBe(true);
  });

  it("A2: encryptAesEcb produces different output than input", () => {
    const key = hexToKey(generateAesKeyHex());
    const plaintext = Buffer.from("test data");
    const encrypted = encryptAesEcb(plaintext, key);
    expect(encrypted.equals(plaintext)).toBe(false);
  });

  it("A3: generateAesKeyHex returns 32-char hex string", () => {
    const hex = generateAesKeyHex();
    expect(hex.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(hex)).toBe(true);
  });

  it("A4: generateAesKeyHex is unique each call", () => {
    const a = generateAesKeyHex();
    const b = generateAesKeyHex();
    expect(a).not.toBe(b);
  });

  it("A5: md5Hex produces 32-char hex", () => {
    const hash = md5Hex(Buffer.from("hello"));
    expect(hash).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("A6: sha256Hex produces 64-char hex", () => {
    const hash = sha256Hex(Buffer.from("hello"));
    expect(hash.length).toBe(64);
  });

  it("A7: randomWechatUin returns base64 string", () => {
    const uin = randomWechatUin();
    expect(typeof uin).toBe("string");
    expect(uin.length).toBeGreaterThan(0);
    expect(() => Buffer.from(uin, "base64")).not.toThrow();
  });

  it("A8: hexToKey correctly parses hex", () => {
    const hex = "aabbccddeeff00112233445566778899";
    const key = hexToKey(hex);
    expect(key.length).toBe(16);
    expect(key[0]).toBe(0xaa);
    expect(key[1]).toBe(0xbb);
    expect(key[15]).toBe(0x99);
  });
});

describe("Group B - splitLongText", () => {
  it("B1: short text returns single element", () => {
    expect(splitLongText("Hello", 1400)).toEqual(["Hello"]);
  });

  it("B2: exactly maxLen returns single element", () => {
    const text = "A".repeat(1400);
    expect(splitLongText(text, 1400)).toHaveLength(1);
  });

  it("B3: long text splits at newlines first", () => {
    const chunk1 = "A".repeat(500) + "\n";
    const chunk2 = "B".repeat(500) + "\n";
    const chunk3 = "C".repeat(500);
    const text = chunk1 + chunk2 + chunk3;
    expect(splitLongText(text, 800).length).toBeGreaterThan(1);
  });

  it("B4: long text without breaks splits at period", () => {
    const text = "A".repeat(800) + "。" + "B".repeat(800);
    expect(splitLongText(text, 1000).length).toBeGreaterThan(1);
  });

  it("B5: tiny maxLen still returns chunks", () => {
    expect(splitLongText("test", 1).length).toBeGreaterThanOrEqual(1);
  });
});

describe("Group C - API request structure", () => {
  it("C1: SendMessageRequest for text is well-formed", () => {
    const req: SendMessageRequest = {
      base_info: { channel_version: "1.0.2" },
      msg: {
        from_user_id: "",
        to_user_id: "user123@im.wechat",
        client_id: "cid",
        message_type: 2,
        message_state: 2,
        context_token: "ctx_abc",
        item_list: [{ type: 1, text_item: { text: "你好" } }],
      },
    };
    expect(req.msg.message_type).toBe(2);
    expect(req.msg.item_list[0].type).toBe(1);
    expect(req.msg.item_list[0].text_item?.text).toBe("你好");
  });

  it("C2: SendMessageRequest for image has media envelope", () => {
    const req: SendMessageRequest = {
      base_info: { channel_version: "1.0.2" },
      msg: {
        from_user_id: "",
        to_user_id: "user123@im.wechat",
        client_id: "cid",
        message_type: 2,
        message_state: 2,
        context_token: "ctx_abc",
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: "enc_param_xyz",
                aes_key: "abcdef0123456789abcdef0123456789",
                encrypt_type: 1,
              },
            },
          },
        ],
      },
    };
    expect(req.msg.item_list[0].image_item?.media.encrypt_type).toBe(1);
  });

  it("C3: GetUpdatesRequest has correct structure", () => {
    const req: GetUpdatesRequest = {
      get_updates_buf: "",
      base_info: { channel_version: "1.0.2" },
    };
    expect(req.base_info.channel_version).toBe("1.0.2");
    expect(req.get_updates_buf).toBe("");
  });

  it("C4: GetUploadUrlRequest uses numeric media_type", () => {
    const req: GetUploadUrlRequest = {
      filekey: "abc",
      media_type: 1,
      to_user_id: "user123@im.wechat",
      rawsize: 1,
      rawfilemd5: "d41d8cd98f00b204e9800998ecf8427e",
      filesize: 16,
      aeskey: "abcdef0123456789abcdef0123456789",
    };
    expect(req.media_type).toBe(1);
    expect(typeof req.aeskey).toBe("string");
  });
});

describe("Group D - Poller message parsing", () => {
  it("D1: text message has type 1", () => {
    const msg: WeixinMessage = {
      from_user_id: "user@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    };
    expect(msg.item_list[0].type).toBe(1);
  });

  it("D2: image message has type 2", () => {
    const msg: WeixinMessage = {
      from_user_id: "user@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "tok",
      item_list: [{ type: 2, image_item: {} }],
    };
    expect(msg.item_list[0].type).toBe(2);
  });

  it("D3: voice message has type 3 with trans_text", () => {
    const msg: WeixinMessage = {
      from_user_id: "user@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "tok",
      item_list: [
        {
          type: 3,
          voice_item: {
            trans_text: "明天下午三点开会",
          },
        },
      ],
    };
    expect(msg.item_list[0].type).toBe(3);
    expect(msg.item_list[0].voice_item?.trans_text).toBe("明天下午三点开会");
  });

  it("D4: file message has type 4 with file_name and len", () => {
    const msg: WeixinMessage = {
      from_user_id: "user@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "tok",
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: "report.pdf",
            len: 102400,
          },
        },
      ],
    };
    expect(msg.item_list[0].type).toBe(4);
    expect(msg.item_list[0].file_item?.file_name).toBe("report.pdf");
    expect(msg.item_list[0].file_item?.len).toBe(102400);
  });

  it("D5: quoted message stays type 1", () => {
    const msg: WeixinMessage = {
      from_user_id: "user@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "引用: 原始消息 - 回复内容" } }],
    };
    expect(msg.item_list[0].type).toBe(1);
    expect(msg.item_list[0].text_item?.text).toContain("引用");
  });

  it("D6: parseMessage keeps quoted voice transcription", () => {
    const parsed = parseMessage({
      from_user_id: "user@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "tok",
      item_list: [
        {
          type: 1,
          text_item: { text: "我引用了一条语音消息" },
          ref_msg: {
            message_item: {
              type: 3,
              voice_item: {
                trans_text: "这是语音里的文字",
              },
            },
          },
        },
      ],
    });

    expect(parsed.text).toBe("我引用了一条语音消息");
    expect(parsed.quotedMessage?.text).toBe("这是语音里的文字");
  });

  it("D7: parseMessage maps quoted image to marker", () => {
    const parsed = parseMessage({
      from_user_id: "user@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "tok",
      item_list: [
        {
          type: 1,
          text_item: { text: "我引用了一张图片" },
          ref_msg: {
            message_item: {
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: "enc",
                  aes_key: "abc",
                  encrypt_type: 1,
                },
              },
            },
          },
        },
      ],
    });

    expect(parsed.quotedMessage?.text).toBe("[图片]");
  });

  it("D8: parseMessage captures direct voice transcription", () => {
    const parsed = parseMessage({
      from_user_id: "user@im.wechat",
      to_user_id: "bot@im.bot",
      message_type: 1,
      message_state: 2,
      context_token: "tok",
      item_list: [
        {
          type: 3,
          voice_item: {
            trans_text: "明天下午三点开会",
            playtime: 1874,
            media: {
              encrypt_query_param: "enc",
              aes_key: "abc",
              encrypt_type: 1,
              full_url: "https://cdn/voice.silk",
            },
          },
        },
      ],
    });

    expect(parsed.voiceText).toBe("明天下午三点开会");
    expect(parsed.itemTypes).toEqual(["voice"]);
    expect(parsed.mediaRefs[0]?.itemType).toBe("voice");
  });

  it("D9: normalizeVoiceText preserves literal recognized text", () => {
    expect(normalizeVoiceText("我发了一段语音")).toBe("我发了一段语音");
    expect(normalizeVoiceText("[语音]")).toBe("[语音]");
    expect(normalizeVoiceText("真正的语音内容")).toBe("真正的语音内容");
  });
});
