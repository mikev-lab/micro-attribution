/**
 * Network Transport, Backoff Engine & Lifecycle Delivery Module.
 *
 * Provides offline-resilient event dispatching, truncated exponential backoff with full jitter,
 * and page exit lifecycle synchronization.
 *
 * Zero runtime dependencies. Dual browser/edge runtime agnostic.
 */

export {
  computeExponentialBackoff,
  computeFullJitterBackoff,
  parseRetryAfterHeader,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
} from "./backoff.js";

export { transmitBatch } from "./transmitter.js";
export { bindUnloadFlush } from "./flusher.js";
export { NetworkDispatcher } from "./dispatcher.js";
