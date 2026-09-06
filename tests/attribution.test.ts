import { describe, it, expect } from "vitest";
import type { CustomerJourney } from "../src/types";
import {
  firstTouchAttribution,
  lastTouchAttribution,
  lastNonDirectTouchAttribution,
  linearAttribution,
  timeDecayAttribution,
  positionBasedAttribution,
  calculateAttribution,
  calculateCohortAttribution
} from "../src/attribution/index";

describe("Deterministic Single-Touch & Heuristic Multi-Touch Attribution", () => {
  const baseTimestamp = 1700000000000;
  const oneDayMs = 24 * 60 * 60 * 1000;

  const sampleJourney: CustomerJourney = {
    visitorId: "anon_user_1",
    touchpoints: [
      { channel: "paid_search", timestamp: baseTimestamp },
      { channel: "social", timestamp: baseTimestamp + oneDayMs },
      { channel: "organic_search", timestamp: baseTimestamp + 2 * oneDayMs },
      { channel: "direct", timestamp: baseTimestamp + 3 * oneDayMs }
    ],
    conversion: {
      id: "conv_1",
      value: 1000,
      timestamp: baseTimestamp + 3 * oneDayMs + 3600000,
      name: "purchase"
    }
  };

  const emptyJourney: CustomerJourney = {
    visitorId: "anon_user_empty",
    touchpoints: [],
    conversion: {
      id: "conv_empty",
      value: 500,
      timestamp: baseTimestamp
    }
  };

  describe("First-Touch Attribution (FTA)", () => {
    it("allocates 100% credit to the earliest chronological touchpoint", () => {
      const result = firstTouchAttribution(sampleJourney);

      expect(result.model).toBe("first-touch");
      expect(result.weights["paid_search"]).toBe(1.0);
      expect(result.credits["paid_search"]).toBe(1000);
      expect(result.weights["social"]).toBeUndefined();
      expect(result.weights["direct"]).toBeUndefined();
      expect(result.totalValue).toBe(1000);
    });

    it("correctly handles unsorted touchpoints by chronological sorting", () => {
      const unsortedJourney: CustomerJourney = {
        visitorId: "anon_unsorted",
        touchpoints: [
          { channel: "social", timestamp: baseTimestamp + 1000 },
          { channel: "paid_search", timestamp: baseTimestamp }
        ],
        conversion: { id: "conv_2", value: 200, timestamp: baseTimestamp + 2000 }
      };

      const result = firstTouchAttribution(unsortedJourney);
      expect(result.weights["paid_search"]).toBe(1.0);
      expect(result.credits["paid_search"]).toBe(200);
      expect(result.weights["social"]).toBeUndefined();
    });

    it("returns empty weights and retains totalValue for empty journey", () => {
      const result = firstTouchAttribution(emptyJourney);
      expect(result.weights).toEqual({});
      expect(result.credits).toEqual({});
      expect(result.totalValue).toBe(500);
    });
  });

  describe("Last-Touch Attribution (LTA)", () => {
    it("allocates 100% credit to the latest chronological touchpoint", () => {
      const result = lastTouchAttribution(sampleJourney);

      expect(result.model).toBe("last-touch");
      expect(result.weights["direct"]).toBe(1.0);
      expect(result.credits["direct"]).toBe(1000);
      expect(result.weights["paid_search"]).toBeUndefined();
      expect(result.totalValue).toBe(1000);
    });

    it("returns empty weights and retains totalValue for empty journey", () => {
      const result = lastTouchAttribution(emptyJourney);
      expect(result.weights).toEqual({});
      expect(result.credits).toEqual({});
      expect(result.totalValue).toBe(500);
    });
  });

  describe("Last Non-Direct Touch Attribution", () => {
    it("allocates 100% credit to the latest non-direct touchpoint when journey ends in direct", () => {
      const result = lastNonDirectTouchAttribution(sampleJourney);

      expect(result.model).toBe("last-non-direct");
      expect(result.weights["organic_search"]).toBe(1.0);
      expect(result.credits["organic_search"]).toBe(1000);
      expect(result.weights["direct"]).toBeUndefined();
    });

    it("falls back to direct when ALL touchpoints in journey are direct", () => {
      const allDirectJourney: CustomerJourney = {
        visitorId: "anon_direct_only",
        touchpoints: [
          { channel: "direct", timestamp: baseTimestamp },
          { channel: "Direct", timestamp: baseTimestamp + 1000 }
        ],
        conversion: { id: "conv_d", value: 300, timestamp: baseTimestamp + 2000 }
      };

      const result = lastNonDirectTouchAttribution(allDirectJourney);
      expect(result.weights["Direct"]).toBe(1.0);
      expect(result.credits["Direct"]).toBe(300);
    });

    it("respects custom direct channel name option", () => {
      const customDirectJourney: CustomerJourney = {
        visitorId: "anon_custom_direct",
        touchpoints: [
          { channel: "organic", timestamp: baseTimestamp },
          { channel: "none_specified", timestamp: baseTimestamp + 1000 }
        ],
        conversion: { id: "conv_cd", value: 400, timestamp: baseTimestamp + 2000 }
      };

      const result = lastNonDirectTouchAttribution(customDirectJourney, {
        directChannelName: "none_specified"
      });
      expect(result.weights["organic"]).toBe(1.0);
      expect(result.credits["organic"]).toBe(400);
    });

    it("returns empty weights for empty journey", () => {
      const result = lastNonDirectTouchAttribution(emptyJourney);
      expect(result.weights).toEqual({});
      expect(result.credits).toEqual({});
    });
  });

  describe("Linear Attribution", () => {
    it("distributes credit uniformly across all touchpoints (1/n each)", () => {
      const result = linearAttribution(sampleJourney);

      expect(result.model).toBe("linear");
      // 4 touchpoints: each gets 0.25
      expect(result.weights["paid_search"]).toBeCloseTo(0.25, 6);
      expect(result.weights["social"]).toBeCloseTo(0.25, 6);
      expect(result.weights["organic_search"]).toBeCloseTo(0.25, 6);
      expect(result.weights["direct"]).toBeCloseTo(0.25, 6);

      // Verify credit sums to total value
      const sumCredits = Object.values(result.credits).reduce((acc, v) => acc + v, 0);
      expect(sumCredits).toBeCloseTo(1000, 6);

      // Verify weight sum strictly equals 1.0
      const sumWeights = Object.values(result.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);
    });

    it("correctly aggregates weights for recurring channels", () => {
      const repeatJourney: CustomerJourney = {
        visitorId: "anon_repeat",
        touchpoints: [
          { channel: "paid_search", timestamp: baseTimestamp },
          { channel: "social", timestamp: baseTimestamp + 1000 },
          { channel: "paid_search", timestamp: baseTimestamp + 2000 },
          { channel: "paid_search", timestamp: baseTimestamp + 3000 }
        ],
        conversion: { id: "conv_rep", value: 1200, timestamp: baseTimestamp + 4000 }
      };

      const result = linearAttribution(repeatJourney);
      // paid_search appeared 3 times out of 4 (75%), social 1 time (25%)
      expect(result.weights["paid_search"]).toBeCloseTo(0.75, 6);
      expect(result.weights["social"]).toBeCloseTo(0.25, 6);
      expect(result.credits["paid_search"]).toBeCloseTo(900, 6);
      expect(result.credits["social"]).toBeCloseTo(300, 6);
    });

    it("returns empty weights for empty journey", () => {
      const result = linearAttribution(emptyJourney);
      expect(result.weights).toEqual({});
      expect(result.credits).toEqual({});
    });
  });

  describe("Time-Decay Attribution", () => {
    it("allocates strictly higher credit to touchpoints closer to conversion", () => {
      const result = timeDecayAttribution(sampleJourney, { halfLifeDays: 7 });

      expect(result.model).toBe("time-decay");
      // Chronological order: paid_search (day 0), social (day 1), organic (day 2), direct (day 3)
      expect(result.weights["direct"]!).toBeGreaterThan(result.weights["organic_search"]!);
      expect(result.weights["organic_search"]!).toBeGreaterThan(result.weights["social"]!);
      expect(result.weights["social"]!).toBeGreaterThan(result.weights["paid_search"]!);

      // Invariant: sum of weights = 1.0
      const sumWeights = Object.values(result.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);

      // Invariant: sum of credits = totalValue
      const sumCredits = Object.values(result.credits).reduce((acc, v) => acc + v, 0);
      expect(sumCredits).toBeCloseTo(1000, 6);
    });

    it("handles touchpoints with identical timestamps uniformly", () => {
      const simultaneousJourney: CustomerJourney = {
        visitorId: "anon_simul",
        touchpoints: [
          { channel: "channel_a", timestamp: baseTimestamp },
          { channel: "channel_b", timestamp: baseTimestamp }
        ],
        conversion: { id: "conv_sim", value: 100, timestamp: baseTimestamp + 1000 }
      };

      const result = timeDecayAttribution(simultaneousJourney);
      expect(result.weights["channel_a"]).toBeCloseTo(0.5, 6);
      expect(result.weights["channel_b"]).toBeCloseTo(0.5, 6);
    });

    it("returns empty weights for empty journey", () => {
      const result = timeDecayAttribution(emptyJourney);
      expect(result.weights).toEqual({});
      expect(result.credits).toEqual({});
    });
  });

  describe("Position-Based (U-Shaped) Attribution", () => {
    it("handles single-touch journey (100% to first)", () => {
      const singleJourney: CustomerJourney = {
        visitorId: "single_touch",
        touchpoints: [{ channel: "search", timestamp: baseTimestamp }],
        conversion: { id: "c1", value: 500, timestamp: baseTimestamp + 1000 }
      };

      const result = positionBasedAttribution(singleJourney);
      expect(result.weights["search"]).toBe(1.0);
      expect(result.credits["search"]).toBe(500);
    });

    it("handles two-touch journey (50% first, 50% last)", () => {
      const twoJourney: CustomerJourney = {
        visitorId: "two_touch",
        touchpoints: [
          { channel: "search", timestamp: baseTimestamp },
          { channel: "social", timestamp: baseTimestamp + 1000 }
        ],
        conversion: { id: "c2", value: 800, timestamp: baseTimestamp + 2000 }
      };

      const result = positionBasedAttribution(twoJourney);
      expect(result.weights["search"]).toBe(0.5);
      expect(result.weights["social"]).toBe(0.5);
      expect(result.credits["search"]).toBe(400);
      expect(result.credits["social"]).toBe(400);
    });

    it("applies standard U-shaped 40/20/40 rule for n >= 3", () => {
      // 4 touchpoints: search (0.4), social (0.1), organic (0.1), direct (0.4)
      const result = positionBasedAttribution(sampleJourney);

      expect(result.model).toBe("position-based");
      expect(result.weights["paid_search"]).toBeCloseTo(0.40, 6);
      expect(result.weights["social"]).toBeCloseTo(0.10, 6);
      expect(result.weights["organic_search"]).toBeCloseTo(0.10, 6);
      expect(result.weights["direct"]).toBeCloseTo(0.40, 6);

      const sumWeights = Object.values(result.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);
    });

    it("supports custom position-based weighting options (e.g. 30/40/30)", () => {
      const result = positionBasedAttribution(sampleJourney, {
        firstWeight: 0.30,
        lastWeight: 0.30,
        middleWeight: 0.40
      });

      expect(result.weights["paid_search"]).toBeCloseTo(0.30, 6);
      expect(result.weights["direct"]).toBeCloseTo(0.30, 6);
      // Middle 2 touches split 0.40 -> 0.20 each
      expect(result.weights["social"]).toBeCloseTo(0.20, 6);
      expect(result.weights["organic_search"]).toBeCloseTo(0.20, 6);
    });

    it("returns empty weights for empty journey", () => {
      const result = positionBasedAttribution(emptyJourney);
      expect(result.weights).toEqual({});
      expect(result.credits).toEqual({});
    });
  });

  describe("calculateAttribution Facade", () => {
    it("dispatches to requested model correctly", () => {
      const fta = calculateAttribution(sampleJourney, "first-touch");
      expect(fta.model).toBe("first-touch");
      expect(fta.weights["paid_search"]).toBe(1.0);

      const lta = calculateAttribution(sampleJourney, "last-touch");
      expect(lta.model).toBe("last-touch");
      expect(lta.weights["direct"]).toBe(1.0);

      const linear = calculateAttribution(sampleJourney, "linear");
      expect(linear.model).toBe("linear");

      const uShaped = calculateAttribution(sampleJourney, "position-based");
      expect(uShaped.model).toBe("position-based");
    });
  });

  describe("calculateCohortAttribution Aggregator", () => {
    it("aggregates credits and normalizes weights across multiple journeys", () => {
      const journey1: CustomerJourney = {
        visitorId: "j1",
        touchpoints: [
          { channel: "search", timestamp: baseTimestamp },
          { channel: "social", timestamp: baseTimestamp + 1000 }
        ],
        conversion: { id: "c1", value: 100, timestamp: baseTimestamp + 2000 }
      };

      const journey2: CustomerJourney = {
        visitorId: "j2",
        touchpoints: [
          { channel: "search", timestamp: baseTimestamp },
          { channel: "email", timestamp: baseTimestamp + 1000 }
        ],
        conversion: { id: "c2", value: 300, timestamp: baseTimestamp + 2000 }
      };

      // Under Linear:
      // j1 (100): search gets 50, social gets 50
      // j2 (300): search gets 150, email gets 150
      // Total value = 400
      // Total search = 200 (50%), social = 50 (12.5%), email = 150 (37.5%)
      const cohortResult = calculateCohortAttribution([journey1, journey2], "linear");

      expect(cohortResult.totalValue).toBe(400);
      expect(cohortResult.credits["search"]).toBe(200);
      expect(cohortResult.credits["social"]).toBe(50);
      expect(cohortResult.credits["email"]).toBe(150);

      expect(cohortResult.weights["search"]).toBeCloseTo(0.50, 6);
      expect(cohortResult.weights["social"]).toBeCloseTo(0.125, 6);
      expect(cohortResult.weights["email"]).toBeCloseTo(0.375, 6);
    });
  });
});
