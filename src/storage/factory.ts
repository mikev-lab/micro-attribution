import type { AdaptiveStorageOptions, StorageAdapter } from "../types";
import { IndexedDBAdapter } from "./indexeddb";
import { LocalStorageAdapter } from "./localstorage";
import { MemoryAdapter } from "./memory";

/**
 * Adaptive storage factory that dynamically probes runtime capabilities and selects
 * the most resilient available persistence tier.
 *
 * Tier Selection Hierarchy:
 * 1. Tier 1 (IndexedDB): Preferred for asynchronous durability, large quotas, and transactional indexing.
 * 2. Tier 2 (localStorage): Intermediate fallback when IndexedDB is blocked, unsupported, or disabled.
 * 3. Tier 3 (Memory): Zero-dependency fallback for headless Edge runtimes (Cloudflare Workers,
 *    Vercel Edge, Deno, Node.js) and SSR contexts where browser storage APIs are unavailable.
 *
 * @param options Optional configuration parameters and preferred tier override.
 * @returns A fully initialized, verified StorageAdapter instance.
 */
export async function createAdaptiveStorage(
  options: AdaptiveStorageOptions = {}
): Promise<StorageAdapter> {
  const preferred = options.preferredTier;

  // If a specific tier is explicitly requested, attempt it first
  if (preferred === "memory") {
    const memory = new MemoryAdapter();
    await memory.init();
    return memory;
  }

  if (preferred === "localstorage") {
    const local = new LocalStorageAdapter(options.localStorageKey);
    await local.init();
    if (await local.isAvailable()) {
      return local;
    }
    // If preferred localStorage failed, fallback to memory
    const memory = new MemoryAdapter();
    await memory.init();
    return memory;
  }

  if (preferred === "indexeddb") {
    const idb = new IndexedDBAdapter(options.dbName, options.storeName);
    await idb.init();
    if (await idb.isAvailable()) {
      return idb;
    }
    // If preferred IndexedDB failed, fallback through secondary tiers
  }

  // Auto-detection sequence: IndexedDB -> localStorage -> Memory

  // Step 1: Probe IndexedDB
  try {
    const idb = new IndexedDBAdapter(options.dbName, options.storeName);
    await idb.init();
    if (await idb.isAvailable()) {
      return idb;
    }
  } catch {
    // Continue to next tier
  }

  // Step 2: Probe localStorage
  try {
    const local = new LocalStorageAdapter(options.localStorageKey);
    await local.init();
    if (await local.isAvailable()) {
      return local;
    }
  } catch {
    // Continue to next tier
  }

  // Step 3: Default to volatile in-memory buffer
  const memory = new MemoryAdapter();
  await memory.init();
  return memory;
}
