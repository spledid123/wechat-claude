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
    console.error(`  CDN key decode failed: ${aesKeyRaw.slice(0, 30)}...`);
    return null;
  }

  // Use the full download URL if provided, otherwise construct from encrypt_query_param
  const downloadUrl = downloadUrlOrParam.startsWith("http")
    ? downloadUrlOrParam
    : `${CDN_BASE}/download?encrypt_query_param=${encodeURIComponent(downloadUrlOrParam)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(downloadUrl, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      console.error(`  CDN ${response.status}: ${downloadUrl.slice(0, 100)}`);
      return null;
    }

    const encrypted = Buffer.from(await response.arrayBuffer());
    const decrypted = decryptAesEcb(encrypted, key); // decrypt already handles PKCS7

    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, decrypted);
    console.log(`  CDN OK: ${fileName} (${decrypted.length} bytes)`);
    return filePath;
  } catch (err) {
    console.error(`  CDN err: ${(err as Error).message}`);
    return null;
  }
}
