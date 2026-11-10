// The lookahead and ramp rules (ADR 0157; architecture §4.3, §4.7): pure arithmetic, no state. `ClockMap` (clock.ts)
// feeds them its frame-interval EMA Δ̄; tests call them directly.
//
// - L, the lookahead, applies to stamped records only (`at`, synced starts, replays): a stamped record's frame must be
//   at least L past *F*_now to be sure the batch arrives before it. asap records never use it.
// - `rampFrames` is the ramp length the host puts on SET_PARAMS and BUS_MIX (and MASTER): one frame interval, so a
//   per-frame change glides into the next instead of stepping, clamped so it is never a click nor sluggish.
// - `firstFrame` is the batch header's estimate: *F*_now + L, never earlier than the previous batch's.
//
// Units: `intervalMs` is Δ̄ in ms; `sampleRate` in Hz; results in sample frames.

/** §4.7 Lookahead: L's floor in frames (8 quanta). It covers Chromium's 3–4 quanta per callback and postMessage's 3–5 quanta tail. */
export const LOOKAHEAD_MIN_FRAMES = 1024;
/** §4.7 Lookahead: L's ceiling in seconds (100 ms). */
export const LOOKAHEAD_MAX_SECONDS = 0.1;
/** §4.7 Lookahead: L is this many frame intervals before the clamps. */
export const LOOKAHEAD_INTERVALS = 2;
/** §4.7 Ramps: Δ̄ clamps to this range in ms before it becomes `rampFrames`. */
export const RAMP_MIN_MS = 5;
export const RAMP_MAX_MS = 50;

/**
 * L (§4.3): round(clamp(2·Δ̄, 1,024 frames, 100 ms)) in frames. Where the clamps cross (a rate under 10,240 Hz, where
 * 100 ms is fewer than 1,024 frames) the ceiling wins, so the added latency never passes 100 ms. A non-finite or
 * negative interval counts as 0 (the floor).
 */
export function lookaheadFrames(intervalMs: number, sampleRate: number): number {
  const ms = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  const wanted = Math.max((LOOKAHEAD_INTERVALS * ms * sampleRate) / 1000, LOOKAHEAD_MIN_FRAMES);
  return Math.round(Math.min(wanted, LOOKAHEAD_MAX_SECONDS * sampleRate));
}

/** `rampFrames` (§4.3): round(clamp(Δ̄, 5 ms, 50 ms)·sr) in frames. A non-finite interval counts as the floor. */
export function rampFrames(intervalMs: number, sampleRate: number): number {
  const raw = Number.isFinite(intervalMs) ? intervalMs : RAMP_MIN_MS;
  const ms = Math.min(Math.max(raw, RAMP_MIN_MS), RAMP_MAX_MS);
  return Math.round((ms * sampleRate) / 1000);
}

/** `firstFrame` (§4.3): max(round(*F*_now + L), the previous batch's `firstFrame`), so batches never go backwards. */
export function firstFrame(framesNow: number, lookahead: number, previous: number): number {
  return Math.max(Math.round(framesNow + lookahead), previous);
}

/**
 * The context frame an `at` time (seconds on the heard clock, `Audio.time`) is for: frame *f* is heard when
 * `Audio.time` = f / sr (§4.3), so it is round(at·sr). 0 (the voice table's "asap") when `at` is omitted, non-finite
 * or not after time 0.
 */
export function frameOfTime(at: number | undefined, sampleRate: number): number {
  if (at === undefined || !Number.isFinite(at)) return 0;
  const frame = Math.round(at * sampleRate);
  return frame > 0 ? frame : 0;
}

/**
 * True when a record for `frame` is sent stamped, false when it goes asap. API §1: "past or omitted: as soon as
 * possible". A frame not after *F*_now is past for the core (it is rendering at or beyond it when the batch can
 * arrive), so stamping it would only start it at once and count it late; §4.4's late count measures the pipeline's
 * lateness (a stamped record that was ahead when sent), not a past `at`. 0 is asap.
 */
export function isStamped(frame: number, framesNow: number): boolean {
  return frame > 0 && frame > framesNow;
}
