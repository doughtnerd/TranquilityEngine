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

/** How long (ms) the frame sampler keeps itself alive after the last `rafTime()` call. */
const RAF_IDLE_MS = 1_000;

/**
 * A0.3/A1.7: the clock over a real AudioContext (architecture §4.6). `rafTime()` samples `requestAnimationFrame` while
 * it's being called. `context` may be a getter (A3.4c): a rebuild into a new context then moves the clock with it.
 */
export function browserHostClock(context: AudioContext | (() => AudioContext)): HostClock {
  const contextNow = typeof context === "function" ? context : () => context;
  let frameTime = 0;
  let inFrame = false;
  let sampling = false;
  let lastAsked = 0;
  const hasRaf = typeof requestAnimationFrame === "function";
  const sample = (t: number): void => {
    frameTime = t;
    inFrame = true;
    setTimeout(() => (inFrame = false), 0);
    if (performance.now() - lastAsked < RAF_IDLE_MS) requestAnimationFrame(sample);
    else sampling = false;
  };
  return {
    rafTime() {
      lastAsked = performance.now();
      if (hasRaf && !sampling) {
        sampling = true;
        requestAnimationFrame(sample);
      }
      return inFrame ? frameTime : lastAsked;
    },
    outputTimestamp() {
      const context = contextNow();
      if (context.state !== "running" || typeof context.getOutputTimestamp !== "function") return null;
      const t = context.getOutputTimestamp();
      if (!t || t.contextTime === undefined || t.performanceTime === undefined) return null;
      // A3.2: a non-finite or negative pair would poison the offset filter; the clock map falls back instead.
      if (!Number.isFinite(t.contextTime) || !Number.isFinite(t.performanceTime) || t.contextTime < 0 || t.performanceTime < 0) return null;
      // Engines report zeros until the first render.
      if (t.contextTime === 0 && t.performanceTime === 0) return null;
      return { contextTime: t.contextTime, performanceTime: t.performanceTime };
    },
    currentTime: () => contextNow().currentTime,
    dateNow: () => Date.now(),
    fake: false,
  };
}

/** The controls a test has over a fake clock. */
export interface FakeHostClock extends HostClock {
  /** Moves every clock forward by `ms` (the context clock by `ms / 1000` seconds unless suspended). */
  advance(ms: number): void;
  /** Sets whether the context clock runs (a suspended context's `currentTime` stands still). */
  setRunning(running: boolean): void;
  /** A3.4c: a new context: its clock starts again at 0 (the page's clocks run on). */
  restartContext(): void;
}

/** A fake clock starting at the given times (defaults: rAF 1000 ms, context 0 s, wall clock 1,000,000 ms). */
export function fakeHostClock(start: { rafTime?: number; currentTime?: number; dateNow?: number } = {}): FakeHostClock {
  let raf = start.rafTime ?? 1_000;
  let current = start.currentTime ?? 0;
  let date = start.dateNow ?? 1_000_000;
  let running = true;
  return {
    rafTime: () => raf,
    outputTimestamp: () => (running ? { contextTime: current, performanceTime: raf } : null),
    currentTime: () => current,
    dateNow: () => date,
    fake: true,
    advance(ms) {
      raf += ms;
      date += ms;
      if (running) current += ms / 1000;
    },
    setRunning(value) {
      running = value;
    },
    restartContext() {
      current = 0;
    },
  };
}
