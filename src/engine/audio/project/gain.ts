/**
 * Internal (ADR 0344): decibels and linear gain for the mix in `audio.json`. A fader's floor, `MIN_DB`, is silence (−∞):
 * a level at or below it is a gain of 0, and a gain of 0 is `MIN_DB`. The ceiling, `MAX_DB`, is the old linear model's
 * top (a gain of 2, about +6.02 dB), so a migrated mix keeps every level it had.
 *
 * The law itself is the audio runtime's (`../decibels.ts`, ADR 0456); this module adds the fader's range and rounding.
 *
 * Pure; no plugin, no DOM.
 */
import { dbToGain as lawGain, gainToDb, SILENCE_DB } from "../decibels";

/** The fader floor: at or below it is silence. */
export const MIN_DB = SILENCE_DB;
/** The fader ceiling: the linear model's gain of 2. */
export const MAX_DB = 20 * Math.log10(2);

/** `x` rounded to 9 decimals, so a level converted to dB and back reads as it was written (0.8, not 0.7999999999999999). */
export const tidy = (x: number): number => Math.round(x * 1e9) / 1e9;

/** The linear gain of `db` (the runtime's law, tidied): 0 at or below `MIN_DB`. */
export const dbToGain = (db: number): number => tidy(lawGain(db));

/**
 * The shortest level in dB (fewest decimals, up to 9) that, with `offset` dB added, reads back as `gain`
 * (`dbToGain(level + offset) === gain`), clamped to the fader's range: so a converted level is written as -6.0206, not
 * -6.020599913279624, and an undo through the linear view lands on the level it left (-6, not -6.0000000057).
 */
export function levelDbOf(gain: number, offset = 0, clamp = true): number {
  const limit = clamp ? clampDb : (db: number) => Math.max(MIN_DB, db);
  const exact = gainToDb(gain) - offset;
  for (let places = 0; places <= 9; places++) {
    const f = Math.pow(10, places);
    const c = limit(Math.round(exact * f) / f);
    if (dbToGain(c + offset) === gain) return c;
  }
  return limit(exact);
}

/** `db` clamped to the fader's range. */
export const clampDb = (db: number): number => Math.min(MAX_DB, Math.max(MIN_DB, db));
