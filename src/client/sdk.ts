/**
 * MicroAttribution Browser Telemetry Client SDK.
 *
 * Provides an embeddable, zero-dependency client surface for privacy-preserving
 * touchpoint capture, cookieless sessionization, and unload-safe delivery.
 *
 * Integrates:
 * - Adaptive 3-tier storage (IndexedDB -> LocalStorage -> Memory)
 * - Capacity-bounded backpressure event queue with priority-aware FIFO eviction
 * - Ephemeral daily rotating visitor tokenization
 * - Network dispatcher with truncated exponential backoff and unload flushing
 *
 * Zero runtime dependencies. Target bundle budget < 2.5 KB min+gzip.
 */

import { generateVisitorToken } from "../privacy/hasher.js";
import { EventQueue } from "../queue/event-queue.js";
import { createAdaptiveStorage } from "../storage/factory.js";
import { NetworkDispatcher } from "../transport/dispatcher.js";
import type {
  ClientOptions,
  DispatchResult,
  QueuedEvent,
  QueueStats,
} from "../types.js";
import { clock } from "../utils/clock.js";
import { extractCampaignMetadata } from "./campaign.js";

/**
 * Main telemetry client coordinating touchpoints, queueing, and network delivery.
 */
export class MicroAttribution {
  private static instance: MicroAttribution | null = null;

  private readonly options: ClientOptions;
  private readonly queue: EventQueue;
  private readonly dispatcher: NetworkDispatcher;
  private visitorToken = "";
  private isInitialized = false;

  /**
   * Initializes a MicroAttribution client instance.
   *
   * @param options - Configuration options for endpoint, storage, and batching.
   */
  constructor(options: ClientOptions) {
    if (!options.endpoint) {
      throw new Error("MicroAttribution client requires a target 'endpoint' URL");
    }

    this.options = {
      batchSize: 50,
      batchIntervalMs: 500,
      baseBackoffMs: 1000,
      maxBackoffMs: 30000,
      maxRetries: 10,
      autoCapturePageview: true,
      autoCaptureCampaign: true,
      sampleRate: 1.0,
      ...options,
    };

    // If storage is not explicitly provided, EventQueue will initialize with adaptive storage
    this.queue = new EventQueue({
      storage: options.storage,
    });

    this.dispatcher = new NetworkDispatcher(this.queue, {
      endpoint: this.options.endpoint,
      batchSize: this.options.batchSize,
      batchIntervalMs: this.options.batchIntervalMs,
      baseBackoffMs: this.options.baseBackoffMs,
      maxBackoffMs: this.options.maxBackoffMs,
      maxRetries: this.options.maxRetries,
      headers: this.options.headers,
      preferredTransport: this.options.preferredTransport,
    });
  }

  /**
   * Static factory initializing the singleton client instance.
   *
   * @param options - Client configuration options.
   * @returns Initialized MicroAttribution instance.
   */
  public static async init(options: ClientOptions): Promise<MicroAttribution> {
    const client = new MicroAttribution(options);
    await client.init();
    MicroAttribution.instance = client;
    return client;
  }

  /**
   * Retrieves the currently active singleton client instance, if initialized.
   */
  public static getInstance(): MicroAttribution | null {
    return MicroAttribution.instance;
  }

  /**
   * Asynchronously establishes storage adapters, derives daily visitor token,
   * starts dispatcher draining, and captures initial pageview.
   */
  public async init(): Promise<this> {
    if (this.isInitialized) {
      return this;
    }

    // If storage adapter was not supplied, mount adaptive storage tier
    if (!this.options.storage) {
      const adaptiveStorage = await createAdaptiveStorage();
      await (this.queue as unknown as { initStorage?: (s: unknown) => Promise<void> }).initStorage?.(adaptiveStorage);
    }

    // Generate ephemeral daily visitor pseudonym token
    try {
      this.visitorToken = await generateVisitorToken({
        pepper: this.options.saltPepper,
      });
    } catch {
      // In constrained environments where Web Crypto might fail, fallback to empty token
      this.visitorToken = "";
    }

    // Start network dispatcher batch processing
    this.dispatcher.start();
    this.isInitialized = true;

    // Automatically record initial landing pageview if enabled
    if (this.options.autoCapturePageview !== false) {
      await this.pageview();
    }

    return this;
  }

  /**
   * Records a pageview touchpoint event.
   *
   * Automatically attaches extracted campaign attributes and platform click IDs.
   *
   * @param path - Optional custom URL path (defaults to window.location.pathname).
   * @param metadata - Optional custom payload metadata.
   * @returns QueuedEvent or null if dropped by sampling rate.
   */
  public async pageview(
    path?: string,
    metadata?: Record<string, unknown>
  ): Promise<QueuedEvent | null> {
    if (!this.shouldSample()) {
      return null;
    }

    const currentPath =
      path ??
      (typeof window !== "undefined" && window.location ? window.location.pathname : "/");

    const campaign =
      this.options.autoCaptureCampaign !== false
        ? extractCampaignMetadata()
        : undefined;

    const payload: Record<string, unknown> = {
      type: "pageview",
      path: currentPath,
      channel: campaign?.channel ?? "direct",
      campaign,
      visitorToken: this.visitorToken,
      ...(metadata ?? {}),
    };

    const event = await this.queue.enqueue(payload, "normal");
    return event;
  }

  /**
   * Records an explicit custom touchpoint event.
   *
   * @param channel - Marketing channel identifier (e.g. 'paid_search', 'email', 'social').
   * @param metadata - Custom attributes associated with the touchpoint.
   * @returns QueuedEvent or null if dropped by sampling rate.
   */
  public async touchpoint(
    channel: string,
    metadata?: Record<string, unknown>
  ): Promise<QueuedEvent | null> {
    if (!this.shouldSample()) {
      return null;
    }

    const payload: Record<string, unknown> = {
      type: "touchpoint",
      channel,
      visitorToken: this.visitorToken,
      timestamp: clock.now(),
      ...(metadata ?? {}),
    };

    const event = await this.queue.enqueue(payload, "normal");
    return event;
  }

  /**
   * Records a terminal conversion event.
   *
   * Conversions are assigned 'high' priority to guarantee preservation
   * during backpressure eviction and immediately trigger a queue flush.
   *
   * @param name - Conversion event name (e.g. 'purchase', 'signup', 'subscription').
   * @param value - Monetary conversion value or credit weighting (e.g. 99.99).
   * @param metadata - Transaction details (e.g. transactionId, currency, items).
   * @returns High-priority QueuedEvent.
   */
  public async conversion(
    name: string,
    value: number,
    metadata?: Record<string, unknown>
  ): Promise<QueuedEvent | null> {
    // Conversions strictly bypass sample rate to preserve financial revenue metrics
    const payload: Record<string, unknown> = {
      type: "conversion",
      name,
      value: Math.max(0, Number.isFinite(value) ? value : 0),
      visitorToken: this.visitorToken,
      timestamp: clock.now(),
      ...(metadata ?? {}),
    };

    const event = await this.queue.enqueue(payload, "high");

    // Trigger immediate rapid drain for urgent conversion dispatch
    void this.dispatcher.drain();

    return event;
  }

  /**
   * Immediately flushes all queued events to the ingestion endpoint.
   *
   * @returns Array of DispatchResult for each transmitted batch.
   */
  public async flush(): Promise<DispatchResult[]> {
    return this.dispatcher.flush();
  }

  /**
   * Halts network draining timers and unbinds browser unload listeners.
   */
  public stop(): void {
    this.dispatcher.stop();
    this.isInitialized = false;
  }

  /**
   * Retrieves operational metrics and backpressure telemetry from the queue.
   */
  public async getStats(): Promise<QueueStats> {
    return this.queue.stats();
  }

  /**
   * Retrieves the underlying EventQueue instance.
   */
  public getQueue(): EventQueue {
    return this.queue;
  }

  /**
   * Retrieves the underlying NetworkDispatcher instance.
   */
  public getDispatcher(): NetworkDispatcher {
    return this.dispatcher;
  }

  /**
   * Evaluates whether a non-critical event passes client sampling rate.
   */
  private shouldSample(): boolean {
    const rate = this.options.sampleRate ?? 1.0;
    if (rate >= 1.0) {
      return true;
    }
    if (rate <= 0.0) {
      return false;
    }
    return Math.random() < rate;
  }
}
