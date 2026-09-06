/**
 * Truncated Exponential Backoff with Full Randomized Jitter.
 *
 * Implements decorrelated network retry scheduling to avoid thundering herd
 * congestion waves when mobile devices reconnect or servers recover from outages.
 *
 * Mathematical formulation:
 * - Deterministic bound: I_raw(r) = min(M, B * 2^r)
 * - Full jitter sleep:   t_sleep(r) ~ U(0, min(M, B * 2^r))
 *
 * Zero runtime dependencies.
 */

export const DEFAULT_BASE_BACKOFF_MS = 1000;
export const DEFAULT_MAX_BACKOFF_MS = 30000;

/**
 * Computes deterministic raw exponential backoff bound without jitter.
 *
 * @param attempt - 0-indexed consecutive retry attempt count (r >= 0).
 * @param baseMs - Base initial backoff interval in milliseconds (default: 1000 ms).
 * @param maxMs - Maximum upper backoff ceiling in milliseconds (default: 30000 ms).
 * @returns Upper boundary delay in milliseconds: min(maxMs, baseMs * 2^attempt).
 */
export function computeExponentialBackoff(
  attempt: number,
  baseMs = DEFAULT_BASE_BACKOFF_MS,
  maxMs = DEFAULT_MAX_BACKOFF_MS
): number {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return Math.min(baseMs, maxMs);
  }
  const safeBase = Math.max(0, Number.isFinite(baseMs) ? baseMs : DEFAULT_BASE_BACKOFF_MS);
  const safeMax = Math.max(0, Number.isFinite(maxMs) ? maxMs : DEFAULT_MAX_BACKOFF_MS);

  // Prevent 2^r from overflowing JavaScript MAX_SAFE_INTEGER when attempt is high
  const safeExponent = Math.min(Math.floor(attempt), 31);
  const multiplier = Math.pow(2, safeExponent);
  const rawInterval = safeBase * multiplier;

  return Math.min(safeMax, rawInterval);
}

/**
 * Computes randomized retry delay using the Full Jitter algorithm.
 *
 * Full Jitter produces a uniform distribution over [0, I_raw(r)], which
 * mathematically maximizes request spread across clients during mass reconnects.
 *
 * @param attempt - 0-indexed consecutive retry attempt count.
 * @param baseMs - Base initial backoff interval in milliseconds (default: 1000 ms).
 * @param maxMs - Maximum upper backoff ceiling in milliseconds (default: 30000 ms).
 * @returns Randomized delay in milliseconds uniformly distributed in [0, I_raw].
 */
export function computeFullJitterBackoff(
  attempt: number,
  baseMs = DEFAULT_BASE_BACKOFF_MS,
  maxMs = DEFAULT_MAX_BACKOFF_MS
): number {
  const ceiling = computeExponentialBackoff(attempt, baseMs, maxMs);
  if (ceiling <= 0) {
    return 0;
  }
  return Math.floor(Math.random() * (ceiling + 1));
}

/**
 * Parses an HTTP standard 'Retry-After' header value (RFC 7231 / RFC 9110).
 *
 * Supports both delay-seconds format ("120") and HTTP-date format
 * ("Wed, 21 Oct 2026 07:28:00 GMT").
 *
 * @param headerValue - Raw header string from HTTP response or null.
 * @param now - Reference timestamp in milliseconds (defaults to Date.now()).
 * @returns Delay duration in milliseconds, or null if the header is absent or invalid.
 */
export function parseRetryAfterHeader(
  headerValue: string | null | undefined,
  now?: number
): number | null {
  if (!headerValue || typeof headerValue !== "string") {
    return null;
  }

  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Format 1: Delay-seconds (non-negative integer)
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  // Reject signed integers or floats (e.g. "-10", "+5", "3.14")
  if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }

  // Format 2: HTTP-date (RFC 7231 dates contain month/day name abbreviations like 'GMT')
  if (/[a-zA-Z]/.test(trimmed)) {
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate)) {
      const current = typeof now === "number" ? now : Date.now();
      return Math.max(0, parsedDate - current);
    }
  }

  return null;
}
