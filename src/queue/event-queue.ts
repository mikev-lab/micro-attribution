import type {
  EventPriority,
  EventQueueOptions,
  QueuedEvent,
  QueueStats,
  StorageAdapter
} from "../types";
import { estimateByteSize } from "../storage/adapter";
import { MemoryAdapter } from "../storage/memory";
import { MonotonicClock } from "../utils/clock";

/**
 * Default maximum number of events retained before backpressure eviction triggers.
 */
export const DEFAULT_MAX_EVENTS = 1000;

/**
 * Default maximum queue byte size (2 MB = 2,097,152 bytes).
 */
export const DEFAULT_MAX_BYTE_SIZE = 2 * 1024 * 1024;

/**
 * Durable telemetry EventQueue enforcing backpressure and priority-aware FIFO eviction.
 *
 * Guaranteed Invariants:
 * 1. Hard capacity caps: never exceeds maxEvents or maxByteSize.
 * 2. Priority preservation: normal events (pageviews, clicks) are evicted first during backpressure,
 *    protecting high-value conversion and revenue events from dropped telemetry.
 * 3. Exact monotonic ordering: timestamps and event IDs are generated monotonically.
 */
export class EventQueue {
  private readonly maxEvents: number;
  private readonly maxByteSize: number;
  private storage: StorageAdapter | null;
  private readonly onDrop?: (event: QueuedEvent, reason: "count_limit" | "byte_limit") => void;
  private readonly clock: MonotonicClock;

  /** Internal monotonic sequence counter for collision-free ID generation */
  private sequenceCounter: number;

  /** Cumulative cached byte size of all queued payloads */
  private currentByteSize: number;

  /** Total number of events dropped due to backpressure since creation */
  private droppedEventsCount: number;

  /** Initialization state */
  private initialized: boolean;

  /**
   * Constructs a new EventQueue instance.
   *
   * @param options Configuration options including capacity limits and storage adapter.
   */
  public constructor(options: EventQueueOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxByteSize = options.maxByteSize ?? DEFAULT_MAX_BYTE_SIZE;
    this.onDrop = options.onDrop;
    this.storage = options.storage ?? null;
    this.clock = new MonotonicClock();
    this.sequenceCounter = 0;
    this.currentByteSize = 0;
    this.droppedEventsCount = 0;
    this.initialized = false;
  }

  /**
   * Initializes the event queue and underlying storage adapter, hydrating size metrics.
   */
  public async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Resolve or initialize storage adapter
    if (!this.storage) {
      this.storage = new MemoryAdapter();
    }
    await this.storage.init();

    // Hydrate current byte size and state from existing records in storage
    const existing = await this.storage.peek();
    this.currentByteSize = 0;
    for (const item of existing) {
      this.currentByteSize += item.byteSize;
    }

    this.initialized = true;
  }

  /**
   * Enqueues a new telemetry payload into durable storage with backpressure protection.
   *
   * @param payload Telemetry data object.
   * @param priority Eviction priority ('high' for conversions, 'normal' for pageviews).
   * @param customId Optional explicit event ID.
   * @returns The persisted QueuedEvent record.
   */
  public async enqueue<T extends Record<string, unknown>>(
    payload: T,
    priority: EventPriority = "normal",
    customId?: string
  ): Promise<QueuedEvent<T>> {
    await this.ensureInitialized();

    const timestamp = this.clock.now();
    this.sequenceCounter += 1;
    const id = customId || `evt_${timestamp}_${this.sequenceCounter.toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const payloadBytes = estimateByteSize(payload);
    // Base metadata byte overhead for id, timestamp, priority, retryCount
    const recordBytes = payloadBytes + 80;

    const event: QueuedEvent<T> = {
      id,
      timestamp,
      priority,
      byteSize: recordBytes,
      payload,
      retryCount: 0
    };

    // Check if the single event itself exceeds maximum capacity
    if (recordBytes > this.maxByteSize) {
      this.droppedEventsCount += 1;
      this.onDrop?.(event as QueuedEvent, "byte_limit");
      return event;
    }

    // Enforce backpressure limits before writing to storage
    await this.enforceBackpressure(recordBytes);

    const storage = await this.ensureInitialized();

    // Persist event in storage with emergency quota protection
    try {
      await storage.set(event as QueuedEvent);
      this.currentByteSize += recordBytes;
    } catch (err) {
      const isQuota =
        (err instanceof Error &&
          (err.name === "QuotaExceededError" ||
            err.message.toLowerCase().includes("quota"))) ||
        (typeof DOMException !== "undefined" &&
          err instanceof DOMException &&
          err.name === "QuotaExceededError");

      if (isQuota) {
        // Emergency eviction of oldest normal priority item
        const all = await storage.peek();
        const victim = all.find((item) => item.priority === "normal") || all[0];
        if (victim) {
          await storage.delete(victim.id);
          this.currentByteSize = Math.max(0, this.currentByteSize - victim.byteSize);
          this.droppedEventsCount += 1;
          this.onDrop?.(victim, "byte_limit");

          // Retry write once after eviction
          try {
            await storage.set(event as QueuedEvent);
            this.currentByteSize += recordBytes;
            return event;
          } catch {
            this.droppedEventsCount += 1;
            this.onDrop?.(event as QueuedEvent, "byte_limit");
            return event;
          }
        }
      }
      throw err;
    }

    return event;
  }

  /**
   * Peeks at the oldest queued events up to limit without removing them from storage.
   *
   * @param limit Maximum number of records to retrieve.
   * @returns Chronologically ordered list of queued events.
   */
  public async peek(limit?: number): Promise<QueuedEvent[]> {
    const storage = await this.ensureInitialized();
    return storage.peek(limit);
  }

  /**
   * Acknowledges successfully transmitted events by permanently removing them from storage.
   *
   * @param ids Array of event IDs to remove.
   */
  public async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const storage = await this.ensureInitialized();

    // Deduct byte sizes of acknowledged items
    for (const id of ids) {
      const item = await storage.get(id);
      if (item) {
        this.currentByteSize = Math.max(0, this.currentByteSize - item.byteSize);
      }
    }

    await storage.deleteMany(ids);
  }

  /**
   * Negative acknowledgment: marks events as failed during dispatch and increments retry counter.
   *
   * @param ids Array of event IDs that failed dispatch.
   */
  public async nack(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const storage = await this.ensureInitialized();

    for (const id of ids) {
      const item = await storage.get(id);
      if (item) {
        item.retryCount = (item.retryCount || 0) + 1;
        await storage.set(item);
      }
    }
  }

  /**
   * Returns the total count of queued events currently stored.
   */
  public async size(): Promise<number> {
    const storage = await this.ensureInitialized();
    return storage.count();
  }

  /**
   * Alias for size(): returns total count of queued events currently stored.
   */
  public async count(): Promise<number> {
    return this.size();
  }

  /**
   * Returns the current estimated byte size of all queued payloads.
   */
  public getByteSize(): number {
    return this.currentByteSize;
  }

  /**
   * Retrieves runtime operational metrics and backpressure statistics.
   */
  public async stats(): Promise<QueueStats> {
    const storage = await this.ensureInitialized();
    const all = await storage.peek();

    let highCount = 0;
    let computedBytes = 0;
    for (const item of all) {
      if (item.priority === "high") {
        highCount += 1;
      }
      computedBytes += item.byteSize;
    }

    this.currentByteSize = computedBytes;

    return {
      eventCount: all.length,
      byteSize: this.currentByteSize,
      highPriorityCount: highCount,
      droppedCount: this.droppedEventsCount,
      storageTier: storage.tier
    };
  }

  /**
   * Clears all queued events and resets internal metrics.
   */
  public async clear(): Promise<void> {
    const storage = await this.ensureInitialized();
    await storage.clear();
    this.currentByteSize = 0;
    this.droppedEventsCount = 0;
  }

  /**
   * Internal guard to guarantee storage initialization before operations.
   */
  private async ensureInitialized(): Promise<StorageAdapter> {
    if (!this.initialized || !this.storage) {
      await this.init();
    }
    return this.storage!;
  }

  /**
   * Enforces capacity limits using priority-aware FIFO eviction.
   *
   * Eviction Algorithm:
   * 1. While currentCount + 1 > maxEvents OR currentByteSize + incomingBytes > maxByteSize:
   *    a. Search for the oldest 'normal' priority event.
   *    b. If found, evict it, decrement currentByteSize, increment droppedCount.
   *    c. If no 'normal' events exist (100% high-priority saturation), evict oldest 'high' event.
   */
  private async enforceBackpressure(incomingBytes: number): Promise<void> {
    const storage = await this.ensureInitialized();
    let currentCount = await storage.count();

    while (
      (currentCount + 1 > this.maxEvents || this.currentByteSize + incomingBytes > this.maxByteSize) &&
      currentCount > 0
    ) {
      const all = await storage.peek();
      if (all.length === 0) {
        break;
      }

      // First pass: locate oldest normal-priority event
      let victim = all.find((item) => item.priority === "normal");
      const reason: "count_limit" | "byte_limit" =
        currentCount + 1 > this.maxEvents ? "count_limit" : "byte_limit";

      // Second pass: if queue is 100% saturated with high priority, evict oldest high priority event
      if (!victim) {
        victim = all[0];
      }

      if (!victim) {
        break;
      }

      // Evict selected victim
      await storage.delete(victim.id);
      this.currentByteSize = Math.max(0, this.currentByteSize - victim.byteSize);
      this.droppedEventsCount += 1;
      currentCount -= 1;

      this.onDrop?.(victim, reason);
    }
  }
}
