/**
 * Internal (ADR 0456): the audio runtime's one decibel law. At or below `SILENCE_DB` (−60 dB, the Audio Studio's dB floor,
 * decision log D8) a level is silence, a gain of 0; above it the gain is `10^(dB/20)`. Every place that turns an authored
 * dB value (a fader, a curve key, a sequence track, an attenuation or occlusion curve, a normalise gain) into a linear gain
 * uses this, so a value at the editors' −60 minimum is silent everywhere, not 0.001 in some places.
 *
 * Meters and other displays that show −∞ for silence (`plugins/audio/editor/dbScale.ts`) are a separate concept.
 *
 * Pure; no plugin, no DOM.
 */

/** The dB floor: a level at or below it is silence (gain 0). */
export const SILENCE_DB = -60;

/** The linear gain of `SILENCE_DB` (0.001): the quietest gain that is not silence. */
const SILENCE_GAIN = Math.pow(10, SILENCE_DB / 20);

/** The linear gain of `db`: 0 at or below `SILENCE_DB`; an unset (NaN) level is unity, 1. */
export function dbToGain(db: number): number {
  if (db !== db) return 1;
  return db <= SILENCE_DB ? 0 : Math.pow(10, db / 20);
}

/** The level in dB of a linear `gain`: `SILENCE_DB` at or below the floor's gain (0 included). */
export function gainToDb(gain: number): number {
  return gain <= SILENCE_GAIN ? SILENCE_DB : 20 * Math.log10(gain);
}

/** The playback-rate ratio of a pitch shift of `semitones` (12 semitones is 2). */
export const semitonesToRatio = (semitones: number): number => Math.pow(2, semitones / 12);
