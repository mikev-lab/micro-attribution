/**
 * Lightweight in-memory Mock IndexedDB engine for testing IndexedDBAdapter.
 */

export interface MockStoreRecord {
  id: string;
  timestamp: number;
  priority: string;
  [key: string]: unknown;
}

export class MockIDBCursor {
  private records: MockStoreRecord[];
  private index: number;

  private request: { onsuccess: (() => void) | null; result: MockIDBCursor | null };

  public constructor(
    records: MockStoreRecord[],
    request: { onsuccess: (() => void) | null; result: MockIDBCursor | null }
  ) {
    this.records = records;
    this.index = 0;
    this.request = request;
  }

  public get value(): MockStoreRecord {
    return this.records[this.index]!;
  }

  public continue(): void {
    this.index++;
    if (this.index < this.records.length) {
      this.request.result = this;
    } else {
      this.request.result = null;
    }
    queueMicrotask(() => {
      this.request.onsuccess?.();
    });
  }

  public hasMore(): boolean {
    return this.index < this.records.length;
  }
}

export class MockIDBIndex {
  private name: string;
  private keyPath: string;
  private store: MockIDBObjectStore;

  public constructor(name: string, keyPath: string, store: MockIDBObjectStore) {
    this.name = name;
    this.keyPath = keyPath;
    this.store = store;
  }

  public openCursor(_query?: unknown, direction: "next" | "prev" = "next"): {
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    result: MockIDBCursor | null;
  } {
    const all = Array.from(this.store.records.values());
    if (this.keyPath === "timestamp") {
      all.sort((a, b) => (direction === "next" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp));
    }

    const request = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      result: null as MockIDBCursor | null
    };

    const cursor = new MockIDBCursor(all, request);
    request.result = cursor.hasMore() ? cursor : null;

    queueMicrotask(() => {
      request.onsuccess?.();
    });

    return request;
  }
}

export class MockIDBObjectStore {
  public name: string;
  public keyPath: string;
  public records: Map<string, MockStoreRecord>;
  public indexes: Map<string, MockIDBIndex>;

  public constructor(name: string, keyPath: string) {
    this.name = name;
    this.keyPath = keyPath;
    this.records = new Map();
    this.indexes = new Map();
  }

  public createIndex(name: string, keyPath: string): MockIDBIndex {
    const index = new MockIDBIndex(name, keyPath, this);
    this.indexes.set(name, index);
    return index;
  }

  public index(name: string): MockIDBIndex {
    const idx = this.indexes.get(name);
    if (!idx) {
      throw new Error(`Index not found: ${name}`);
    }
    return idx;
  }

  public get(id: string): { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown } {
    const result = this.records.get(id) || null;
    const req = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      result
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  public put(record: MockStoreRecord): { onsuccess: (() => void) | null; onerror: (() => void) | null } {
    this.records.set(record.id, record);
    const req = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  public delete(id: string): { onsuccess: (() => void) | null; onerror: (() => void) | null } {
    this.records.delete(id);
    const req = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  public count(): { onsuccess: (() => void) | null; onerror: (() => void) | null; result: number } {
    const req = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      result: this.records.size
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  public clear(): { onsuccess: (() => void) | null; onerror: (() => void) | null } {
    this.records.clear();
    const req = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
}

export class MockIDBTransaction {
  public store: MockIDBObjectStore;
  public oncomplete: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;

  public constructor(store: MockIDBObjectStore) {
    this.store = store;
    queueMicrotask(() => {
      this.oncomplete?.();
    });
  }

  public objectStore(_name: string): MockIDBObjectStore {
    return this.store;
  }
}

export class MockIDBDatabase {
  public name: string;
  public stores: Map<string, MockIDBObjectStore> = new Map();
  public onversionchange: (() => void) | null = null;
  public objectStoreNames = {
    contains: (name: string) => this.stores.has(name)
  };

  public constructor(name: string) {
    this.name = name;
  }

  public createObjectStore(name: string, options: { keyPath: string }): MockIDBObjectStore {
    const store = new MockIDBObjectStore(name, options.keyPath);
    this.stores.set(name, store);
    return store;
  }

  public transaction(name: string, _mode: string): MockIDBTransaction {
    const store = this.stores.get(name);
    if (!store) {
      throw new Error(`ObjectStore not found: ${name}`);
    }
    return new MockIDBTransaction(store);
  }

  public close(): void {
    // Closed
  }
}

export class MockIDBFactory {
  public databases: Map<string, MockIDBDatabase> = new Map();

  public open(name: string, _version: number): {
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onupgradeneeded: (() => void) | null;
    onblocked: (() => void) | null;
    result: MockIDBDatabase;
  } {
    let db = this.databases.get(name);
    const isNew = !db;
    if (!db) {
      db = new MockIDBDatabase(name);
      this.databases.set(name, db);
    }

    const request = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
      onblocked: null as (() => void) | null,
      result: db
    };

    queueMicrotask(() => {
      if (isNew) {
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    });

    return request;
  }
}
