/**
 * High-resolution monotonic timestamp synchronizer.
 * Combines wall-clock epoch origin with high-resolution performance monotonic deltas
 * to eliminate NTP clock skew, user system time adjustments, and backwards time jumps.
 */
export class MonotonicClock {
  private originWall: number;
  private originMono: number;
  private lastTimestamp: number;
  private readonly epsilon: number;

  /**
   * Initializes a new MonotonicClock instance.
   *
   * @param customOriginWall - Optional wall clock reference in milliseconds (defaults to Date.now()).
   * @param customOriginMono - Optional monotonic reference in milliseconds (defaults to performance.now()).
   * @param epsilon - Sub-pixel resolution offset in milliseconds (default 0.001 ms).
   */
  constructor(customOriginWall?: number, customOriginMono?: number, epsilon = 0.001) {
    this.originWall = customOriginWall ?? Date.now();
    this.originMono = customOriginMono ?? this.getMonotonicNow();
    this.lastTimestamp = this.originWall;
    this.epsilon = epsilon;
  }

  /**
   * Evaluates current monotonic execution time safely across browser, worker, and server runtimes.
   *
   * @returns Current high-resolution timestamp in milliseconds.
   */
  private getMonotonicNow(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return 0;
  }

  /**
   * Returns a normalized, strictly non-decreasing monotonic timestamp in milliseconds.
   *
   * Mathematical invariant:
   *   nextTimestamp = max(originWall + (performance.now() - originMono), lastTimestamp + epsilon)
   *
   * @returns Strictly non-decreasing timestamp in milliseconds.
   */
  public now(): number {
    const currentMono = this.getMonotonicNow();
    const elapsedMono = currentMono - this.originMono;
    const computedTimestamp = this.originWall + elapsedMono;

    // Enforce strictly monotonic non-decreasing invariant
    const nextTimestamp = Math.max(computedTimestamp, this.lastTimestamp + this.epsilon);
    this.lastTimestamp = nextTimestamp;
    return nextTimestamp;
  }

  /**
   * Resets clock reference origins (useful for testing, hibernation recovery, or re-synchronization).
   *
   * @param originWall - Optional new wall clock origin in milliseconds.
   * @param originMono - Optional new monotonic origin in milliseconds.
   */
  public reset(originWall?: number, originMono?: number): void {
    this.originWall = originWall ?? Date.now();
    this.originMono = originMono ?? this.getMonotonicNow();
    this.lastTimestamp = this.originWall;
  }

  /**
   * Returns the current wall origin timestamp.
   *
   * @returns Reference wall clock origin in milliseconds.
   */
  public getOriginWall(): number {
    return this.originWall;
  }

  /**
   * Returns the last emitted timestamp.
   *
   * @returns Last generated monotonic timestamp in milliseconds.
   */
  public getLastTimestamp(): number {
    return this.lastTimestamp;
  }
}

/** Global default clock singleton instance */
export const defaultClock = new MonotonicClock();
