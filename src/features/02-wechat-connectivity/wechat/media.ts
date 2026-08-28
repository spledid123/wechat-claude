/**
 * WeChat CDN media download + decrypt.
 *
 * CDN base: https://novac2c.cdn.weixin.qq.com/c2c
 * Download: GET /c2c/download?encrypt_query_param=X
 * Decrypt: AES-128-ECB (PKCS7 padding)
 */

import { decryptAesEcb } from "./crypto.js";
import fs from "node:fs";
import path from "node:path";

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

/** Hard cap on a single downloaded media file (bytes) to avoid OOM. */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Reduce a sender-supplied file name to a safe basename that always lands
 * inside `outputDir`. Strips any directory components (so `..\..\evil.bat`
 * becomes `evil.bat`) and illegal characters; falls back to a generic name.
 */
function safeFileName(fileName: string): string {
  // Take the last path segment regardless of / or \ separators.
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || `file_${Date.now()}`;
}

/**
 * Decode a WeChat AES key from one of two formats:
 *   Format 1: 32-char hex string → 16 bytes directly
 *   Format 2: base64(hex string) → decode base64 → 32 hex chars → 16 bytes
 */
function decodeAesKey(raw: string): Buffer | null {
  if (!raw) return null;

  // Format 1: hex string (32 chars → 16 bytes)
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  // Format 2: base64(hex string)
  try {
    const decoded = Buffer.from(raw, "base64").toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(decoded)) {
      return Buffer.from(decoded, "hex");
    }
  } catch {
    // not valid base64
  }

  // Format 2 alt: base64(raw 16 bytes)
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 16) return decoded;
  } catch {
    // not valid base64
  }

  return null;
}

/**
 * Download and decrypt a file from WeChat CDN.
 */
export async function downloadFromCdn(
  downloadUrlOrParam: string,
  aesKeyRaw: string,
  outputDir: string,
  fileName: string,
): Promise<string | null> {
  fs.mkdirSync(outputDir, { recursive: true });

  // Decode AES key
  const key = decodeAesKey(aesKeyRaw);
  if (!key) {
    // Never log the key material itself.
    console.error("  CDN key decode failed (unrecognized key format)");
    return null;
  }

  // Use the full download URL if provided, otherwise construct from encrypt_query_param
  const downloadUrl = downloadUrlOrParam.startsWith("http")
    ? downloadUrlOrParam
    : `${CDN_BASE}/download?encrypt_query_param=${encodeURIComponent(downloadUrlOrParam)}`;

  const controller = new AbortController();
  // The timeout must cover the whole transfer, not just the response headers —
  // clearing it right after fetch() resolves leaves body streaming unguarded
  // (a stalled CDN connection would hang forever).
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(downloadUrl, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`  CDN ${response.status}: ${downloadUrl.slice(0, 100)}`);
      return null;
    }

    // Reject oversized files up front when the CDN advertises a length.
    const declaredLen = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLen) && declaredLen > MAX_DOWNLOAD_BYTES) {
      console.error(
        `  CDN file too large: ${declaredLen} bytes (max ${MAX_DOWNLOAD_BYTES})`,
      );
      return null;
    }

    const encrypted = Buffer.from(await response.arrayBuffer());
    if (encrypted.length > MAX_DOWNLOAD_BYTES) {
      console.error(
        `  CDN file too large after download: ${encrypted.length} bytes`,
      );
      return null;
    }
    const decrypted = decryptAesEcb(encrypted, key); // decrypt already handles PKCS7

    const filePath = path.join(outputDir, safeFileName(fileName));
    fs.writeFileSync(filePath, decrypted);
    console.log(`  CDN OK: ${path.basename(filePath)} (${decrypted.length} bytes)`);
    return filePath;
  } catch (err) {
    console.error(`  CDN err: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
