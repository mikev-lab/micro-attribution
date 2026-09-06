import { describe, it, expect, afterEach, vi } from "vitest";
import { createAdaptiveStorage } from "../../src/storage/factory";
import { MockIDBFactory } from "../mocks/mock-idb";

describe("createAdaptiveStorage Factory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects IndexedDB as tier 1 when indexedDB is functional", async () => {
    vi.stubGlobal("indexedDB", new MockIDBFactory());

    const storage = await createAdaptiveStorage();
    expect(storage.tier).toBe("indexeddb");
    expect(await storage.isAvailable()).toBe(true);
  });

  it("falls back to localStorage as tier 2 when indexedDB is absent but localStorage is available", async () => {
    vi.stubGlobal("indexedDB", undefined);

    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      length: 0,
      key: () => null
    });

    const storage = await createAdaptiveStorage();
    expect(storage.tier).toBe("localstorage");
    expect(await storage.isAvailable()).toBe(true);
  });

  it("falls back to Memory as tier 3 when both IndexedDB and localStorage are absent or failing", async () => {
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("localStorage", undefined);

    const storage = await createAdaptiveStorage();
    expect(storage.tier).toBe("memory");
    expect(await storage.isAvailable()).toBe(true);
  });

  it("honors explicit preferredTier: 'memory' even when other storage is present", async () => {
    vi.stubGlobal("indexedDB", new MockIDBFactory());

    const storage = await createAdaptiveStorage({ preferredTier: "memory" });
    expect(storage.tier).toBe("memory");
  });

  it("honors explicit preferredTier: 'localstorage'", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      length: 0,
      key: () => null
    });

    const storage = await createAdaptiveStorage({ preferredTier: "localstorage" });
    expect(storage.tier).toBe("localstorage");
  });
});
