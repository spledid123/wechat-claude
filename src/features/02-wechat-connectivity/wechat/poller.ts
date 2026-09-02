/**
 * Long-poll message receiver.
 *
 * Parses inbound WeChat messages, extracting all known fields
 * (text, voice transcription, quoted messages, CDN URLs, etc.)
 */

import { getUpdates, HttpError } from "./api.js";
import type { WeixinMessage, MessageItem } from "./types.js";

export interface ParsedMessage {
  raw: WeixinMessage;
  /** Server-side message id (survives quotes); item msg_id is v1:-scoped. */
  messageId?: string;
  text: string;
  itemTypes: string[];
  voiceText?: string;
  voiceDurationMs?: number;
  fileName?: string;
  fileMd5?: string;
  fileSize?: number;
  cdnUrls: string[];
  aesKeys: string[];
  mediaRefs: Array<{
    downloadUrl: string;
    aesKey: string;
    itemType: string;
    encryptQueryParam?: string;
    msgId?: string;
  }>;
  quotedMessage?: {
    msgId?: string;
    text?: string;
    fromUser?: string;
    itemType?: string;
    fileName?: string;
    mediaKey?: string;
    /** Server-side timestamp of the QUOTED message (nested create_time_ms). */
    createTimeMs?: number;
  };
  itemMeta: Array<{
    msgId?: string;
    createTimeMs?: number;
    isCompleted?: boolean;
  }>;
}

export interface PollerCallbacks {
  onMessage: (msg: ParsedMessage) => void;
  onError?: (err: Error) => void;
  onReconnect?: (delayMs: number) => void;
  /**
   * Called when the bot_token starts being rejected (HTTP 401/403), and again
   * once it recovers. `stale=true` means the token just went stale; `stale=false`
   * means a poll succeeded again. Polling does NOT stop — the iLink token revives
   * on activity, so we keep polling and auto-recover on the next successful poll
   * (e.g. right after the user sends a message).
   */
  onAuthError?: (err: Error, stale: boolean) => void;
}

export async function startPolling(
  botToken: string,
  callbacks: PollerCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  let getUpdatesBuf = "";
  let consecutiveErrors = 0;
  let authStale = false;

  while (!signal?.aborted) {
    try {
      const res = await getUpdates(
        {
          get_updates_buf: getUpdatesBuf,
          base_info: { channel_version: "1.0.2" },
        },
        botToken,
        signal,
      );

      // A nonzero ret with no messages means the server rejected the poll at
      // the application layer (e.g. a stale token returning HTTP 200). Treat
      // it as an error and back off instead of spinning in a tight hot loop.
      if (res.ret && res.ret !== 0) {
        throw new HttpError(401, `getupdates returned ret=${res.ret}`);
      }

      consecutiveErrors = 0;
      // A successful poll means the token is live again.
      if (authStale) {
        authStale = false;
        callbacks.onAuthError?.(new Error("bot_token recovered"), false);
      }
      if (res.get_updates_buf) {
        getUpdatesBuf = res.get_updates_buf;
      }

      if (res.msgs?.length) {
        for (const msg of res.msgs) {
          if (msg.message_type !== 1) continue;
          // Isolate per-message handler failures: one bad message must not
          // skip the rest of the batch or be counted as a network error.
          try {
            callbacks.onMessage(parseMessage(msg));
          } catch (handlerErr) {
            callbacks.onError?.(handlerErr as Error);
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) break;

      consecutiveErrors++;
      const isAuthError =
        err instanceof HttpError && (err.status === 401 || err.status === 403);

      if (isAuthError) {
        // The iLink token goes stale on inactivity but revives on activity and
        // does NOT require re-scanning the QR. So keep polling with a short,
        // fixed backoff — the next successful poll (e.g. right after the user
        // sends a WeChat message) recovers automatically. Notify once per
        // stale→live transition so the UI can hint without log spam.
        if (!authStale) {
          authStale = true;
          callbacks.onAuthError?.(err as Error, true);
        }
        callbacks.onReconnect?.(AUTH_RETRY_DELAY_MS);
        await sleep(AUTH_RETRY_DELAY_MS, signal);
        continue;
      }

      callbacks.onError?.(err as Error);
      const delay = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), 30_000);
      callbacks.onReconnect?.(delay);
      await sleep(delay, signal);
    }
  }
}

/** Backoff between polls while the token is stale (kept short for fast recovery). */
const AUTH_RETRY_DELAY_MS = 10_000;

export function parseMessage(msg: WeixinMessage): ParsedMessage {
  const result: ParsedMessage = {
    raw: msg,
    messageId: msg.message_id,
    text: "",
    itemTypes: [],
    cdnUrls: [],
    aesKeys: [],
    mediaRefs: [],
    itemMeta: [],
  };

  for (const item of msg.item_list ?? []) {
    result.itemTypes.push(itemTypeName(item.type));
    result.itemMeta.push({
      msgId: msg.message_id ?? item.msg_id,
      createTimeMs: item.create_time_ms,
      isCompleted: item.is_completed,
    });

    if (item.type === 1 && item.text_item) {
      const text = item.text_item.text ?? "";
      result.text += (result.text ? "\n" : "") + text;

      if (item.ref_msg) {
        const nested = item.ref_msg.message_item;
        let quotedText = normalizeText(item.ref_msg.text);
        if (!quotedText) quotedText = extractMessageItemText(nested);
        result.quotedMessage = {
          // WeChat keeps the quoted message's id on the INNER message_item;
          // ref_msg.msg_id itself is usually absent. Read both so the quote
          // index lookup has a key to match against.
          msgId: nested?.msg_id ?? item.ref_msg.msg_id,
          text: quotedText || undefined,
          fromUser: item.ref_msg.from_user_id,
          itemType: nested?.type ? itemTypeName(nested.type) : undefined,
          fileName: nested?.file_item?.file_name,
          mediaKey: extractMediaKey(nested),
          createTimeMs: nested?.create_time_ms,
        };
      }
    }

    if (item.type === 2 && item.image_item) {
      const img = item.image_item;
      const downloadUrl = img.media?.full_url || img.full_url || img.media?.url;
      const aesKey = img.aeskey || img.media?.aes_key || "";
      if (img.aeskey) result.aesKeys.push(img.aeskey);
      if (img.media?.aes_key) result.aesKeys.push(img.media.aes_key);
      if (downloadUrl) {
        result.cdnUrls.push(downloadUrl.slice(0, 80));
        result.mediaRefs.push({
          downloadUrl,
          aesKey,
          itemType: "image",
          encryptQueryParam: img.media?.encrypt_query_param,
          msgId: msg.message_id ?? item.msg_id,
        });
      }
    }

    if (item.type === 3 && item.voice_item) {
      const voice = item.voice_item;
      result.voiceText = normalizeVoiceText(
        voice.trans_text ??
          voice.text ??
          voice.recognition_text ??
          voice.transcript ??
          voice.transcribed_text ??
          voice.speech_to_text,
      );

      const downloadUrl = voice.media?.full_url || voice.media?.url;
      if (downloadUrl) {
        result.cdnUrls.push(downloadUrl.slice(0, 80));
        result.mediaRefs.push({
          downloadUrl,
          aesKey: voice.media?.aes_key || "",
          itemType: "voice",
          encryptQueryParam: voice.media?.encrypt_query_param,
          msgId: msg.message_id ?? item.msg_id,
        });
      }
      if (voice.media?.aes_key) result.aesKeys.push(voice.media.aes_key);
      if (voice.playtime) result.voiceDurationMs = voice.playtime;
    }

    if (item.type === 4 && item.file_item) {
      const file = item.file_item;
      if (file.file_name) result.fileName = file.file_name;
      if (file.md5) result.fileMd5 = file.md5;
      if (file.len) result.fileSize = file.len;
      const downloadUrl = file.media?.full_url || file.media?.url;
      if (downloadUrl) {
        result.cdnUrls.push(downloadUrl.slice(0, 80));
        result.mediaRefs.push({
          downloadUrl,
          aesKey: file.media?.aes_key || "",
          itemType: "file",
          encryptQueryParam: file.media?.encrypt_query_param,
          msgId: msg.message_id ?? item.msg_id,
        });
      }
      if (file.media?.aes_key) result.aesKeys.push(file.media.aes_key);
    }

    if (item.type === 5 && item.video_item) {
      const video = item.video_item;
      const downloadUrl = video.media?.full_url || video.media?.url;
      if (downloadUrl) {
        result.cdnUrls.push(downloadUrl.slice(0, 80));
        result.mediaRefs.push({
          downloadUrl,
          aesKey: video.media?.aes_key || "",
          itemType: "video",
          encryptQueryParam: video.media?.encrypt_query_param,
          msgId: msg.message_id ?? item.msg_id,
        });
      }
      if (video.media?.aes_key) result.aesKeys.push(video.media.aes_key);
    }
  }

  return result;
}

export function extractMessageItemText(item?: Partial<MessageItem>): string | undefined {
  if (!item) return undefined;

  const voiceText = normalizeVoiceText(
    item.voice_item?.trans_text ??
      item.voice_item?.text ??
      item.voice_item?.recognition_text ??
      item.voice_item?.transcript ??
      item.voice_item?.transcribed_text ??
      item.voice_item?.speech_to_text,
  );

  switch (item.type) {
    case 1:
      return normalizeText(item.text_item?.text);
    case 2:
      return "[图片]";
    case 3:
      return normalizeText(voiceText) ?? "[语音]";
    case 4:
      return normalizeText(item.file_item?.file_name) ?? "[文件]";
    case 5:
      return "[视频]";
    case 8:
      return "[混合消息]";
    default:
      return (
        normalizeText(item.text_item?.text) ??
        normalizeText(voiceText) ??
        normalizeText(item.file_item?.file_name)
      );
  }
}

function extractMediaKey(item?: Partial<MessageItem>): string | undefined {
  if (!item) return undefined;
  if (item.type === 2) {
    return item.image_item?.aeskey ?? item.image_item?.media?.aes_key;
  }
  if (item.type === 3) {
    return item.voice_item?.media?.aes_key;
  }
  if (item.type === 4) {
    return item.file_item?.media?.aes_key;
  }
  if (item.type === 5) {
    return item.video_item?.media?.aes_key;
  }
  return undefined;
}

function normalizeText(text?: string): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed || trimmed === "undefined") return undefined;
  return trimmed;
}

export function normalizeVoiceText(text?: string): string | undefined {
  return normalizeText(text);
}

function itemTypeName(type: number): string {
  switch (type) {
    case 1:
      return "text";
    case 2:
      return "image";
    case 3:
      return "voice";
    case 4:
      return "file";
    case 5:
      return "video";
    default:
      return `unknown(${type})`;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
