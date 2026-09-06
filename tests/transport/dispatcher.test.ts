import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventQueue } from "../../src/queue/event-queue.js";
import { MemoryAdapter } from "../../src/storage/memory.js";
import { NetworkDispatcher } from "../../src/transport/dispatcher.js";

describe("NetworkDispatcher & Exponential Retry Engine", () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;

  let queue: EventQueue;

  beforeEach(() => {
    vi.restoreAllMocks();
    queue = new EventQueue({
      storage: new MemoryAdapter(),
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

  it("throws descriptive error when instantiated without valid endpoint URL", () => {
    expect(() => new NetworkDispatcher(queue, { endpoint: "" })).toThrow(
      "NetworkDispatcher requires a valid string endpoint URL"
    );
  });

  it("successfully drains batches on HTTP 200 OK and acknowledges records", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    await queue.enqueue({ action: "click", target: "btn_signup" });
    await queue.enqueue({ action: "pageview", path: "/home" });

    expect(await queue.count()).toBe(2);

    const successCallback = vi.fn();
    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://api.example.com/telemetry",
      preferredTransport: "fetch",
      onSuccess: successCallback,
    });

    const result = await dispatcher.drain();

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.sentCount).toBe(2);
    expect(result?.status).toBe(200);

    // Assert queue acknowledged and emptied
    expect(await queue.count()).toBe(0);
    expect(successCallback).toHaveBeenCalledTimes(1);
    expect(dispatcher.getRetryAttempt()).toBe(0);
  });

  it("prunes poison pills on HTTP 400 non-retryable client error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    });
    globalThis.fetch = fetchMock;

    await queue.enqueue({ malformed: "payload" });
    expect(await queue.count()).toBe(1);

    const errorCallback = vi.fn();
    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://api.example.com/telemetry",
      preferredTransport: "fetch",
      onError: errorCallback,
    });

    const result = await dispatcher.drain();

    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.status).toBe(400);

    // Assert poison pill event was pruned to prevent endless retry loops
    expect(await queue.count()).toBe(0);
    expect(errorCallback).toHaveBeenCalledWith(expect.any(Error), 400);
    expect(dispatcher.getRetryAttempt()).toBe(0);
  });

  it("nacks events and increments exponential backoff on HTTP 500 server error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    globalThis.fetch = fetchMock;

    await queue.enqueue({ event: "critical_conversion" }, "high");
    expect(await queue.count()).toBe(1);

    const errorCallback = vi.fn();
    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://api.example.com/telemetry",
      preferredTransport: "fetch",
      onError: errorCallback,
    });

    const result = await dispatcher.drain();

    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.status).toBe(500);

    // Event is preserved in queue for subsequent retry
    expect(await queue.count()).toBe(1);
    expect(dispatcher.getRetryAttempt()).toBe(1);
    expect(errorCallback).toHaveBeenCalledWith(expect.any(Error), 500);
  });

  it("handles HTTP 429 rate limits by applying exponential backoff", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });
    globalThis.fetch = fetchMock;

    await queue.enqueue({ action: "search", query: "shoes" });

    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://api.example.com/telemetry",
      preferredTransport: "fetch",
    });

    const result = await dispatcher.drain();
    expect(result?.status).toBe(429);
    expect(dispatcher.getRetryAttempt()).toBe(1);
    expect(await queue.count()).toBe(1);
  });

  it("pauses draining when device is offline", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await queue.enqueue({ action: "offline_touch" });

    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://api.example.com/telemetry",
      preferredTransport: "fetch",
    });

    expect(dispatcher.isOnline()).toBe(false);

    const result = await dispatcher.drain();
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queue.count()).toBe(1);
  });

  it("resets backoff counter and drains when window online event triggers", async () => {
    const windowListeners: Record<string, () => void> = {};
    const mockWindow = {
      addEventListener: vi.fn((event: string, handler: () => void) => {
        windowListeners[event] = handler;
      }),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(globalThis, "window", {
      value: mockWindow,
      configurable: true,
      writable: true,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    await queue.enqueue({ action: "delayed_item" });

    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://api.example.com/telemetry",
      preferredTransport: "fetch",
    });

    dispatcher.start();

    // Simulate prior failures
    await dispatcher.drain();
    expect(dispatcher.getRetryAttempt()).toBe(0);

    // Simulate online trigger
    windowListeners.online?.();
    expect(dispatcher.getRetryAttempt()).toBe(0);

    dispatcher.stop();
    expect(mockWindow.removeEventListener).toHaveBeenCalledWith(
      "online",
      expect.any(Function)
    );
  });

  it("flushes entire queue across multiple batches during flush()", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    // Enqueue 7 items with a batchSize of 3 (requires 3 sequential batches)
    for (let i = 0; i < 7; i++) {
      await queue.enqueue({ item: i });
    }

    expect(await queue.count()).toBe(7);

    const dispatcher = new NetworkDispatcher(queue, {
      endpoint: "https://api.example.com/telemetry",
      batchSize: 3,
      preferredTransport: "fetch",
    });

    const results = await dispatcher.flush();

    expect(results.length).toBe(3);
    expect(results[0]?.sentCount).toBe(3);
    expect(results[1]?.sentCount).toBe(3);
    expect(results[2]?.sentCount).toBe(1);

    expect(await queue.count()).toBe(0);
  });
});
