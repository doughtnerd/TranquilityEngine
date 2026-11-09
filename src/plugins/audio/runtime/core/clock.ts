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

  /** True once an output timestamp gave the offset. */
  private primed = false;
  /** The offset filter's value o (frames). */
  private offset = 0;
  /** The render lead Lambda (frames). */
  private lead = 0;
  /** Offset samples rejected in a row. */
  private rejectRun = 0;
  /** The previous beginFrame's rafTime (ms), valid when `hasPrevP`. */
  private prevP = 0;
  private hasPrevP = false;
  /** Delta-bar: the frame-interval EMA (ms). */
  private intervalMs = INITIAL_INTERVAL_MS;
  /** The newest STATUS pair (fallback input). */
  private statusFrame = 0;
  private statusDateMs = 0;
  private hasStatus = false;
  /** The previous nextFirstFrame result. */
  private prevFirstFrame = 0;

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
    const p = this.clock.rafTime();
    if (this.hasPrevP && p === this.prevP) return;
    let stall = false;
    if (this.hasPrevP) {
      const dt = p - this.prevP;
      if (dt > STALL_MS) stall = true;
      else if (dt > 0) this.intervalMs += INTERVAL_EMA * (dt - this.intervalMs);
    }
    this.prevP = p;
    this.hasPrevP = true;
    const ts = this.clock.outputTimestamp();
    const ct = this.clock.currentTime();
    if (ts === null) return;
    const sr = this.sampleRate;
    const heard = sr * (ts.contextTime + (p - ts.performanceTime) / 1000);
    const oObs = heard - (p * sr) / 1000;
    const lambdaObs = ct * sr - heard;
    if (!this.primed) {
      this.offset = oObs;
      this.lead = Math.max(0, lambdaObs);
      this.primed = true;
    } else if (stall) {
      this.offset = oObs;
      this.lead = Math.max(0, lambdaObs);
      this.reanchors++;
      this.rejectRun = 0;
    } else {
      const diff = oObs - this.offset;
      if (Math.abs(diff) > (OFFSET_REJECT_MS * sr) / 1000) {
        this.rejected++;
        this.rejectRun++;
        if (this.rejectRun >= REANCHOR_AFTER) {
          this.offset = oObs;
          this.updateLead(lambdaObs);
          this.reanchors++;
          this.rejectRun = 0;
        }
      } else {
        this.rejectRun = 0;
        this.offset += OFFSET_EMA * diff;
        this.updateLead(lambdaObs);
      }
    }
  }

  /** The lead envelope: attack at once, release by LEAD_RELEASE of the gap per frame; never below 0. */
  private updateLead(lambdaObs: number): void {
    if (lambdaObs > this.lead) this.lead = lambdaObs;
    else this.lead = Math.max(0, this.lead - LEAD_RELEASE * (this.lead - lambdaObs));
  }

  /** The fallback's frame now (no lookahead lead), or 0 before any STATUS block. */
  private fallbackFrame(): number {
    if (!this.hasStatus) return 0;
    return this.statusFrame + ((this.clock.dateNow() - this.statusDateMs) * this.sampleRate) / 1000;
  }

  /**
   * §4.3 fallback input: the newest STATUS block's `currentFrame` and `dateMs` (`StatusMirror.frameAudio`,
   * `frameDateMs`). Used while there is no usable output timestamp.
   */
  noteStatus(currentFrame: number, dateMs: number): void {
    this.statusFrame = currentFrame;
    this.statusDateMs = dateMs;
    this.hasStatus = true;
  }

  /** True once an output timestamp gave an offset (the primary path); false while on the fallback or before anything. */
  get anchored(): boolean {
    return this.primed;
  }

  /** The offset filter's value *o*, in frames (0 until anchored). */
  get offsetFrames(): number {
    return this.offset;
  }

  /** The render lead Λ, in frames (0 until anchored). */
  get leadFrames(): number {
    return this.lead;
  }

  /** Δ̄: the EMA of frame intervals, ms. */
  get frameIntervalMs(): number {
    return this.intervalMs;
  }

  /** `Audio.time` in seconds (§4.3): the heard clock; 0 before the clock has any estimate. */
  audioTime(): number {
    if (this.primed) {
      return Math.max(0, ((this.prevP * this.sampleRate) / 1000 + this.offset) / this.sampleRate);
    }
    return Math.max(0, this.fallbackFrame() / this.sampleRate);
  }

  /** *F*_now (§4.3): the frame the core will render when a command sent in this frame arrives; 0 before any estimate. */
  framesNow(): number {
    if (this.primed) {
      return ((this.prevP * this.sampleRate) / 1000) + this.offset + this.lead;
    }
    if (!this.hasStatus) return 0;
    return this.fallbackFrame() + FALLBACK_LEAD_FRAMES;
  }

  /** L (§4.3): the lookahead in frames. */
  lookaheadFrames(): number {
    const sr = this.sampleRate;
    const wanted = Math.max((2 * this.intervalMs * sr) / 1000, LOOKAHEAD_MIN_FRAMES);
    return Math.round(Math.min(wanted, LOOKAHEAD_MAX_SECONDS * sr));
  }

  /** `rampFrames` (§4.3): the ramp length for SET_PARAMS and BUS_MIX, in frames. */
  rampFrames(): number {
    const ms = Math.min(Math.max(this.intervalMs, RAMP_MIN_MS), RAMP_MAX_MS);
    return Math.round((ms * this.sampleRate) / 1000);
  }

  /**
   * §4.3 `firstFrame`: max(round(*F*_now + L), the previous call's result). Each call records its result as the
   * previous one, so the sequence never goes backwards.
   */
  nextFirstFrame(): number {
    const frameNow = this.framesNow();
    const candidate = Math.round(frameNow + this.lookaheadFrames());
    const result = Math.max(candidate, this.prevFirstFrame);
    this.prevFirstFrame = result;
    return result;
  }

  /** Forgets every estimate (a rebuild, a new context). Counters stay. */
  reset(): void {
    this.primed = false;
    this.offset = 0;
    this.lead = 0;
    this.rejectRun = 0;
    this.prevP = 0;
    this.hasPrevP = false;
    this.statusFrame = 0;
    this.statusDateMs = 0;
    this.hasStatus = false;
    this.prevFirstFrame = 0;
    this.intervalMs = INITIAL_INTERVAL_MS;
  }
}
