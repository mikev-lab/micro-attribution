import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IndexedDBAdapter } from "../../src/storage/indexeddb";
import { MockIDBFactory } from "../mocks/mock-idb";
import type { QueuedEvent } from "../../src/types";

describe("IndexedDBAdapter", () => {
  let mockFactory: MockIDBFactory;
  let adapter: IndexedDBAdapter;

  const createEvent = (id: string, timestamp: number, priority: "high" | "normal" = "normal"): QueuedEvent => ({
    id,
    timestamp,
    priority,
    byteSize: 150,
    payload: { action: "conversion", value: 49.99, id }
  });

  beforeEach(async () => {
    mockFactory = new MockIDBFactory();
    vi.stubGlobal("indexedDB", mockFactory);
    adapter = new IndexedDBAdapter("__test_db__", "event_queue");
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
    vi.unstubAllGlobals();
  });

  it("identifies as indexeddb tier and is functional", async () => {
    expect(adapter.tier).toBe("indexeddb");
    expect(await adapter.isAvailable()).toBe(true);
  });

  it("performs set and get operations", async () => {
    const event = createEvent("evt_1", 1000, "high");
    await adapter.set(event);

    const retrieved = await adapter.get("evt_1");
    expect(retrieved).toEqual(event);

    const missing = await adapter.get("missing");
    expect(missing).toBeNull();
  });

  it("deletes single and multiple records", async () => {
    await adapter.set(createEvent("evt_1", 1000));
    await adapter.set(createEvent("evt_2", 2000));
    await adapter.set(createEvent("evt_3", 3000));

    expect(await adapter.count()).toBe(3);

    await adapter.delete("evt_2");
    expect(await adapter.count()).toBe(2);
    expect(await adapter.get("evt_2")).toBeNull();

    await adapter.deleteMany(["evt_1", "evt_3"]);
    expect(await adapter.count()).toBe(0);
  });

  it("peeks records sorted chronologically by timestamp ascending", async () => {
    await adapter.set(createEvent("evt_3", 3000));
    await adapter.set(createEvent("evt_1", 1000));
    await adapter.set(createEvent("evt_2", 2000));

    const all = await adapter.peek();
    expect(all.map((e) => e.id)).toEqual(["evt_1", "evt_2", "evt_3"]);

    const limited = await adapter.peek(2);
    expect(limited.map((e) => e.id)).toEqual(["evt_1", "evt_2"]);
  });

  it("clears all records from object store", async () => {
    await adapter.set(createEvent("evt_1", 1000));
    await adapter.set(createEvent("evt_2", 2000));

    await adapter.clear();
    expect(await adapter.count()).toBe(0);
    expect(await adapter.peek()).toEqual([]);
  });

  it("handles environment where indexedDB is absent gracefully", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const absentAdapter = new IndexedDBAdapter("__absent_db__");

    await absentAdapter.init();
    expect(await absentAdapter.isAvailable()).toBe(false);
    expect(await absentAdapter.get("evt_1")).toBeNull();
    expect(await absentAdapter.count()).toBe(0);
    expect(await absentAdapter.peek()).toEqual([]);
  });
});
