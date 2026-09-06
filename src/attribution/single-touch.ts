import type { AttributionResult, CustomerJourney, Touchpoint } from "../types";

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
 * First-Touch Attribution (FTA):
 * Assigns 100% of conversion credit to the very first recorded touchpoint in the journey.
 *
 * Mathematical formulation:
 * - w_1 = 1.0
 * - w_i = 0.0 for i > 1
 *
 * @param journey - The customer journey containing touchpoints and conversion data.
 * @returns The attribution result containing weights, allocated credits, and total value.
 */
export function firstTouchAttribution(journey: CustomerJourney): AttributionResult {
  const totalValue = journey.conversion?.value ?? 0;
  const sorted = getSortedTouchpoints(journey);

  if (sorted.length === 0) {
    return {
      model: "first-touch",
      weights: {},
      credits: {},
      totalValue
    };
  }

  const firstTouch = sorted[0]!;
  const channel = firstTouch.channel;

  return {
    model: "first-touch",
    weights: { [channel]: 1.0 },
    credits: { [channel]: totalValue },
    totalValue
  };
}

/**
 * Last-Touch Attribution (LTA):
 * Assigns 100% of conversion credit to the final recorded touchpoint preceding conversion.
 *
 * Mathematical formulation:
 * - w_n = 1.0
 * - w_i = 0.0 for i < n
 *
 * @param journey - The customer journey containing touchpoints and conversion data.
 * @returns The attribution result containing weights, allocated credits, and total value.
 */
export function lastTouchAttribution(journey: CustomerJourney): AttributionResult {
  const totalValue = journey.conversion?.value ?? 0;
  const sorted = getSortedTouchpoints(journey);

  if (sorted.length === 0) {
    return {
      model: "last-touch",
      weights: {},
      credits: {},
      totalValue
    };
  }

  const lastTouch = sorted[sorted.length - 1]!;
  const channel = lastTouch.channel;

  return {
    model: "last-touch",
    weights: { [channel]: 1.0 },
    credits: { [channel]: totalValue },
    totalValue
  };
}

/**
 * Last Non-Direct Touch Attribution:
 * Assigns 100% of conversion credit to the most recent touchpoint whose channel
 * is not 'direct'. If all recorded touchpoints are direct, falls back to the final touchpoint.
 *
 * Mathematical formulation:
 * - i* = max { i in {1, ..., n} | channel_i != 'direct' }
 * - w_i* = 1.0
 * - If no non-direct touchpoint exists, w_n = 1.0
 *
 * @param journey - The customer journey containing touchpoints and conversion data.
 * @param options - Optional configuration including custom direct channel name.
 * @returns The attribution result containing weights, allocated credits, and total value.
 */
export function lastNonDirectTouchAttribution(
  journey: CustomerJourney,
  options?: { directChannelName?: string }
): AttributionResult {
  const totalValue = journey.conversion?.value ?? 0;
  const sorted = getSortedTouchpoints(journey);
  const directName = (options?.directChannelName ?? "direct").toLowerCase();

  if (sorted.length === 0) {
    return {
      model: "last-non-direct",
      weights: {},
      credits: {},
      totalValue
    };
  }

  // Scan backwards from most recent to oldest for the latest non-direct touchpoint
  let selectedTouch = sorted[sorted.length - 1]!;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const touch = sorted[i]!;
    if (touch.channel.toLowerCase() !== directName) {
      selectedTouch = touch;
      break;
    }
  }

  const channel = selectedTouch.channel;

  return {
    model: "last-non-direct",
    weights: { [channel]: 1.0 },
    credits: { [channel]: totalValue },
    totalValue
  };
}
