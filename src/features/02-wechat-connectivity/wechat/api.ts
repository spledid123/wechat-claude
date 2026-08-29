/**
 * iLink Bot API — HTTP client.
 *
 * Matches the working codex_for_wechat implementation structure.
 */

import { randomWechatUin, generateClientId } from "./crypto.js";
import type {
  QrCodeResponse,
  QrCodeStatusResponse,
  GetUpdatesRequest,
  GetUpdatesResponse,
  SendMessageRequest,
  SendMessageResponse,
  GetUploadUrlRequest,
  GetUploadUrlResponse,
  GetConfigResponse,
  SendTypingRequest,
} from "./types.js";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.2";

// --------------- low-level HTTP ---------------

interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (opts.signal?.aborted) {
    controller.abort();
  } else {
    opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 40_000,
  );

  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    // Surface HTTP errors instead of blindly JSON-parsing them. Error pages are
    // usually HTML, which would otherwise throw an opaque "Unexpected token '<'"
    // and hide the status code — breaking auth-failure (401/403) detection.
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new HttpError(res.status, bodyText.slice(0, 200));
    }
    // WeChat's server-side message ids (message_id, and msg_id in quote
    // refs) are 19-digit integers. JSON.parse() rounds anything above 2^53,
    // silently corrupting them (the quote's nested msg_id arrives as a string
    // and survives exactly — so the two would never match). Quote large
    // integer literals into strings before parsing to keep ids exact.
    const rawText = await res.text();
    return JSON.parse(rawText.replace(
      /("(?:message_id|msg_id)"\s*:\s*)(-?\d{15,})/g,
      '$1"$2"',
    )) as T;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** HTTP error carrying the status code so callers can detect auth failures. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    body = "",
  ) {
    super(`HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "HttpError";
  }
}

// --------------- auth headers ---------------

function authHeaders(_botToken: string): Record<string, string> {
  return {
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    Authorization: `Bearer ${_botToken}`,
  };
}

// --------------- QR Login (unauthenticated) ---------------

export async function getBotQrCode(): Promise<QrCodeResponse> {
  return request<QrCodeResponse>(
    "/ilink/bot/get_bot_qrcode?bot_type=3",
  );
}

export async function getQrCodeStatus(
  qrcode: string,
): Promise<QrCodeStatusResponse> {
  return request<QrCodeStatusResponse>(
    `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
  );
}

// --------------- Messages (authenticated) ---------------

export async function getUpdates(
  body: GetUpdatesRequest,
  botToken: string,
  signal?: AbortSignal,
): Promise<GetUpdatesResponse> {
  return request<GetUpdatesResponse>("/ilink/bot/getupdates", {
    method: "POST",
    headers: authHeaders(botToken),
    body,
    timeoutMs: 45_000,
    signal,
  });
}

/**
 * Send a message. Uses the same structure as codex_for_wechat:
 *   { base_info: {...}, msg: { from_user_id, to_user_id, client_id, ... } }
 */
export async function sendMessage(
  body: SendMessageRequest,
  botToken: string,
): Promise<SendMessageResponse> {
  return request<SendMessageResponse>("/ilink/bot/sendmessage", {
    method: "POST",
    headers: authHeaders(botToken),
    body: {
      ...body,
      base_info: body.base_info ?? { channel_version: CHANNEL_VERSION },
    },
  });
}

// --------------- CDN Upload ---------------

/**
 * Request a pre-signed CDN upload URL.
 * Body includes base_info wrapper (matching codex_for_wechat).
 */
export async function getUploadUrl(
  body: GetUploadUrlRequest,
  botToken: string,
): Promise<GetUploadUrlResponse> {
  return request<GetUploadUrlResponse>("/ilink/bot/getuploadurl", {
    method: "POST",
    headers: authHeaders(botToken),
    body: {
      ...body,
      base_info: {
        channel_version: CHANNEL_VERSION,
      },
    },
  });
}

/** Upload encrypted file bytes to the CDN. Returns x-encrypted-param. */
export async function uploadToCdn(
  uploadUrl: string,
  encryptedData: Buffer,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(encryptedData),
      signal: controller.signal,
    });
    return res.headers.get("x-encrypted-param");
  } finally {
    clearTimeout(timer);
  }
}

// --------------- Config ---------------

export async function getConfig(
  botToken: string,
): Promise<GetConfigResponse> {
  return request<GetConfigResponse>("/ilink/bot/getconfig", {
    method: "POST",
    headers: authHeaders(botToken),
    body: {},
  });
}

export async function sendTyping(
  body: SendTypingRequest,
  botToken: string,
): Promise<{ ret: number }> {
  return request<{ ret: number }>("/ilink/bot/sendtyping", {
    method: "POST",
    headers: authHeaders(botToken),
    body,
  });
}

// re-export for convenience
export { generateClientId, CHANNEL_VERSION };
