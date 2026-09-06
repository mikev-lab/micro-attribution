/**
 * Chaos and Redundancy Verification Suite.
 *
 * Tests:
 * 1. Automatic failover to fallbackEndpoint upon primary endpoint outage (5xx / network error).
 * 2. Non-failover on non-retryable client errors (4xx).
 * 3. Emergency unload flush failover.
 * 4. MicroAttribution client GA4 dual-dispatch and onConversion redundancy hooks.
 * 5. Zero-storage mode verification (volatile memory tier override).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NetworkDispatcher } from "../../src/transport/dispatcher.js";
import { EventQueue } from "../../src/queue/event-queue.js";
import { MemoryAdapter } from "../../src/storage/memory.js";
import { MicroAttribution } from "../../src/client/sdk.js";
import type { QueuedEvent } from "../../src/types.js";

describe("Secondary Redundancy and Failover", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("NetworkDispatcher Failover", () => {
    it("fails over to fallbackEndpoint when primary returns 500 server error", async () => {
      const storage = new MemoryAdapter();
      await storage.init();
      const queue = new EventQueue({ storage });

      await queue.enqueue({ type: "conversion", value: 100 }, "high");

      const primaryUrl = "https://primary.example.com/telemetry";
      const fallbackUrl = "https://backup.example.com/telemetry";

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === primaryUrl) {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        if (url === fallbackUrl) {
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: "OK",
          });
        }
        return Promise.reject(new Error("Unexpected URL"));
      });
      globalThis.fetch = fetchMock;

      const dispatcher = new NetworkDispatcher(queue, {
        endpoint: primaryUrl,
        fallbackEndpoint: fallbackUrl,
        preferredTransport: "fetch",
      });

      const result = await dispatcher.drain();

      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      expect(result?.status).toBe(200);

      // Verify both endpoints were called in failover order
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]![0]).toBe(primaryUrl);
      expect(fetchMock.mock.calls[1]![0]).toBe(fallbackUrl);

      // Queue should have acknowledged and purged the event
      const remaining = await queue.count();
      expect(remaining).toBe(0);
      expect(dispatcher.getRetryAttempt()).toBe(0);
    });

    it("does not call fallbackEndpoint when primary succeeds", async () => {
      const storage = new MemoryAdapter();
      await storage.init();
      const queue = new EventQueue({ storage });

      await queue.enqueue({ type: "pageview", path: "/home" }, "normal");

      const primaryUrl = "https://primary.example.com/telemetry";
      const fallbackUrl = "https://backup.example.com/telemetry";

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      globalThis.fetch = fetchMock;

      const dispatcher = new NetworkDispatcher(queue, {
        endpoint: primaryUrl,
        fallbackEndpoint: fallbackUrl,
        preferredTransport: "fetch",
      });

      const result = await dispatcher.drain();

      expect(result?.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(primaryUrl);
    });

    it("does not call fallbackEndpoint on non-retryable 4xx client errors", async () => {
      const storage = new MemoryAdapter();
      await storage.init();
      const queue = new EventQueue({ storage });

      await queue.enqueue({ type: "bad_request" }, "normal");

      const primaryUrl = "https://primary.example.com/telemetry";
      const fallbackUrl = "https://backup.example.com/telemetry";

      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
      });
      globalThis.fetch = fetchMock;

      const dispatcher = new NetworkDispatcher(queue, {
        endpoint: primaryUrl,
        fallbackEndpoint: fallbackUrl,
        preferredTransport: "fetch",
      });

      const result = await dispatcher.drain();

      expect(result?.success).toBe(false);
      expect(result?.status).toBe(400);
      // Fallback is NOT invoked for client bugs
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(primaryUrl);

      // Poison pill should be pruned from queue
      const remaining = await queue.count();
      expect(remaining).toBe(0);
    });

    it("nacks and backs off when both primary and fallback fail", async () => {
      const storage = new MemoryAdapter();
      await storage.init();
      const queue = new EventQueue({ storage });

      await queue.enqueue({ type: "critical_conversion" }, "high");

      const primaryUrl = "https://primary.example.com/telemetry";
      const fallbackUrl = "https://backup.example.com/telemetry";

      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      globalThis.fetch = fetchMock;

      const dispatcher = new NetworkDispatcher(queue, {
        endpoint: primaryUrl,
        fallbackEndpoint: fallbackUrl,
        preferredTransport: "fetch",
      });

      const result = await dispatcher.drain();

      expect(result?.success).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Event is released back to queue for future retry
      const remaining = await queue.count();
      expect(remaining).toBe(1);
      expect(dispatcher.getRetryAttempt()).toBe(1);
    });

    it("fails over during emergency unload flush", async () => {
      const storage = new MemoryAdapter();
      await storage.init();
      const queue = new EventQueue({ storage });

      await queue.enqueue({ type: "conversion", value: 49 }, "high");

      const primaryUrl = "https://primary.example.com/telemetry";
      const fallbackUrl = "https://backup.example.com/telemetry";

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === primaryUrl) {
          return Promise.resolve({ ok: false, status: 502 });
        }
        if (url === fallbackUrl) {
          return Promise.resolve({ ok: true, status: 200 });
        }
        return Promise.reject(new Error("Unknown URL"));
      });
      globalThis.fetch = fetchMock;

      const dispatcher = new NetworkDispatcher(queue, {
        endpoint: primaryUrl,
        fallbackEndpoint: fallbackUrl,
        preferredTransport: "fetch",
      });

      const results = await dispatcher.flush();

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await queue.count()).toBe(0);
    });
  });

  describe("MicroAttribution Client Dual-Dispatch Redundancy", () => {
    it("dispatches to GA4 and invokes onConversion hook on conversion", async () => {
      const fetchCalls: Array<{ url: string; body: string }> = [];
      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        fetchCalls.push({
          url,
          body: (init?.body as string) || "",
        });
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      });

      const convertedEvents: QueuedEvent[] = [];
      const onConversionHook = vi.fn().mockImplementation((event: QueuedEvent) => {
        convertedEvents.push(event);
      });

      const storage = new MemoryAdapter();
      await storage.init();

      const client = new MicroAttribution({
        endpoint: "https://my-api.com/telemetry",
        storage,
        autoCapturePageview: false,
        redundancy: {
          fallbackEndpoint: "https://backup-api.com/telemetry",
          ga4: {
            measurementId: "G-11223344",
            apiSecret: "test_secret_123",
          },
          onConversion: onConversionHook,
        },
      });

      await client.init();

      await client.conversion("plan_upgrade", 299, {
        currency: "USD",
        transactionId: "sub_987",
        planTier: "enterprise",
      });

      // Wait brief microtask tick for async hooks
      await new Promise((r) => setTimeout(r, 20));

      // 1. onConversion hook called with the event
      expect(onConversionHook).toHaveBeenCalledTimes(1);
      expect(convertedEvents[0]!.payload.name).toBe("plan_upgrade");
      expect(convertedEvents[0]!.payload.value).toBe(299);

      // 2. GA4 dual-dispatch fired
      const ga4Call = fetchCalls.find((c) => c.url.includes("google-analytics.com"));
      expect(ga4Call).toBeDefined();
      expect(ga4Call?.url).toContain("measurement_id=G-11223344");
      expect(ga4Call?.url).toContain("api_secret=test_secret_123");

      const ga4Body = JSON.parse(ga4Call!.body);
      expect(ga4Body.events[0].name).toBe("purchase");
      expect(ga4Body.events[0].params.value).toBe(299);
      expect(ga4Body.events[0].params.transaction_id).toBe("sub_987");
      expect(ga4Body.events[0].params.planTier).toBe("enterprise");

      client.stop();
    });

    it("respects storageTier: 'memory' override for zero-storage mode", async () => {
      const client = new MicroAttribution({
        endpoint: "https://my-api.com/telemetry",
        storageTier: "memory",
        autoCapturePageview: false,
      });

      await client.init();
      const stats = await client.getStats();

      // Verified active storage is memory tier
      expect(stats.storageTier).toBe("memory");

      client.stop();
    });
  });
});
