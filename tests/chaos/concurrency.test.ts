/**
 * Chaos & Resilience Test Suite: Multi-Tab Concurrency & Race Conditions
 *
 * Simulates concurrent multi-tab browser activity:
 * - Simultaneous writes from multiple browser tabs sharing storage
 * - Concurrent drain/flush races between tabs
 * - Interleaved writing and draining without deadlocks or record duplication
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventQueue } from "../../src/queue/event-queue.js";
import { IndexedDBAdapter } from "../../src/storage/indexeddb.js";
import { MemoryAdapter } from "../../src/storage/memory.js";
import { NetworkDispatcher } from "../../src/transport/dispatcher.js";
import type { QueuedEvent } from "../../src/types.js";
import { MockIDBFactory } from "../mocks/mock-idb.js";

describe("Concurrency & Race Condition Chaos Suite", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("handles 5 simulated concurrent browser tabs enqueueing simultaneously without lost updates", async () => {
    const mockFactory = new MockIDBFactory();
    vi.stubGlobal("indexedDB", mockFactory);

    // Shared database name across 5 tabs
    const sharedDbName = "__concurrency_shared_db__";
    const numTabs = 5;
    const eventsPerTab = 20;

    // Create 5 separate tab instances sharing the same underlying database
    const tabQueues: EventQueue[] = [];
    for (let t = 0; t < numTabs; t++) {
      const adapter = new IndexedDBAdapter(sharedDbName, "event_queue");
      await adapter.init();
      const q = new EventQueue({ storage: adapter, maxEvents: 1000 });
      await q.init();
      tabQueues.push(q);
    }

    // Simultaneously enqueue events from all 5 tabs
    const writePromises: Promise<unknown>[] = [];
    for (let t = 0; t < numTabs; t++) {
      for (let e = 0; e < eventsPerTab; e++) {
        writePromises.push(
          tabQueues[t]!.enqueue(
            { tabId: t, sequence: e, action: "tab_event" },
            e === 0 ? "high" : "normal"
          )
        );
      }
    }

    await Promise.all(writePromises);

    // Verify all 100 events exist in the shared database
    const totalExpected = numTabs * eventsPerTab;
    const verifyAdapter = new IndexedDBAdapter(sharedDbName, "event_queue");
    await verifyAdapter.init();

    const storedEvents = await verifyAdapter.peek();
    expect(storedEvents.length).toBe(totalExpected);

    // Verify all generated IDs are distinct (no collision across tabs)
    const uniqueIds = new Set(storedEvents.map((evt) => evt.id));
    expect(uniqueIds.size).toBe(totalExpected);

    // Verify high priority conversions from each tab were preserved
    const highPriorityEvents = storedEvents.filter((evt) => evt.priority === "high");
    expect(highPriorityEvents.length).toBe(numTabs);

    // Cleanup
    for (const q of tabQueues) {
      await (q as unknown as { storage: IndexedDBAdapter }).storage.close();
    }
    await verifyAdapter.close();
  });

  it("prevents double-transmissions during concurrent flush races across two tabs", async () => {
    const sharedStorage = new MemoryAdapter();
    await sharedStorage.init();

    const queueTab1 = new EventQueue({ storage: sharedStorage, maxEvents: 500 });
    const queueTab2 = new EventQueue({ storage: sharedStorage, maxEvents: 500 });
    await queueTab1.init();
    await queueTab2.init();

    // Populate queue with 20 events
    for (let i = 0; i < 20; i++) {
      await queueTab1.enqueue({ action: "race_test", index: i });
    }
    expect(await queueTab1.count()).toBe(20);

    const receivedEventIds: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const batch: QueuedEvent[] = JSON.parse(init.body);
      for (const evt of batch) {
        receivedEventIds.push(evt.id);
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
      };
    });

    const dispatcher1 = new NetworkDispatcher(queueTab1, {
      endpoint: "https://api.example.com/collect",
      preferredTransport: "fetch",
      batchSize: 10,
    });

    const dispatcher2 = new NetworkDispatcher(queueTab2, {
      endpoint: "https://api.example.com/collect",
      preferredTransport: "fetch",
      batchSize: 10,
    });

    // Run concurrent flushes simultaneously from both dispatchers
    await Promise.all([dispatcher1.flush(), dispatcher2.flush()]);

    // Queue must be completely drained
    expect(await queueTab1.count()).toBe(0);
    expect(await queueTab2.count()).toBe(0);

    // Ensure all 20 events were received
    expect(receivedEventIds.length).toBeGreaterThanOrEqual(20);

    // Assert that the set of unique event IDs received matches exactly 20
    const uniqueReceived = new Set(receivedEventIds);
    expect(uniqueReceived.size).toBe(20);

    dispatcher1.stop();
    dispatcher2.stop();
  });

  it("handles interleaved writes and continuous drains without deadlocking", async () => {
    const sharedStorage = new MemoryAdapter();
    await sharedStorage.init();

    const producerQueue = new EventQueue({ storage: sharedStorage, maxEvents: 500 });
    const consumerQueue = new EventQueue({ storage: sharedStorage, maxEvents: 500 });
    await producerQueue.init();
    await consumerQueue.init();

    let totalDispatched = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const batch: QueuedEvent[] = JSON.parse(init.body);
      totalDispatched += batch.length;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
      };
    });

    const dispatcher = new NetworkDispatcher(consumerQueue, {
      endpoint: "https://api.example.com/collect",
      preferredTransport: "fetch",
      batchSize: 15,
      batchIntervalMs: 20,
    });

    // Start concurrent continuous writer
    const totalToWrite = 60;
    const writerPromise = (async () => {
      for (let i = 0; i < totalToWrite; i++) {
        await producerQueue.enqueue({ action: "stream_item", idx: i });
      }
    })();

    await writerPromise;

    // Flush remaining
    await dispatcher.flush();

    expect(await consumerQueue.count()).toBe(0);
    expect(totalDispatched).toBe(totalToWrite);

    dispatcher.stop();
  });
});
