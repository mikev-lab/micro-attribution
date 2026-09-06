import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transmitBatch } from "../../src/transport/transmitter.js";
import type { QueuedEvent } from "../../src/types.js";

function createSampleEvents(count = 2): QueuedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt_${Date.now()}_${i}`,
    timestamp: Date.now() + i,
    priority: "normal",
    byteSize: 120,
    payload: { action: "pageview", path: `/page-${i}` },
  }));
}

describe("Network Transmitter & Auto-Negotiation", () => {
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    globalThis.fetch = originalFetch;
  });

  it("returns immediate success when event list is empty", async () => {
    const result = await transmitBatch("https://example.com/collect", []);
    expect(result.success).toBe(true);
    expect(result.sentCount).toBe(0);
    expect(result.status).toBe(200);
  });

  it("uses navigator.sendBeacon when available and accepted", async () => {
    const sendBeaconMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconMock },
      configurable: true,
      writable: true,
    });

    const events = createSampleEvents(3);
    const result = await transmitBatch("https://example.com/collect", events);

    expect(result.success).toBe(true);
    expect(result.transport).toBe("beacon");
    expect(result.sentCount).toBe(3);
    expect(result.status).toBe(200);
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(sendBeaconMock).toHaveBeenCalledWith(
      "https://example.com/collect",
      expect.anything()
    );
  });

  it("falls back to keepalive fetch when navigator.sendBeacon returns false (buffer full)", async () => {
    const sendBeaconMock = vi.fn().mockReturnValue(false);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconMock },
      configurable: true,
      writable: true,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    const events = createSampleEvents(2);
    const result = await transmitBatch("https://example.com/collect", events);

    expect(result.success).toBe(true);
    expect(result.transport).toBe("keepalive");
    expect(result.sentCount).toBe(2);
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/collect",
      expect.objectContaining({ keepalive: true, method: "POST" })
    );
  });

  it("falls back to standard fetch when keepalive fetch throws", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      callCount++;
      if (init && init.keepalive) {
        throw new Error("QuotaExceededError: keepalive payload too large");
      }
      return Promise.resolve({
        ok: true,
        status: 200,
      });
    });
    globalThis.fetch = fetchMock;

    const events = createSampleEvents(2);
    const result = await transmitBatch("https://example.com/collect", events);

    expect(result.success).toBe(true);
    expect(result.transport).toBe("fetch");
    expect(result.sentCount).toBe(2);
    expect(callCount).toBe(2);
  });

  it("respects preferredTransport = 'fetch' directly without calling beacon", async () => {
    const sendBeaconMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconMock },
      configurable: true,
      writable: true,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
    });
    globalThis.fetch = fetchMock;

    const events = createSampleEvents(1);
    const result = await transmitBatch("https://example.com/collect", events, {
      preferredTransport: "fetch",
    });

    expect(result.success).toBe(true);
    expect(result.transport).toBe("fetch");
    expect(result.status).toBe(201);
    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("attaches custom HTTP headers during fetch dispatch", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    const events = createSampleEvents(1);
    await transmitBatch("https://example.com/collect", events, {
      preferredTransport: "fetch",
      headers: { "X-API-Key": "secret-123" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/collect",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-API-Key": "secret-123",
        }),
      })
    );
  });

  it("handles HTTP 4xx client errors accurately", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    });
    globalThis.fetch = fetchMock;

    const events = createSampleEvents(2);
    const result = await transmitBatch("https://example.com/collect", events, {
      preferredTransport: "fetch",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.sentCount).toBe(0);
  });

  it("handles network rejection gracefully", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });

    const fetchMock = vi.fn().mockRejectedValue(new Error("Network connection dropped"));
    globalThis.fetch = fetchMock;

    const events = createSampleEvents(1);
    const result = await transmitBatch("https://example.com/collect", events, {
      preferredTransport: "fetch",
    });

    expect(result.success).toBe(false);
    expect(result.sentCount).toBe(0);
    expect(result.error?.message).toContain("Network connection dropped");
  });
});
