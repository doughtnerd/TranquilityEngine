// The clock map (ADR 0157; architecture §4.3, §4.5, §4.7): turns the host's clocks into "which audio frame is
// being heard now" (`Audio.time`) and "which frame will the core render when a command sent now arrives"
// (`firstFrame`). Pure arithmetic over a `HostClock` (hostClock.ts, K4): no timers, no globals, no allocation per
// frame. A1.4 wrote the offset filter, the render lead and the fallback; A3.2 moved the lookahead and ramp rules to
// `lookahead.ts`, added the stamp-or-asap rule for `at` (`stampFor`) and re-anchors when an output timestamp comes
// back after a gap (a suspended or interrupted context). A2.9 adds the core's fixed output latency (the master
// limiter's look-ahead, `limiterLatency.ts`): a frame the core renders at context frame f leaves the core D frames
// later, so `Audio.time` (the heard clock, in the core's frames) is the heard context frame less D. Everything that
// talks to the core (*F*_now, `firstFrame`, stamps) stays in the core's frames, so `at` = f / sr is heard exactly
// when `Audio.time` reads it.
//
// Units: `p` is a frame's rAF time in ms (the `performance.now()` base). Frames are sample frames at the context rate
// `sr`. The offset `o` and the lead Λ are in frames. Seconds only in `audioTime`.
import type { HostClock } from "./hostClock";
import { firstFrame, frameOfTime, isStamped, lookaheadFrames, rampFrames } from "./lookahead";

export { LOOKAHEAD_MAX_SECONDS, LOOKAHEAD_MIN_FRAMES, RAMP_MAX_MS, RAMP_MIN_MS } from "./lookahead";

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

/** §4.3 as one object. One per host. */
export class ClockMap {
  /** Offset samples rejected since construction (diagnostics, `Audio.debug()`). */
  rejected = 0;
  /** Times the offset re-anchored: after `REANCHOR_AFTER` rejections in a row, or after a stall. */
  reanchors = 0;

  /** True once an output timestamp gave the offset. */
  private primed = false;
  /** True when a frame since priming had no output timestamp: the next one re-anchors (§4.5). */
  private gap = false;
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
  private rate: number;
  private latencyFrames: number;
  /**
   * A3.4c: seconds added to the core's clock to give `Audio.time` (0 until the first context swap). A new context starts
   * its frames at 0; this keeps `Audio.time` continuous and monotonic for the game, so `at` times it computed from it
   * keep their meaning: frame f of the current context is heard when `Audio.time` = f / sr + `timeOffset`.
   */
  private offsetSeconds = 0;
  /** A3.4c: the old context's `Audio.time` at the swap and the rAF time it was read at, until the new clock has an estimate. */
  private carry: { readonly time: number; readonly p: number } | null = null;
  /** The newest `audioTime()` result, held while there is no estimate (after a reset). */
  private lastTime = 0;

  constructor(
    private readonly clock: HostClock,
    /** The context's sample rate, Hz. */
    sampleRate: number,
    /** The core's output latency in frames (`limiterLatencyFrames` of the preset's look-ahead): a rendered frame is heard this much later. */
    outputLatencyFrames = 0,
  ) {
    this.rate = sampleRate;
    this.latencyFrames = outputLatencyFrames;
  }

  /** The context's sample rate, Hz (a context swap changes it, `rebase`). */
  get sampleRate(): number {
    return this.rate;
  }

  /** The core's output latency in frames at `sampleRate`. */
  get outputLatencyFrames(): number {
    return this.latencyFrames;
  }

  /** A3.4c: seconds between the current context's frame timeline and `Audio.time` (see `rebase`). */
  get timeOffset(): number {
    return this.offsetSeconds;
  }

  /** A3.4c: true from a `rebase` until the new context's clock gave its first estimate (`timeOffset` is not known yet). */
  get carryPending(): boolean {
    return this.carry !== null;
  }

  /**
   * A3.4c: where `Audio.time` is now and the rAF time it is for (the last frame's *p* once anchored), for a later
   * `rebase`: read it while the old context still runs.
   */
  carryPoint(): { readonly time: number; readonly p: number } {
    return { time: this.audioTime(), p: this.primed ? this.prevP : this.clock.rafTime() };
  }

  /**
   * A3.4c, a rebuild into a new context (architecture §3.7): forgets every estimate, takes the new context's rate and
   * the core's output latency at it, and carries `Audio.time` across: until the new context's clock has an estimate,
   * `audioTime()` holds `from.time`; at its first estimate `timeOffset` is set so `Audio.time` continues from
   * `from.time` plus the rAF time elapsed since `from.p` (never below what it last returned). The new context's frames
   * start again at 0, and every frame this map hands out (*F*_now, `firstFrame`, stamps) is in them.
   */
  rebase(sampleRate: number, outputLatencyFrames: number, from: { readonly time: number; readonly p: number }): void {
    this.reset();
    this.rate = sampleRate;
    this.latencyFrames = outputLatencyFrames;
    this.carry = { time: Math.max(from.time, this.lastTime), p: from.p };
    this.lastTime = this.carry.time;
  }

  /** The carry resolves at the new clock's first estimate. */
  private resolveCarry(): void {
    const carry = this.carry;
    if (!carry || (!this.primed && !this.hasStatus)) return;
    this.carry = null;
    const p = this.primed ? this.prevP : this.clock.rafTime();
    const target = Math.max(carry.time + Math.max(0, p - carry.p) / 1000, this.lastTime);
    this.offsetSeconds = target - this.rawTime();
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
    if (ts === null) {
      if (this.primed) this.gap = true;
      return;
    }
    const sr = this.sampleRate;
    const heard = sr * (ts.contextTime + (p - ts.performanceTime) / 1000);
    const oObs = heard - (p * sr) / 1000;
    const lambdaObs = ct * sr - heard;
    if (!this.primed) {
      this.offset = oObs;
      this.lead = Math.max(0, lambdaObs);
      this.primed = true;
    } else if (stall || this.gap) {
      // A stall or a frame without a timestamp (the context suspended or interrupted): the old offset says nothing
      // about the new one, so take the sample as it is rather than reject ten in a row.
      this.gap = false;
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
    this.resolveCarry();
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
    this.resolveCarry();
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

  /**
   * `Audio.time` in seconds (§4.3): the heard clock, as the core frame being heard: the context frame at the output
   * less the core's output latency, so frame f renders for `at` = f / sr and is heard when this reads f / sr. 0 before
   * the clock has any estimate. A3.4c: plus `timeOffset` after a context swap; with no estimate (after a reset) it
   * holds the last value it returned, so a rebuild never sends it backwards.
   */
  audioTime(): number {
    if (this.carry) {
      this.resolveCarry();
      if (this.carry) return this.carry.time;
    }
    if (!this.primed && !this.hasStatus) return this.lastTime;
    const t = this.rawTime() + this.offsetSeconds;
    this.lastTime = t;
    return t;
  }

  /** `audioTime()` on the current context's own timeline (no `timeOffset`). */
  private rawTime(): number {
    if (this.primed) {
      return Math.max(0, ((this.prevP * this.sampleRate) / 1000 + this.offset - this.outputLatencyFrames) / this.sampleRate);
    }
    return Math.max(0, (this.fallbackFrame() - this.outputLatencyFrames) / this.sampleRate);
  }

  /** *F*_now (§4.3): the frame the core will render when a command sent in this frame arrives; 0 before any estimate. */
  framesNow(): number {
    if (this.primed) {
      return ((this.prevP * this.sampleRate) / 1000) + this.offset + this.lead;
    }
    if (!this.hasStatus) return 0;
    return this.fallbackFrame() + FALLBACK_LEAD_FRAMES;
  }

  /** L (§4.3, `lookahead.ts`): the lookahead in frames. Applies to stamped records only. */
  lookaheadFrames(): number {
    return lookaheadFrames(this.intervalMs, this.sampleRate);
  }

  /** `rampFrames` (§4.3, `lookahead.ts`): the ramp length for SET_PARAMS and BUS_MIX, in frames. */
  rampFrames(): number {
    return rampFrames(this.intervalMs, this.sampleRate);
  }

  /**
   * The context frame for an `at` time on the heard clock (`Audio.time` seconds), or 0 (asap) when omitted or
   * non-finite. A3.4c: `at` is on `Audio.time`, which runs `timeOffset` ahead of the current context's frames.
   */
  frameOfTime(at: number | undefined): number {
    return frameOfTime(at === undefined ? undefined : at - this.offsetSeconds, this.sampleRate);
  }

  /**
   * The frame a record for `frame` (from `frameOfTime`) is stamped with, or undefined to send it asap: a frame not
   * after *F*_now is past (API §1: "past: as soon as possible"; `lookahead.ts` `isStamped`).
   */
  stampFor(frame: number): number | undefined {
    return isStamped(frame, this.framesNow()) ? frame : undefined;
  }

  /**
   * §4.3 `firstFrame`: max(round(*F*_now + L), the previous call's result). Each call records its result as the
   * previous one, so the sequence never goes backwards.
   */
  nextFirstFrame(): number {
    const result = firstFrame(this.framesNow(), this.lookaheadFrames(), this.prevFirstFrame);
    this.prevFirstFrame = result;
    return result;
  }

  /**
   * A3.4b (§3.8, §4.5): the next frame takes its output timestamp as the new offset instead of filtering it (a tab
   * that became visible, a context resumed). Keeps the other estimates and the first-frame monotonicity.
   */
  reanchor(): void {
    if (this.primed) this.gap = true;
    this.hasPrevP = false;
  }

  /** Forgets every estimate (a rebuild, a new context). Counters stay. */
  reset(): void {
    this.primed = false;
    this.gap = false;
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
