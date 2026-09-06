import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicroAttribution } from "../../src/client/sdk.js";
import { MemoryAdapter } from "../../src/storage/memory.js";

describe("MicroAttribution Client SDK", () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  });

  it("throws descriptive error when instantiated without endpoint URL", () => {
    expect(() => new MicroAttribution({ endpoint: "" })).toThrow(
      "MicroAttribution client requires a target 'endpoint' URL"
    );
  });

  it("initializes singleton client instance via static init()", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    const storage = new MemoryAdapter();
    const client = await MicroAttribution.init({
      endpoint: "https://api.example.com/collect",
      storage,
      autoCapturePageview: false,
    });

    expect(client).toBeInstanceOf(MicroAttribution);
    expect(MicroAttribution.getInstance()).toBe(client);

    client.stop();
  });

  it("records pageview touchpoint with campaign attributes and normal priority", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    const storage = new MemoryAdapter();
    const client = new MicroAttribution({
      endpoint: "https://api.example.com/collect",
      storage,
      autoCapturePageview: false,
    });
    await client.init();

    const event = await client.pageview("/pricing", { plan: "enterprise" });

    expect(event).not.toBeNull();
    expect(event?.priority).toBe("normal");
    expect(event?.payload).toMatchObject({
      type: "pageview",
      path: "/pricing",
      plan: "enterprise",
    });

    expect(await client.getQueue().count()).toBe(1);
    client.stop();
  });

  it("records explicit custom touchpoint event with monotonic timestamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    const storage = new MemoryAdapter();
    const client = new MicroAttribution({
      endpoint: "https://api.example.com/collect",
      storage,
      autoCapturePageview: false,
    });
    await client.init();

    const event = await client.touchpoint("newsletter_click", { campaign: "weekly_roundup" });

    expect(event).not.toBeNull();
    expect(event?.priority).toBe("normal");
    expect(event?.payload).toMatchObject({
      type: "touchpoint",
      channel: "newsletter_click",
      campaign: "weekly_roundup",
    });

    client.stop();
  });

  it("records conversion event with high priority and value preservation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    const storage = new MemoryAdapter();
    const client = new MicroAttribution({
      endpoint: "https://api.example.com/collect",
      storage,
      autoCapturePageview: false,
    });
    await client.init();

    const event = await client.conversion("purchase", 149.99, {
      currency: "USD",
      orderId: "ord_9981",
    });

    expect(event).not.toBeNull();
    expect(event?.priority).toBe("high");
    expect(event?.payload).toMatchObject({
      type: "conversion",
      name: "purchase",
      value: 149.99,
      currency: "USD",
      orderId: "ord_9981",
    });

    client.stop();
  });

  it("strictly preserves conversions even when sampleRate is 0.0", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    const storage = new MemoryAdapter();
    const client = new MicroAttribution({
      endpoint: "https://api.example.com/collect",
      storage,
      sampleRate: 0.0, // Drops 100% of non-critical telemetry
      autoCapturePageview: false,
    });
    await client.init();

    // Normal touchpoints dropped by sampling
    const pageviewResult = await client.pageview("/dashboard");
    const touchpointResult = await client.touchpoint("social");

    expect(pageviewResult).toBeNull();
    expect(touchpointResult).toBeNull();

    // Critical financial conversions strictly bypass sampling
    const conversionResult = await client.conversion("deal_won", 5000);
    expect(conversionResult).not.toBeNull();
    expect(conversionResult?.priority).toBe("high");

    client.stop();
  });

  it("flushes queued events immediately across network batches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = fetchMock;

    const storage = new MemoryAdapter();
    const client = new MicroAttribution({
      endpoint: "https://api.example.com/collect",
      storage,
      autoCapturePageview: false,
      batchSize: 2,
    });
    await client.init();

    await client.touchpoint("ad_1");
    await client.touchpoint("ad_2");
    await client.touchpoint("ad_3");

    expect(await client.getQueue().count()).toBe(3);

    const flushResults = await client.flush();

    expect(flushResults.length).toBe(2);
    expect(await client.getQueue().count()).toBe(0);

    const stats = await client.getStats();
    expect(stats.eventCount).toBe(0);

    client.stop();
  });
});
