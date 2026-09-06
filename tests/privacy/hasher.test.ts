import { describe, it, expect } from "vitest";
import {
  sha256Hex,
  hmacSha256Hex,
  deriveDailySalt,
  generateVisitorToken,
  normalizeUserAgent
} from "../../src/privacy/hasher";

describe("Web Crypto Hasher & Ephemeral Tokenizer", () => {
  describe("NIST / Standard SHA-256 Test Vectors", () => {
    it("hashes empty string matching standard NIST digest", async () => {
      const digest = await sha256Hex("");
      expect(digest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("hashes 'abc' matching standard NIST digest", async () => {
      const digest = await sha256Hex("abc");
      expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("hashes long sentence deterministically", async () => {
      const input = "The quick brown fox jumps over the lazy dog";
      const digest = await sha256Hex(input);
      expect(digest).toBe("d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
    });
  });

  describe("RFC 4231 HMAC-SHA256 Test Vectors", () => {
    it("calculates HMAC-SHA256 matching RFC 4231 Test Case 2", async () => {
      const key = "Jefe";
      const data = "what do ya want for nothing?";
      const signature = await hmacSha256Hex(key, data);
      expect(signature).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    });
  });

  describe("Ephemeral Daily Salt & Visitor Tokenization", () => {
    const day1 = new Date("2026-09-06T10:00:00Z");
    const day1Later = new Date("2026-09-06T22:30:00Z");
    const day2 = new Date("2026-09-07T01:00:00Z");

    it("maintains intraday stability on the same calendar day", async () => {
      const salt1 = await deriveDailySalt(day1, "example.com");
      const salt2 = await deriveDailySalt(day1Later, "example.com");
      expect(salt1).toBe(salt2);

      const token1 = await generateVisitorToken({
        ip: "198.51.100.42",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        origin: "example.com",
        date: day1
      });

      const token2 = await generateVisitorToken({
        ip: "198.51.100.99", // Different host in same /24 subnet!
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        origin: "example.com",
        date: day1Later
      });

      // Because IPs are in same /24 subnet and UA/origin/day are identical:
      expect(token1).toBe(token2);
    });

    it("guarantees interday decorrelation across consecutive days", async () => {
      const saltDay1 = await deriveDailySalt(day1, "example.com");
      const saltDay2 = await deriveDailySalt(day2, "example.com");
      expect(saltDay1).not.toBe(saltDay2);

      const tokenDay1 = await generateVisitorToken({
        ip: "198.51.100.42",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        origin: "example.com",
        date: day1
      });

      const tokenDay2 = await generateVisitorToken({
        ip: "198.51.100.42",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        origin: "example.com",
        date: day2
      });

      expect(tokenDay1).not.toBe(tokenDay2);
    });

    it("produces distinct tokens for distinct subnets or devices", async () => {
      const tokenUserA = await generateVisitorToken({
        ip: "198.51.100.42",
        userAgent: "Mozilla/5.0 (Macintosh)",
        origin: "example.com",
        date: day1
      });

      const tokenUserB = await generateVisitorToken({
        ip: "203.0.113.15", // Different subnet
        userAgent: "Mozilla/5.0 (Macintosh)",
        origin: "example.com",
        date: day1
      });

      expect(tokenUserA).not.toBe(tokenUserB);
    });

    it("namespaces daily salts by domain origin", async () => {
      const saltSiteA = await deriveDailySalt(day1, "site-a.com");
      const saltSiteB = await deriveDailySalt(day1, "site-b.com");
      expect(saltSiteA).not.toBe(saltSiteB);
    });

    it("supports optional secret pepper keying", async () => {
      const saltNoPepper = await deriveDailySalt(day1, "example.com");
      const saltWithPepper = await deriveDailySalt(day1, "example.com", "my_secret_pepper_key");
      expect(saltWithPepper).not.toBe(saltNoPepper);
    });
  });

  describe("normalizeUserAgent", () => {
    it("categorizes common platforms into archetypes", () => {
      expect(normalizeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("mobile-browser");
      expect(normalizeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("mobile-browser");
      expect(normalizeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("desktop-mac");
      expect(normalizeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("desktop-windows");
      expect(normalizeUserAgent("Mozilla/5.0 (X11; Ubuntu; Linux x86_64)")).toBe("desktop-linux");
      expect(normalizeUserAgent("")).toBe("unknown");
    });
  });
});
