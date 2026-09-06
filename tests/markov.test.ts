import { describe, it, expect } from "vitest";
import type { CustomerJourney } from "../src/types";
import {
  buildTransitionMatrix,
  calculateConversionProbability,
  markovAttribution,
  START_STATE,
  CONVERSION_STATE,
  NULL_STATE
} from "../src/attribution/markov";

describe("First-Order Markov Chain Attribution Engine", () => {
  const baseTimestamp = 1700000000000;

  it("builds transition count and probability matrix accurately", () => {
    const journeys: CustomerJourney[] = [
      {
        visitorId: "user_1",
        touchpoints: [
          { channel: "search", timestamp: baseTimestamp },
          { channel: "social", timestamp: baseTimestamp + 1000 }
        ],
        conversion: { id: "c1", value: 100, timestamp: baseTimestamp + 2000 }
      },
      {
        visitorId: "user_2",
        touchpoints: [
          { channel: "search", timestamp: baseTimestamp },
          { channel: "email", timestamp: baseTimestamp + 1000 }
        ]
        // Non-converted journey terminates in (null)
      }
    ];

    const matrix = buildTransitionMatrix(journeys);

    expect(matrix.channels).toEqual(["email", "search", "social"]);
    expect(matrix.states).toContain(START_STATE);
    expect(matrix.states).toContain(CONVERSION_STATE);
    expect(matrix.states).toContain(NULL_STATE);

    // Transitions from (start): 2 to search
    expect(matrix.counts[START_STATE]!["search"]).toBe(2);
    expect(matrix.probabilities[START_STATE]!["search"]).toBe(1.0);

    // Transitions from search: 1 to social, 1 to email
    expect(matrix.counts["search"]!["social"]).toBe(1);
    expect(matrix.counts["search"]!["email"]).toBe(1);
    expect(matrix.probabilities["search"]!["social"]).toBe(0.5);
    expect(matrix.probabilities["search"]!["email"]).toBe(0.5);

    // Terminal transitions
    expect(matrix.counts["social"]![CONVERSION_STATE]).toBe(1);
    expect(matrix.counts["email"]![NULL_STATE]).toBe(1);
  });

  it("calculates absorption conversion probability for deterministic paths", () => {
    // Pure series path: Start -> Search -> Conversion
    const journeys: CustomerJourney[] = [
      {
        visitorId: "user_1",
        touchpoints: [{ channel: "search", timestamp: baseTimestamp }],
        conversion: { id: "c1", value: 50, timestamp: baseTimestamp + 1000 }
      }
    ];

    const matrix = buildTransitionMatrix(journeys);
    const baselineProb = calculateConversionProbability(matrix);
    expect(baselineProb).toBeCloseTo(1.0, 6);

    // Removing search eliminates conversion
    const probWithoutSearch = calculateConversionProbability(matrix, "search");
    expect(probWithoutSearch).toBeCloseTo(0.0, 6);
  });

  it("calculates accurate removal effects for parallel competing channels", () => {
    // Path A (Converted): Start -> Search -> Conversion (1 path)
    // Path B (Converted): Start -> Social -> Conversion (1 path)
    // Path C (Dropped):   Start -> Email -> Null        (1 path)
    const journeys: CustomerJourney[] = [
      {
        visitorId: "u1",
        touchpoints: [{ channel: "search", timestamp: baseTimestamp }],
        conversion: { id: "c1", value: 100, timestamp: baseTimestamp + 1000 }
      },
      {
        visitorId: "u2",
        touchpoints: [{ channel: "social", timestamp: baseTimestamp }],
        conversion: { id: "c2", value: 200, timestamp: baseTimestamp + 1000 }
      },
      {
        visitorId: "u3",
        touchpoints: [{ channel: "email", timestamp: baseTimestamp }]
      }
    ];

    const result = markovAttribution(journeys);

    // Baseline conversion probability: 2 out of 3 paths convert (2/3 = 0.6667)
    expect(result.baselineConversionProbability).toBeCloseTo(2 / 3, 4);

    // Search and Social have identical structural removal effect; Email has 0 removal effect
    expect(result.removalEffects["email"]!.removalEffect).toBeCloseTo(0, 4);
    expect(result.weights["email"]).toBeCloseTo(0, 4);
    expect(result.credits["email"]).toBeCloseTo(0, 4);

    // Search and Social split 100% of the credit equally (50% each)
    expect(result.weights["search"]).toBeCloseTo(0.5, 4);
    expect(result.weights["social"]).toBeCloseTo(0.5, 4);

    // Total value = 300
    expect(result.totalValue).toBe(300);
    expect(result.credits["search"]).toBeCloseTo(150, 4);
    expect(result.credits["social"]).toBeCloseTo(150, 4);

    // Invariant: sum of weights = 1.0
    const sumWeights = Object.values(result.weights).reduce((acc, v) => acc + v, 0);
    expect(sumWeights).toBeCloseTo(1.0, 9);
  });

  it("handles cyclical transitions and loops without infinite recursion", () => {
    // User visits Search -> Social -> Search -> Social -> Conversion
    const cyclicJourneys: CustomerJourney[] = [
      {
        visitorId: "cyclical_user",
        touchpoints: [
          { channel: "search", timestamp: baseTimestamp },
          { channel: "social", timestamp: baseTimestamp + 1000 },
          { channel: "search", timestamp: baseTimestamp + 2000 },
          { channel: "social", timestamp: baseTimestamp + 3000 }
        ],
        conversion: { id: "c_cycle", value: 500, timestamp: baseTimestamp + 4000 }
      },
      {
        visitorId: "abandon_user",
        touchpoints: [
          { channel: "search", timestamp: baseTimestamp },
          { channel: "null_channel", timestamp: baseTimestamp + 1000 }
        ]
      }
    ];

    const result = markovAttribution(cyclicJourneys);

    expect(result.model).toBe("markov");
    expect(result.totalValue).toBe(500);

    const sumWeights = Object.values(result.weights).reduce((acc, v) => acc + v, 0);
    expect(sumWeights).toBeCloseTo(1.0, 9);

    const sumCredits = Object.values(result.credits).reduce((acc, v) => acc + v, 0);
    expect(sumCredits).toBeCloseTo(500, 6);
  });

  it("handles self-transitions cleanly (e.g. repeated same-channel searches)", () => {
    const repeatJourneys: CustomerJourney[] = [
      {
        visitorId: "repeat_search",
        touchpoints: [
          { channel: "search", timestamp: baseTimestamp },
          { channel: "search", timestamp: baseTimestamp + 1000 },
          { channel: "search", timestamp: baseTimestamp + 2000 }
        ],
        conversion: { id: "c_rep", value: 250, timestamp: baseTimestamp + 3000 }
      }
    ];

    const result = markovAttribution(repeatJourneys);
    expect(result.weights["search"]).toBeCloseTo(1.0, 6);
    expect(result.credits["search"]).toBeCloseTo(250, 6);
  });

  it("handles empty journey cohorts gracefully", () => {
    const result = markovAttribution([]);
    expect(result.weights).toEqual({});
    expect(result.credits).toEqual({});
    expect(result.totalValue).toBe(0);
    expect(result.baselineConversionProbability).toBe(0);
  });
});
