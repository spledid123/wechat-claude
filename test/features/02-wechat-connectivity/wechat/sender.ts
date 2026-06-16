/**
 * Message sender — text, images, files, videos.
 *
 * Protocol matched to working codex_for_wechat implementation.
 */

import { sendMessage, getUploadUrl, uploadToCdn, generateClientId, CHANNEL_VERSION } from "./api.js";
import {
  encryptAesEcb,
  aesEcbPaddedSize,
  generateAesKeyHex,
  generateFileKeyHex,
  hexToKey,
  md5Hex,
  buildMediaAesKey,
} from "./crypto.js";
import type { MediaEnvelope } from "./types.js";
import fs from "node:fs";
import path from "node:path";

/** WeChat CDN base URL for file uploads. */
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// --------------- CDN upload helper ---------------

interface UploadResult {
  encryptedParam: string;
  uploadFullUrl?: string;
  uploadParam?: string;
}

/**
 * Get upload URL from WeChat and upload encrypted file to CDN.
 * Handles both upload_full_url (direct) and upload_param (build URL).
 */
async function uploadFile(
  body: {
    filekey: string;
    media_type: 1 | 3;
    toUserId: string;
    rawSize: number;
    rawMd5: string;
    paddedSize: number;
    aesKeyHex: string;
    aesKey: Buffer;
    fileBuffer: Buffer;
  },
  botToken: string,
): Promise<string> {
  const encrypted = encryptAesEcb(body.fileBuffer, body.aesKey);

  const uploadResp = await getUploadUrl(
    {
      filekey: body.filekey,
      media_type: body.media_type,
      to_user_id: body.toUserId,
      rawsize: body.rawSize,
      rawfilemd5: body.rawMd5,
      filesize: body.paddedSize,
      no_need_thumb: true,
      aeskey: body.aesKeyHex,
    },
    botToken,
  );

  // Build the actual upload URL
  const uploadUrl = uploadResp.upload_full_url
    ? uploadResp.upload_full_url
    : uploadResp.upload_param
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param)}&filekey=${encodeURIComponent(body.filekey)}`
      : null;

  if (!uploadUrl) {
    throw new Error(
      `getuploadurl returned no URL. ` +
      `upload_full_url=${uploadResp.upload_full_url ?? "missing"}, ` +
      `upload_param=${uploadResp.upload_param ?? "missing"}`,
    );
  }

  const encryptedParam = await uploadToCdn(uploadUrl, encrypted);
  if (!encryptedParam) {
    throw new Error("CDN upload succeeded but x-encrypted-param header missing");
  }

  return encryptedParam;
}

// --------------- Text ---------------

export interface SendTextParams {
  toUserId: string;
  contextToken: string;
  text: string;
}

export async function sendText(
  params: SendTextParams,
  botToken: string,
): Promise<{ ret: number; msgId?: string }> {
  const res = await sendMessage(
    {
      base_info: { channel_version: CHANNEL_VERSION },
      msg: {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        context_token: params.contextToken,
        item_list: [
          { type: 1, text_item: { text: params.text } },
        ],
      },
    },
    botToken,
  );

  return { ret: res.ret, msgId: res.msg_id };
}

// --------------- Image ---------------

export interface SendImageParams {
  toUserId: string;
  contextToken: string;
  filePath: string;
}

export async function sendImage(
  params: SendImageParams,
  botToken: string,
): Promise<{ ret: number; msgId?: string }> {
  const fileBuffer = fs.readFileSync(params.filePath);
  const rawSize = fileBuffer.length;
  const rawMd5 = md5Hex(fileBuffer);
  const aesKeyHex = generateAesKeyHex();
  const aesKey = hexToKey(aesKeyHex);
  const filekey = generateFileKeyHex();
  const paddedSize = aesEcbPaddedSize(rawSize);

  const encryptedParam = await uploadFile(
    {
      filekey,
      media_type: 1,
      toUserId: params.toUserId,
      rawSize,
      rawMd5,
      paddedSize,
      aesKeyHex,
      aesKey,
      fileBuffer,
    },
    botToken,
  );

  const media: MediaEnvelope = {
    encrypt_query_param: encryptedParam,
    aes_key: buildMediaAesKey(aesKeyHex),
    encrypt_type: 1,
  };

  const res = await sendMessage(
    {
      base_info: { channel_version: CHANNEL_VERSION },
      msg: {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        context_token: params.contextToken,
        item_list: [
          {
            type: 2,
            image_item: { media },
          },
        ],
      },
    },
    botToken,
  );

  return { ret: res.ret, msgId: res.msg_id };
}

// --------------- File ---------------

export interface SendFileParams {
  toUserId: string;
  contextToken: string;
  filePath: string;
}

export async function sendFile(
  params: SendFileParams,
  botToken: string,
): Promise<{ ret: number; msgId?: string }> {
  const fileBuffer = fs.readFileSync(params.filePath);
  const rawSize = fileBuffer.length;
  const rawMd5 = md5Hex(fileBuffer);
  const fileName = path.basename(params.filePath);
  const aesKeyHex = generateAesKeyHex();
  const aesKey = hexToKey(aesKeyHex);
  const filekey = generateFileKeyHex();
  const paddedSize = aesEcbPaddedSize(rawSize);

  const encryptedParam = await uploadFile(
    {
      filekey,
      media_type: 3,
      toUserId: params.toUserId,
      rawSize,
      rawMd5,
      paddedSize,
      aesKeyHex,
      aesKey,
      fileBuffer,
    },
    botToken,
  );

  const media: MediaEnvelope = {
    encrypt_query_param: encryptedParam,
    aes_key: buildMediaAesKey(aesKeyHex),
    encrypt_type: 1,
  };

  const res = await sendMessage(
    {
      base_info: { channel_version: CHANNEL_VERSION },
      msg: {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        context_token: params.contextToken,
        item_list: [
          {
            type: 4,
            file_item: {
              media,
              file_name: fileName,
              len: String(rawSize),
            },
          },
        ],
      },
    },
    botToken,
  );

  return { ret: res.ret, msgId: res.msg_id };
}

// --------------- Utility ---------------

export function splitLongText(text: string, maxLen = 1400): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) {
      splitAt = remaining.lastIndexOf("。", maxLen);
    }
    if (splitAt < maxLen * 0.5) {
      splitAt = remaining.lastIndexOf(". ", maxLen);
    }
    if (splitAt < 1) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
