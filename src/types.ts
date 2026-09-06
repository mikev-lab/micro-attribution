/**
 * Core type definitions for micro-attribution telemetry and attribution engine.
 */

export type Channel = string;

export interface Touchpoint {
  /** Acquisition or interaction channel (e.g. 'paid_search', 'organic', 'email') */
  channel: Channel;
  /** Monotonic normalized timestamp in milliseconds */
  timestamp: number;
  /** Optional touchpoint value or weight multiplier */
  value?: number;
  /** Additional sanitized campaign metadata */
  metadata?: Record<string, string | number | boolean>;
}

export interface ConversionEvent {
  /** Unique conversion identifier */
  id: string;
  /** Total monetary or credit value of conversion */
  value: number;
  /** Timestamp of conversion event in milliseconds */
  timestamp: number;
  /** Optional conversion type or event name (e.g. 'purchase', 'signup') */
  name?: string;
  /** Additional sanitized properties */
  properties?: Record<string, string | number | boolean>;
}

export interface CustomerJourney {
  /** Anonymized daily visitor pseudonym token */
  visitorId: string;
  /** Chronologically ordered touchpoints */
  touchpoints: Touchpoint[];
  /** Associated conversion event if journey converted */
  conversion?: ConversionEvent;
}

export type AttributionModelType =
  | "first-touch"
  | "last-touch"
  | "last-non-direct"
  | "linear"
  | "time-decay"
  | "position-based"
  | "markov";

export interface AttributionWeights {
  [channel: string]: number;
}

export interface AttributionResult {
  model: AttributionModelType;
  weights: AttributionWeights;
  credits: Record<string, number>;
  totalValue: number;
}

export interface TimeDecayOptions {
  /** Half-life parameter in days (default 7 days) */
  halfLifeDays?: number;
}

export interface PositionBasedOptions {
  /** First touch weight fraction (default 0.40) */
  firstWeight?: number;
  /** Last touch weight fraction (default 0.40) */
  lastWeight?: number;
  /** Middle touches cumulative weight fraction (default 0.20) */
  middleWeight?: number;
}

export interface AttributionOptions extends TimeDecayOptions, PositionBasedOptions {
  /** Fallback channel when no non-direct channel is present (default 'direct') */
  directChannelName?: string;
}

export interface MarkovTransitionCounts {
  [fromState: string]: Record<string, number>;
}

export interface MarkovTransitionProbabilities {
  [fromState: string]: Record<string, number>;
}

export interface MarkovTransitionMatrix {
  /** List of all distinct states including (start), channels, (conversion), and (null) */
  states: string[];
  /** Distinct marketing channels excluding start and terminal states */
  channels: string[];
  /** Raw transition counts between states */
  counts: MarkovTransitionCounts;
  /** Normalized transition probabilities P(toState | fromState) */
  probabilities: MarkovTransitionProbabilities;
}

export interface ChannelRemovalEffect {
  channel: string;
  conversionProbabilityWithout: number;
  removalEffect: number;
  weight: number;
  credit: number;
}

export interface MarkovAttributionResult extends AttributionResult {
  model: "markov";
  baselineConversionProbability: number;
  removalEffects: Record<string, ChannelRemovalEffect>;
}

/**
 * Options for generating ephemeral daily visitor pseudonym tokens.
 */
export interface VisitorTokenOptions {
  /** Client IP address (automatically truncated to /24 or /48 prefix) */
  ip?: string;
  /** Client User-Agent string (will be normalized) */
  userAgent?: string;
  /** First-party origin or application hostname */
  origin?: string;
  /** Explicit reference date for daily epoch calculation (defaults to current date) */
  date?: Date;
  /** Optional server-side master secret pepper for HMAC keying */
  pepper?: string;
}

/**
 * Configuration options for PII scrubbing and payload sanitization.
 */
export interface SanitizerOptions {
  /** Additional custom parameter or key names to denylist */
  additionalDenylist?: string[];
  /** Replacement placeholder mask for redacted sensitive patterns (default '[REDACTED]') */
  redactionMask?: string;
  /** Handling behavior for denylisted keys: 'drop' deletes key, 'mask' replaces value */
  denylistAction?: "drop" | "mask";
  /** Maximum traversal depth for nested objects and arrays to prevent recursion overflow */
  maxDepth?: number;
}

/**
 * Priority tier for queued telemetry events.
 * High priority events (conversions, purchases, revenue) are preserved during backpressure eviction.
 */
export type EventPriority = "high" | "normal";

/**
 * Storage tier identifier.
 */
export type StorageTier = "indexeddb" | "localstorage" | "memory";

/**
 * Represents a durable telemetry record enqueued for dispatch.
 */
export interface QueuedEvent<T = Record<string, unknown>> {
  /** Unique monotonic event record identifier */
  id: string;
  /** Monotonic millisecond timestamp */
  timestamp: number;
  /** Eviction priority level ('high' or 'normal') */
  priority: EventPriority;
  /** Estimated serialized payload size in bytes */
  byteSize: number;
  /** Telemetry payload data */
  payload: T;
  /** Number of dispatch retry attempts */
  retryCount?: number;
}

/**
 * Common asynchronous CRUD contract implemented by all storage adapters.
 */
export interface StorageAdapter {
  /** Name of the underlying storage tier */
  readonly tier: StorageTier;
  /** Initialize database connections or storage structures */
  init(): Promise<void>;
  /** Retrieve a single event by ID */
  get(id: string): Promise<QueuedEvent | null>;
  /** Insert or update an event in storage */
  set(event: QueuedEvent): Promise<void>;
  /** Delete a single event by ID */
  delete(id: string): Promise<void>;
  /** Batch delete multiple events by ID */
  deleteMany(ids: string[]): Promise<void>;
  /** Peek at the oldest queued events up to limit without removing */
  peek(limit?: number): Promise<QueuedEvent[]>;
  /** Get total count of queued events */
  count(): Promise<number>;
  /** Clear all events from storage */
  clear(): Promise<void>;
  /** Check if the storage engine is currently available and functional */
  isAvailable(): Promise<boolean>;
  /** Close any active database connections or handles */
  close?(): Promise<void>;
}

/**
 * Options for configuring EventQueue backpressure and eviction limits.
 */
export interface EventQueueOptions {
  /** Maximum number of records before backpressure eviction triggers (default 1000) */
  maxEvents?: number;
  /** Maximum queue payload size in bytes before eviction triggers (default 2097152 = 2MB) */
  maxByteSize?: number;
  /** Custom storage adapter instance (defaults to adaptive storage factory) */
  storage?: StorageAdapter;
  /** Optional callback triggered when an event is dropped due to queue saturation */
  onDrop?: (event: QueuedEvent, reason: "count_limit" | "byte_limit") => void;
}

/**
 * Runtime telemetry metrics for EventQueue.
 */
export interface QueueStats {
  /** Current total number of queued events */
  eventCount: number;
  /** Estimated cumulative byte size of queued payloads */
  byteSize: number;
  /** Number of high-priority events currently queued */
  highPriorityCount: number;
  /** Cumulative count of events dropped due to backpressure since queue creation */
  droppedCount: number;
  /** Active storage tier name */
  storageTier: StorageTier;
}

/**
 * Configuration options for the adaptive storage factory.
 */
export interface AdaptiveStorageOptions {
  /** Explicitly prefer or force a specific storage tier */
  preferredTier?: StorageTier;
  /** Custom IndexedDB database name (default '__micro_attr_db') */
  dbName?: string;
  /** Custom IndexedDB object store name (default 'event_queue') */
  storeName?: string;
  /** Custom localStorage key (default '__micro_attr_queue__') */
  localStorageKey?: string;
}

/**
 * Transport protocol utilized to transmit telemetry payloads.
 * - 'beacon': Non-blocking browser daemon delivery via navigator.sendBeacon.
 * - 'keepalive': Asynchronous fetch with { keepalive: true } lifecycle survival.
 * - 'fetch': Standard HTTP POST via standard fetch API.
 */
export type TransportType = "beacon" | "keepalive" | "fetch";

/**
 * Options for transmitting a batch of events across the network.
 */
export interface TransmitOptions {
  /** Additional HTTP headers to include with the request */
  headers?: Record<string, string>;
  /** Preferred transport mechanism (auto-negotiates if omitted or unavailable) */
  preferredTransport?: TransportType;
}

/**
 * Detailed result of a batch network transmission.
 */
export interface DispatchResult {
  /** Whether the transmission was acknowledged by the server */
  success: boolean;
  /** The transport mechanism utilized for the dispatch */
  transport: TransportType;
  /** Number of events included in the dispatched batch */
  sentCount: number;
  /** HTTP response status code (e.g. 200, 429, 500) if available */
  status?: number;
  /** Error encountered during transmission if unsuccessful */
  error?: Error;
}

/**
 * Options for configuring NetworkDispatcher behavior and intervals.
 */
export interface DispatcherOptions {
  /** Ingestion server endpoint URL */
  endpoint: string;
  /** Secondary backup HTTP endpoint used if primary endpoint fails */
  fallbackEndpoint?: string;
  /** Maximum number of events to dispatch per batch (default 50) */
  batchSize?: number;
  /** Draining interval in milliseconds when queue is non-empty (default 500 ms) */
  batchIntervalMs?: number;
  /** Base exponential backoff interval in milliseconds (default 1000 ms) */
  baseBackoffMs?: number;
  /** Maximum backoff ceiling in milliseconds (default 30000 ms) */
  maxBackoffMs?: number;
  /** Maximum consecutive retry attempts before dropping or pausing (default 10) */
  maxRetries?: number;
  /** Additional HTTP headers to attach to every outgoing request */
  headers?: Record<string, string>;
  /** Preferred transport mechanism */
  preferredTransport?: TransportType;
  /** Optional callback invoked upon successful batch dispatch */
  onSuccess?: (result: DispatchResult) => void;
  /** Optional callback invoked upon failed batch dispatch */
  onError?: (error: Error, status?: number) => void;
}

/**
 * Computed retry delay parameters.
 */
export interface RetrySchedule {
  /** Current 0-indexed retry attempt count */
  attempt: number;
  /** Computed sleep interval in milliseconds including randomized jitter */
  delayMs: number;
}

/**
 * Normalized campaign and attribution tracking metadata extracted from URL and referrer.
 */
export interface CampaignInfo {
  /** Inferred marketing channel (e.g. 'organic_search', 'paid_search', 'social', 'direct', 'referral') */
  channel: string;
  /** Campaign source (e.g. 'google', 'newsletter', 'facebook') */
  source?: string;
  /** Campaign medium (e.g. 'cpc', 'email', 'organic', 'banner') */
  medium?: string;
  /** Campaign name */
  campaign?: string;
  /** Campaign search term or keyword */
  term?: string;
  /** Campaign content identifier for A/B testing */
  content?: string;
  /** Ad platform click identifier value (e.g. gclid, fbclid) */
  clickId?: string;
  /** Platform identifier type ('gclid', 'fbclid', 'msclkid', 'ttclid', etc.) */
  clickIdType?: string;
  /** Inbound document referrer URL */
  referrer?: string;
}

/**
 * Configuration for forwarding conversions to Google Analytics 4 Measurement Protocol.
 * Uses native zero-dependency HTTP requests to https://www.google-analytics.com/mp/collect.
 */
export interface GA4ForwardingOptions {
  /** Google Analytics 4 Measurement ID (e.g. 'G-XXXXXXXXXX') */
  measurementId: string;
  /** Google Analytics 4 API Secret generated in Admin > Data Streams > Measurement Protocol */
  apiSecret: string;
  /** Whether to forward pageviews in addition to conversions (default: false) */
  forwardPageviews?: boolean;
  /** Explicit client_id to attach to GA4 payloads (defaults to visitor token or event id) */
  clientId?: string;
  /** When true, dispatches to GA4 debug endpoint /debug/mp/collect for validation */
  debug?: boolean;
}

/**
 * Secondary redundancy configuration to ensure monetary conversions are never lost.
 */
export interface RedundancyOptions {
  /** Secondary backup HTTP endpoint used if the primary endpoint experiences an outage */
  fallbackEndpoint?: string;
  /** Optional zero-dependency GA4 Measurement Protocol bridge */
  ga4?: GA4ForwardingOptions;
  /** Optional callback invoked immediately whenever a high-priority conversion is recorded */
  onConversion?: (event: QueuedEvent) => Promise<void> | void;
}

/**
 * Configuration options for initializing the MicroAttribution client SDK.
 */
export interface ClientOptions {
  /** Target ingestion server endpoint URL */
  endpoint: string;
  /** Custom storage adapter (defaults to createAdaptiveStorage cascade: IDB -> LocalStorage -> Memory) */
  storage?: StorageAdapter;
  /** Preferred storage tier override ('indexeddb', 'localstorage', 'memory') */
  storageTier?: StorageTier;
  /** Maximum number of events to dispatch per network batch (default 50) */
  batchSize?: number;
  /** Draining interval in milliseconds when queue is non-empty (default 500 ms) */
  batchIntervalMs?: number;
  /** Base exponential backoff interval in milliseconds (default 1000 ms) */
  baseBackoffMs?: number;
  /** Maximum backoff ceiling in milliseconds (default 30000 ms) */
  maxBackoffMs?: number;
  /** Maximum consecutive retry attempts before pausing (default 10) */
  maxRetries?: number;
  /** Automatically record initial pageview on client init() (default true) */
  autoCapturePageview?: boolean;
  /** Automatically extract and attach campaign parameters from window location (default true) */
  autoCaptureCampaign?: boolean;
  /** Automatically classify inbound document referrer (default true) */
  autoCaptureReferrer?: boolean;
  /** Server-side or client pepper for daily salt visitor pseudonym hashing */
  saltPepper?: string;
  /** Client-side sample rate between 0.0 and 1.0 (default 1.0 = 100% telemetry capture) */
  sampleRate?: number;
  /** Additional HTTP headers attached to dispatch requests */
  headers?: Record<string, string>;
  /** Preferred transport mechanism ('beacon', 'keepalive', 'fetch') */
  preferredTransport?: TransportType;
  /** Optional secondary redundancy and failover configuration */
  redundancy?: RedundancyOptions;
  /** Enable diagnostic console logging */
  debug?: boolean;
}

/**
 * Request execution context captured by edge telemetry collectors.
 */
export interface EdgeContext {
  /** Masked client subnet IP (/24 for IPv4 or /48 for IPv6) */
  clientIp: string;
  /** Client User-Agent string */
  userAgent: string;
  /** Inbound request origin hostname */
  origin: string;
  /** Ephemeral daily rotating visitor token */
  visitorToken: string;
  /** Ingestion timestamp in milliseconds */
  timestamp: number;
}

/**
 * Options for configuring edge request collector behavior.
 */
export interface EdgeCollectorOptions {
  /** Allowed CORS origin string or validator function (default '*') */
  corsOrigin?: string | ((origin: string) => boolean);
  /** Master secret pepper for HMAC daily salt derivation */
  pepper?: string;
  /** Whether to truncate client IP addresses to /24 and /48 subnets (default true) */
  anonymizeIp?: boolean;
  /** Whether to apply deep recursive PII sanitization to incoming event payloads (default true) */
  sanitizePayloads?: boolean;
  /** Asynchronous batch persistence hook (e.g. database insert, queue forwarding, or MTA pipeline) */
  onBatch?: (events: QueuedEvent[], context: EdgeContext) => Promise<void> | void;
}

/**
 * Standard edge collector response structure.
 */
export interface IngestResult {
  /** Whether the batch ingestion was accepted */
  success: boolean;
  /** Number of events processed and ingested */
  count: number;
  /** Error or diagnostic message if applicable */
  message?: string;
}


