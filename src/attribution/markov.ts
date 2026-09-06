import type {
  ChannelRemovalEffect,
  CustomerJourney,
  MarkovAttributionResult,
  MarkovTransitionMatrix
} from "../types";

export const START_STATE = "(start)";
export const CONVERSION_STATE = "(conversion)";
export const NULL_STATE = "(null)";

/**
 * Builds the empirical state transition count and probability matrix from an array of customer journeys.
 *
 * State space components:
 * - Synthetic origin: '(start)'
 * - Transient marketing channels: e.g. 'paid_search', 'organic', 'email'
 * - Absorbing terminals: '(conversion)' and '(null)'
 *
 * @param journeys - Array of historical customer journeys (both converted and unconverted).
 * @returns Normalized Markov transition matrix containing state lists, counts, and probabilities.
 */
export function buildTransitionMatrix(journeys: CustomerJourney[]): MarkovTransitionMatrix {
  const channelSet = new Set<string>();
  const counts: Record<string, Record<string, number>> = {};

  /**
   * Records a single state-to-state transition count.
   */
  function addTransition(from: string, to: string) {
    if (!counts[from]) {
      counts[from] = {};
    }
    counts[from][to] = (counts[from][to] ?? 0) + 1;
  }

  for (const journey of journeys) {
    const isConverted = Boolean(journey.conversion && journey.conversion.value >= 0);
    const terminalState = isConverted ? CONVERSION_STATE : NULL_STATE;
    const touchpoints = journey.touchpoints;

    // Handle empty journey (immediate conversion or drop from start)
    if (touchpoints.length === 0) {
      addTransition(START_STATE, terminalState);
      continue;
    }

    // Step 1: Transition from synthetic (start) state to first touchpoint
    const firstChannel = touchpoints[0]!.channel;
    channelSet.add(firstChannel);
    addTransition(START_STATE, firstChannel);

    // Step 2: Intermediate transitions between adjacent touchpoints
    for (let i = 0; i < touchpoints.length - 1; i++) {
      const fromCh = touchpoints[i]!.channel;
      const toCh = touchpoints[i + 1]!.channel;
      channelSet.add(fromCh);
      channelSet.add(toCh);
      addTransition(fromCh, toCh);
    }

    // Step 3: Terminal transition from last touchpoint to conversion or null
    const lastChannel = touchpoints[touchpoints.length - 1]!.channel;
    channelSet.add(lastChannel);
    addTransition(lastChannel, terminalState);
  }

  const channels = Array.from(channelSet).sort();
  const states = [START_STATE, ...channels, CONVERSION_STATE, NULL_STATE];

  // Step 4: Normalize empirical counts into transition probabilities P(toState | fromState)
  const probabilities: Record<string, Record<string, number>> = {};

  for (const fromState of [START_STATE, ...channels]) {
    probabilities[fromState] = {};
    const rowCounts = counts[fromState] ?? {};
    let rowTotal = 0;
    for (const toState in rowCounts) {
      rowTotal += rowCounts[toState] ?? 0;
    }

    if (rowTotal > 0) {
      for (const toState in rowCounts) {
        probabilities[fromState][toState] = (rowCounts[toState] ?? 0) / rowTotal;
      }
    }
  }

  return {
    states,
    channels,
    counts,
    probabilities
  };
}

/**
 * Solves a square linear system A * x = b using Gaussian elimination with partial pivoting.
 *
 * Algorithm details:
 * 1. Clones augmented matrix [A | b] to prevent mutating input parameters.
 * 2. Forward elimination: searches column for maximum absolute pivot element to maximize
 *    numerical stability, swaps rows, and eliminates entries below diagonal.
 * 3. Back substitution: computes solution vector x from bottom up.
 *
 * @param A - Square coefficient matrix of dimension n x n.
 * @param b - Constant column vector of dimension n.
 * @returns Solution vector x of length n.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;

  // Step 1: Initialize augmented matrix [A | b]
  const M: number[][] = new Array<number[]>(n);
  for (let i = 0; i < n; i++) {
    M[i] = new Array<number>(n + 1);
    for (let j = 0; j < n; j++) {
      M[i]![j] = A[i]![j]!;
    }
    M[i]![n] = b[i]!;
  }

  // Step 2: Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(M[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(M[row]![col]!);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }

    // If pivot is practically zero, skip to avoid division by zero (singular subsystem)
    if (maxVal < 1e-12) {
      continue;
    }

    // Swap current row with pivot row if necessary
    if (maxRow !== col) {
      const temp = M[col]!;
      M[col] = M[maxRow]!;
      M[maxRow] = temp;
    }

    // Eliminate column values in rows below
    for (let row = col + 1; row < n; row++) {
      const factor = M[row]![col]! / M[col]![col]!;
      for (let j = col; j <= n; j++) {
        M[row]![j]! -= factor * M[col]![j]!;
      }
    }
  }

  // Step 3: Back substitution
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    const diag = M[row]![row]!;
    if (Math.abs(diag) < 1e-12) {
      x[row] = 0;
      continue;
    }
    let sum = M[row]![n]!;
    for (let j = row + 1; j < n; j++) {
      sum -= M[row]![j]! * x[j]!;
    }
    x[row] = sum / diag;
  }

  return x;
}

/**
 * Calculates the total probability of transitioning from (start) to (conversion).
 * Optionally excludes a specified marketing channel by redirecting its incoming transitions to (null).
 *
 * Mathematical derivation:
 * For an absorbing Markov chain, let x_i be the probability of absorption into (conversion)
 * from transient state i.
 * By the law of total probability:
 *   x_i = R_{i, conversion} + sum_{j in transient} Q_{i, j} * x_j
 * In matrix form:
 *   (I - Q) * x = R_conversion
 * Solving this linear system yields x_(start), the exact conversion probability from start.
 *
 * @param matrix - Empirical Markov transition matrix.
 * @param excludedChannel - Optional channel name to exclude for Removal Effect calculation.
 * @returns Total absorption probability from start into conversion in range [0, 1].
 */
export function calculateConversionProbability(
  matrix: MarkovTransitionMatrix,
  excludedChannel?: string
): number {
  const transientStates = [START_STATE, ...matrix.channels];
  const stateIndexMap = new Map<string, number>();
  transientStates.forEach((st, idx) => stateIndexMap.set(st, idx));

  const n = transientStates.length;
  if (n === 0) {
    return 0;
  }

  // Formulate (I - Q) * x = b, where b is the direct probability to (conversion)
  const A: number[][] = new Array<number[]>(n);
  const b: number[] = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    A[i] = new Array<number>(n).fill(0);
    A[i]![i] = 1.0; // Identity diagonal
  }

  for (let i = 0; i < n; i++) {
    const fromState = transientStates[i]!;
    const probs = matrix.probabilities[fromState] ?? {};

    // If current state is the excluded channel, it has zero probability to convert
    if (excludedChannel && fromState === excludedChannel) {
      b[i] = 0;
      continue;
    }

    // Direct transition to conversion state
    b[i] = probs[CONVERSION_STATE] ?? 0;

    // Transitions to other transient states (-Q[i][j])
    for (const toState in probs) {
      if (toState === CONVERSION_STATE || toState === NULL_STATE) {
        continue;
      }

      // If transition target is the excluded channel, redirect to null (drop from transient sum)
      if (excludedChannel && toState === excludedChannel) {
        continue;
      }

      const j = stateIndexMap.get(toState);
      if (j !== undefined) {
        A[i]![j]! -= probs[toState] ?? 0;
      }
    }
  }

  const x = solveLinearSystem(A, b);
  const startIndex = stateIndexMap.get(START_STATE) ?? 0;
  return Math.max(0, Math.min(1.0, x[startIndex] ?? 0));
}

/**
 * First-Order Markov Chain Attribution Engine with Removal Effect Scoring.
 * Computes global channel weights and attributes total revenue across channels.
 *
 * Removal Effect formulation:
 * - RE(c) = 1 - (P(Conversion | without c) / P(Conversion))
 * - w(c) = RE(c) / sum_{c'} RE(c')
 * - Credit(c) = w(c) * totalValue
 *
 * @param journeys - Array of historical customer journeys.
 * @param explicitTotalValue - Optional override for total converted value to distribute.
 * @returns Markov attribution result including baseline conversion probability and per-channel breakdown.
 */
export function markovAttribution(
  journeys: CustomerJourney[],
  explicitTotalValue?: number
): MarkovAttributionResult {
  let calculatedTotalValue = 0;
  for (const journey of journeys) {
    if (journey.conversion && journey.conversion.value > 0) {
      calculatedTotalValue += journey.conversion.value;
    }
  }
  const totalValue = explicitTotalValue !== undefined ? explicitTotalValue : calculatedTotalValue;

  const matrix = buildTransitionMatrix(journeys);
  const channels = matrix.channels;

  if (channels.length === 0) {
    return {
      model: "markov",
      weights: {},
      credits: {},
      totalValue,
      baselineConversionProbability: 0,
      removalEffects: {}
    };
  }

  // Step 1: Compute baseline conversion probability across intact transition graph
  const baselineProb = calculateConversionProbability(matrix);

  const removalEffects: Record<string, ChannelRemovalEffect> = {};
  const rawEffects: Record<string, number> = {};
  let totalRemovalEffect = 0;

  // Step 2: Compute marginal removal effect for each channel individually
  for (const ch of channels) {
    const probWithout = calculateConversionProbability(matrix, ch);
    let effect = 0;

    if (baselineProb > 1e-12) {
      effect = Math.max(0, (baselineProb - probWithout) / baselineProb);
    }

    rawEffects[ch] = effect;
    totalRemovalEffect += effect;
  }

  const weights: Record<string, number> = {};
  const credits: Record<string, number> = {};

  // Step 3: Normalize removal effects to sum to 1.0
  if (totalRemovalEffect > 1e-12) {
    for (const ch of channels) {
      const w = (rawEffects[ch] ?? 0) / totalRemovalEffect;
      const c = w * totalValue;
      weights[ch] = w;
      credits[ch] = c;
      removalEffects[ch] = {
        channel: ch,
        conversionProbabilityWithout: calculateConversionProbability(matrix, ch),
        removalEffect: rawEffects[ch] ?? 0,
        weight: w,
        credit: c
      };
    }
  } else {
    // If all removal effects are zero (all paths convert equally without restriction), distribute evenly
    const uniform = 1.0 / channels.length;
    for (const ch of channels) {
      const c = uniform * totalValue;
      weights[ch] = uniform;
      credits[ch] = c;
      removalEffects[ch] = {
        channel: ch,
        conversionProbabilityWithout: baselineProb,
        removalEffect: 0,
        weight: uniform,
        credit: c
      };
    }
  }

  return {
    model: "markov",
    weights,
    credits,
    totalValue,
    baselineConversionProbability: baselineProb,
    removalEffects
  };
}
