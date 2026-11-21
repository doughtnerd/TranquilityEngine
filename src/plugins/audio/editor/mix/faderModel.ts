// The mixer fader's dB taper (ADR 0171 api-and-models §7 names "dB taper" for faderModel; ADR 0172 doesn't change it).
// The design gives no numbers, so this module fixes them, matching the existing editor: a bus volume is a linear
// multiplier 0..2 (`AudioSettingsSection`), and the meter bar's floor is -60 dB (`METER_FLOOR_DB`).
//
// Taper (position p in 0..1, the fader travel):
//   p = 0            silence: gain 0, -Infinity dB
//   0 < p <= UNITY   dB rises linearly from FADER_FLOOR_DB (-60) to 0 dB at p = UNITY_POSITION (0.75)
//   UNITY < p <= 1   dB rises linearly from 0 to FADER_MAX_DB (+6.0206 dB, gain 2, the volume's upper bound)
// Gain is 10^(dB/20). Between p = 0 and the first step the gain jumps from 0 to -60 dB: the fader's bottom is a
// mute notch, as on a console. Pure TypeScript; no DOM. The gain/dB conversions and the readout are the dB scale's
// (`../dbScale.ts`).
import { METER_FLOOR_DB, gainToDb } from "../dbScale";

/** The quietest non-silent fader level, in dB. Same as the meter floor. */
const FADER_FLOOR_DB = METER_FLOOR_DB;
/** The loudest fader level, in dB: gain 2, the upper bound of `Bus.volume` in the settings. */
export const FADER_MAX_DB = gainToDb(2);
/** The maximum linear gain (position 1). */
export const FADER_MAX_GAIN = 2;
/** The fader position of unity gain (0 dB, gain 1). */
export const UNITY_POSITION = 0.75;
/** A drag within this distance of `UNITY_POSITION` snaps to it. */
const SNAP_RADIUS = 0.02;
/** Fine drag (a modifier key held) moves the position this fraction of the pointer travel. */
export const FINE_DRAG_SCALE = 0.1;

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/** Position 0..1 to dB; position 0 is `-Infinity`. A non-finite or out-of-range position is clamped (NaN reads as 0). */
export function positionToDb(position: number): number {
  const p = clamp01(position);
  if (p === 0) return -Infinity;
  if (p === UNITY_POSITION) return 0;
  if (p < UNITY_POSITION) return FADER_FLOOR_DB * (1 - p / UNITY_POSITION);
  return (FADER_MAX_DB * (p - UNITY_POSITION)) / (1 - UNITY_POSITION);
}

/** dB to position 0..1, the inverse of `positionToDb`. `-Infinity`, NaN and anything under the floor give 0 (silence); over `FADER_MAX_DB` gives 1. */
export function dbToPosition(db: number): number {
  if (!(db >= FADER_FLOOR_DB)) return 0;
  if (db >= FADER_MAX_DB) return 1;
  if (db <= 0) return UNITY_POSITION * (1 - db / FADER_FLOOR_DB);
  return UNITY_POSITION + ((1 - UNITY_POSITION) * db) / FADER_MAX_DB;
}

/** Position 0..1 to a linear gain 0..2 (position 0 is exactly 0, position `UNITY_POSITION` is exactly 1). */
export function positionToGain(position: number): number {
  const p = clamp01(position);
  if (p === 0) return 0;
  if (p === UNITY_POSITION) return 1;
  if (p === 1) return FADER_MAX_GAIN;
  return Math.pow(10, positionToDb(p) / 20);
}

/** A linear gain to the fader position; gain at or under -60 dB (and 0, negative, NaN) is position 0, gain over 2 is 1. */
export function gainToPosition(gain: number): number {
  if (!(gain > 0)) return 0;
  if (gain === 1) return UNITY_POSITION;
  return dbToPosition(gainToDb(gain));
}

/** Snap a position to `UNITY_POSITION` when within `SNAP_RADIUS` of it; otherwise the clamped position. */
export function snapToUnity(position: number): number {
  const p = clamp01(position);
  return Math.abs(p - UNITY_POSITION) <= SNAP_RADIUS ? UNITY_POSITION : p;
}

/**
 * One drag step: the position after the pointer moved `delta` of the fader's travel (positive up), from `start`.
 * `fine` scales the movement by `FINE_DRAG_SCALE`. The result is clamped and snapped to unity.
 * Compute from the drag's start position and the total delta, not step by step, so snapping never sticks.
 */
export function dragPosition(start: number, delta: number, fine = false): number {
  return snapToUnity(clamp01(start) + delta * (fine ? FINE_DRAG_SCALE : 1));
}
