import type {
  AttributionModelType,
  AttributionOptions,
  AttributionResult,
  CustomerJourney
} from "../types";
import {
  firstTouchAttribution,
  lastNonDirectTouchAttribution,
  lastTouchAttribution
} from "./single-touch";
import {
  linearAttribution,
  positionBasedAttribution,
  timeDecayAttribution
} from "./multi-touch";
import {
  buildTransitionMatrix,
  calculateConversionProbability,
  markovAttribution,
  START_STATE,
  CONVERSION_STATE,
  NULL_STATE
} from "./markov";

export * from "../types";
export * from "./single-touch";
export * from "./multi-touch";
export * from "./markov";

/**
 * Universal facade function to calculate conversion attribution for an individual customer journey.
 * Dynamically routes to the requested attribution model strategy.
 *
 * Supported models:
 * - 'first-touch': 100% credit to the earliest touchpoint.
 * - 'last-touch': 100% credit to the final touchpoint preceding conversion.
 * - 'last-non-direct': 100% credit to the most recent non-direct touchpoint.
 * - 'linear': Equal distribution across all touchpoints (1 / n).
 * - 'time-decay': Exponential decay based on touchpoint age relative to conversion.
 * - 'position-based': U-shaped weighting (40% first, 40% last, 20% intermediate).
 * - 'markov': First-order Markov chain removal effect scoring.
 *
 * @param journey - The customer journey to evaluate.
 * @param model - The attribution model algorithm to execute.
 * @param options - Optional model-specific parameters (e.g. halfLifeDays, custom weights).
 * @returns The computed attribution result including channel weights and allocated credits.
 * @throws Error if an unrecognized model type is provided.
 */
export function calculateAttribution(
  journey: CustomerJourney,
  model: AttributionModelType,
  options?: AttributionOptions
): AttributionResult {
  switch (model) {
    case "first-touch":
      return firstTouchAttribution(journey);
    case "last-touch":
      return lastTouchAttribution(journey);
    case "last-non-direct":
      return lastNonDirectTouchAttribution(journey, options);
    case "linear":
      return linearAttribution(journey);
    case "time-decay":
      return timeDecayAttribution(journey, options);
    case "position-based":
      return positionBasedAttribution(journey, options);
    case "markov":
      return markovAttribution([journey]);
    default:
      throw new Error(`Unsupported attribution model: ${String(model)}`);
  }
}

/**
 * Calculates aggregate conversion attribution across a cohort of multiple customer journeys.
 *
 * For single-journey models ('first-touch', 'last-touch', 'linear', etc.), individual journey
 * results are computed and credits are aggregated across channels.
 * For the 'markov' model, the global state transition graph is built across all journeys simultaneously.
 *
 * @param journeys - Array of customer journeys representing the cohort.
 * @param model - The attribution model algorithm to execute.
 * @param options - Optional model-specific configuration.
 * @returns Aggregated attribution result with cohort-wide weights, credits, and total value.
 */
export function calculateCohortAttribution(
  journeys: CustomerJourney[],
  model: AttributionModelType,
  options?: AttributionOptions
): AttributionResult {
  if (model === "markov") {
    return markovAttribution(journeys);
  }

  const aggregateCredits: Record<string, number> = {};
  let aggregateTotalValue = 0;

  for (const journey of journeys) {
    const singleResult = calculateAttribution(journey, model, options);
    aggregateTotalValue += singleResult.totalValue;

    for (const ch in singleResult.credits) {
      aggregateCredits[ch] = (aggregateCredits[ch] ?? 0) + (singleResult.credits[ch] ?? 0);
    }
  }

  const aggregateWeights: Record<string, number> = {};
  if (aggregateTotalValue > 0) {
    for (const ch in aggregateCredits) {
      aggregateWeights[ch] = (aggregateCredits[ch] ?? 0) / aggregateTotalValue;
    }
  } else {
    const channelKeys = Object.keys(aggregateCredits);
    const uniform = channelKeys.length > 0 ? 1.0 / channelKeys.length : 0;
    for (const ch of channelKeys) {
      aggregateWeights[ch] = uniform;
    }
  }

  return {
    model,
    weights: aggregateWeights,
    credits: aggregateCredits,
    totalValue: aggregateTotalValue
  };
}
