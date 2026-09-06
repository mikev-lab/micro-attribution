import type { QueuedEvent, StorageAdapter, StorageTier } from "../types";
import { DEFAULT_LS_KEY } from "./adapter";

/**
 * Secondary storage adapter backed by window.localStorage.
 *
 * Provides intermediate persistence across browser reloads when IndexedDB is blocked,
 * disabled, or unsupported. Wraps all interactions with defensive try-catch guards to
 * gracefully handle QuotaExceededError, SecurityError (Safari Private Mode), and
 * disabled storage flags.
 */
export class LocalStorageAdapter implements StorageAdapter {
  public readonly tier: StorageTier = "localstorage";

  /** The localStorage key used to store the serialized event queue */
  private readonly storageKey: string;

  /** Cached availability flag verified during initialization */
  private available: boolean;

  /**
   * Constructs a new LocalStorageAdapter instance.
   *
   * @param storageKey Optional custom storage key name (defaults to '__micro_attr_queue__').
   */
  public constructor(storageKey: string = DEFAULT_LS_KEY) {
    this.storageKey = storageKey;
    this.available = false;
  }

  /**
   * Initializes the adapter and probes functional read/write availability.
   * Tests for Safari Private Browsing mode and storage quota restrictions.
   */
  public async init(): Promise<void> {
    this.available = this.probeAvailability();
    return Promise.resolve();
  }

  /**
   * Retrieves a single event record by ID.
   *
   * @param id Unique event identifier.
   * @returns The queued event record, or null if not present or storage unavailable.
   */
  public async get(id: string): Promise<QueuedEvent | null> {
    if (!this.available) {
      return Promise.resolve(null);
    }

    const events = this.readQueue();
    const event = events.find((item) => item.id === id);
    return Promise.resolve(event || null);
  }

  /**
   * Inserts or updates an event record in localStorage.
   *
   * @param event The event record to persist.
   */
  public async set(event: QueuedEvent): Promise<void> {
    if (!this.available) {
      return Promise.resolve();
    }

    const events = this.readQueue();
    const existingIndex = events.findIndex((item) => item.id === event.id);

    if (existingIndex >= 0) {
      events[existingIndex] = event;
    } else {
      events.push(event);
    }

    this.writeQueue(events);
    return Promise.resolve();
  }

  /**
   * Deletes a single event record by ID.
   *
   * @param id Unique event identifier to delete.
   */
  public async delete(id: string): Promise<void> {
    if (!this.available) {
      return Promise.resolve();
    }

    const events = this.readQueue().filter((item) => item.id !== id);
    this.writeQueue(events);
    return Promise.resolve();
  }

  /**
   * Batch deletes multiple event records by ID.
   *
   * @param ids Array of event identifiers to delete.
   */
  public async deleteMany(ids: string[]): Promise<void> {
    if (!this.available || ids.length === 0) {
      return Promise.resolve();
    }

    const idSet = new Set(ids);
    const events = this.readQueue().filter((item) => !idSet.has(item.id));
    this.writeQueue(events);
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
    if (!this.available) {
      return Promise.resolve([]);
    }

    const events = this.readQueue();
    events.sort((a, b) => a.timestamp - b.timestamp);

    if (limit !== undefined && limit > 0) {
      return Promise.resolve(events.slice(0, limit));
    }
    return Promise.resolve(events);
  }

  /**
   * Returns the total count of queued events in localStorage.
   */
  public async count(): Promise<number> {
    if (!this.available) {
      return Promise.resolve(0);
    }

    return Promise.resolve(this.readQueue().length);
  }

  /**
   * Clears all queued events from localStorage.
   */
  public async clear(): Promise<void> {
    if (!this.available) {
      return Promise.resolve();
    }

    try {
      this.getStorage()?.removeItem(this.storageKey);
    } catch {
      // Ignore removal failures during clearing
    }
    return Promise.resolve();
  }

  /**
   * Checks whether localStorage is available and accessible in the current runtime context.
   */
  public async isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  /**
   * Safely acquires the global localStorage handle if present in current environment.
   */
  private getStorage(): Storage | null {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        return window.localStorage;
      }
      if (typeof globalThis !== "undefined" && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
        return (globalThis as unknown as { localStorage: Storage }).localStorage;
      }
    } catch {
      // Access denied by browser security policy (e.g. sandboxed iframe or Private Browsing)
      return null;
    }
    return null;
  }

  /**
   * Probes whether localStorage is fully operational by performing a write/read/delete cycle.
   */
  private probeAvailability(): boolean {
    const storage = this.getStorage();
    if (!storage) {
      return false;
    }

    const probeKey = `__micro_attr_probe_${Math.random().toString(36).substring(2, 8)}__`;
    try {
      storage.setItem(probeKey, "probe");
      const readBack = storage.getItem(probeKey);
      storage.removeItem(probeKey);
      return readBack === "probe";
    } catch {
      // QuotaExceededError, SecurityError, or disabled storage
      return false;
    }
  }

  /**
   * Reads and parses the serialized event queue array from storage.
   */
  private readQueue(): QueuedEvent[] {
    const storage = this.getStorage();
    if (!storage) {
      return [];
    }

    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupted JSON or read failure: return empty queue to prevent crashing
      return [];
    }
  }

  /**
   * Serializes and writes the event queue array to storage.
   */
  private writeQueue(events: QueuedEvent[]): void {
    const storage = this.getStorage();
    if (!storage) {
      return;
    }

    try {
      storage.setItem(this.storageKey, JSON.stringify(events));
    } catch {
      // Catch QuotaExceededError gracefully without throwing uncaught exception
    }
  }
}
