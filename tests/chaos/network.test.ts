/**
 * Chaos & Resilience Test Suite: Network Fault Injection & Flapping
 *
 * Simulates adversarial mobile network environments:
 * - Flapping network transitions (rapid online/offline toggling)
 * - HTTP 429 Rate Limiting and backoff attempt tracking
 * - Transient 5xx server errors and exponential backoff recovery
 * - Non-retryable 4xx client error poison pill pruning
 * - Fetch timeouts and AbortError handling
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventQueue } from "../../src/queue/event-queue.js";
import { MemoryAdapter } from "../../src/storage/memory.js";
import { NetworkDispatcher } from "../../src/transport/dispatcher.js";
import type { QueuedEvent } from "../../src/types.js";

describe("Network Chaos & Resilience Suite", () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;

  let queue: EventQueue;

  beforeEach(() => {
    vi.restoreAllMocks();
    queue = new EventQueue({
      storage: new MemoryAdapter(),
      maxEvents: 500,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });

  it("handles rapid network flapping and drains queue when connection stabilizes", async () => {
    let isOnline = false;
    const listeners: Record<string, (() => void)[]> = {
      online: [],
      offline: [],
    };

    const mockWindow = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(globalThis, "window", {
      value: mockWindow,
      configurable: true,
      writable: true,
    });

    Object.defineProperty(globalThis, "navigator", {
      value: {
        get onLine() {
          return isOnline;
        },
      },
      configurable: true,
      writable: true,
    });

    const sentBatches: QueuedEvent[][] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      if (!isOnline) {
        throw new Error("Failed to fetch: NetworkOffline");
      }
      const parsed = JSON.parse(init.body);
      sentBatches.push(parsed);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
      };
    });

    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://telemetry.example.com/collect",
      batchSize: 10,
      batchIntervalMs: 100000,
      preferredTransport: "fetch",
    });

    // Step 1: Enqueue events while offline
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ action: "pageview", index: i });
    }
    expect(await queue.count()).toBe(5);

    // Drain while offline returns null gracefully without throwing
    const offlineResult = await dispatcher.drain();
    expect(offlineResult).toBeNull();
    expect(await queue.count()).toBe(5);

    // Step 2: Flap network rapidly between online and offline
    for (let cycle = 0; cycle < 6; cycle++) {
      isOnline = cycle % 2 === 1;
      const eventName = isOnline ? "online" : "offline";
      listeners[eventName]?.forEach((cb) => cb());
      await queue.enqueue({ action: "touchpoint", cycle });
    }

    // Stabilize network to online
    isOnline = true;
    listeners.online?.forEach((cb) => cb());

    // Step 3: Trigger drain after stabilization
    const stabilizedResult = await dispatcher.drain();
    expect(stabilizedResult).not.toBeNull();
    expect(stabilizedResult!.success).toBe(true);
    expect(stabilizedResult!.sentCount).toBeGreaterThan(0);
    expect(sentBatches.length).toBeGreaterThan(0);

    // Ensure all remaining events can be flushed
    await dispatcher.flush();
    expect(await queue.count()).toBe(0);
    dispatcher.stop();
  });

  it("respects HTTP 429 Rate Limiting and increments backoff attempts", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Return 429 Too Many Requests
        return {
          ok: false,
          status: 429,
          headers: new Headers({ "Retry-After": "2" }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
      };
    });

    const errorHandler = vi.fn();
    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://telemetry.example.com/collect",
      preferredTransport: "fetch",
      onError: errorHandler,
    });

    await queue.enqueue({ action: "conversion", value: 100 });
    expect(await queue.count()).toBe(1);

    // First attempt triggers HTTP 429
    const res1 = await dispatcher.drain();
    expect(res1).not.toBeNull();
    expect(res1!.success).toBe(false);
    expect(res1!.sentCount).toBe(0);
    expect(res1!.status).toBe(429);
    expect(errorHandler).toHaveBeenCalled();
    expect(dispatcher.getRetryAttempt()).toBe(1);

    // Verify queue still holds the event (nack preserved it)
    expect(await queue.count()).toBe(1);

    // After server recovers, next drain succeeds and resets backoff
    const res2 = await dispatcher.drain();
    expect(res2).not.toBeNull();
    expect(res2!.success).toBe(true);
    expect(res2!.sentCount).toBe(1);
    expect(dispatcher.getRetryAttempt()).toBe(0);
    expect(await queue.count()).toBe(0);

    dispatcher.stop();
  });

  it("recovers from consecutive 5xx server errors using exponential backoff", async () => {
    let attempt = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        return { ok: false, status: 500, headers: new Headers() };
      }
      if (attempt === 2) {
        return { ok: false, status: 503, headers: new Headers() };
      }
      return { ok: true, status: 200, headers: new Headers() };
    });

    const errors: Error[] = [];
    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://telemetry.example.com/collect",
      preferredTransport: "fetch",
      onError: (err) => errors.push(err),
    });

    await queue.enqueue({ action: "test_5xx" });

    // Attempt 1: 500 Internal Server Error
    const r1 = await dispatcher.drain();
    expect(r1).not.toBeNull();
    expect(r1!.success).toBe(false);
    expect(r1!.status).toBe(500);
    expect(dispatcher.getRetryAttempt()).toBe(1);

    // Attempt 2: 503 Service Unavailable
    const r2 = await dispatcher.drain();
    expect(r2).not.toBeNull();
    expect(r2!.success).toBe(false);
    expect(r2!.status).toBe(503);
    expect(dispatcher.getRetryAttempt()).toBe(2);

    // Event must remain in queue
    expect(await queue.count()).toBe(1);

    // Attempt 3: 200 OK recovery
    const r3 = await dispatcher.drain();
    expect(r3).not.toBeNull();
    expect(r3!.success).toBe(true);
    expect(dispatcher.getRetryAttempt()).toBe(0);
    expect(await queue.count()).toBe(0);

    dispatcher.stop();
  });

  it("prunes non-retryable 4xx client errors (poison pills) to prevent pipeline blockage", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 400, // Bad Request
          headers: new Headers(),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
      };
    });
    globalThis.fetch = fetchMock;

    const errorCallback = vi.fn();
    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://telemetry.example.com/collect",
      preferredTransport: "fetch",
      onError: errorCallback,
    });

    // Enqueue a poison pill record
    await queue.enqueue({ action: "corrupted_record_payload" });
    expect(await queue.count()).toBe(1);

    // Drain should detect 400 as non-retryable client error and prune it (ack it)
    const result = await dispatcher.drain();
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.status).toBe(400);
    expect(errorCallback).toHaveBeenCalled();
    expect(dispatcher.getRetryAttempt()).toBe(0); // non-retryable resets retry counter

    // Crucial invariant: poisoned item is evicted from queue so subsequent items are not blocked
    expect(await queue.count()).toBe(0);

    // Subsequent valid event enqueued and dispatched cleanly
    await queue.enqueue({ action: "valid_subsequent_event" });
    const result2 = await dispatcher.drain();
    expect(result2).not.toBeNull();
    expect(result2!.success).toBe(true);
    expect(await queue.count()).toBe(0);

    dispatcher.stop();
  });

  it("handles fetch AbortError timeouts gracefully without crashing the pipeline", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
      };
    });

    const errorCallback = vi.fn();
    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://telemetry.example.com/collect",
      preferredTransport: "fetch",
      onError: errorCallback,
    });

    await queue.enqueue({ action: "timed_out_action" });
    expect(await queue.count()).toBe(1);

    const res = await dispatcher.drain();
    expect(res).not.toBeNull();
    expect(res!.success).toBe(false);
    expect(errorCallback).toHaveBeenCalled();
    expect(dispatcher.getRetryAttempt()).toBe(1);

    // Event must remain preserved for retry
    expect(await queue.count()).toBe(1);

    // Next attempt succeeds
    const res2 = await dispatcher.drain();
    expect(res2!.success).toBe(true);
    expect(await queue.count()).toBe(0);

    dispatcher.stop();
  });
});
