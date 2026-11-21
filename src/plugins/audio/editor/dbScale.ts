// The audio editor's dB scale (ADR 0157 §7), pure: no Preact, no editor SDK, so the mixer's meter model can use it
// without pulling a view in. One place for the gain/dB conversions, the meter bar's scale and the dB readouts the mixer
// strips, the profiler tables, the capture tracks and the debug monitor show. `BusMeters.tsx` re-exports the meter names.

/** The quietest level a bar or a fader readout shows, in dB; anything under it is empty (or "-inf"). */
export const METER_FLOOR_DB = -60;

/** A linear gain in dB: 20 log10, `-Infinity` for 0, negatives and NaN; never NaN. */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

/** dB to a linear gain (`-Infinity` and NaN give 0). */
export function dbToGain(db: number): number {
  return db > -Infinity ? Math.pow(10, db / 20) : 0;
}

/** A linear peak as a 0..1 bar length on a dB scale from `METER_FLOOR_DB` to 0 (clipping over 0 dB fills the bar). */
export function meterFill(peak: number): number {
  const db = gainToDb(peak);
  return db <= METER_FLOOR_DB ? 0 : db >= 0 ? 1 : (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

/** A dB figure, one decimal: "-6.0 dB"; "-inf dB" for silence (and NaN), "+inf dB" for infinity. */
export function formatDb(db: number): string {
  if (db === -Infinity || Number.isNaN(db)) return "-inf dB";
  if (db === Infinity) return "+inf dB";
  return `${db.toFixed(1)} dB`;
}

/** A gain as the fader's readout, signed to one decimal: "-inf" (silence, or under `METER_FLOOR_DB`), "0.0 dB", "-6.0 dB", "+3.5 dB". */
export function formatGainDb(gain: number): string {
  const db = gainToDb(gain);
  if (db < METER_FLOOR_DB) return "-inf";
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? "+" : ""}${(r === 0 ? 0 : r).toFixed(1)} dB`;
}

/** Gain reduction in dB (>= 0) from a duck gain (1 = not ducked): NaN and over-unity read as none, a full duck (gain 0) as 99, not infinity. */
export function gainReductionDb(duckGain: number): number {
  if (!(duckGain < 1)) return 0;
  return Math.min(99, -gainToDb(duckGain));
}
