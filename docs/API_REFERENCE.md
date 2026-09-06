# Complete API Reference

This document provides exhaustive documentation for all public modules, classes, interfaces, and helper functions exposed by `micro-attribution`.

---

## Subpath Package Summary

| Subpath | Description | Core Exports |
| :--- | :--- | :--- |
| `micro-attribution/client` | High-level browser tracking SDK | `MicroAttribution`, `extractCampaignMetadata`, `classifyReferrer` |
| `micro-attribution/edge` | Universal serverless edge collector | `handleEdgeRequest` |
| `micro-attribution/attribution` | Multi-touch attribution modeling engine | `calculateAttribution`, `calculateCohortAttribution` |
| `micro-attribution/privacy` | Cryptographic hasher, IP masking, PII scrubber | `generateVisitorToken`, `truncateIp`, `sanitizePayload` |
| `micro-attribution/storage` | 3-tier persistence cascade | `createAdaptiveStorage`, `IndexedDBAdapter`, `LocalStorageAdapter`, `MemoryAdapter` |
| `micro-attribution/queue` | Backpressure event queue | `EventQueue` |
| `micro-attribution/transport` | Network dispatcher and unload flusher | `NetworkDispatcher`, `transmitBatch`, `bindUnloadFlush`, `computeFullJitterBackoff` |

---

## 1. Client SDK (`micro-attribution/client`)

### `MicroAttribution`
The primary client-side telemetry class for web applications.

#### Constructor
```typescript
new MicroAttribution(options: ClientOptions)
```

#### `ClientOptions` Interface
- `endpoint: string` (required): Full HTTP URL of the ingestion endpoint.
- `sampleRate?: number` (default: `1.0`): Sampling fraction from `0.0` to `1.0` for normal pageviews. Conversions always bypass sampling.
- `autoCaptureCampaign?: boolean` (default: `true`): Automatically extracts UTM tags and platform click IDs from `window.location.search`.
- `autoCaptureReferrer?: boolean` (default: `true`): Automatically categorizes `document.referrer` into marketing channels.
- `storageTier?: 'indexeddb' | 'localstorage' | 'memory'`: Preferred storage tier override.
- `batchSize?: number` (default: `50`): Maximum events per HTTP dispatch batch.
- `batchIntervalMs?: number` (default: `500`): Draining interval in milliseconds.
- `debug?: boolean` (default: `false`): Enables console diagnostic logging.

#### Methods
- `init(): Promise<void>`: Initializes storage, registers unload listeners, and captures campaign metadata.
- `pageview(path?: string, metadata?: Record<string, unknown>): Promise<QueuedEvent | null>`: Records a pageview touchpoint. Subject to `sampleRate`.
- `touchpoint(action: string, metadata?: Record<string, unknown>, priority?: 'normal' | 'high'): Promise<QueuedEvent>`: Records a custom interaction.
- `conversion(name: string, data: { value?: number; revenue?: number; currency?: string; orderId?: string }): Promise<QueuedEvent>`: Records a monetary conversion. Always recorded with `priority: 'high'` and bypasses sampling.
- `flush(): Promise<DispatchResult[]>`: Immediately flushes all queued events to the server.
- `stop(): void`: Stops periodic background draining and unbinds all window lifecycle listeners.
- `getStats(): Promise<QueueStats>`: Returns operational metrics (event count, byte size, dropped events).

---

## 2. Universal Edge Collector (`micro-attribution/edge`)

### `handleEdgeRequest`
Standard Fetch API request handler (`Request -> Promise<Response>`).

```typescript
function handleEdgeRequest(
  request: Request,
  options?: EdgeCollectorOptions
): Promise<Response>
```

#### `EdgeCollectorOptions` Interface
- `saltSecret?: string`: Secret key combined with UTC date for daily rotating visitor tokenization.
- `allowedOrigins?: string[]` (default: `['*']`): Allowed origins for CORS headers.
- `maxBatchSize?: number` (default: `100`): Maximum acceptable events in a single batch.
- `onBatch?: (events: QueuedEvent[], context: EdgeContext) => Promise<void> | void`: Callback invoked with sanitized events for database insertion.

#### `EdgeContext` Interface
- `clientIp: string`: Masked client IP address (/24 IPv4, /48 IPv6).
- `userAgent: string`: Client User-Agent string.
- `visitorToken: string`: Irreversible, daily rotating HMAC-SHA256 pseudonym.
- `timestamp: number`: Edge receipt timestamp.

---

## 3. Attribution Models (`micro-attribution/attribution`)

### `calculateAttribution`
Calculates attribution for an individual customer journey.

```typescript
function calculateAttribution(
  journey: CustomerJourney,
  model: AttributionModelType,
  options?: AttributionOptions
): AttributionResult
```

#### Parameters
- `journey: CustomerJourney`: The customer journey containing touchpoints and conversion data.
- `model: AttributionModelType`: One of `'first-touch'`, `'last-touch'`, `'last-non-direct'`, `'linear'`, `'time-decay'`, `'position-based'`, `'markov'`.
- `options?: AttributionOptions`:
  - `halfLifeDays?: number` (default: `7`): Half-life duration for `'time-decay'`.
  - `positionWeights?: { first: number; middle: number; last: number }`: Custom weights for `'position-based'`.
  - `directChannels?: string[]`: Custom direct channel aliases for `'last-non-direct'`.

#### `AttributionResult` Return Object
- `model: AttributionModelType`: The model evaluated.
- `weights: Record<string, number>`: Normalized fractional credit per channel (summing to 1.0).
- `credits: Record<string, number>`: Absolute monetary value allocated to each channel.
- `totalValue: number`: Total monetary conversion value preserved.

### `calculateCohortAttribution`
Calculates aggregated attribution across a collection of multiple customer journeys.

```typescript
function calculateCohortAttribution(
  journeys: CustomerJourney[],
  model: AttributionModelType,
  options?: AttributionOptions
): AttributionResult
```

---

## 4. Privacy & Sanitization (`micro-attribution/privacy`)

### `truncateIp(ip: string): string`
Applies statutory subnet masking to IP addresses:
- IPv4: Masks final octet to zero (`192.168.1.100 -> 192.168.1.0/24`).
- IPv6: Retains the first 48 bits, zeroing the remaining 80 bits (`2001:db8:85a3:: -> 2001:db8:85a3::/48`).

### `generateVisitorToken(ip: string, userAgent: string, salt: string): Promise<string>`
Calculates an irreversible, 64-character hexadecimal SHA-256 / HMAC-SHA256 pseudonym from client IP, User-Agent, and ephemeral salt.

### `sanitizePayload<T>(payload: T): T`
Recursively sanitizes telemetry objects:
- Removes denylisted keys (`password`, `ssn`, `token`, `secret`, `credit_card`).
- Redacts regex patterns matching emails, 13 to 19 digit payment card PANs, and SSNs.
- Protected marketing parameters (`utm_*`, `gclid`, `fbclid`, etc.) are preserved.
- Circular references are detected and handled without stack overflow.

---

## 5. Storage Hierarchy (`micro-attribution/storage`)

### `createAdaptiveStorage(options?: AdaptiveStorageOptions): Promise<StorageAdapter>`
Automatically probes runtime capabilities and returns the most durable functional adapter:
`IndexedDBAdapter` -> `LocalStorageAdapter` -> `MemoryAdapter`.

### `IndexedDBAdapter`
Native browser IndexedDB adapter with transactional isolation and a cursor index on `timestamp`.

### `LocalStorageAdapter`
Synchronous fallback adapter with automatic corrupted record pruning and `QuotaExceededError` detection.

### `MemoryAdapter`
Volatile in-memory adapter designed for Web Workers, SSR contexts, and serverless edge runtimes.

---

## 6. Backpressure Event Queue (`micro-attribution/queue`)

### `EventQueue`
Durable event queue managing storage, backpressure, and priority-aware eviction.

#### Methods
- `enqueue(payload: Record<string, unknown>, priority?: 'normal' | 'high'): Promise<QueuedEvent>`: Persists an event. Drops oldest normal events if capacity is exceeded.
- `peek(limit?: number): Promise<QueuedEvent[]>`: Retrieves oldest events in chronological order without deletion.
- `ack(ids: string[]): Promise<void>`: Permanently removes successfully transmitted events.
- `nack(ids: string[]): Promise<void>`: Increments retry counts for events that failed dispatch.
- `count(): Promise<number>`: Total number of queued events.
- `getByteSize(): number`: Estimated cumulative byte size of queued records.
- `stats(): Promise<QueueStats>`: Comprehensive runtime statistics.
- `clear(): Promise<void>`: Purges all stored records and resets size metrics.

---

## 7. Network Dispatcher & Transport (`micro-attribution/transport`)

### `NetworkDispatcher`
Asynchronous coordinator for queue draining, HTTP status classification, and exponential backoff.

#### Methods
- `drain(): Promise<DispatchResult | null>`: Transmits a single batch across the network.
- `flush(): Promise<DispatchResult[]>`: Immediately drains all batches until queue is exhausted.
- `stop(): void`: Unbinds lifecycle listeners and cancels active timers.
- `getRetryAttempt(): number`: Returns consecutive failed retry count.
- `resetBackoff(): void`: Resets retry counter to zero.

### `transmitBatch(endpoint: string, events: QueuedEvent[], options?: TransmitOptions): Promise<DispatchResult>`
Transmits a batch with automatic transport negotiation: `navigator.sendBeacon` -> `fetch` with `keepalive: true` -> standard `fetch`.

### `bindUnloadFlush(flushFn: () => Promise<void>): () => void`
Binds page exit handlers to `visibilitychange` (`hidden`) and `pagehide`. Returns an unbind cleanup function.

### `computeFullJitterBackoff(attempt: number, baseMs?: number, maxMs?: number): number`
Computes randomized sleep interval: $t_{\text{sleep}} \sim \mathcal{U}(0, \min(M, B \cdot 2^r))$.
