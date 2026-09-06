import type { VisitorTokenOptions } from "../types";
import { truncateIp } from "./ip";

/**
 * Converts an ArrayBuffer to a lowercase hexadecimal string.
 *
 * @param buffer - Binary buffer to convert.
 * @returns Hexadecimal string representation.
 */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    hex += byte < 16 ? "0" + byte.toString(16) : byte.toString(16);
  }
  return hex;
}

/**
 * Retrieves the global Web Crypto subtle interface.
 *
 * @returns The CryptoSubtle interface.
 * @throws Error if Web Crypto is not supported in the execution environment.
 */
function getCryptoSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error("Web Crypto API (crypto.subtle) is not available in this runtime environment.");
}

/**
 * Computes a standard SHA-256 cryptographic digest as a lowercase hexadecimal string.
 *
 * @param message - Plaintext string to hash.
 * @returns A Promise resolving to the 64-character SHA-256 hex digest.
 */
export async function sha256Hex(message: string): Promise<string> {
  const subtle = getCryptoSubtle();
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await subtle.digest("SHA-256", data);
  return bufferToHex(hashBuffer);
}

/**
 * Computes an HMAC-SHA256 signature as a lowercase hexadecimal string.
 *
 * @param key - The secret key string.
 * @param message - The payload string to authenticate.
 * @returns A Promise resolving to the 64-character HMAC-SHA256 hex signature.
 */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const subtle = getCryptoSubtle();
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(message);

  const cryptoKey = await subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await subtle.sign("HMAC", cryptoKey, messageData);
  return bufferToHex(signatureBuffer);
}

/**
 * Derives a deterministic 256-bit daily rotating salt that changes at 00:00:00 UTC.
 *
 * Mathematical basis:
 *   dayEpoch = floor(timestamp / 86400000)
 *   salt = HMAC-SHA256(pepper, "day:" + dayEpoch + ":origin:" + origin)
 *
 * @param date - Optional reference date (defaults to current time).
 * @param domainOrigin - Optional domain origin to namespace the salt.
 * @param secretPepper - Optional server-side master secret pepper.
 * @returns A Promise resolving to the 64-character hex daily salt string.
 */
export async function deriveDailySalt(
  date?: Date,
  domainOrigin = "default",
  secretPepper?: string
): Promise<string> {
  const targetDate = date ?? new Date();
  const dayEpoch = Math.floor(targetDate.getTime() / 86400000);
  const message = `day:${dayEpoch}:origin:${domainOrigin.toLowerCase().trim()}`;

  if (secretPepper) {
    return hmacSha256Hex(secretPepper, message);
  }
  return sha256Hex(message);
}

/**
 * Normalizes a raw user-agent string to an archetype to prevent device fingerprinting.
 *
 * @param ua - Raw user-agent string.
 * @returns Coarse archetype user-agent string.
 */
export function normalizeUserAgent(ua?: string): string {
  if (!ua) {
    return "unknown";
  }

  const clean = ua.trim();
  // Extract major platform and browser family without micro-version numbers
  if (/mobile|android|iphone|ipad/i.test(clean)) {
    return "mobile-browser";
  }
  if (/macintosh|mac os/i.test(clean)) {
    return "desktop-mac";
  }
  if (/windows/i.test(clean)) {
    return "desktop-windows";
  }
  if (/linux/i.test(clean)) {
    return "desktop-linux";
  }
  return "desktop-other";
}

/**
 * Generates an ephemeral daily visitor pseudonym token (K_visitor).
 *
 * Guarantees:
 * 1. Intraday determinism: Same day + same client attributes = identical token for conversion stitching.
 * 2. Interday decorrelation: Next day produces an uncorrelated token, preventing cross-week tracking.
 * 3. Privacy compliance: Raw IP is masked (/24 or /48) and user-agent is normalized before hashing.
 *
 * @param options - Visitor token parameters (ip, userAgent, origin, date, pepper).
 * @returns A Promise resolving to the 64-character pseudonymous visitor token string.
 */
export async function generateVisitorToken(options: VisitorTokenOptions): Promise<string> {
  const truncatedIp = truncateIp(options.ip ?? "");
  const coarseUa = normalizeUserAgent(options.userAgent);
  const origin = (options.origin ?? "default").toLowerCase().trim();

  // Derive daily rotating salt
  const salt = await deriveDailySalt(options.date, origin, options.pepper);

  // Compute HMAC token: HMAC-SHA256(salt, IP_trunc || UA_coarse || Origin)
  const message = `ip:${truncatedIp}|ua:${coarseUa}|origin:${origin}`;
  return hmacSha256Hex(salt, message);
}
