/**
 * QR code login flow for WeChat iLink Bot.
 *
 * Flow:
 *   1. getBotQrCode() → { qrcode, qrcode_img_content (URL or base64) }
 *   2. Generate QR image from URL or decode base64 → save as PNG
 *   3. Poll getQrCodeStatus(qrcode) every 1-2s
 *   4. On "confirmed" → save bot_token
 */

import { getBotQrCode, getQrCodeStatus } from "./api.js";
import type { QrCodeResponse } from "./types.js";
import QRCode from "qrcode";
import fs from "node:fs";
import path from "node:path";

export interface LoginResult {
  botToken: string;
  baseurl: string;
  qrcode: string;
}

/**
 * Full login flow.
 *
 * @param onQrCode  Called when QR code is ready. Receives the response.
 *                  The caller should display the image to the user.
 * @param pollIntervalMs  How often to check scan status (default 1500ms).
 * @param maxWaitMs       Maximum time to wait for scan (default 180_000 = 3 min).
 */
export async function login(
  onQrCode: (qr: QrCodeResponse) => Promise<void> | void,
  pollIntervalMs = 1500,
  maxWaitMs = 180_000,
): Promise<LoginResult> {
  // Step 1: Get QR code
  const qr = await getBotQrCode();
  if (!qr.qrcode) {
    throw new Error("No qrcode in response");
  }
  await onQrCode(qr);

  // Step 2: Poll for confirmation
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    const status = await getQrCodeStatus(qr.qrcode);

    switch (status.status) {
      case "confirmed":
        if (!status.bot_token) {
          throw new Error("Confirmed but no bot_token in response");
        }
        return {
          botToken: status.bot_token,
          baseurl: status.baseurl ?? "https://ilinkai.weixin.qq.com",
          qrcode: qr.qrcode,
        };

      case "expired":
        throw new Error("QR code expired. Please restart login.");

      case "cancelled":
        throw new Error("Login cancelled by user.");

      case "scanned":
        // User scanned but hasn't confirmed yet — keep polling
        break;

      case "pending":
      default:
        // Still waiting — keep polling
        break;
    }
  }

  throw new Error("Login timed out (QR code not scanned within 3 minutes).");
}

/**
 * Generate a QR code PNG image file.
 *
 * Handles two formats from the API:
 *   - URL:  "https://liteapp.weixin.qq.com/q/..." → generate QR from URL
 *   - base64: "iVBORw0KGgo..." → decode to PNG directly
 *
 * @param content  The `qrcode_img_content` from the API response.
 * @param outputDir  Directory to save the PNG file.
 * @returns  Path to the saved PNG file.
 */
export async function saveQrImage(
  content: string,
  outputDir: string,
): Promise<string> {
  const filePath = path.join(outputDir, "wechat-qr.png");

  if (content.startsWith("http")) {
    // It's a URL — generate a QR code image from it
    await QRCode.toFile(filePath, content, {
      width: 400,
      margin: 2,
      type: "png",
      errorCorrectionLevel: "M",
    });
  } else {
    // It's base64-encoded PNG — decode and save
    const clean = content.replace(/^data:image\/\w+;base64,/, "");
    fs.writeFileSync(filePath, Buffer.from(clean, "base64"));
  }

  return filePath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
