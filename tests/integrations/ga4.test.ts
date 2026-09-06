/**
 * Comprehensive Unit Tests for GA4 Measurement Protocol Integration.
 *
 * Validates:
 * 1. Event name sanitization against GA4 specifications.
 * 2. Conversion and pageview payload mapping.
 * 3. Client ID resolution hierarchy.
 * 4. Network transmission via fetch keepalive, standard fetch, and debug endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sanitizeGA4EventName,
  formatGA4Event,
  buildGA4Payload,
  sendToGA4,
} from "../../src/integrations/ga4.js";
import type { QueuedEvent } from "../../src/types.js";

describe("GA4 Measurement Protocol Integration", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("sanitizeGA4EventName", () => {
    it("preserves valid alphanumeric names", () => {
      expect(sanitizeGA4EventName("purchase")).toBe("purchase");
      expect(sanitizeGA4EventName("user_signup_v2")).toBe("user_signup_v2");
    });

    it("replaces hyphens and special characters with underscores", () => {
      expect(sanitizeGA4EventName("sign-up")).toBe("sign_up");
      expect(sanitizeGA4EventName("custom.event@v1")).toBe("custom_event_v1");
    });

    it("prepends 'e_' when event name starts with a number", () => {
      expect(sanitizeGA4EventName("123_checkout")).toBe("e_123_checkout");
    });

    it("truncates names longer than 40 characters", () => {
      const longName = "a".repeat(50);
      expect(sanitizeGA4EventName(longName)).toHaveLength(40);
    });

    it("handles empty strings gracefully", () => {
      expect(sanitizeGA4EventName("")).toBe("custom_event");
    });
  });

  describe("formatGA4Event", () => {
    it("formats a standard purchase conversion event", () => {
      const event: QueuedEvent = {
        id: "evt_1",
        timestamp: 1700000000000,
        priority: "high",
        byteSize: 120,
        payload: {
          type: "conversion",
          name: "purchase",
          value: 149.99,
          conversion: {
            conversionId: "purchase",
            revenue: 149.99,
            currency: "EUR",
            transactionId: "ord_9988",
            properties: {
              coupon: "SUMMER10",
              item_count: 2,
            },
          },
          campaign: {
            campaign: "summer_sale",
            source: "google",
            medium: "cpc",
          },
        },
      };

      const ga4Event = formatGA4Event(event);
      expect(ga4Event).not.toBeNull();
      expect(ga4Event?.name).toBe("purchase");
      expect(ga4Event?.params?.value).toBe(149.99);
      expect(ga4Event?.params?.currency).toBe("EUR");
      expect(ga4Event?.params?.transaction_id).toBe("ord_9988");
      expect(ga4Event?.params?.campaign).toBe("summer_sale");
      expect(ga4Event?.params?.source).toBe("google");
      expect(ga4Event?.params?.medium).toBe("cpc");
      expect(ga4Event?.params?.coupon).toBe("SUMMER10");
      expect(ga4Event?.params?.item_count).toBe(2);
    });

    it("omits pageviews by default when forwardPageviews is false", () => {
      const pageviewEvent: QueuedEvent = {
        id: "evt_pv",
        timestamp: 1700000000000,
        priority: "normal",
        byteSize: 80,
        payload: {
          type: "pageview",
          path: "/pricing",
        },
      };

      expect(formatGA4Event(pageviewEvent)).toBeNull();
      expect(formatGA4Event(pageviewEvent, { measurementId: "G-123", apiSecret: "secret" })).toBeNull();
    });

    it("formats pageviews when forwardPageviews is enabled", () => {
      const pageviewEvent: QueuedEvent = {
        id: "evt_pv2",
        timestamp: 1700000000000,
        priority: "normal",
        byteSize: 90,
        payload: {
          type: "pageview",
          path: "/checkout",
          title: "Checkout - Store",
          campaign: {
            campaign: "re-engagement",
            source: "newsletter",
          },
        },
      };

      const formatted = formatGA4Event(pageviewEvent, {
        measurementId: "G-123",
        apiSecret: "sec",
        forwardPageviews: true,
      });

      expect(formatted).not.toBeNull();
      expect(formatted?.name).toBe("page_view");
      expect(formatted?.params?.page_location).toBe("/checkout");
      expect(formatted?.params?.page_title).toBe("Checkout - Store");
      expect(formatted?.params?.campaign).toBe("re-engagement");
      expect(formatted?.params?.source).toBe("newsletter");
    });
  });

  describe("buildGA4Payload", () => {
    it("builds a payload and resolves visitorToken as client_id", () => {
      const event: QueuedEvent = {
        id: "evt_token",
        timestamp: 1700000000000,
        priority: "high",
        byteSize: 100,
        payload: {
          type: "conversion",
          visitorToken: "vis_hash_456",
          value: 50,
          conversion: {
            conversionId: "signup",
            revenue: 50,
          },
        },
      };

      const payload = buildGA4Payload(event, {
        measurementId: "G-TEST",
        apiSecret: "SECRET",
      });

      expect(payload).not.toBeNull();
      expect(payload?.client_id).toBe("vis_hash_456");
      expect(payload?.events).toHaveLength(1);
      expect(payload?.events[0]!.name).toBe("purchase");
      expect(payload?.events[0]!.params?.value).toBe(50);
    });

    it("prefers explicit clientId option if provided", () => {
      const event: QueuedEvent = {
        id: "evt_explicit",
        timestamp: 1700000000000,
        priority: "high",
        byteSize: 100,
        payload: {
          type: "conversion",
          visitorToken: "vis_internal",
        },
      };

      const payload = buildGA4Payload(event, {
        measurementId: "G-TEST",
        apiSecret: "SECRET",
        clientId: "explicit_ga_client_id.12345",
      });

      expect(payload?.client_id).toBe("explicit_ga_client_id.12345");
    });
  });

  describe("sendToGA4", () => {
    it("dispatches to the GA4 collect endpoint using keepalive fetch", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });
      globalThis.fetch = fetchMock;

      const event: QueuedEvent = {
        id: "evt_send",
        timestamp: 1700000000000,
        priority: "high",
        byteSize: 100,
        payload: {
          type: "conversion",
          value: 99,
          visitorToken: "vis_123",
          conversion: {
            conversionId: "purchase",
            revenue: 99,
            currency: "USD",
          },
        },
      };

      const result = await sendToGA4(event, {
        measurementId: "G-ABCD1234EF",
        apiSecret: "api_sec_secret",
      });

      expect(result.success).toBe(true);
      expect(result.transport).toBe("keepalive");
      expect(result.sentCount).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
      expect(calledUrl).toContain("https://www.google-analytics.com/mp/collect");
      expect(calledUrl).toContain("measurement_id=G-ABCD1234EF");
      expect(calledUrl).toContain("api_secret=api_sec_secret");
      expect(calledInit.keepalive).toBe(true);

      const parsedBody = JSON.parse(calledInit.body);
      expect(parsedBody.client_id).toBe("vis_123");
      expect(parsedBody.events[0].name).toBe("purchase");
    });

    it("uses the debug endpoint when debug flag is true", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      globalThis.fetch = fetchMock;

      const event: QueuedEvent = {
        id: "evt_debug",
        timestamp: 1700000000000,
        priority: "high",
        byteSize: 100,
        payload: {
          type: "conversion",
          value: 10,
        },
      };

      await sendToGA4(event, {
        measurementId: "G-DEBUG",
        apiSecret: "SECRET",
        debug: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl] = fetchMock.mock.calls[0]!;
      expect(calledUrl).toContain("https://www.google-analytics.com/debug/mp/collect");
    });

    it("returns an error if measurementId or apiSecret is missing", async () => {
      const event: QueuedEvent = {
        id: "evt_missing",
        timestamp: 1700000000000,
        priority: "high",
        byteSize: 100,
        payload: { type: "conversion" },
      };

      const result = await sendToGA4(event, {
        measurementId: "",
        apiSecret: "",
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("measurementId and apiSecret");
    });
  });
});
