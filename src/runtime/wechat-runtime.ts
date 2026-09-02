import { getRootLogger } from "./logger.js";
import { getConfig, sendTyping } from "../features/02-wechat-connectivity/wechat/api.js";
import {
  sendFile,
  sendImage,
  sendText,
  splitLongText,
} from "../features/02-wechat-connectivity/wechat/sender.js";
import {
  IntervalTypingService,
  NoopTypingService,
  type SendTextLike,
  type TypingService,
} from "../features/05-message-orchestration/orchestrator.js";
import type { SendAttachmentFunc } from "../features/04-bridge/bridge.js";

export interface OutboundTextSent {
  toUserId: string;
  /** The text of THIS bubble — one reply may be split into several. */
  bubbleText: string;
  /** Server-side message id of this bubble; absent if the API did not return one. */
  msgId?: string;
}

export function createWechatSendText(
  botToken: string,
  onSent?: (info: OutboundTextSent) => void,
): SendTextLike {
  return async ({ toUserId, contextToken, text }) => {
    const bubbles = splitLongText(text);
    for (let i = 0; i < bubbles.length; i += 1) {
      const sent = await sendText({ toUserId, contextToken, text: bubbles[i] }, botToken);
      // Long replies split into bubbles, each with its own server msg_id —
      // and a later WeChat quote references the quoted BUBBLE's id. Report
      // per bubble so the quote index maps id → that bubble's text.
      if (onSent) {
        try {
          onSent({ toUserId, bubbleText: bubbles[i], msgId: sent.msgId });
        } catch {
          // Indexing is best-effort; it must never fail the send itself.
        }
      }
      if (i < bubbles.length - 1) {
        await sleep(500);
      }
    }
  };
}

export function createWechatSendAttachment(botToken: string): SendAttachmentFunc {
  return async ({ toUserId, contextToken, filePath, kind }) => {
    if (kind === "image") {
      // Surface the msg_id so the bridge can index outbound images for
      // later quote lookups.
      const sent = await sendImage({ toUserId, contextToken, filePath }, botToken);
      return { msgId: sent.msgId };
    }

    await sendFile({ toUserId, contextToken, filePath }, botToken);
  };
}

export async function createWechatTypingService(botToken: string): Promise<TypingService> {
  try {
    const config = await getConfig(botToken);
    const typingTicket = config.typing_ticket?.trim();
    if (!typingTicket) {
      getRootLogger().warn("Typing disabled: getconfig did not return typing_ticket.");
      return new NoopTypingService();
    }

    return new IntervalTypingService(async ({ toUserId, contextToken }) => {
      await sendTyping(
        {
          to_user_id: toUserId,
          context_token: contextToken,
          typing_ticket: typingTicket,
        },
        botToken,
      );
    });
  } catch (err) {
    getRootLogger().warn(`Typing disabled: ${(err as Error).message}`);
    return new NoopTypingService();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
