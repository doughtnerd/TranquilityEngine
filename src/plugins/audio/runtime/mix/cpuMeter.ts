// `CpuMeter` (ADR 0171 amended by 0172 §1.10, task Cp2; architecture §4.3 "The CPU figure", R18; api-and-models §1.3, §10).
// The worklet shell counts busy milliseconds and quanta cumulatively (`busyMsTotal`, `quantaTotal`, f64; Cp1) and the core
// counts five cumulative work-unit totals; the wire's `loadPermille` stays 0. Main computes the figure here, from the
// STATUS blocks the mirror applies, with a window chosen by quantum count so cadence switches and skipped posts change
// only how many samples a window spans, never its bias. Pure TypeScript, allocation-free per `feed`, tested with a fake
// `Date.now` (the meter never reads a clock: the shell's counters are its only input).
import type { AudioCpuDebug } from "../backend";

/** @internal Architecture §4.3: the window, in quanta, at a clock step of 1 ms or less (256 ms at 48 kHz). */
export const CPU_WINDOW_QUANTA = 96;
/** @internal §4.3: the window at a 2 ms step (Firefox resistFingerprinting): 4 times longer, 1 s at 48 kHz. */
export const CPU_WINDOW_QUANTA_COARSE = 384;
/** @internal §4.3 `CPU_COARSE_STEP_MS`: a step above this hides the figure ("clock too coarse (n ms)"). */
export const CPU_COARSE_STEP_MS = 2;
/** @internal §4.3: "no step after 1 s": quanta worth this many seconds with `clockStepMs` still 0 hide the figure. */
export const CPU_NO_STEP_SECONDS = 1;
/** @internal The sample ring holds this many STATUS samples of the current epoch (§4.3 says 32; 128 covers the 384-quantum window at the 6-quantum cadence, 64 samples, with slack; interpretation noted in the Cp2 report). */
export const CPU_RING_SAMPLES = 128;
/** @internal §4.3: the refit keeps this many windows (16 s at 256 ms each). */
export const CPU_FIT_WINDOWS = 64;
/** @internal Fewest windows before the refit reports (and `sections` is non-null). */
export const CPU_FIT_MIN_WINDOWS = 8;
/** @internal Frames per quantum (the Web Audio render quantum). */
export const CPU_QUANTUM_FRAMES = 128;

/** What `feed` reads of a STATUS block (a `StatusBlock` satisfies it; the mirror passes the block itself). */
export interface CpuFeed {
  /** Shell: cumulative busy ms (f64); restarts at 0 with the driver (an epoch). */
  busyMsTotal: number;
  /** Shell: cumulative quanta (f64). */
  quantaTotal: number;
  /** Core: cumulative work units by section. */
  wuVoices: number;
  wuBuses: number;
  wuSpatial: number;
  wuMusic: number;
  wuLoudness: number;
  /** Shell: the smallest non-zero `Date.now` step, ms; 0 = none yet. */
  clockStepMs: number;
  /** Shell: wall-clock steps clamped (u16, saturating). */
  clockSteps: number;
}

/** The `Audio.debug().cpu` object's sections value. */
export type CpuSections = NonNullable<AudioCpuDebug["sections"]>;

export class CpuMeter {
  /**
   * `sampleRate` fixes the quantum's duration (`128 / sampleRate` s). A hard rebuild into a new context calls
   * `setSampleRate`.
   */
  constructor(sampleRate: number = 48000) {
    void sampleRate;
    throw new Error("Cp2 (lead): CpuMeter.constructor");
  }

  /** The new context's rate: restarts the meter (a new core restarts its counters). */
  setSampleRate(sampleRate: number): void {
    void sampleRate;
    throw new Error("Cp2 (lead): CpuMeter.setSampleRate");
  }

  /**
   * Takes one STATUS block's cumulative totals (§4.3). A `quantaTotal` or `busyMsTotal` that went back is an epoch (a
   * driver restart reads as the counters returning to 0): the ring restarts and no delta is ever negative. A block with
   * no new quanta changes nothing but `clockStepMs` and `clockSteps`. No allocation.
   */
  feed(status: CpuFeed): void {
    void status;
    throw new Error("Cp2 (lead): CpuMeter.feed");
  }

  /** An EPOCH from outside (a rebuild, the capture's marker): forgets the ring and the window, keeps the sample rate. */
  epoch(): void {
    throw new Error("Cp2 (lead): CpuMeter.epoch");
  }

  /**
   * The figure, permille of a quantum: 1000 x delta busy / (delta quanta x quantum ms) over the newest window of at
   * least W quanta (W 96, 384 at a 2 ms step). `null` before the first window fills, and while hidden.
   */
  get loadPermille(): number | null {
    throw new Error("Cp2 (lead): CpuMeter.loadPermille");
  }

  /** §1.3 `Audio.debug().cpu`: a fresh object. `hidden` carries "clock too coarse (n ms)" when the clock is above 2 ms. */
  debug(): AudioCpuDebug {
    throw new Error("Cp2 (lead): CpuMeter.debug");
  }
}
