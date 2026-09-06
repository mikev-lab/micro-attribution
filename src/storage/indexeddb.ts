import type { QueuedEvent, StorageAdapter, StorageTier } from "../types";
import { DEFAULT_DB_NAME, DEFAULT_STORE_NAME } from "./adapter";

/**
 * Primary persistent storage adapter backed by native browser IndexedDB.
 *
 * Provides transactional durability, non-blocking asynchronous I/O, and indexed queries
 * for timestamps and priority levels. Seamlessly handles connection lifecycles, versioning,
 * transaction aborts, and environment availability.
 */
export class IndexedDBAdapter implements StorageAdapter {
  public readonly tier: StorageTier = "indexeddb";

  /** Database name */
  private readonly dbName: string;

  /** Object store name */
  private readonly storeName: string;

  /** Active IDBDatabase connection handle */
  private db: IDBDatabase | null;

  /** Cached availability state */
  private available: boolean;

  /** In-flight initialization promise to prevent race conditions during concurrent calls */
  private initPromise: Promise<void> | null;

  /**
   * Constructs a new IndexedDBAdapter instance.
   *
   * @param dbName Optional custom database name (defaults to '__micro_attr_db').
   * @param storeName Optional custom object store name (defaults to 'event_queue').
   */
  public constructor(
    dbName: string = DEFAULT_DB_NAME,
    storeName: string = DEFAULT_STORE_NAME
  ) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.db = null;
    this.available = false;
    this.initPromise = null;
  }

  /**
   * Initializes the IndexedDB database connection and creates required object stores and indexes.
   */
  public async init(): Promise<void> {
    if (this.db) {
      return Promise.resolve();
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.openDatabase();
    return this.initPromise;
  }

  /**
   * Retrieves a single event record by ID.
   *
   * @param id Unique event identifier.
   * @returns The queued event record, or null if not found.
   */
  public async get(id: string): Promise<QueuedEvent | null> {
    const db = await this.ensureDb();
    if (!db) {
      return null;
    }

    return new Promise<QueuedEvent | null>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readonly");
        const store = tx.objectStore(this.storeName);
        const request = store.get(id);

        request.onsuccess = () => {
          resolve(request.result || null);
        };
        request.onerror = () => {
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Inserts or updates an event record in the IndexedDB object store.
   *
   * @param event The event record to persist.
   */
  public async set(event: QueuedEvent): Promise<void> {
    const db = await this.ensureDb();
    if (!db) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        const request = store.put(event);

        request.onsuccess = () => {
          resolve();
        };
        request.onerror = () => {
          reject(request.error || new Error("Failed to write event to IndexedDB"));
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Deletes a single event record by ID.
   *
   * @param id Unique event identifier to delete.
   */
  public async delete(id: string): Promise<void> {
    const db = await this.ensureDb();
    if (!db) {
      return;
    }

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        const request = store.delete(id);

        request.onsuccess = () => {
          resolve();
        };
        request.onerror = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }

  /**
   * Batch deletes multiple event records by ID within a single readwrite transaction.
   *
   * @param ids Array of event identifiers to delete.
   */
  public async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const db = await this.ensureDb();
    if (!db) {
      return;
    }

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);

        for (const id of ids) {
          store.delete(id);
        }

        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          resolve();
        };
        tx.onabort = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }

  /**
   * Peeks at the oldest queued events up to limit without removing them.
   * Uses the 'timestamp' index to retrieve records in chronological ascending order.
   *
   * @param limit Maximum number of records to return (defaults to all).
   * @returns Array of queued event records ordered by timestamp.
   */
  public async peek(limit?: number): Promise<QueuedEvent[]> {
    const db = await this.ensureDb();
    if (!db) {
      return [];
    }

    return new Promise<QueuedEvent[]>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readonly");
        const store = tx.objectStore(this.storeName);
        const index = store.index("timestamp");
        const results: QueuedEvent[] = [];

        // Open cursor on chronological index in ascending direction
        const request = index.openCursor(null, "next");

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            results.push(cursor.value);
            if (limit !== undefined && limit > 0 && results.length >= limit) {
              resolve(results);
              return;
            }
            cursor.continue();
          } else {
            resolve(results);
          }
        };

        request.onerror = () => {
          resolve(results);
        };
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * Returns the total count of queued events in the object store.
   */
  public async count(): Promise<number> {
    const db = await this.ensureDb();
    if (!db) {
      return 0;
    }

    return new Promise<number>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readonly");
        const store = tx.objectStore(this.storeName);
        const request = store.count();

        request.onsuccess = () => {
          resolve(request.result || 0);
        };
        request.onerror = () => {
          resolve(0);
        };
      } catch {
        resolve(0);
      }
    });
  }

  /**
   * Clears all queued events from the object store.
   */
  public async clear(): Promise<void> {
    const db = await this.ensureDb();
    if (!db) {
      return;
    }

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        const request = store.clear();

        request.onsuccess = () => {
          resolve();
        };
        request.onerror = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }

  /**
   * Checks whether IndexedDB is available, accessible, and functional.
   */
  public async isAvailable(): Promise<boolean> {
    if (this.db) {
      return true;
    }
    await this.init();
    return this.available;
  }

  /**
   * Closes the active IndexedDB connection handle.
   */
  public async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.available = false;
      this.initPromise = null;
    }
    return Promise.resolve();
  }

  /**
   * Internal helper to ensure database connection is established before running operations.
   */
  private async ensureDb(): Promise<IDBDatabase | null> {
    if (!this.db) {
      await this.init();
    }
    return this.db;
  }

  /**
   * Safely acquires the global IDBFactory handle if present in current execution context.
   */
  private getFactory(): IDBFactory | null {
    try {
      if (typeof window !== "undefined" && window.indexedDB) {
        return window.indexedDB;
      }
      if (typeof globalThis !== "undefined" && (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB) {
        return (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Opens or upgrades the IndexedDB database.
   */
  private async openDatabase(): Promise<void> {
    const factory = this.getFactory();
    if (!factory) {
      this.available = false;
      return;
    }

    return new Promise<void>((resolve) => {
      try {
        const request = factory.open(this.dbName, 1);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName, { keyPath: "id" });
            store.createIndex("timestamp", "timestamp", { unique: false });
            store.createIndex("priority", "priority", { unique: false });
          }
        };

        request.onsuccess = () => {
          this.db = request.result;
          this.available = true;

          // Handle unexpected connection loss
          this.db.onversionchange = () => {
            this.db?.close();
            this.db = null;
            this.available = false;
          };

          resolve();
        };

        request.onerror = () => {
          this.db = null;
          this.available = false;
          resolve();
        };

        request.onblocked = () => {
          this.available = false;
          resolve();
        };
      } catch {
        this.db = null;
        this.available = false;
        resolve();
      }
    });
  }
}
