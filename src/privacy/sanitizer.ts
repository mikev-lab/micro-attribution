import type { SanitizerOptions } from "../types";

/**
 * Standard PII key denylist.
 * Any key matching these names (case-insensitive, normalized) will be purged or redacted.
 */
const DEFAULT_PII_KEYS = new Set<string>([
  // Personal identity
  "email",
  "e-mail",
  "mail",
  "phone",
  "telephone",
  "tel",
  "mobile",
  "cell",
  "first_name",
  "firstname",
  "last_name",
  "lastname",
  "surname",
  "full_name",
  "fullname",
  "ssn",
  "sin",
  "passport",
  "dob",
  "date_of_birth",
  "birthdate",
  "address",
  "postal_code",
  "zip",
  "zipcode",

  // Authentication & Secrets
  "token",
  "bearer",
  "access_token",
  "auth",
  "authorization",
  "api_key",
  "apikey",
  "password",
  "pwd",
  "pass",
  "secret",
  "jwt",
  "private_key",

  // Financial & Banking
  "card",
  "credit_card",
  "cc",
  "cc_num",
  "cvv",
  "cvc",
  "pan",
  "account_number",
  "iban",
  "routing_number"
]);

/**
 * Legitimate marketing attribution parameter names that must NEVER be stripped.
 */
const PROTECTED_MARKETING_KEYS = new Set<string>([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "ttclid",
  "li_fat_id",
  "twclid",
  "wbraid",
  "gbraid"
]);

// Regular expression patterns for detecting sensitive data inside values
const EMAIL_REGEX = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
// Enforce digits only at ends so trailing whitespace/dashes are preserved
const CREDIT_CARD_REGEX = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Normalizes a key name for denylist comparison (lowercased, trimmed).
 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Checks if a parameter key is considered Personally Identifiable Information (PII).
 *
 * @param key - The property or query parameter name.
 * @param customDenylist - Optional additional denylist keys.
 * @returns True if the key is denylisted as PII; false otherwise.
 */
export function isPiiKey(key: string, customDenylist?: string[]): boolean {
  const normalized = normalizeKey(key);

  // Marketing campaign parameters are always protected
  if (PROTECTED_MARKETING_KEYS.has(normalized)) {
    return false;
  }

  if (DEFAULT_PII_KEYS.has(normalized)) {
    return true;
  }

  if (customDenylist && customDenylist.length > 0) {
    for (const custom of customDenylist) {
      if (normalizeKey(custom) === normalized) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Sanitizes a string value by redacting embedded emails, credit card PANs, and SSNs.
 *
 * @param value - Raw string value.
 * @param mask - Replacement placeholder text (default '[REDACTED]').
 * @returns Sanitized string with sensitive patterns replaced.
 */
export function sanitizeStringValue(value: string, mask = "[REDACTED]"): string {
  if (!value || typeof value !== "string") {
    return value;
  }

  let result = value;
  result = result.replace(EMAIL_REGEX, mask);
  result = result.replace(CREDIT_CARD_REGEX, mask);
  result = result.replace(SSN_REGEX, mask);
  return result;
}

/**
 * Parses and sanitizes a URL query string, purging denylisted PII parameters
 * and scrubbing sensitive pattern values from retained parameters.
 *
 * @param queryString - Raw query string (e.g. "?utm_source=ad&email=user@test.com").
 * @param options - Optional sanitizer settings.
 * @returns Key-value map of sanitized parameters.
 */
export function sanitizeQueryString(
  queryString: string,
  options?: SanitizerOptions
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!queryString || typeof queryString !== "string") {
    return result;
  }

  const cleanQuery = queryString.startsWith("?") ? queryString.slice(1) : queryString;
  if (!cleanQuery.trim()) {
    return result;
  }

  const pairs = cleanQuery.split("&");
  const mask = options?.redactionMask ?? "[REDACTED]";
  const action = options?.denylistAction ?? "drop";

  for (const pair of pairs) {
    if (!pair) {
      continue;
    }
    const eqIdx = pair.indexOf("=");
    let rawKey: string;
    let rawVal: string;

    if (eqIdx !== -1) {
      rawKey = pair.slice(0, eqIdx);
      rawVal = pair.slice(eqIdx + 1);
    } else {
      rawKey = pair;
      rawVal = "";
    }

    try {
      rawKey = decodeURIComponent(rawKey);
      rawVal = decodeURIComponent(rawVal);
    } catch {
      // Retain undecoded strings if malformed URI component encountered
    }

    if (isPiiKey(rawKey, options?.additionalDenylist)) {
      if (action === "mask") {
        result[rawKey] = mask;
      }
      // If action is 'drop', key is omitted
      continue;
    }

    result[rawKey] = sanitizeStringValue(rawVal, mask);
  }

  return result;
}

/**
 * Sanitizes a complete URL by purging sensitive query parameters and redacting PII patterns.
 *
 * @param rawUrl - The input URL string.
 * @param options - Optional sanitizer configuration.
 * @returns The sanitized URL string.
 */
export function sanitizeUrl(rawUrl: string, options?: SanitizerOptions): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }

  try {
    const hashIdx = rawUrl.indexOf("#");
    let urlWithoutHash = hashIdx !== -1 ? rawUrl.slice(0, hashIdx) : rawUrl;
    const hash = hashIdx !== -1 ? rawUrl.slice(hashIdx) : "";

    const queryIdx = urlWithoutHash.indexOf("?");
    if (queryIdx === -1) {
      return rawUrl;
    }

    const base = urlWithoutHash.slice(0, queryIdx);
    const query = urlWithoutHash.slice(queryIdx + 1);

    const sanitizedParams = sanitizeQueryString(query, options);
    const paramEntries = Object.entries(sanitizedParams);

    if (paramEntries.length === 0) {
      return `${base}${hash}`;
    }

    const newQuery = paramEntries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    return `${base}?${newQuery}${hash}`;
  } catch {
    return rawUrl;
  }
}

/**
 * Deep recursive payload sanitizer for objects, arrays, and nested metadata structures.
 * Protects against circular references and limits recursion to maxDepth.
 *
 * @param payload - Inbound payload of arbitrary type.
 * @param options - Optional sanitizer options.
 * @returns Deeply sanitized copy of the payload.
 */
export function sanitizePayload<T>(payload: T, options?: SanitizerOptions): T {
  const mask = options?.redactionMask ?? "[REDACTED]";
  const action = options?.denylistAction ?? "drop";
  const maxDepth = options?.maxDepth ?? 10;
  const visited = new WeakSet<object>();

  function recursiveSanitize(value: unknown, currentDepth: number): unknown {
    if (currentDepth > maxDepth) {
      return mask;
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return sanitizeStringValue(value, mask);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (typeof value !== "object") {
      return value;
    }

    // Circular reference protection
    if (visited.has(value)) {
      return "[CIRCULAR]";
    }
    visited.add(value);

    // Handle Arrays
    if (Array.isArray(value)) {
      return value.map((item) => recursiveSanitize(item, currentDepth + 1));
    }

    // Handle Plain Objects
    const result: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;

    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        continue;
      }

      const val = obj[key];

      if (isPiiKey(key, options?.additionalDenylist)) {
        if (action === "mask") {
          result[key] = mask;
        }
        continue;
      }

      result[key] = recursiveSanitize(val, currentDepth + 1);
    }

    return result;
  }

  return recursiveSanitize(payload, 0) as T;
}
