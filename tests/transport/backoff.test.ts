import { describe, expect, it } from "vitest";
import {
  computeExponentialBackoff,
  computeFullJitterBackoff,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  parseRetryAfterHeader,
} from "../../src/transport/backoff.js";

describe("Truncated Exponential Backoff & Jitter", () => {
  describe("computeExponentialBackoff", () => {
    it("computes deterministic exponential steps up to ceiling", () => {
      expect(computeExponentialBackoff(0)).toBe(1000);
      expect(computeExponentialBackoff(1)).toBe(2000);
      expect(computeExponentialBackoff(2)).toBe(4000);
      expect(computeExponentialBackoff(3)).toBe(8000);
      expect(computeExponentialBackoff(4)).toBe(16000);
      expect(computeExponentialBackoff(5)).toBe(30000); // capped by 30000 ceiling
      expect(computeExponentialBackoff(6)).toBe(30000);
    });

    it("respects custom base and max ceiling parameters", () => {
      expect(computeExponentialBackoff(0, 500, 5000)).toBe(500);
      expect(computeExponentialBackoff(1, 500, 5000)).toBe(1000);
      expect(computeExponentialBackoff(2, 500, 5000)).toBe(2000);
      expect(computeExponentialBackoff(3, 500, 5000)).toBe(4000);
      expect(computeExponentialBackoff(4, 500, 5000)).toBe(5000); // capped at 5000
    });

    it("safely handles boundary values and large exponents without integer overflow", () => {
      expect(computeExponentialBackoff(100)).toBe(DEFAULT_MAX_BACKOFF_MS);
      expect(computeExponentialBackoff(-1)).toBe(DEFAULT_BASE_BACKOFF_MS);
      expect(computeExponentialBackoff(Number.NaN)).toBe(DEFAULT_BASE_BACKOFF_MS);
      expect(computeExponentialBackoff(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BASE_BACKOFF_MS);
    });

    it("handles zero base or max gracefully", () => {
      expect(computeExponentialBackoff(2, 0, 1000)).toBe(0);
      expect(computeExponentialBackoff(2, 1000, 0)).toBe(0);
    });
  });

  describe("computeFullJitterBackoff", () => {
    it("returns values strictly within [0, I_raw(r)] across repeated trials", () => {
      for (let attempt = 0; attempt <= 5; attempt++) {
        const ceiling = computeExponentialBackoff(attempt);
        for (let trial = 0; trial < 50; trial++) {
          const jitterDelay = computeFullJitterBackoff(attempt);
          expect(jitterDelay).toBeGreaterThanOrEqual(0);
          expect(jitterDelay).toBeLessThanOrEqual(ceiling);
          expect(Number.isInteger(jitterDelay)).toBe(true);
        }
      }
    });

    it("returns 0 when ceiling is 0", () => {
      expect(computeFullJitterBackoff(2, 0, 0)).toBe(0);
    });
  });

  describe("parseRetryAfterHeader", () => {
    it("correctly parses integer seconds into milliseconds", () => {
      expect(parseRetryAfterHeader("120")).toBe(120000);
      expect(parseRetryAfterHeader("0")).toBe(0);
      expect(parseRetryAfterHeader("  45  ")).toBe(45000);
    });

    it("correctly parses HTTP-date formatted header relative to reference time", () => {
      const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
      const futureHeader = "Wed, 21 Oct 2026 07:28:30 GMT"; // 30 seconds later
      expect(parseRetryAfterHeader(futureHeader, now)).toBe(30000);
    });

    it("clamps past HTTP-dates to 0 ms", () => {
      const now = Date.parse("Wed, 21 Oct 2026 07:28:30 GMT");
      const pastHeader = "Wed, 21 Oct 2026 07:28:00 GMT";
      expect(parseRetryAfterHeader(pastHeader, now)).toBe(0);
    });

    it("returns null for missing, null, undefined, or empty header values", () => {
      expect(parseRetryAfterHeader(null)).toBeNull();
      expect(parseRetryAfterHeader(undefined)).toBeNull();
      expect(parseRetryAfterHeader("")).toBeNull();
      expect(parseRetryAfterHeader("   ")).toBeNull();
    });

    it("returns null for invalid or malformed header values", () => {
      expect(parseRetryAfterHeader("invalid-header")).toBeNull();
      expect(parseRetryAfterHeader("-10")).toBeNull();
      expect(parseRetryAfterHeader("abc123")).toBeNull();
    });
  });
});
