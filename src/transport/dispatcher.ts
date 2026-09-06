/**
 * Resilient Network Dispatcher with Truncated Exponential Backoff.
 *
 * Coordinates asynchronous batch draining between EventQueue and the network:
 * 1. Drains events in configurable batch sizes with periodic timers.
 * 2. Employs truncated exponential backoff with full jitter on 5xx, 429, or network errors.
 * 3. Prunes poison pills on non-retryable 4xx client errors.
 * 4. Automatically recovers and flushes upon network reconnection ('online' listener).
 * 5. Binds to document visibility and pagehide lifecycle events for safe unload flushes.
 *
 * Zero runtime dependencies. Dual browser/edge runtime agnostic.
 */

import type { EventQueue } from "../queue/event-queue.js";
import type { DispatcherOptions, DispatchResult, QueuedEvent } from "../types.js";
import { computeFullJitterBackoff, DEFAULT_BASE_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS } from "./backoff.js";
import { bindUnloadFlush } from "./flusher.js";
import { transmitBatch } from "./transmitter.js";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BATCH_INTERVAL_MS = 500;
const DEFAULT_MAX_RETRIES = 10;

/**
 * Network dispatcher managing queue draining, backoff scheduling,
 * and page exit lifecycle synchronization.
 */
export class NetworkDispatcher {
  private readonly queue: EventQueue;
  private readonly endpoint: string;
  private readonly batchSize: number;
  private readonly batchIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;
  private readonly headers?: Record<string, string>;
  private readonly preferredTransport?: "beacon" | "keepalive" | "fetch";
  private readonly onSuccess?: (result: DispatchResult) => void;
  private readonly onError?: (error: Error, status?: number) => void;

  private isRunning = false;
  private isDraining = false;
  private retryAttempt = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private unbindUnload: (() => void) | null = null;
  private boundOnlineHandler: (() => void) | null = null;

  /**
   * Initializes a NetworkDispatcher bound to an EventQueue.
   *
   * @param queue - Durable backpressure event queue instance.
   * @param options - Configuration options specifying ingestion endpoint and intervals.
   */
  constructor(queue: EventQueue, options: DispatcherOptions) {
    if (!options.endpoint || typeof options.endpoint !== "string") {
      throw new Error("NetworkDispatcher requires a valid string endpoint URL");
    }

    this.queue = queue;
    this.endpoint = options.endpoint;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.batchIntervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.headers = options.headers;
    this.preferredTransport = options.preferredTransport;
    this.onSuccess = options.onSuccess;
    this.onError = options.onError;
  }

  /**
   * Starts periodic batch draining and binds network/lifecycle event listeners.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    // Bind unload flusher to modern browser visibility and pagehide events
    this.unbindUnload = bindUnloadFlush(async () => {
      await this.flush();
    });

    // Listen to network reconnection events
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.boundOnlineHandler = () => {
        this.retryAttempt = 0;
        this.scheduleDrain(0);
      };
      window.addEventListener("online", this.boundOnlineHandler);
    }

    // Schedule initial queue drain
    this.scheduleDrain(0);
  }

  /**
   * Stops periodic batch draining and unbinds all lifecycle event listeners.
   */
  stop(): void {
    this.isRunning = false;

    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }

    if (this.unbindUnload) {
      this.unbindUnload();
      this.unbindUnload = null;
    }

    if (
      typeof window !== "undefined" &&
      typeof window.removeEventListener === "function" &&
      this.boundOnlineHandler
    ) {
      window.removeEventListener("online", this.boundOnlineHandler);
      this.boundOnlineHandler = null;
    }
  }

  /**
   * Checks whether the client currently possesses active network connectivity.
   *
   * @returns True if connected or in an environment without navigator.onLine.
   */
  isOnline(): boolean {
    if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
      return navigator.onLine;
    }
    return true;
  }

  /**
   * Retrieves the current consecutive retry attempt count.
   *
   * @returns Number of consecutive failures currently registered.
   */
  getRetryAttempt(): number {
    return this.retryAttempt;
  }

  /**
   * Resets the exponential backoff attempt counter to zero.
   */
  resetBackoff(): void {
    this.retryAttempt = 0;
  }

  /**
   * Drains a single batch of events from the queue and transmits across the network.
   *
   * Handles HTTP response classifications:
   * - 2xx: Acknowledges and purges events, resets backoff counter.
   * - 4xx (non-429): Client error. Drops poison pills to prevent queue stalling.
   * - 429 / 5xx / Network error: Nacks events and schedules full jitter backoff sleep.
   *
   * @returns DispatchResult if a batch was processed, or null if queue was empty or busy.
   */
  async drain(): Promise<DispatchResult | null> {
    if (this.isDraining) {
      return null;
    }

    if (!this.isOnline()) {
      const delay = computeFullJitterBackoff(this.retryAttempt, this.baseBackoffMs, this.maxBackoffMs);
      this.scheduleDrain(delay);
      return null;
    }

    this.isDraining = true;

    try {
      const events: QueuedEvent[] = await this.queue.peek(this.batchSize);
      if (events.length === 0) {
        return null;
      }

      const ids = events.map((event) => event.id);

      const result = await transmitBatch(this.endpoint, events, {
        headers: this.headers,
        preferredTransport: this.preferredTransport,
      });

      if (result.success) {
        // Successful transmission: acknowledge and purge from storage
        await this.queue.ack(ids);
        this.retryAttempt = 0;
        this.onSuccess?.(result);

        // If there are more events waiting in queue, schedule rapid follow-up drain
        const remainingCount = await this.queue.count();
        if (remainingCount > 0 && this.isRunning) {
          this.scheduleDrain(0);
        } else if (this.isRunning) {
          this.scheduleDrain(this.batchIntervalMs);
        }

        return result;
      }

      // Transmission failed: classify response code
      const status = result.status;
      const isClientError = typeof status === "number" && status >= 400 && status < 500 && status !== 429;

      if (isClientError) {
        // Non-retryable client error (400, 401, 403, 404, 422).
        // Prune poison pills to prevent infinite retry loops.
        await this.queue.ack(ids);
        this.retryAttempt = 0;

        const error = result.error ?? new Error(`Non-retryable client error: HTTP ${status}`);
        this.onError?.(error, status);

        if (this.isRunning) {
          this.scheduleDrain(this.batchIntervalMs);
        }

        return result;
      }

      // Server error (5xx), Rate Limited (429), or Network error.
      // Negative acknowledge to release events back to queue.
      await this.queue.nack(ids);
      this.retryAttempt++;

      const error = result.error ?? new Error(`Retryable network error: HTTP ${status ?? "offline"}`);
      this.onError?.(error, status);

      const delay = computeFullJitterBackoff(
        this.retryAttempt,
        this.baseBackoffMs,
        this.maxBackoffMs
      );

      if (this.isRunning) {
        this.scheduleDrain(delay);
      }

      return result;
    } finally {
      this.isDraining = false;
    }
  }

  /**
   * Immediately flushes all queued events until the queue is exhausted.
   *
   * Frequently utilized during page exit (pagehide / visibilitychange)
   * or explicit application shutdown.
   *
   * @returns Array of DispatchResult for each processed batch.
   */
  async flush(): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];

    while (true) {
      const count = await this.queue.count();
      if (count === 0) {
        break;
      }

      const events = await this.queue.peek(this.batchSize);
      if (events.length === 0) {
        break;
      }

      const ids = events.map((event) => event.id);

      // Prioritize beacon or keepalive during emergency unload flush
      const result = await transmitBatch(this.endpoint, events, {
        headers: this.headers,
        preferredTransport: this.preferredTransport ?? "beacon",
      });

      results.push(result);

      if (result.success) {
        await this.queue.ack(ids);
      } else {
        // During an unload flush, if a dispatch fails, release and break
        await this.queue.nack(ids);
        break;
      }
    }

    return results;
  }

  /**
   * Internal scheduler registering a timeout callback for queue draining.
   *
   * @param delayMs - Delay in milliseconds before executing next drain.
   */
  private scheduleDrain(delayMs: number): void {
    if (!this.isRunning) {
      return;
    }

    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
    }

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.isRunning) {
        void this.drain();
      }
    }, Math.max(0, delayMs));
  }
}
