/**
 * Chaos & Resilience Test Suite: Performance & Math Microbenchmarks
 *
 * Validates real-time performance and computational complexity:
 * - Sub-5ms attribution calculation for 1,000-touchpoint customer journeys
 * - Fast Markov transition matrix and absorbing chain solving on dense graphs
 * - High-throughput queue cycling across 10,000 events with bounded memory
 */

import { describe, expect, it } from "vitest";
import {
  calculateAttribution,
  calculateCohortAttribution,
} from "../../src/attribution/index.js";
import { EventQueue } from "../../src/queue/event-queue.js";
import { MemoryAdapter } from "../../src/storage/memory.js";
import type { CustomerJourney, Touchpoint } from "../../src/types.js";

describe("Performance & Mathematical Microbenchmarks", () => {
  it("computes heuristic attribution for 1,000-touchpoint journeys in under 5ms", () => {
    const channelPool = [
      "google_search",
      "facebook_ads",
      "organic_direct",
      "email_newsletter",
      "linkedin_sponsored",
      "youtube_display",
      "affiliate_partner",
      "twitter_promo",
      "podcast_referral",
      "retargeting_banner",
    ];

    const baseTime = 1700000000000;
    const touchpoints: Touchpoint[] = [];

    // Synthesize 1,000 sequential touchpoints
    for (let i = 0; i < 1000; i++) {
      const channel = channelPool[i % channelPool.length]!;
      touchpoints.push({
        channel,
        timestamp: baseTime + i * 3600000, // 1 hour intervals
      });
    }

    const journey: CustomerJourney = {
      visitorId: "benchmark_user_1000",
      touchpoints,
      conversion: {
        id: "conv_bench_1",
        value: 5000.0,
        timestamp: baseTime + 1000 * 3600000 + 1000,
      },
    };

    const models = [
      "first-touch",
      "last-touch",
      "linear",
      "time-decay",
      "position-based",
    ] as const;

    for (const model of models) {
      const start = performance.now();
      const result = calculateAttribution(journey, model);
      const duration = performance.now() - start;

      // Mathematical precision assertions
      const weightValues = Object.values(result.weights);
      expect(weightValues.length).toBeGreaterThan(0);
      const totalWeight = weightValues.reduce((sum, w) => sum + w, 0);

      const creditValues = Object.values(result.credits);
      const totalCredit = creditValues.reduce((sum, c) => sum + c, 0);

      expect(totalWeight).toBeCloseTo(1.0, 5);
      expect(totalCredit).toBeCloseTo(5000.0, 2);
      expect(result.totalValue).toBe(5000.0);

      // Performance benchmark: strictly sub-5ms per 1,000-touchpoint calculation
      expect(duration).toBeLessThan(5.0);
    }
  });

  it("solves absorbing Markov chain for dense multi-channel cohorts in under 25ms", () => {
    const channels = [
      "c1", "c2", "c3", "c4", "c5",
      "c6", "c7", "c8", "c9", "c10",
      "c11", "c12", "c13", "c14", "c15"
    ];

    const journeys: CustomerJourney[] = [];
    const baseTime = 1700000000000;

    // Create 100 journeys with complex multi-channel transitions and cyclic loops
    for (let j = 0; j < 100; j++) {
      const pathLength = 5 + (j % 15);
      const touchpoints: Touchpoint[] = [];

      for (let step = 0; step < pathLength; step++) {
        const channelIdx = (j * 3 + step * 7) % channels.length;
        touchpoints.push({
          channel: channels[channelIdx]!,
          timestamp: baseTime + step * 1000,
        });
      }

      const isConverting = j % 3 !== 0; // 67% conversion rate
      journeys.push({
        visitorId: `visitor_${j}`,
        touchpoints,
        conversion: isConverting
          ? { id: `conv_${j}`, value: 100 + j * 5, timestamp: baseTime + 100000 }
          : undefined,
      });
    }

    const start = performance.now();
    const cohortResult = calculateCohortAttribution(journeys, "markov");
    const duration = performance.now() - start;

    const weights = Object.values(cohortResult.weights);
    expect(weights.length).toBeGreaterThan(0);

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);

    // Performance assertion: dense absorbing Markov network solved in under 25ms
    expect(duration).toBeLessThan(25.0);
  });

  it("cycles 10,000 events through queue with high throughput and zero memory leaks", async () => {
    const queue = new EventQueue({
      storage: new MemoryAdapter(),
      maxEvents: 20000,
      maxByteSize: 10 * 1024 * 1024, // 10MB
    });
    await queue.init();

    const totalEvents = 10000;
    const batchSize = 100;

    const start = performance.now();

    // Enqueue 10,000 events in batches
    for (let b = 0; b < totalEvents / batchSize; b++) {
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < batchSize; i++) {
        promises.push(
          queue.enqueue({ action: "bench_event", b, i }, (b + i) % 10 === 0 ? "high" : "normal")
        );
      }
      await Promise.all(promises);
    }

    expect(await queue.count()).toBe(totalEvents);

    // Drain all 10,000 events in batches
    while (true) {
      const batch = await queue.peek(batchSize);
      if (batch.length === 0) {
        break;
      }
      const ids = batch.map((evt) => evt.id);
      await queue.ack(ids);
    }

    const duration = performance.now() - start;

    // Queue must be completely empty
    expect(await queue.count()).toBe(0);

    // Byte size tracking must return to zero (no memory leak)
    expect(queue.getByteSize()).toBe(0);

    const stats = await queue.stats();
    expect(stats.eventCount).toBe(0);
    expect(stats.byteSize).toBe(0);

    // High throughput assertion: 10,000 enqueues + peeks + acks complete in under 500ms
    expect(duration).toBeLessThan(500.0);
  });
});
