/**
 * Values by tick for a window of the newest ticks (ADR 0311): a client's sent inputs (`input.ts`)
 * and each predicted ghost's predicted states (`prediction.ts`).
 *
 * A ring of `capacity` slots, one per tick modulo the capacity. What's kept is decided by tick
 * numbers alone: the window is the `capacity` ticks up to the newest tick written, whatever order
 * ticks were written in (a correction for an older tick, a client's `serverTick` stepping back).
 * A tick older than the window is ignored when written and gone when read.
 */
export class TickHistory<T> {
  private readonly ticks: Float64Array;
  private readonly values: (T | undefined)[];
  private newestTick = -1;

  constructor(readonly capacity: number) {
    if (!(Number.isInteger(capacity) && capacity > 0)) throw new Error(`TickHistory: the capacity must be a positive integer (got ${capacity}).`);
    this.ticks = new Float64Array(capacity).fill(-1);
    this.values = new Array<T | undefined>(capacity);
  }

  /** The newest tick written since the last `clear`, or -1. */
  get newest(): number {
    return this.newestTick;
  }

  /** The oldest tick the window can hold now: older ones are ignored and gone. */
  get oldest(): number {
    return this.newestTick - this.capacity + 1;
  }

  /** Store `value` for `tick` (ticks are 0 or more). Ignored for a tick older than the window. */
  set(tick: number, value: T): void {
    if (tick < 0 || tick < this.oldest) return;
    const slot = tick % this.capacity;
    this.ticks[slot] = tick;
    this.values[slot] = value;
    if (tick > this.newestTick) this.newestTick = tick;
  }

  /** The value stored for `tick`, if it's still in the window. */
  get(tick: number): T | undefined {
    if (tick < 0 || tick < this.oldest || tick > this.newestTick) return undefined;
    const slot = tick % this.capacity;
    return this.ticks[slot] === tick ? this.values[slot] : undefined;
  }

  has(tick: number): boolean {
    return this.get(tick) !== undefined;
  }

  /** Forget every tick before `tick` (the newest tick stays the newest written). */
  dropBefore(tick: number): void {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.ticks[slot] >= 0 && this.ticks[slot] < tick) {
        this.ticks[slot] = -1;
        this.values[slot] = undefined;
      }
    }
  }

  /** Forget everything. */
  clear(): void {
    this.ticks.fill(-1);
    this.values.fill(undefined);
    this.newestTick = -1;
  }
}
