import fs from "node:fs";
import path from "node:path";
import type { ParsedMessage } from "../features/02-wechat-connectivity/wechat/poller.js";

export interface QuoteDebugRecord {
  receivedAt: string;
  fromUserId: string;
  contextToken: string;
  itemTypes: string[];
  text: string;
  quotedMessage: ParsedMessage["quotedMessage"] | null;
  rawRefMsgs: unknown[];
  rawItems: ParsedMessage["raw"]["item_list"];
}

export function appendQuoteDebugRecord(
  msg: ParsedMessage,
  quoteJsonlPath: string,
): QuoteDebugRecord {
  fs.mkdirSync(path.dirname(quoteJsonlPath), { recursive: true });
  const record = buildQuoteDebugRecord(msg);
  fs.appendFileSync(quoteJsonlPath, `${JSON.stringify(record)}\n`);
  return record;
}

function buildQuoteDebugRecord(msg: ParsedMessage): QuoteDebugRecord {
  const rawRefMsgs = (msg.raw.item_list ?? [])
    .filter((item) => item.ref_msg)
    .map((item) => ({
      type: item.type,
      msg_id: item.msg_id,
      ref_msg: item.ref_msg,
      text_item: item.text_item,
      voice_item: item.voice_item,
      file_item: item.file_item,
      image_item: item.image_item,
      video_item: item.video_item,
    }));

  return {
    receivedAt: new Date().toISOString(),
    fromUserId: msg.raw.from_user_id,
    contextToken: msg.raw.context_token,
    itemTypes: msg.itemTypes,
    text: msg.text,
    quotedMessage: msg.quotedMessage ?? null,
    rawRefMsgs,
    rawItems: msg.raw.item_list,
  };
}
