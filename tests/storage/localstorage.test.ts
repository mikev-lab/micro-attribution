import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LocalStorageAdapter } from "../../src/storage/localstorage";
import type { QueuedEvent } from "../../src/types";

class MockLocalStorage implements Storage {
  private store: Map<string, string> = new Map();

  public get length(): number {
    return this.store.size;
  }

  public clear(): void {
    this.store.clear();
  }

  public getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  public key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  public removeItem(key: string): void {
    this.store.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("LocalStorageAdapter", () => {
  let mockStorage: MockLocalStorage;
  let adapter: LocalStorageAdapter;

  const createEvent = (id: string, timestamp: number, priority: "high" | "normal" = "normal"): QueuedEvent => ({
    id,
    timestamp,
    priority,
    byteSize: 120,
    payload: { action: "pageview", id }
  });

  beforeEach(() => {
    mockStorage = new MockLocalStorage();
    vi.stubGlobal("localStorage", mockStorage);
    adapter = new LocalStorageAdapter("__test_queue__");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("identifies as localstorage tier and initializes successfully", async () => {
    expect(adapter.tier).toBe("localstorage");
    await adapter.init();
    expect(await adapter.isAvailable()).toBe(true);
  });

  it("performs set and get operations", async () => {
    await adapter.init();
    const event = createEvent("evt_1", 1000);
    await adapter.set(event);

    const retrieved = await adapter.get("evt_1");
    expect(retrieved).toEqual(event);

    const missing = await adapter.get("missing");
    expect(missing).toBeNull();
  });

  it("updates existing record on duplicate id", async () => {
    await adapter.init();
    const event = createEvent("evt_1", 1000);
    await adapter.set(event);

    const updated = { ...event, byteSize: 300 };
    await adapter.set(updated);

    expect(await adapter.count()).toBe(1);
    const retrieved = await adapter.get("evt_1");
    expect(retrieved?.byteSize).toBe(300);
  });

  it("deletes single and multiple records", async () => {
    await adapter.init();
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

  it("peeks records sorted by timestamp ascending", async () => {
    await adapter.init();
    await adapter.set(createEvent("evt_3", 3000));
    await adapter.set(createEvent("evt_1", 1000));
    await adapter.set(createEvent("evt_2", 2000));

    const all = await adapter.peek();
    expect(all.map((e) => e.id)).toEqual(["evt_1", "evt_2", "evt_3"]);

    const limited = await adapter.peek(2);
    expect(limited.map((e) => e.id)).toEqual(["evt_1", "evt_2"]);
  });

  it("clears storage key on clear", async () => {
    await adapter.init();
    await adapter.set(createEvent("evt_1", 1000));
    await adapter.clear();

    expect(await adapter.count()).toBe(0);
    expect(await adapter.peek()).toEqual([]);
  });

  it("gracefully marks unavailable when localStorage throws during probe (Safari Private Mode)", async () => {
    const restrictedStorage = new MockLocalStorage();
    restrictedStorage.setItem = () => {
      throw new Error("QuotaExceededError: DOM Exception 22");
    };
    vi.stubGlobal("localStorage", restrictedStorage);

    const restrictedAdapter = new LocalStorageAdapter("__test_private__");
    await restrictedAdapter.init();

    expect(await restrictedAdapter.isAvailable()).toBe(false);
    expect(await restrictedAdapter.get("evt_1")).toBeNull();
    expect(await restrictedAdapter.count()).toBe(0);
    expect(await restrictedAdapter.peek()).toEqual([]);
  });

  it("recovers gracefully from corrupted JSON in storage", async () => {
    mockStorage.setItem("__test_corrupt__", "{ invalid json content");
    const corruptAdapter = new LocalStorageAdapter("__test_corrupt__");
    await corruptAdapter.init();

    expect(await corruptAdapter.count()).toBe(0);
    expect(await corruptAdapter.peek()).toEqual([]);
    expect(await corruptAdapter.get("any")).toBeNull();
  });
});
