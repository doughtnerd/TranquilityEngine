/**
 * Internal (ADR 0330): decibels and linear gain for the mix in `audio.json`. A fader's floor, `MIN_DB`, is silence (−∞):
 * a level at or below it is a gain of 0, and a gain of 0 is `MIN_DB`. The ceiling, `MAX_DB`, is the old linear model's
 * top (a gain of 2, about +6.02 dB), so a migrated mix keeps every level it had.
 *
 * Pure; no plugin, no DOM.
 */

/** The fader floor: at or below it is silence. */
export const MIN_DB = -60;
/** The fader ceiling: the linear model's gain of 2. */
export const MAX_DB = 20 * Math.log10(2);

/** `x` rounded to 9 decimals, so a level converted to dB and back reads as it was written (0.8, not 0.7999999999999999). */
export const tidy = (x: number): number => Math.round(x * 1e9) / 1e9;

/** The linear gain of `db`: 0 at or below `MIN_DB`. */
export function dbToGain(db: number): number {
  return db <= MIN_DB ? 0 : tidy(Math.pow(10, db / 20));
}

/** The level in dB of a linear `gain`: `MIN_DB` at or below the floor's gain. Not rounded, so it converts back exactly. */
export function gainToDb(gain: number): number {
  return gain <= Math.pow(10, MIN_DB / 20) ? MIN_DB : 20 * Math.log10(gain);
}

/** `db` clamped to the fader's range. */
export const clampDb = (db: number): number => Math.min(MAX_DB, Math.max(MIN_DB, db));
