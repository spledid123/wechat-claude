/**
 * WeChat iLink CDN — AES-128-ECB crypto + hashing utilities.
 *
 * All CDN media files are encrypted with AES-128-ECB using PKCS padding (default).
 * Media AES keys in sendmessage use base64(utf8(hex)).
 */

import crypto from "node:crypto";

// --------------- AES-128-ECB ---------------

/** PKCS-padded size: (plaintextSize + 1) rounded up to 16-byte boundary. */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** Encrypt with AES-128-ECB using default PKCS padding. */
export function encryptAesEcb(
  plaintext: Buffer,
  key: Buffer, // 16 bytes
): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  // Default padding is PKCS — matches the working codex_for_wechat implementation
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Decrypt ciphertext buffer with AES-128-ECB. */
export function decryptAesEcb(
  ciphertext: Buffer,
  key: Buffer, // 16 bytes
): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  // Default padding
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// --------------- Key generation ---------------

/** Generate a random 16-byte AES key, return as hex string. */
export function generateAesKeyHex(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Generate a random filekey (16-byte hex). */
export function generateFileKeyHex(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Parse a hex string back to a 16-byte Buffer. */
export function hexToKey(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

/**
 * Convert AES key hex to the format used in media envelope.
 * Working implementation: Buffer.from(aesKeyHex, "utf8").toString("base64")
 */
export function buildMediaAesKey(aesKeyHex: string): string {
  return Buffer.from(aesKeyHex, "utf8").toString("base64");
}

// --------------- Hashing ---------------

export function md5Hex(data: Buffer): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// --------------- Headers/IDs ---------------

/** Generate a random X-WECHAT-UIN header value (base64 of random uint32 as utf8). */
export function randomWechatUin(): string {
  const uin = String(Math.floor(Math.random() * 0x7fffffff));
  return Buffer.from(uin, "utf8").toString("base64");
}

/** Generate a client_id for sendmessage. */
export function generateClientId(): string {
  const now = Date.now();
  const suffix = Math.floor(Math.random() * 1_000_000_000)
    .toString(36)
    .padStart(6, "0");
  return `wechat-claude-relay_${now}_${suffix}`;
}
