import type {
  AttributionResult,
  CustomerJourney,
  PositionBasedOptions,
  TimeDecayOptions,
  Touchpoint
} from "../types";

/**
 * Sorts customer journey touchpoints chronologically by monotonic timestamp
 * without mutating the original array.
 *
 * @param journey - The customer journey containing touchpoints to sort.
 * @returns A shallow-copied array of touchpoints ordered by timestamp ascending.
 */
function getSortedTouchpoints(journey: CustomerJourney): Touchpoint[] {
  if (journey.touchpoints.length <= 1) {
    return journey.touchpoints;
  }
  return [...journey.touchpoints].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Linear Attribution:
 * Distributes conversion credit uniformly across all touchpoints in the journey.
 * Each touchpoint receives an equal share (1 / n) of total value.
 *
 * Mathematical formulation:
 * - w_i = 1 / n for all i in {1, ..., n}
 * - Credit(channel) = sum_{i: channel_i = channel} (w_i * totalValue)
 *
 * @param journey - The customer journey containing touchpoints and conversion data.
 * @returns The attribution result containing weights, allocated credits, and total value.
 */
export function linearAttribution(journey: CustomerJourney): AttributionResult {
  const totalValue = journey.conversion?.value ?? 0;
  const sorted = getSortedTouchpoints(journey);
  const n = sorted.length;

  if (n === 0) {
    return {
      model: "linear",
      weights: {},
      credits: {},
      totalValue
    };
  }

  const individualWeight = 1.0 / n;
  const weights: Record<string, number> = {};
  const credits: Record<string, number> = {};

  for (let i = 0; i < n; i++) {
    const ch = sorted[i]!.channel;
    weights[ch] = (weights[ch] ?? 0) + individualWeight;
  }

  for (const ch in weights) {
    credits[ch] = (weights[ch] ?? 0) * totalValue;
  }

  return {
    model: "linear",
    weights,
    credits,
    totalValue
  };
}

/**
 * Time-Decay Attribution:
 * Allocates exponentially higher weight to touchpoints that occurred closer in time
 * to the conversion event, parameterized by half-life lambda (default 7 days).
 *
 * Mathematical formulation:
 * - delta_t_i = max(0, t_C - t_i)
 * - raw_w_i = 2^(-delta_t_i / lambda) = exp(-ln(2) * delta_t_i / lambda)
 * - w_i = raw_w_i / sum_{j=1}^n raw_w_j
 *
 * @param journey - The customer journey containing touchpoints and conversion data.
 * @param options - Optional configuration specifying halfLifeDays (default 7 days).
 * @returns The attribution result containing weights, allocated credits, and total value.
 */
export function timeDecayAttribution(
  journey: CustomerJourney,
  options?: TimeDecayOptions
): AttributionResult {
  const totalValue = journey.conversion?.value ?? 0;
  const sorted = getSortedTouchpoints(journey);
  const n = sorted.length;

  if (n === 0) {
    return {
      model: "time-decay",
      weights: {},
      credits: {},
      totalValue
    };
  }

  const halfLifeDays = options?.halfLifeDays && options.halfLifeDays > 0 ? options.halfLifeDays : 7;
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  const ln2 = Math.LN2;

  // Reference conversion timestamp
  const conversionTimestamp =
    journey.conversion?.timestamp ?? sorted[sorted.length - 1]!.timestamp;

  // Pre-allocate raw weights array to prevent object allocations in loop
  const rawWeights = new Array<number>(n);
  let totalRawWeight = 0;

  for (let i = 0; i < n; i++) {
    const deltaMs = Math.max(0, conversionTimestamp - sorted[i]!.timestamp);
    // Raw decay: 2^(-delta / halfLife) = exp(-ln(2) * delta / halfLife)
    const raw = Math.exp((-ln2 * deltaMs) / halfLifeMs);
    rawWeights[i] = raw;
    totalRawWeight += raw;
  }

  const weights: Record<string, number> = {};
  const credits: Record<string, number> = {};

  if (totalRawWeight === 0) {
    // Graceful fallback to uniform distribution if floating point underflow occurs
    const uniform = 1.0 / n;
    for (let i = 0; i < n; i++) {
      const ch = sorted[i]!.channel;
      weights[ch] = (weights[ch] ?? 0) + uniform;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const ch = sorted[i]!.channel;
      const normalizedWeight = rawWeights[i]! / totalRawWeight;
      weights[ch] = (weights[ch] ?? 0) + normalizedWeight;
    }
  }

  for (const ch in weights) {
    credits[ch] = (weights[ch] ?? 0) * totalValue;
  }

  return {
    model: "time-decay",
    weights,
    credits,
    totalValue
  };
}

/**
 * Position-Based (U-Shaped) Attribution:
 * Assigns heavy weight to the first (discovery) and last (closing) touchpoints (default 40% each),
 * and distributes the remaining weight (default 20%) uniformly across intermediate touches.
 *
 * Mathematical formulation (for n >= 3):
 * - w_1 = alpha (default 0.40)
 * - w_n = beta (default 0.40)
 * - w_i = gamma / (n - 2) for 1 < i < n (default gamma = 0.20)
 *
 * Boundary handling:
 * - n = 1: w_1 = 1.0
 * - n = 2: w_1 = 0.5, w_2 = 0.5
 *
 * @param journey - The customer journey containing touchpoints and conversion data.
 * @param options - Optional custom weighting parameters (firstWeight, lastWeight, middleWeight).
 * @returns The attribution result containing weights, allocated credits, and total value.
 */
export function positionBasedAttribution(
  journey: CustomerJourney,
  options?: PositionBasedOptions
): AttributionResult {
  const totalValue = journey.conversion?.value ?? 0;
  const sorted = getSortedTouchpoints(journey);
  const n = sorted.length;

  if (n === 0) {
    return {
      model: "position-based",
      weights: {},
      credits: {},
      totalValue
    };
  }

  const weights: Record<string, number> = {};
  const credits: Record<string, number> = {};

  // Boundary condition 1: Single touchpoint gets 100%
  if (n === 1) {
    const ch = sorted[0]!.channel;
    weights[ch] = 1.0;
    credits[ch] = totalValue;
    return { model: "position-based", weights, credits, totalValue };
  }

  // Boundary condition 2: Two touchpoints split evenly (50% / 50%)
  if (n === 2) {
    const chFirst = sorted[0]!.channel;
    const chLast = sorted[1]!.channel;
    weights[chFirst] = (weights[chFirst] ?? 0) + 0.5;
    weights[chLast] = (weights[chLast] ?? 0) + 0.5;
    for (const ch in weights) {
      credits[ch] = (weights[ch] ?? 0) * totalValue;
    }
    return { model: "position-based", weights, credits, totalValue };
  }

  // Generalized weights normalization
  let alpha = options?.firstWeight ?? 0.40;
  let beta = options?.lastWeight ?? 0.40;
  let gamma = options?.middleWeight ?? 0.20;
  const paramSum = alpha + beta + gamma;

  if (paramSum > 0) {
    alpha /= paramSum;
    beta /= paramSum;
    gamma /= paramSum;
  } else {
    alpha = 0.40;
    beta = 0.40;
    gamma = 0.20;
  }

  const middleWeightPerTouch = gamma / (n - 2);

  for (let i = 0; i < n; i++) {
    const ch = sorted[i]!.channel;
    let w = 0;
    if (i === 0) {
      w = alpha;
    } else if (i === n - 1) {
      w = beta;
    } else {
      w = middleWeightPerTouch;
    }
    weights[ch] = (weights[ch] ?? 0) + w;
  }

  for (const ch in weights) {
    credits[ch] = (weights[ch] ?? 0) * totalValue;
  }

  return {
    model: "position-based",
    weights,
    credits,
    totalValue
  };
}
