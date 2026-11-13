// Mixer meters (ADR 0171 api-and-models §7): `meterFill`'s bar plus a peak hold and a clip latch. The bar's fill is
// `meterFill(peak)` unchanged. `Bus.peak` is the core's newest peak, already falling at 20 dB/s and rising at once
// (goal.md bus meters), so the live bar needs no smoothing here. The design gives no hold time; this module chooses
// 1500 ms, then a fall at the core's rate, 20 dB/s. The latch trips at 0 dBFS or over (the same level at which
// `meterFill` fills the bar) and stays until `resetClip`. All time is the `nowMs` the caller passes (the poll's
// clock or a test's): no timers, no `Date.now`. Pure TypeScript; no DOM.
import { METER_FLOOR_DB, meterFill } from "../meterFill";

/** How long the held peak stays put before it falls, in ms. */
export const PEAK_HOLD_MS = 1500;
/** The held peak's fall rate once the hold time has passed, in dB per second (the core's own meter fall rate). */
export const PEAK_FALL_DB_PER_S = 20;
/** A linear peak at or over this latches the clip (0 dBFS). */
export const CLIP_PEAK = 1;

/** A meter's state; treat it as immutable (every function returns a new one). */
export interface MeterState {
  /** The held peak, linear (0 when none). */
  readonly hold: number;
  /** When the hold last rose to or was refreshed by the live peak, in ms; it starts to fall `PEAK_HOLD_MS` after. */
  readonly holdSinceMs: number;
  /** The clock of the last `tickMeter`, in ms (NaN before the first). */
  readonly lastMs: number;
  /** True once a peak reached `CLIP_PEAK`, until `resetClip`. */
  readonly clipped: boolean;
}

/** What a view draws from one tick. */
export interface MeterReading {
  /** The live bar, 0..1: exactly `meterFill(peak)`. */
  readonly fill: number;
  /** The hold marker's position, 0..1 (`meterFill` of the held peak). */
  readonly holdFill: number;
  /** The clip lamp. */
  readonly clipped: boolean;
}

/** A fresh meter: nothing held, no clip. */
export function createMeter(): MeterState {
  return { hold: 0, holdSinceMs: 0, lastMs: NaN, clipped: false };
}

/**
 * Feed one reading: `peak` (linear, as `Bus.peak`) at `nowMs`. The hold rises at once to a higher peak and restarts
 * its timer when the peak equals or passes it; otherwise it stays `PEAK_HOLD_MS`, then falls `PEAK_FALL_DB_PER_S`
 * (continuously, whatever the tick spacing) and is dropped once under the bar's floor. A clock that goes backwards
 * is treated as no time passing. A NaN or negative peak reads as 0.
 */
export function tickMeter(state: MeterState, peak: number, nowMs: number): MeterState {
  const p = peak > 0 ? peak : 0;
  let hold = state.hold;
  let holdSinceMs = state.holdSinceMs;
  if (hold > 0 && state.lastMs === state.lastMs) {
    const fallFrom = Math.max(state.lastMs, holdSinceMs + PEAK_HOLD_MS);
    const dt = nowMs - fallFrom;
    if (dt > 0) hold *= Math.pow(10, (-PEAK_FALL_DB_PER_S * dt) / 1000 / 20);
  }
  if (hold <= Math.pow(10, METER_FLOOR_DB / 20)) hold = 0;
  if (p > 0 && p >= hold) {
    hold = p;
    holdSinceMs = nowMs;
  }
  return { hold, holdSinceMs, lastMs: nowMs, clipped: state.clipped || p >= CLIP_PEAK };
}

/** The bar, hold marker and lamp for a state and the live peak (the one passed to the last `tickMeter`). */
export function readMeter(state: MeterState, peak: number): MeterReading {
  return { fill: meterFill(peak), holdFill: meterFill(state.hold), clipped: state.clipped };
}

/** Clear the clip latch (a click on the lamp, Reset, a new Play); the hold is kept. */
export function resetClip(state: MeterState): MeterState {
  return state.clipped ? { ...state, clipped: false } : state;
}

/** Clear everything (a new Play): hold and latch. */
export function resetMeter(): MeterState {
  return createMeter();
}
