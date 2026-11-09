// The clock map, v1 (ADR 0157; architecture §4.3, §4.5, §4.7): turns the host's clocks into "which audio frame is
// being heard now" (`Audio.time`) and "which frame will the core render when a command sent now arrives"
// (`firstFrame`). Pure arithmetic over a `HostClock` (hostClock.ts, K4): no timers, no globals, no allocation per
// frame. A3.2 later replaces the lookahead and ramp rules with `lookahead.ts` and adds late counting; the offset
// filter, the render lead and the fallback stay.
//
// Units: `p` is a frame's rAF time in ms (the `performance.now()` base). Frames are sample frames at the context rate
// `sr`. The offset `o` and the lead Λ are in frames. Seconds only in `audioTime`.
import type { HostClock } from "./hostClock";

/** §4.7 Clock: the offset filter's EMA gain. */
export const OFFSET_EMA = 0.1;
/** §4.7 Clock: an offset sample more than this many ms off the filtered offset is rejected. */
export const OFFSET_REJECT_MS = 5;
/** §4.7 Clock: this many rejections in a row re-anchor the offset to the newest sample. */
export const REANCHOR_AFTER = 10;
/** §4.7 Clock: the render lead Λ releases by this fraction of its distance to the observation per frame. */
export const LEAD_RELEASE = 0.01;
/** §4.7 Clock: the fallback adds this many frames of lead. */
export const FALLBACK_LEAD_FRAMES = 512;
/** §4.3: the frame-interval EMA's gain (Δ̄). */
export const INTERVAL_EMA = 0.1;
/** The frame-interval EMA starts here (ms, 60 Hz). */
export const INITIAL_INTERVAL_MS = 1000 / 60;
/** A gap between two frames longer than this (ms) is a stall or a hidden tab: re-anchor (§4.5), leave Δ̄ alone. */
export const STALL_MS = 250;
/** §4.3 L: the lookahead floor in frames (8 quanta). */
export const LOOKAHEAD_MIN_FRAMES = 1024;
/** §4.3 L: the lookahead ceiling in seconds. */
export const LOOKAHEAD_MAX_SECONDS = 0.1;
/** §4.3 `rampFrames`: Δ̄ clamps to this range in ms. */
export const RAMP_MIN_MS = 5;
export const RAMP_MAX_MS = 50;

/** §4.3 as one object. One per host. */
export class ClockMap {
  /** Offset samples rejected since construction (diagnostics, `Audio.debug()`). */
  rejected = 0;
  /** Times the offset re-anchored: after `REANCHOR_AFTER` rejections in a row, or after a stall. */
  reanchors = 0;

  constructor(
    private readonly clock: HostClock,
    /** The context's sample rate, Hz. */
    readonly sampleRate: number,
  ) {
    void this.clock;
  }

  /**
   * Called once per frame, first. Reads `clock.rafTime()` (*p*), `outputTimestamp()` and `currentTime()` and updates
   * the filters (the A1.4-L1 spec in the brief). Does nothing the second time in the same frame (same `rafTime`).
   */
  beginFrame(): void {
    throw new Error("not implemented: A1.4-L1 (ClockMap.beginFrame)");
  }

  /**
   * §4.3 fallback input: the newest STATUS block's `currentFrame` and `dateMs` (`StatusMirror.frameAudio`,
   * `frameDateMs`). Used while there is no usable output timestamp.
   */
  noteStatus(currentFrame: number, dateMs: number): void {
    void currentFrame;
    void dateMs;
    throw new Error("not implemented: A1.4-L1 (ClockMap.noteStatus)");
  }

  /** True once an output timestamp gave an offset (the primary path); false while on the fallback or before anything. */
  get anchored(): boolean {
    throw new Error("not implemented: A1.4-L1 (ClockMap.anchored)");
  }

  /** The offset filter's value *o*, in frames (0 until anchored). */
  get offsetFrames(): number {
    throw new Error("not implemented: A1.4-L1 (ClockMap.offsetFrames)");
  }

  /** The render lead Λ, in frames (0 until anchored). */
  get leadFrames(): number {
    throw new Error("not implemented: A1.4-L1 (ClockMap.leadFrames)");
  }

  /** Δ̄: the EMA of frame intervals, ms. */
  get frameIntervalMs(): number {
    throw new Error("not implemented: A1.4-L1 (ClockMap.frameIntervalMs)");
  }

  /** `Audio.time` in seconds (§4.3): the heard clock; 0 before the clock has any estimate. */
  audioTime(): number {
    throw new Error("not implemented: A1.4-L1 (ClockMap.audioTime)");
  }

  /** *F*_now (§4.3): the frame the core will render when a command sent in this frame arrives; 0 before any estimate. */
  framesNow(): number {
    throw new Error("not implemented: A1.4-L1 (ClockMap.framesNow)");
  }

  /** L (§4.3): the lookahead in frames. */
  lookaheadFrames(): number {
    throw new Error("not implemented: A1.4-L1 (ClockMap.lookaheadFrames)");
  }

  /** `rampFrames` (§4.3): the ramp length for SET_PARAMS and BUS_MIX, in frames. */
  rampFrames(): number {
    throw new Error("not implemented: A1.4-L1 (ClockMap.rampFrames)");
  }

  /**
   * §4.3 `firstFrame`: max(round(*F*_now + L), the previous call's result). Each call records its result as the
   * previous one, so the sequence never goes backwards.
   */
  nextFirstFrame(): number {
    throw new Error("not implemented: A1.4-L1 (ClockMap.nextFirstFrame)");
  }

  /** Forgets every estimate (a rebuild, a new context). Counters stay. */
  reset(): void {
    throw new Error("not implemented: A1.4-L1 (ClockMap.reset)");
  }
}
