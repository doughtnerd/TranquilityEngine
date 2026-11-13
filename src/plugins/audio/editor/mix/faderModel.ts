// The mixer fader's dB taper (ADR 0171 api-and-models §7 names "dB taper" for faderModel; ADR 0172 doesn't change it).
// The design gives no numbers, so this module fixes them, matching the existing editor: a bus volume is a linear
// multiplier 0..2 (`AudioSettingsSection`), and the meter bar's floor is -60 dB (`METER_FLOOR_DB`).
//
// Taper (position p in 0..1, the fader travel):
//   p = 0            silence: gain 0, -Infinity dB
//   0 < p <= UNITY   dB rises linearly from FADER_FLOOR_DB (-60) to 0 dB at p = UNITY_POSITION (0.75)
//   UNITY < p <= 1   dB rises linearly from 0 to FADER_MAX_DB (+6.0206 dB, gain 2, the volume's upper bound)
// Gain is 10^(dB/20). Between p = 0 and the first step the gain jumps from 0 to -60 dB: the fader's bottom is a
// mute notch, as on a console. Pure TypeScript; no DOM.

/** The quietest non-silent fader level, in dB. Same as the meter floor. */
export const FADER_FLOOR_DB = -60;
/** The loudest fader level, in dB: gain 2, the upper bound of `Bus.volume` in the settings. */
export const FADER_MAX_DB = 20 * Math.log10(2);
/** The maximum linear gain (position 1). */
export const FADER_MAX_GAIN = 2;
/** The fader position of unity gain (0 dB, gain 1). */
export const UNITY_POSITION = 0.75;
/** A drag within this distance of `UNITY_POSITION` snaps to it. */
export const SNAP_RADIUS = 0.02;
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
  return dbToPosition(20 * Math.log10(gain));
}

/** A linear gain to dB (`-Infinity` for 0, negative and NaN). For the readout beside the fader. */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

/** dB to a linear gain (`-Infinity` and NaN give 0). */
export function dbToGain(db: number): number {
  return db > -Infinity ? Math.pow(10, db / 20) : 0;
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

/** The gain a drag lands on (`dragPosition` then `positionToGain`). */
export function dragGain(startGain: number, delta: number, fine = false): number {
  return positionToGain(dragPosition(gainToPosition(startGain), delta, fine));
}

/** A readout string for a gain: "-inf", "0.0 dB", "-6.0 dB", "+3.5 dB". */
export function formatDb(gain: number): string {
  const db = gainToDb(gain);
  if (db === -Infinity) return "-inf";
  if (db < FADER_FLOOR_DB) return "-inf";
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? "+" : ""}${(r === 0 ? 0 : r).toFixed(1)} dB`;
}
