import type { QueuedEvent, StorageAdapter, StorageTier } from "../types";

/**
 * High-performance volatile in-memory storage adapter.
 *
 * Serves as the tier-3 fallback for serverless edge environments (Cloudflare Workers,
 * Vercel Edge, Deno, Node.js) and SSR execution where browser persistence APIs
 * (IndexedDB and localStorage) are unavailable.
 */
export class MemoryAdapter implements StorageAdapter {
  public readonly tier: StorageTier = "memory";

  /** Internal key-value registry holding queued events in heap memory */
  private events: Map<string, QueuedEvent>;

  /**
   * Constructs a new MemoryAdapter instance.
   */
  public constructor() {
    this.events = new Map<string, QueuedEvent>();
  }

  /**
   * Initializes the memory adapter.
   * Resolves immediately as heap memory requires no connection handshake.
   */
  public async init(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Retrieves a single event record by ID.
   *
   * @param id Unique event identifier.
   * @returns The queued event record, or null if not present.
   */
  public async get(id: string): Promise<QueuedEvent | null> {
    return Promise.resolve(this.events.get(id) || null);
  }

  /**
   * Inserts or updates an event record in volatile storage.
   *
   * @param event The event record to persist.
   */
  public async set(event: QueuedEvent): Promise<void> {
    this.events.set(event.id, event);
    return Promise.resolve();
  }

  /**
   * Deletes a single event record by ID.
   *
   * @param id Unique event identifier to delete.
   */
  public async delete(id: string): Promise<void> {
    this.events.delete(id);
    return Promise.resolve();
  }

  /**
   * Batch deletes multiple event records by ID.
   *
   * @param ids Array of event identifiers to delete.
   */
  public async deleteMany(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.events.delete(id);
    }
    return Promise.resolve();
  }

  /**
   * Peeks at the oldest queued events up to limit without removing them.
   * Events are returned in ascending chronological order (oldest first).
   *
   * @param limit Maximum number of records to return (defaults to all).
   * @returns Array of queued event records.
   */
  public async peek(limit?: number): Promise<QueuedEvent[]> {
    // Collect all records and sort chronologically by timestamp
    const all = Array.from(this.events.values());
    all.sort((a, b) => a.timestamp - b.timestamp);

    if (limit !== undefined && limit > 0) {
      return Promise.resolve(all.slice(0, limit));
    }
    return Promise.resolve(all);
  }

  /**
   * Returns the total count of queued events in memory.
   */
  public async count(): Promise<number> {
    return Promise.resolve(this.events.size);
  }

  /**
   * Clears all queued events from memory.
   */
  public async clear(): Promise<void> {
    this.events.clear();
    return Promise.resolve();
  }

  /**
   * Checks whether the memory adapter is available and functional.
   * Always returns true in any JavaScript execution context.
   */
  public async isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
