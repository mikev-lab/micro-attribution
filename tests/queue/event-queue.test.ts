import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventQueue } from "../../src/queue/event-queue";
import { MemoryAdapter } from "../../src/storage/memory";
import type { QueuedEvent } from "../../src/types";

describe("EventQueue and Backpressure Engine", () => {
  let memoryStorage: MemoryAdapter;

  beforeEach(() => {
    memoryStorage = new MemoryAdapter();
  });

  it("enqueues events with monotonic timestamp and estimated byte size", async () => {
    const queue = new EventQueue({ storage: memoryStorage });
    await queue.init();

    const event = await queue.enqueue({ action: "pageview", path: "/pricing" }, "normal");

    expect(event.id).toBeDefined();
    expect(event.id.startsWith("evt_")).toBe(true);
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.priority).toBe("normal");
    expect(event.byteSize).toBeGreaterThan(80);
    expect(await queue.size()).toBe(1);
    expect(queue.getByteSize()).toBe(event.byteSize);
  });

  it("peeks and acknowledges (ack) events by deleting them", async () => {
    const queue = new EventQueue({ storage: memoryStorage });
    await queue.init();

    const e1 = await queue.enqueue({ step: 1 });
    const e2 = await queue.enqueue({ step: 2 });
    const e3 = await queue.enqueue({ step: 3 });

    expect(await queue.size()).toBe(3);

    const peeked = await queue.peek(2);
    expect(peeked.length).toBe(2);
    expect(peeked[0]?.id).toBe(e1.id);
    expect(peeked[1]?.id).toBe(e2.id);

    // Acknowledge first two events
    await queue.ack([e1.id, e2.id]);
    expect(await queue.size()).toBe(1);

    const remaining = await queue.peek();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.id).toBe(e3.id);
  });

  it("negative acknowledges (nack) events by incrementing retryCount", async () => {
    const queue = new EventQueue({ storage: memoryStorage });
    await queue.init();

    const e1 = await queue.enqueue({ task: "retry_me" });
    expect(e1.retryCount).toBe(0);

    await queue.nack([e1.id]);
    const [retried] = await queue.peek();
    expect(retried?.retryCount).toBe(1);

    await queue.nack([e1.id]);
    const [retriedAgain] = await queue.peek();
    expect(retriedAgain?.retryCount).toBe(2);
  });

  it("enforces count backpressure and evicts oldest normal event", async () => {
    const dropped: QueuedEvent[] = [];
    const queue = new EventQueue({
      maxEvents: 3,
      storage: memoryStorage,
      onDrop: (evt) => dropped.push(evt)
    });
    await queue.init();

    const e1 = await queue.enqueue({ num: 1 }, "normal");
    const e2 = await queue.enqueue({ num: 2 }, "normal");
    const e3 = await queue.enqueue({ num: 3 }, "normal");

    expect(await queue.size()).toBe(3);
    expect(dropped.length).toBe(0);

    // Enqueue 4th event: should evict e1 (oldest normal event)
    const e4 = await queue.enqueue({ num: 4 }, "normal");

    expect(await queue.size()).toBe(3);
    expect(dropped.length).toBe(1);
    expect(dropped[0]?.id).toBe(e1.id);

    const remaining = await queue.peek();
    expect(remaining.map((e) => e.id)).toEqual([e2.id, e3.id, e4.id]);
  });

  it("preserves high-priority conversions during backpressure eviction", async () => {
    const dropped: QueuedEvent[] = [];
    const queue = new EventQueue({
      maxEvents: 3,
      storage: memoryStorage,
      onDrop: (evt) => dropped.push(evt)
    });
    await queue.init();

    // Enqueue 1 conversion (high priority) first
    const conv1 = await queue.enqueue({ conversion: "order_1", value: 99 }, "high");

    // Enqueue 2 normal pageviews
    const pv1 = await queue.enqueue({ page: "/home" }, "normal");
    const pv2 = await queue.enqueue({ page: "/product" }, "normal");

    expect(await queue.size()).toBe(3);

    // Enqueue 1 more pageview: should evict pv1 (oldest normal), keeping conv1!
    const pv3 = await queue.enqueue({ page: "/cart" }, "normal");

    expect(await queue.size()).toBe(3);
    expect(dropped.length).toBe(1);
    expect(dropped[0]?.id).toBe(pv1.id);

    // Enqueue second conversion: should evict pv2 (remaining normal), keeping both conv1 and conv2!
    const conv2 = await queue.enqueue({ conversion: "order_2", value: 149 }, "high");

    expect(await queue.size()).toBe(3);
    expect(dropped.length).toBe(2);
    expect(dropped[1]?.id).toBe(pv2.id);

    // Remaining items should be [conv1, pv3, conv2]
    const remaining = await queue.peek();
    expect(remaining.map((e) => e.id)).toEqual([conv1.id, pv3.id, conv2.id]);
  });

  it("evicts oldest high-priority event when queue is 100% high-priority saturated", async () => {
    const dropped: QueuedEvent[] = [];
    const queue = new EventQueue({
      maxEvents: 2,
      storage: memoryStorage,
      onDrop: (evt) => dropped.push(evt)
    });
    await queue.init();

    const c1 = await queue.enqueue({ conv: 1 }, "high");
    const c2 = await queue.enqueue({ conv: 2 }, "high");

    expect(await queue.size()).toBe(2);

    // Enqueue 3rd high priority event: should evict c1 as fallback
    const c3 = await queue.enqueue({ conv: 3 }, "high");

    expect(await queue.size()).toBe(2);
    expect(dropped.length).toBe(1);
    expect(dropped[0]?.id).toBe(c1.id);

    const remaining = await queue.peek();
    expect(remaining.map((e) => e.id)).toEqual([c2.id, c3.id]);
  });

  it("enforces byte size backpressure limits", async () => {
    const dropped: QueuedEvent[] = [];
    // Set a tight byte budget: 250 bytes (each event is ~100 bytes)
    const queue = new EventQueue({
      maxByteSize: 250,
      storage: memoryStorage,
      onDrop: (evt, reason) => {
        expect(reason).toBe("byte_limit");
        dropped.push(evt);
      }
    });
    await queue.init();

    const e1 = await queue.enqueue({ message: "alpha" }, "normal");
    const e2 = await queue.enqueue({ message: "beta" }, "normal");

    expect(await queue.size()).toBe(2);
    expect(queue.getByteSize()).toBeLessThanOrEqual(250);

    // Enqueue 3rd event that forces byte size over 250 bytes
    await queue.enqueue({ message: "gamma" }, "normal");

    expect(queue.getByteSize()).toBeLessThanOrEqual(250);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
    expect(dropped[0]?.id).toBe(e1.id);
  });

  it("drops single payload that alone exceeds maxByteSize", async () => {
    const onDrop = vi.fn();
    const queue = new EventQueue({
      maxByteSize: 200,
      storage: memoryStorage,
      onDrop
    });
    await queue.init();

    // Payload that exceeds 200 bytes
    const hugePayload = { data: "x".repeat(300) };
    const droppedEvent = await queue.enqueue(hugePayload);

    expect(onDrop).toHaveBeenCalledWith(droppedEvent, "byte_limit");
    expect(await queue.size()).toBe(0);
    expect(queue.getByteSize()).toBe(0);
  });

  it("accurately reports queue statistics and hydrates across instances", async () => {
    const queue1 = new EventQueue({ storage: memoryStorage });
    await queue1.init();

    await queue1.enqueue({ page: "/1" }, "normal");
    await queue1.enqueue({ order: 100 }, "high");

    const stats1 = await queue1.stats();
    expect(stats1.eventCount).toBe(2);
    expect(stats1.highPriorityCount).toBe(1);
    expect(stats1.storageTier).toBe("memory");
    expect(stats1.byteSize).toBeGreaterThan(0);

    // Create a new queue instance pointing to same storage
    const queue2 = new EventQueue({ storage: memoryStorage });
    await queue2.init();

    const stats2 = await queue2.stats();
    expect(stats2.eventCount).toBe(2);
    expect(stats2.highPriorityCount).toBe(1);
    expect(stats2.byteSize).toBe(stats1.byteSize);
  });

  it("clears all records and resets counters", async () => {
    const queue = new EventQueue({ storage: memoryStorage });
    await queue.init();

    await queue.enqueue({ a: 1 });
    await queue.enqueue({ a: 2 });

    await queue.clear();
    expect(await queue.size()).toBe(0);
    expect(queue.getByteSize()).toBe(0);

    const stats = await queue.stats();
    expect(stats.eventCount).toBe(0);
    expect(stats.byteSize).toBe(0);
  });
});
