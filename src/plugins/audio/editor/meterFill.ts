// The meter bar's dB scale (ADR 0157 §7), pure: no Preact, no editor SDK, so the mixer's meter model can use it
// without pulling a view in. `BusMeters.tsx` re-exports both names.

/** The quietest level a bar shows, in dB; anything under it is empty. */
export const METER_FLOOR_DB = -60;

/** A linear peak as a 0..1 bar length on a dB scale from `METER_FLOOR_DB` to 0 (clipping over 0 dB fills the bar). */
export function meterFill(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  return db <= METER_FLOOR_DB ? 0 : db >= 0 ? 1 : (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
}
