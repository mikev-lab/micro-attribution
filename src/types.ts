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
