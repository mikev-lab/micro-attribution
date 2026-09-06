/**
 * Chaos & Resilience Test Suite: Storage Quota, Corruption & Restricted Environments
 *
 * Simulates adversarial storage scenarios:
 * - QuotaExceededError hardware/browser quota limits
 * - Priority preservation protecting conversion events under severe pressure
 * - Corrupted and malformed storage records in IndexedDB and LocalStorage
 * - Cascading fallback to in-memory buffers in restricted browsing modes (Safari Private / Sandboxed iframes)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventQueue } from "../../src/queue/event-queue.js";
import { createAdaptiveStorage } from "../../src/storage/factory.js";
import { IndexedDBAdapter } from "../../src/storage/indexeddb.js";
import { LocalStorageAdapter } from "../../src/storage/localstorage.js";
import { MemoryAdapter } from "../../src/storage/memory.js";
import type { QueuedEvent, StorageAdapter, StorageTier } from "../../src/types.js";
import { MockIDBFactory } from "../mocks/mock-idb.js";

describe("Storage Chaos & Fault Injection Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles QuotaExceededError by evicting lower priority events to preserve conversion", async () => {
    // Custom fault-injecting adapter that throws QuotaExceededError when count reaches 2
    class QuotaThrowingAdapter implements StorageAdapter {
      public readonly tier: StorageTier = "memory";
      private records = new Map<string, QueuedEvent>();
      public failOnNextSet = false;

      async init(): Promise<void> {}
      async get(id: string): Promise<QueuedEvent | null> {
        return this.records.get(id) ?? null;
      }
      async set(event: QueuedEvent): Promise<void> {
        if (this.failOnNextSet) {
          this.failOnNextSet = false;
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        }
        this.records.set(event.id, event);
      }
      async delete(id: string): Promise<void> {
        this.records.delete(id);
      }
      async deleteMany(ids: string[]): Promise<void> {
        ids.forEach((id) => this.records.delete(id));
      }
      async peek(limit?: number): Promise<QueuedEvent[]> {
        const all = Array.from(this.records.values());
        return limit ? all.slice(0, limit) : all;
      }
      async count(): Promise<number> {
        return this.records.size;
      }
      async clear(): Promise<void> {
        this.records.clear();
      }
      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const storage = new QuotaThrowingAdapter();
    const dropped: QueuedEvent[] = [];

    const queue = new EventQueue({
      storage,
      maxEvents: 10,
      onDrop: (evt) => dropped.push(evt),
    });

    // Step 1: Enqueue a normal pageview event
    await queue.enqueue({ action: "pageview", path: "/home" }, "normal", "evt_normal_1");
    expect(await queue.count()).toBe(1);

    // Step 2: Set flag to trigger QuotaExceededError on next write
    storage.failOnNextSet = true;

    // Step 3: Enqueue high-priority conversion event
    // The queue should catch QuotaExceededError, evict evt_normal_1, and retry saving the conversion
    const conversion = await queue.enqueue(
      { action: "conversion", value: 99.99 },
      "high",
      "evt_conversion_1"
    );

    expect(conversion.priority).toBe("high");
    expect(dropped.length).toBe(1);
    expect(dropped[0]!.id).toBe("evt_normal_1");

    // The high-priority conversion must be safely stored
    const remaining = await queue.peek();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.id).toBe("evt_conversion_1");
  });

  it("strictly preserves high-priority conversion events during severe capacity pressure", async () => {
    const queue = new EventQueue({
      storage: new MemoryAdapter(),
      maxEvents: 2, // Tiny capacity
    });

    // Enqueue 2 normal events
    await queue.enqueue({ action: "pageview", page: 1 }, "normal", "norm_1");
    await queue.enqueue({ action: "pageview", page: 2 }, "normal", "norm_2");
    expect(await queue.count()).toBe(2);

    // Enqueue high priority conversion: norm_1 should be evicted
    await queue.enqueue({ action: "conversion", revenue: 50 }, "high", "conv_1");
    expect(await queue.count()).toBe(2);

    // Enqueue second high priority conversion: norm_2 should be evicted
    await queue.enqueue({ action: "conversion", revenue: 100 }, "high", "conv_2");
    expect(await queue.count()).toBe(2);

    const events = await queue.peek();
    const priorities = events.map((e) => e.priority);
    expect(priorities).toEqual(["high", "high"]);

    const stats = await queue.stats();
    expect(stats.highPriorityCount).toBe(2);
    expect(stats.droppedCount).toBe(2);
  });

  it("defensively recovers from corrupted JSON and invalid objects in LocalStorage", async () => {
    const mockStorageMap = new Map<string, string>();
    const mockLS = {
      getItem: vi.fn((key: string) => mockStorageMap.get(key) ?? null),
      setItem: vi.fn((key: string, val: string) => mockStorageMap.set(key, val)),
      removeItem: vi.fn((key: string) => mockStorageMap.delete(key)),
      clear: vi.fn(() => mockStorageMap.clear()),
    };

    vi.stubGlobal("localStorage", mockLS);

    const adapter = new LocalStorageAdapter("__chaos_ls_key__");
    await adapter.init();

    // Case 1: Corrupted unparseable JSON string in storage
    mockStorageMap.set("__chaos_ls_key__", "CORRUPTED_NOT_JSON{{{[[");
    expect(await adapter.peek()).toEqual([]);
    expect(await adapter.get("any_id")).toBeNull();
    expect(await adapter.count()).toBe(0);

    // Case 2: Valid JSON array containing non-event / corrupted records
    mockStorageMap.set(
      "__chaos_ls_key__",
      JSON.stringify([
        null,
        "string_record",
        { no_id: 123 },
        { id: "valid_record", timestamp: 1000, priority: "normal", byteSize: 50, payload: {} },
      ])
    );

    const peeked = await adapter.peek();
    expect(peeked.length).toBe(1);
    expect(peeked[0]!.id).toBe("valid_record");

    // Case 3: Deleting an item rewrites clean array without corrupted elements
    await adapter.delete("valid_record");
    expect(await adapter.count()).toBe(0);
  });

  it("safely ignores corrupted records in IndexedDB without throwing", async () => {
    const mockFactory = new MockIDBFactory();
    vi.stubGlobal("indexedDB", mockFactory);

    const adapter = new IndexedDBAdapter("__chaos_idb__", "events");
    await adapter.init();

    // Directly inject a corrupted object missing 'id' into the underlying mock store
    const db = mockFactory.databases.get("__chaos_idb__");
    const store = db?.stores.get("events");
    if (store) {
      // Injected corrupt record
      store.records.set("corrupted_key", {
        id: undefined as unknown as string,
        timestamp: 500,
        priority: "normal",
      });
    }

    // Add one valid event through adapter
    await adapter.set({
      id: "valid_idb_event",
      timestamp: 1000,
      priority: "high",
      byteSize: 100,
      payload: { action: "test" },
    });

    // Peek should return only valid record with id string
    const peeked = await adapter.peek();
    expect(peeked.length).toBe(1);
    expect(peeked[0]!.id).toBe("valid_idb_event");

    // Getting the corrupted key returns null
    expect(await adapter.get("corrupted_key")).toBeNull();

    await adapter.close();
  });

  it("cascades smoothly to in-memory buffer when browser storage throws SecurityError", async () => {
    // Simulate IndexedDB throwing SecurityError (e.g. strict sandboxed iframe)
    const mockIDB = {
      open: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };
    vi.stubGlobal("indexedDB", mockIDB);

    // Simulate localStorage throwing SecurityError (e.g. Safari Private Browsing)
    const mockLS = {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };
    vi.stubGlobal("localStorage", mockLS);

    // Adaptive storage factory should cascade: IndexedDB (fails) -> localStorage (fails) -> Memory (succeeds)
    const adapter = await createAdaptiveStorage();
    expect(adapter.tier).toBe("memory");
    expect(await adapter.isAvailable()).toBe(true);

    // Operational verification: adapter performs standard CRUD without error
    await adapter.set({
      id: "evt_memory_fallback",
      timestamp: Date.now(),
      priority: "normal",
      byteSize: 80,
      payload: { action: "fallback_success" },
    });

    expect(await adapter.count()).toBe(1);
    const retrieved = await adapter.get("evt_memory_fallback");
    expect(retrieved?.id).toBe("evt_memory_fallback");
  });
});
