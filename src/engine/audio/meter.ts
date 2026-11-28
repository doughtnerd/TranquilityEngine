/**
 * Internal (ADR 0456): a time signature written `"n/d"` (a sequence's or a sample's `tempo.meter`). One place knows what
 * a valid meter is (one or two digits each side, neither zero), how a format reads one leniently, and what a meter
 * means as a music grid's `beatsPerBar` and `beatUnit` (`musicGrid.ts`'s `TempoMarker`), with 4/4 for anything else.
 *
 * Pure; no plugin, no DOM.
 */
import type { LenientReader } from "./lenientRead";

/** The meter a missing or bad one reads as. */
export const DEFAULT_METER = "4/4";

const METER = /^\d{1,2}\/\d{1,2}$/;

/** A meter's two numbers, as a music grid's tempo marker names them. */
export interface MeterParts {
  /** Beats in a bar: the numerator. */
  readonly beatsPerBar: number;
  /** The note value of a beat: the denominator. */
  readonly beatUnit: number;
}

const COMMON_TIME: MeterParts = Object.freeze({ beatsPerBar: 4, beatUnit: 4 });

/** True for a valid meter: `"n/d"`, one or two digits each, neither zero (`"7/8"`, `"12/16"`; not `"0/4"` or `"4"`). */
export function isMeter(text: unknown): text is string {
  return typeof text === "string" && METER.test(text) && !text.split("/").some((n) => Number(n) === 0);
}

/**
 * A format's meter field, leniently: a valid meter as written; missing, `DEFAULT_METER`; anything else `DEFAULT_METER`
 * with one problem at `where`.
 */
export function parseMeter(raw: unknown, where: string, r: LenientReader): string {
  if (raw === undefined) return DEFAULT_METER;
  if (isMeter(raw)) return raw;
  r.problem(where, `must be a meter like "${DEFAULT_METER}"; using "${DEFAULT_METER}".`);
  return DEFAULT_METER;
}

/** `"7/8"` → beats per bar 7, beat unit 8; a missing meter or one that isn't two positive whole numbers is 4/4. */
export function meterParts(meter: string | null | undefined): MeterParts {
  if (!meter) return COMMON_TIME;
  const [a, b, rest] = meter.split("/").map(Number);
  return rest === undefined && Number.isInteger(a) && Number.isInteger(b) && a! > 0 && b! > 0 ? { beatsPerBar: a!, beatUnit: b! } : COMMON_TIME;
}
