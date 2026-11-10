// The hard rebuild's rate limit (ADR 0157; architecture §2.1 "Recovering --> Failed: 4th recovery inside 60 s", §7
// trap row "3 per 60 s, then Failed"). A sliding window over the last `limit` grants: a take succeeds while fewer than
// `limit` were granted in the `windowMs` before it, so a 4th within 60 s is refused and one 60 s after the oldest of
// three is granted again. Pure: the clock is injected, nothing else is read.

/** @internal Rebuilds granted per window (architecture §7). */
export const RECOVERY_LIMIT = 3;
/** @internal The window, ms (architecture §7). */
export const RECOVERY_WINDOW_MS = 60_000;

/** @internal `limit` grants per sliding `windowMs`. Allocates only in the constructor. */
export class RateLimit {
  /** Times of the last `limit` grants, a ring; `NaN` for slots never used. */
  private readonly times: Float64Array;
  private next = 0;

  /** `limit` is a positive integer and `windowMs` > 0, else a `RangeError`. `now` is in ms (default `performance.now`). */
  constructor(
    readonly limit = RECOVERY_LIMIT,
    readonly windowMs = RECOVERY_WINDOW_MS,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !(windowMs > 0)) throw new RangeError(`RateLimit needs a positive integer limit and window (got ${limit} and ${windowMs})`);
    this.times = new Float64Array(limit).fill(Number.NaN);
  }

  /** Grants and records one when fewer than `limit` were granted in the last `windowMs`; returns whether it granted. */
  take(): boolean {
    const t = this.now();
    // The ring's oldest entry is the one `next` points at: if it is still inside the window, all `limit` are.
    const oldest = this.times[this.next]!;
    if (!Number.isNaN(oldest) && t - oldest < this.windowMs) return false;
    this.times[this.next] = t;
    this.next = (this.next + 1) % this.limit;
    return true;
  }

  /** Grants inside the window now (0..limit). */
  get count(): number {
    const t = this.now();
    let n = 0;
    for (let i = 0; i < this.limit; i++) {
      const at = this.times[i]!;
      if (!Number.isNaN(at) && t - at < this.windowMs) n++;
    }
    return n;
  }

  /** Forgets every grant. */
  reset(): void {
    this.times.fill(Number.NaN);
    this.next = 0;
  }
}
