import { describe, it, expect } from "vitest";
import {
  isPiiKey,
  sanitizeStringValue,
  sanitizeQueryString,
  sanitizeUrl,
  sanitizePayload
} from "../../src/privacy/sanitizer";

describe("PII Sanitizer & Parameter Scrubbing Subsystem", () => {
  describe("isPiiKey Identification", () => {
    it("flags standard PII keys regardless of letter casing", () => {
      expect(isPiiKey("email")).toBe(true);
      expect(isPiiKey("EMAIL")).toBe(true);
      expect(isPiiKey("password")).toBe(true);
      expect(isPiiKey("PassWord")).toBe(true);
      expect(isPiiKey("token")).toBe(true);
      expect(isPiiKey("API_KEY")).toBe(true);
      expect(isPiiKey("ssn")).toBe(true);
      expect(isPiiKey("credit_card")).toBe(true);
    });

    it("NEVER flags protected marketing attribution parameters", () => {
      expect(isPiiKey("utm_source")).toBe(false);
      expect(isPiiKey("utm_medium")).toBe(false);
      expect(isPiiKey("utm_campaign")).toBe(false);
      expect(isPiiKey("utm_term")).toBe(false);
      expect(isPiiKey("utm_content")).toBe(false);
      expect(isPiiKey("gclid")).toBe(false);
      expect(isPiiKey("fbclid")).toBe(false);
      expect(isPiiKey("msclkid")).toBe(false);
      expect(isPiiKey("ttclid")).toBe(false);
    });

    it("respects custom additional denylist keys", () => {
      expect(isPiiKey("customer_crm_id", ["customer_crm_id"])).toBe(true);
      expect(isPiiKey("customer_crm_id")).toBe(false);
    });
  });

  describe("sanitizeStringValue Pattern Redaction", () => {
    it("redacts email addresses embedded in strings", () => {
      const input = "Contact us at support@enterprise.com for assistance";
      const sanitized = sanitizeStringValue(input);
      expect(sanitized).toBe("Contact us at [REDACTED] for assistance");
    });

    it("redacts credit card PAN sequences (13 to 19 digits)", () => {
      const withSpaces = "Card: 4111 2222 3333 4444 approved";
      expect(sanitizeStringValue(withSpaces)).toBe("Card: [REDACTED] approved");

      const withDashes = "Card: 5500-0000-0000-0004 approved";
      expect(sanitizeStringValue(withDashes)).toBe("Card: [REDACTED] approved");
    });

    it("redacts US Social Security Numbers (SSN)", () => {
      const input = "Tax ID: 123-45-6789";
      expect(sanitizeStringValue(input)).toBe("Tax ID: [REDACTED]");
    });

    it("leaves innocuous strings unchanged", () => {
      const input = "Summer 2026 Promotional Campaign Launch";
      expect(sanitizeStringValue(input)).toBe(input);
    });
  });

  describe("sanitizeQueryString", () => {
    it("drops denylisted PII parameters while preserving campaign tags", () => {
      const query = "?utm_source=google&utm_campaign=summer&email=john.doe@test.com&token=secret123&gclid=Cj0K";
      const result = sanitizeQueryString(query);

      expect(result["utm_source"]).toBe("google");
      expect(result["utm_campaign"]).toBe("summer");
      expect(result["gclid"]).toBe("Cj0K");

      // Denylisted parameters must be completely dropped by default
      expect(result["email"]).toBeUndefined();
      expect(result["token"]).toBeUndefined();
    });

    it("supports 'mask' action for denylisted keys", () => {
      const query = "?utm_source=ad&email=user@test.com";
      const result = sanitizeQueryString(query, { denylistAction: "mask" });

      expect(result["utm_source"]).toBe("ad");
      expect(result["email"]).toBe("[REDACTED]");
    });

    it("redacts sensitive pattern values in allowed keys", () => {
      const query = "?utm_campaign=promo:john@doe.com";
      const result = sanitizeQueryString(query);
      expect(result["utm_campaign"]).toBe("promo:[REDACTED]");
    });
  });

  describe("sanitizeUrl", () => {
    it("sanitizes query parameters while preserving URL base and hash", () => {
      const raw = "https://example.com/checkout?utm_source=meta&email=leak@test.com&token=xyz#step-2";
      const clean = sanitizeUrl(raw);

      expect(clean).toBe("https://example.com/checkout?utm_source=meta#step-2");
      expect(clean).not.toContain("leak@test.com");
      expect(clean).not.toContain("xyz");
    });

    it("returns URLs without query strings unchanged", () => {
      const raw = "https://example.com/pricing#plans";
      expect(sanitizeUrl(raw)).toBe(raw);
    });
  });

  describe("sanitizePayload (Deep Object Sanitization)", () => {
    it("recursively purges sensitive keys in nested objects and arrays", () => {
      const payload = {
        event: "conversion",
        amount: 250,
        customer: {
          first_name: "Alice",
          last_name: "Smith",
          email: "alice@test.com",
          account_id: "acc_12345"
        },
        metadata: {
          utm_source: "linkedin",
          notes: "Customer card is 4111 1111 1111 1111",
          items: [
            { id: "item_1", name: "Widget A" },
            { id: "item_2", password: "temp_pwd_123" }
          ]
        }
      };

      const clean = sanitizePayload(payload);

      expect(clean.event).toBe("conversion");
      expect(clean.amount).toBe(250);
      expect(clean.metadata.utm_source).toBe("linkedin");
      expect(clean.metadata.notes).toBe("Customer card is [REDACTED]");

      // Denylisted keys purged
      expect(clean.customer.first_name).toBeUndefined();
      expect(clean.customer.last_name).toBeUndefined();
      expect(clean.customer.email).toBeUndefined();
      expect(clean.customer.account_id).toBe("acc_12345");

      expect(clean.metadata.items[0]!.name).toBe("Widget A");
      expect((clean.metadata.items[1] as Record<string, unknown>).password).toBeUndefined();
    });

    it("gracefully handles circular object references without call stack overflow", () => {
      interface CircularNode {
        name: string;
        self?: CircularNode;
      }

      const node: CircularNode = { name: "Root" };
      node.self = node; // Circular reference!

      const clean = sanitizePayload(node);
      expect(clean.name).toBe("Root");
      expect(clean.self).toBe("[CIRCULAR]");
    });
  });
});
