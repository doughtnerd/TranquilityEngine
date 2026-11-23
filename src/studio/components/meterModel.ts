// A level meter's rules (ADR 0349 `Meter`): peak and RMS levels in dBFS drawn on the fader's scale (−60..+6, linear in
// dB, so a meter beside a fader lines up with it), the colour zone of a level, the scale's marks, and the peak hold and
// clip latch a meter keeps between readings (hold 1.5 s, then fall 20 dB/s; the clip light stays until it is clicked),
// as console meters do. The meter only draws values it is given; it never reads audio.
import { FADER_MAX_DB, FADER_MIN_DB, dbToPosition } from "./faderModel";

/** How long the peak hold line stays before it falls, ms. */
export const PEAK_HOLD_MS = 1500;
/** How fast the hold line falls after that, dB per second. */
export const PEAK_FALL_DB_PER_S = 20;
/** At or above this a reading is a clip, dBFS. */
export const CLIP_DB = 0;
/** At or above this a level is drawn in the warning colour, dBFS. */
export const HOT_DB = -6;

/** The scale's marks, top to bottom. */
export const METER_MARKS: readonly number[] = [6, 0, -6, -12, -24, -36, -48, -60];

/** How full the meter is for `db`, 0..1 (silence and anything below the floor are 0). */
export const meterFill = (db: number | null | undefined): number => (db == null || !(db > FADER_MIN_DB) ? 0 : dbToPosition(Math.min(FADER_MAX_DB, db)));

/** A level's colour zone. */
export const meterZone = (db: number | null | undefined): "quiet" | "ok" | "hot" | "clip" =>
  db == null || !(db > FADER_MIN_DB) ? "quiet" : db >= CLIP_DB ? "clip" : db >= HOT_DB ? "hot" : "ok";

/** A meter's memory between readings. */
export interface MeterHold {
  /** The held peak, dBFS (−∞ for none). */
  readonly holdDb: number;
  /** When it was last raised, ms. */
  readonly heldAt: number;
  /** A clip was seen since the light was last cleared. */
  readonly clipped: boolean;
}

export const EMPTY_HOLD: MeterHold = { holdDb: -Infinity, heldAt: 0, clipped: false };

/** The hold after a reading of `peakDb` at `now` (ms). */
export function nextHold(prev: MeterHold, peakDb: number | null | undefined, now: number): MeterHold {
  const peak = peakDb == null || Number.isNaN(peakDb) ? -Infinity : peakDb;
  const age = now - prev.heldAt;
  const fallen = age <= PEAK_HOLD_MS ? prev.holdDb : prev.holdDb - ((age - PEAK_HOLD_MS) / 1000) * PEAK_FALL_DB_PER_S;
  const clipped = prev.clipped || peak >= CLIP_DB;
  if (peak >= fallen) return { holdDb: peak, heldAt: now, clipped };
  return { holdDb: fallen, heldAt: prev.heldAt, clipped };
}

/** The hold with its clip light cleared. */
export const clearClip = (hold: MeterHold): MeterHold => (hold.clipped ? { ...hold, clipped: false } : hold);

/** A meter reading as text, for its tooltip and screen readers ("Peak −12.0 dBFS, RMS −18.3 dBFS"). */
export function meterText(peakDb: number | null | undefined, rmsDb?: number | null): string {
  const f = (db: number | null | undefined) => (db == null || !(db > FADER_MIN_DB) ? "silent" : `${db < 0 ? "−" : db > 0 ? "+" : ""}${Math.abs(db).toFixed(1)} dBFS`);
  return rmsDb === undefined ? `Peak ${f(peakDb)}` : `Peak ${f(peakDb)}, RMS ${f(rmsDb)}`;
}
