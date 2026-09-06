import { describe, it, expect, beforeEach } from "vitest";
import { MemoryAdapter } from "../../src/storage/memory";
import type { QueuedEvent } from "../../src/types";

describe("MemoryAdapter", () => {
  let adapter: MemoryAdapter;

  const createEvent = (id: string, timestamp: number, priority: "high" | "normal" = "normal"): QueuedEvent => ({
    id,
    timestamp,
    priority,
    byteSize: 100,
    payload: { action: "test", id }
  });

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.init();
  });

  it("identifies as memory tier and is immediately available", async () => {
    expect(adapter.tier).toBe("memory");
    expect(await adapter.isAvailable()).toBe(true);
  });

  it("performs set and get operations", async () => {
    const event = createEvent("evt_1", 1000);
    await adapter.set(event);

    const retrieved = await adapter.get("evt_1");
    expect(retrieved).toEqual(event);

    const nonExistent = await adapter.get("missing");
    expect(nonExistent).toBeNull();
  });

  it("accurately updates record on set with identical ID", async () => {
    const event = createEvent("evt_1", 1000);
    await adapter.set(event);

    const updated = { ...event, byteSize: 250 };
    await adapter.set(updated);

    expect(await adapter.count()).toBe(1);
    const retrieved = await adapter.get("evt_1");
    expect(retrieved?.byteSize).toBe(250);
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

  it("peeks records in strict chronological ascending order", async () => {
    // Insert out of chronological order
    await adapter.set(createEvent("evt_3", 3000));
    await adapter.set(createEvent("evt_1", 1000));
    await adapter.set(createEvent("evt_2", 2000));

    const all = await adapter.peek();
    expect(all.map((e) => e.id)).toEqual(["evt_1", "evt_2", "evt_3"]);

    const limited = await adapter.peek(2);
    expect(limited.map((e) => e.id)).toEqual(["evt_1", "evt_2"]);
  });

  it("clears all records", async () => {
    await adapter.set(createEvent("evt_1", 1000));
    await adapter.set(createEvent("evt_2", 2000));

    await adapter.clear();
    expect(await adapter.count()).toBe(0);
    expect(await adapter.peek()).toEqual([]);
  });
});
