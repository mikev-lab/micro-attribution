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
  markovAttribution,
  buildTransitionMatrix
} from "../src/attribution/index";

describe("Exhaustive Edge Cases & Boundary Conditions Suite", () => {
  const baseTime = 1700000000000;

  describe("Zero & Fractional Conversion Values", () => {
    const zeroValueJourney: CustomerJourney = {
      visitorId: "user_zero_val",
      touchpoints: [
        { channel: "search", timestamp: baseTime },
        { channel: "social", timestamp: baseTime + 1000 }
      ],
      conversion: { id: "c_zero", value: 0, timestamp: baseTime + 2000 }
    };

    const fractionalValueJourney: CustomerJourney = {
      visitorId: "user_fractional_val",
      touchpoints: [
        { channel: "search", timestamp: baseTime },
        { channel: "social", timestamp: baseTime + 1000 },
        { channel: "email", timestamp: baseTime + 2000 }
      ],
      conversion: { id: "c_frac", value: 99.99, timestamp: baseTime + 3000 }
    };

    it("handles zero conversion value across all attribution models", () => {
      const models = [
        "first-touch",
        "last-touch",
        "last-non-direct",
        "linear",
        "time-decay",
        "position-based",
        "markov"
      ] as const;

      for (const model of models) {
        const res = calculateAttribution(zeroValueJourney, model);
        expect(res.totalValue).toBe(0);

        for (const ch in res.credits) {
          expect(res.credits[ch]).toBe(0);
        }

        // Weights must still normalize to 1.0
        const sumWeights = Object.values(res.weights).reduce((acc, v) => acc + v, 0);
        expect(sumWeights).toBeCloseTo(1.0, 6);
      }
    });

    it("handles fractional monetary values with exact credit conservation", () => {
      const models = [
        "first-touch",
        "last-touch",
        "last-non-direct",
        "linear",
        "time-decay",
        "position-based",
        "markov"
      ] as const;

      for (const model of models) {
        const res = calculateAttribution(fractionalValueJourney, model);
        expect(res.totalValue).toBe(99.99);

        const sumCredits = Object.values(res.credits).reduce((acc, v) => acc + v, 0);
        expect(sumCredits).toBeCloseTo(99.99, 4);

        const sumWeights = Object.values(res.weights).reduce((acc, v) => acc + v, 0);
        expect(sumWeights).toBeCloseTo(1.0, 6);
      }
    });
  });

  describe("Cardinality Extremes & Ultra-Long Journeys", () => {
    it("processes ultra-long customer journeys (n = 250 touchpoints) stably and deterministically", () => {
      const channels = ["search", "social", "display", "email", "affiliate", "referral"];
      const touchpoints = [];

      for (let i = 0; i < 250; i++) {
        touchpoints.push({
          channel: channels[i % channels.length]!,
          timestamp: baseTime + i * 60000
        });
      }

      const longJourney: CustomerJourney = {
        visitorId: "user_long",
        touchpoints,
        conversion: { id: "c_long", value: 5000, timestamp: baseTime + 250 * 60000 }
      };

      const linearRes = linearAttribution(longJourney);
      expect(linearRes.totalValue).toBe(5000);
      const linearSumWeights = Object.values(linearRes.weights).reduce((acc, v) => acc + v, 0);
      expect(linearSumWeights).toBeCloseTo(1.0, 9);
      const linearSumCredits = Object.values(linearRes.credits).reduce((acc, v) => acc + v, 0);
      expect(linearSumCredits).toBeCloseTo(5000, 4);

      const decayRes = timeDecayAttribution(longJourney, { halfLifeDays: 7 });
      const decaySumWeights = Object.values(decayRes.weights).reduce((acc, v) => acc + v, 0);
      expect(decaySumWeights).toBeCloseTo(1.0, 9);

      const uShapedRes = positionBasedAttribution(longJourney);
      const uSumWeights = Object.values(uShapedRes.weights).reduce((acc, v) => acc + v, 0);
      expect(uSumWeights).toBeCloseTo(1.0, 9);
    });

    it("handles journeys where touchpoints have completely missing conversion objects", () => {
      const unconvertedJourney: CustomerJourney = {
        visitorId: "unconverted",
        touchpoints: [
          { channel: "search", timestamp: baseTime },
          { channel: "social", timestamp: baseTime + 1000 }
        ]
      };

      const fta = firstTouchAttribution(unconvertedJourney);
      expect(fta.totalValue).toBe(0);
      expect(fta.credits["search"]).toBe(0);
      expect(fta.weights["search"]).toBe(1.0);

      const lta = lastTouchAttribution(unconvertedJourney);
      expect(lta.totalValue).toBe(0);
      expect(lta.credits["social"]).toBe(0);
      expect(lta.weights["social"]).toBe(1.0);
    });
  });

  describe("Chronological Inversions & Identical Timestamps", () => {
    it("handles completely reversed timestamps and enforces monotonic ordering", () => {
      const reversedJourney: CustomerJourney = {
        visitorId: "reversed_user",
        touchpoints: [
          { channel: "touch_3", timestamp: baseTime + 3000 },
          { channel: "touch_2", timestamp: baseTime + 2000 },
          { channel: "touch_1", timestamp: baseTime + 1000 }
        ],
        conversion: { id: "c_rev", value: 100, timestamp: baseTime + 4000 }
      };

      const fta = firstTouchAttribution(reversedJourney);
      expect(fta.weights["touch_1"]).toBe(1.0);

      const lta = lastTouchAttribution(reversedJourney);
      expect(lta.weights["touch_3"]).toBe(1.0);
    });

    it("handles multiple touchpoints occurring in the exact same millisecond", () => {
      const sameTimeJourney: CustomerJourney = {
        visitorId: "same_time_user",
        touchpoints: [
          { channel: "ch_a", timestamp: baseTime },
          { channel: "ch_b", timestamp: baseTime },
          { channel: "ch_c", timestamp: baseTime }
        ],
        conversion: { id: "c_same", value: 300, timestamp: baseTime }
      };

      const decayRes = timeDecayAttribution(sameTimeJourney);
      // All touchpoints have delta 0, thus identical weights (1/3 each)
      expect(decayRes.weights["ch_a"]).toBeCloseTo(1 / 3, 6);
      expect(decayRes.weights["ch_b"]).toBeCloseTo(1 / 3, 6);
      expect(decayRes.weights["ch_c"]).toBeCloseTo(1 / 3, 6);

      const sumWeights = Object.values(decayRes.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);
    });
  });

  describe("Extreme Parameter Boundaries", () => {
    const standardJourney: CustomerJourney = {
      visitorId: "user_std",
      touchpoints: [
        { channel: "day_0", timestamp: baseTime },
        { channel: "day_10", timestamp: baseTime + 10 * 86400000 }
      ],
      conversion: { id: "c_std", value: 100, timestamp: baseTime + 10 * 86400000 }
    };

    it("handles near-zero half life in time decay without NaN or infinity", () => {
      // Extremely rapid decay: half life of 0.00001 days (under a second)
      const res = timeDecayAttribution(standardJourney, { halfLifeDays: 0.00001 });
      // Day 10 is at conversion time (delta = 0), day 0 is 10 days ago (delta = massive)
      // Day 10 must receive virtually 100% of weight
      expect(res.weights["day_10"]).toBeCloseTo(1.0, 4);
      expect(res.weights["day_0"]).toBeCloseTo(0.0, 4);

      const sumWeights = Object.values(res.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);
    });

    it("handles massive half life in time decay (approaching linear)", () => {
      // Half life of 100,000 days: 10 days difference has negligible decay
      const res = timeDecayAttribution(standardJourney, { halfLifeDays: 100000 });
      expect(res.weights["day_0"]).toBeCloseTo(0.5, 3);
      expect(res.weights["day_10"]).toBeCloseTo(0.5, 3);

      const sumWeights = Object.values(res.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);
    });

    it("handles position-based model with zero middle weight (100% split between ends)", () => {
      const threeTouchJourney: CustomerJourney = {
        visitorId: "three_touch",
        touchpoints: [
          { channel: "first", timestamp: baseTime },
          { channel: "middle", timestamp: baseTime + 1000 },
          { channel: "last", timestamp: baseTime + 2000 }
        ],
        conversion: { id: "c3", value: 100, timestamp: baseTime + 3000 }
      };

      const res = positionBasedAttribution(threeTouchJourney, {
        firstWeight: 0.50,
        lastWeight: 0.50,
        middleWeight: 0.0
      });

      expect(res.weights["first"]).toBeCloseTo(0.50, 6);
      expect(res.weights["last"]).toBeCloseTo(0.50, 6);
      expect(res.weights["middle"]).toBeCloseTo(0.0, 6);

      const sumWeights = Object.values(res.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);
    });

    it("normalizes unnormalized position-based parameters (e.g. 40, 40, 20)", () => {
      const fourTouchJourney: CustomerJourney = {
        visitorId: "four_touch",
        touchpoints: [
          { channel: "first", timestamp: baseTime },
          { channel: "m1", timestamp: baseTime + 1000 },
          { channel: "m2", timestamp: baseTime + 2000 },
          { channel: "last", timestamp: baseTime + 3000 }
        ],
        conversion: { id: "c4", value: 100, timestamp: baseTime + 4000 }
      };

      const res = positionBasedAttribution(fourTouchJourney, {
        firstWeight: 40,
        lastWeight: 40,
        middleWeight: 20
      });

      expect(res.weights["first"]).toBeCloseTo(0.40, 6);
      expect(res.weights["last"]).toBeCloseTo(0.40, 6);
      expect(res.weights["m1"]).toBeCloseTo(0.10, 6);
      expect(res.weights["m2"]).toBeCloseTo(0.10, 6);

      const sumWeights = Object.values(res.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);
    });
  });

  describe("Markov Topological & Cohort Boundary Conditions", () => {
    it("handles cohorts where 100% of journeys convert", () => {
      const allConvertCohorts: CustomerJourney[] = [
        {
          visitorId: "u1",
          touchpoints: [{ channel: "search", timestamp: baseTime }],
          conversion: { id: "c1", value: 100, timestamp: baseTime + 1000 }
        },
        {
          visitorId: "u2",
          touchpoints: [{ channel: "social", timestamp: baseTime }],
          conversion: { id: "c2", value: 100, timestamp: baseTime + 1000 }
        }
      ];

      const res = markovAttribution(allConvertCohorts);
      expect(res.baselineConversionProbability).toBeCloseTo(1.0, 6);
      // Both channels are independent parallel converting routes
      expect(res.weights["search"]).toBeCloseTo(0.5, 4);
      expect(res.weights["social"]).toBeCloseTo(0.5, 4);

      const sumWeights = Object.values(res.weights).reduce((acc, v) => acc + v, 0);
      expect(sumWeights).toBeCloseTo(1.0, 9);
    });

    it("handles cohorts where 0% of journeys convert (all abandon)", () => {
      const noConvertCohorts: CustomerJourney[] = [
        {
          visitorId: "u1",
          touchpoints: [{ channel: "search", timestamp: baseTime }]
        },
        {
          visitorId: "u2",
          touchpoints: [{ channel: "social", timestamp: baseTime }]
        }
      ];

      const res = markovAttribution(noConvertCohorts);
      expect(res.baselineConversionProbability).toBeCloseTo(0.0, 6);
      expect(res.totalValue).toBe(0);

      // In zero conversion case, weights distribute evenly among present channels
      expect(res.weights["search"]).toBeCloseTo(0.5, 4);
      expect(res.weights["social"]).toBeCloseTo(0.5, 4);
    });

    it("handles journeys with 0 touchpoints converting directly from start", () => {
      const zeroTouchConvert: CustomerJourney[] = [
        {
          visitorId: "u_direct_convert",
          touchpoints: [],
          conversion: { id: "c_direct", value: 50, timestamp: baseTime }
        },
        {
          visitorId: "u_touch",
          touchpoints: [{ channel: "search", timestamp: baseTime }],
          conversion: { id: "c_search", value: 50, timestamp: baseTime + 1000 }
        }
      ];

      const matrix = buildTransitionMatrix(zeroTouchConvert);
      expect(matrix.counts["(start)"]!["(conversion)"]).toBe(1);
      expect(matrix.counts["(start)"]!["search"]).toBe(1);

      const res = markovAttribution(zeroTouchConvert);
      expect(res.totalValue).toBe(100);
      expect(res.weights["search"]).toBeCloseTo(1.0, 4);
    });
  });
});
