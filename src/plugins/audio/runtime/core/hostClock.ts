// Contract K4 (coordinator, MS2 wave 2): the host's view of time (architecture §4.6).
// A1.7 writes the browser implementation and the fake; A1.4's clock map and the host take a HostClock,
// so tests inject the fake and advance it explicitly. Don't change these signatures without the coordinator.

/** The context's output timestamp pair, as `AudioContext.getOutputTimestamp()` gives it. */
export interface OutputTimestamp {
  /** Seconds on the context's clock (`contextTime`). */
  readonly contextTime: number;
  /** Milliseconds on the page's clock (`performanceTime`, the `performance.now()` time base). */
  readonly performanceTime: number;
}

/**
 * Every clock the main-thread host reads (architecture §4.6). Production wraps the browser; tests use a fake
 * that advances explicitly. Calibration-like estimators are disabled under the fake.
 */
export interface HostClock {
  /** The current frame's `requestAnimationFrame` time in ms (the `performance.now()` base); `performance.now()` outside a frame. */
  rafTime(): number;
  /** The context's output timestamp, or null where unsupported or not yet meaningful (a suspended context). */
  outputTimestamp(): OutputTimestamp | null;
  /** The context's `currentTime` in seconds. */
  currentTime(): number;
  /** `Date.now()` in ms (wall clock, stamped into STATUS blocks). */
  dateNow(): number;
  /** True for a test fake: estimators that calibrate against real time switch off. */
  readonly fake: boolean;
}

/** A0.3/A1.7: the clock over a real AudioContext. A1.7 fills the body. */
export function browserHostClock(context: AudioContext): HostClock {
  void context;
  throw new Error("not implemented: A1.7 (browserHostClock)");
}

/** The controls a test has over a fake clock. */
export interface FakeHostClock extends HostClock {
  /** Moves every clock forward by `ms` (the context clock by `ms / 1000` seconds unless suspended). */
  advance(ms: number): void;
  /** Sets whether the context clock runs (a suspended context's `currentTime` stands still). */
  setRunning(running: boolean): void;
}

/** A fake clock starting at the given times. A1.7 fills the body. */
export function fakeHostClock(start?: { rafTime?: number; currentTime?: number; dateNow?: number }): FakeHostClock {
  void start;
  throw new Error("not implemented: A1.7 (fakeHostClock)");
}
