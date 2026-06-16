/**
 * WeChat iLink Bot API — message types and protocol structures.
 *
 * Reference: weixin-bot-api.md §3
 * Base URL: https://ilinkai.weixin.qq.com
 */

// --------------- QR Login ---------------

export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string; // base64 PNG (may be empty on some servers)
  baseurl?: string;
}

export type QrCodeStatus =
  | "pending"
  | "scanned"
  | "confirmed"
  | "expired"
  | "cancelled";

export interface QrCodeStatusResponse {
  status: QrCodeStatus;
  bot_token?: string; // present when status === "confirmed"
  baseurl?: string;
}

// --------------- API Envelope ---------------

export interface GetUpdatesRequest {
  get_updates_buf: string;
  base_info: { channel_version: string };
}

export interface GetUpdatesResponse {
  ret: number;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// --------------- Message ---------------

export interface WeixinMessage {
  from_user_id: string; // "o9cq800kum_xxx@im.wechat"
  to_user_id: string; // "e06c1ceea05e@im.bot"
  message_type: number; // 1=user→bot, 2=bot→user
  message_state: number;
  context_token: string;
  group_id?: string;
  item_list: MessageItem[];
}

export interface MessageItem {
  type: ItemType;
  // Item-level metadata (present on all items)
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  button_item_list?: unknown[];
  // Ref message (present on text items that quote another message)
  ref_msg?: {
    msg_id?: string;
    text?: string;
    from_user_id?: string;
    /** The referenced message is nested as a full MessageItem */
    message_item?: Partial<MessageItem>;
  };
  // Item payloads
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  [key: string]: unknown;
}

/** 1=text, 2=image, 3=voice, 4=file, 5=video, 8=mixed */
export type ItemType = 1 | 2 | 3 | 4 | 5 | 8;

export interface TextItem {
  text: string;
}

export interface ImageItem {
  /** AES key hex (note: no underscore — "aeskey" not "aes_key") */
  aeskey?: string;
  full_url?: string;
  url?: string;
  media?: MediaEnvelope; // inbound images have nested media
  mid_size?: number;
  hd_size?: number;
  thumb_size?: number;
  thumb_width?: number;
  thumb_height?: number;
}

export interface VoiceItem {
  /** CDN reference — same nested media envelope as images/files */
  media?: MediaEnvelope;
  /** Server-side transcription (field name varies). */
  trans_text?: string;
  text?: string;
  recognition_text?: string;
  transcript?: string;
  transcribed_text?: string;
  speech_to_text?: string;
  /** Audio metadata */
  playtime?: number; // duration in milliseconds
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  [key: string]: unknown;
}

export interface FileItem {
  media?: MediaEnvelope; // inbound files have nested media
  file_name?: string;
  md5?: string;
  len?: number; // number for inbound, string for outbound
}

export interface VideoItem {
  media?: MediaEnvelope;
  video_size?: number;
  duration_ms?: number;
}

export interface MediaEnvelope {
  encrypt_query_param: string; // from CDN x-encrypted-param
  aes_key: string; // base64(utf8(hexAesKey))
  encrypt_type: number; // 1
  full_url?: string;
  url?: string;
}

// --------------- Sending ---------------

/** media_type for getuploadurl: 1=image, 2=video, 3=file */
export type MediaType = 1 | 2 | 3;

export interface GetUploadUrlRequest {
  filekey: string; // random 16-byte hex
  media_type: MediaType;
  to_user_id: string; // target WeChat user
  rawsize: number; // original file size in bytes
  rawfilemd5: string; // MD5 of original file (hex)
  filesize: number; // encrypted (padded) size
  no_need_thumb?: boolean;
  aeskey: string; // hex of 16-byte AES key
}

export interface GetUploadUrlResponse {
  ret: number;
  upload_full_url?: string;
  upload_param?: string;
  cdn_url?: string;
}

export interface SendMessageRequest {
  base_info: {
    channel_version: string;
  };
  msg: {
    from_user_id: string; // empty string for bot messages
    to_user_id: string;
    client_id: string;
    message_type: 2; // bot→user
    message_state: 2; // FINISH
    context_token: string;
    item_list: Array<{
      type: Exclude<ItemType, 8>;
      text_item?: { text: string };
      image_item?: {
        media: MediaEnvelope;
        mid_size?: number; // number, not object
      };
      file_item?: {
        media: MediaEnvelope;
        file_name: string;
        len: string; // string, not number
      };
      video_item?: {
        media: MediaEnvelope;
        video_size?: number; // number, not object
      };
    }>;
  };
}

export interface SendMessageResponse {
  ret: number;
  msg_id?: string;
}

// --------------- Config ---------------

export interface GetConfigResponse {
  ret: number;
  typing_ticket?: string;
}

// --------------- Typing ---------------

export interface SendTypingRequest {
  to_user_id: string;
  context_token: string;
  typing_ticket: string;
}
