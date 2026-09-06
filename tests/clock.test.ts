import { describe, it, expect } from "vitest";
import { MonotonicClock, defaultClock } from "../src/utils/clock";

describe("MonotonicClock Subsystem", () => {
  it("emits strictly non-decreasing timestamps across sequential calls", () => {
    const clock = new MonotonicClock();
    const timestamps: number[] = [];

    for (let i = 0; i < 100; i++) {
      timestamps.push(clock.now());
    }

    for (let i = 1; i < timestamps.length; i++) {
      const prev = timestamps[i - 1]!;
      const curr = timestamps[i]!;
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it("handles clock skew without moving backwards in time", () => {
    const initialWall = 1700000000000;
    const initialMono = 1000;
    const clock = new MonotonicClock(initialWall, initialMono, 0.01);

    const t1 = clock.now();
    expect(t1).toBeGreaterThanOrEqual(initialWall);

    // Re-instantiate with backwards simulated mono
    const backwardClock = new MonotonicClock(initialWall, 5000, 0.01);
    const b1 = backwardClock.now();
    const b2 = backwardClock.now();

    expect(b2).toBeGreaterThan(b1);
    // Accounting for IEEE 754 floating point quantization at 1.7e12
    expect(b2 - b1).toBeGreaterThan(0.005);
  });

  it("supports reset with custom origin values", () => {
    const clock = new MonotonicClock(1000, 100);
    expect(clock.getOriginWall()).toBe(1000);

    clock.reset(2000, 200);
    expect(clock.getOriginWall()).toBe(2000);
    expect(clock.getLastTimestamp()).toBe(2000);
  });

  it("defaultClock singleton is functional", () => {
    const now1 = defaultClock.now();
    const now2 = defaultClock.now();
    expect(now2).toBeGreaterThanOrEqual(now1);
    expect(defaultClock.getLastTimestamp()).toBe(now2);
  });
});
