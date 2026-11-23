// A number field's rules (`NumberField`, `SliderField`): how a value is written in the box, what typed text reads as
// (clamped to the range and snapped to its decimals), and what an arrow step gives. Pure.
import { scrubScale, textDecimals, type ScrubMods } from "./scrubModel";

export interface NumberRange {
  readonly min?: number;
  readonly max?: number;
  /** One step (default 1). */
  readonly step?: number;
  /** Decimals kept (default: the step's). */
  readonly digits?: number;
}

/** The decimals a range keeps: its `digits`, else its step's ("0.25" → 2). */
export const rangeDigits = (r: NumberRange): number => r.digits ?? Math.min(6, textDecimals(String(r.step ?? 1)));

/** `v` within the range. */
export function clampNumber(v: number, r: NumberRange): number {
  let c = v;
  if (r.min !== undefined) c = Math.max(r.min, c);
  if (r.max !== undefined) c = Math.min(r.max, c);
  return c;
}

/**
 * The box's text, trailing zeros dropped ("2.50" → "2.5"): `digits` decimals when the range names them, else the
 * step's plus one, so a fine (Alt) scrub or step shows what it did.
 */
export const numberText = (v: number, r: NumberRange): string => String(Number(v.toFixed(r.digits ?? Math.min(6, rangeDigits(r) + 1))));

/**
 * What typed `text` reads as, clamped and rounded to the range's decimals; null when it isn't a number. Accepts a
 * typographic minus, a decimal comma, a "k" for thousands ("2.4k") and a trailing unit ("12 ms", "−6 dB").
 */
export function parseNumber(text: string, r: NumberRange = {}): number | null {
  const t = text.trim().replace(/^[−–]/, "-").replace(",", ".");
  const m = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(k)?\s*[a-z%×:/°]*\s*$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  if (!Number.isFinite(n)) return null;
  return Number(clampNumber(n, r).toFixed(rangeDigits(r)));
}

/** The value one arrow step up (`dir` 1) or down (-1) gives: the step, ×10 with Shift, ×0.1 with Alt, clamped. */
export function stepNumber(v: number, dir: 1 | -1, mods: ScrubMods, r: NumberRange): number {
  const scale = scrubScale(mods);
  const digits = Math.min(6, rangeDigits(r) + (scale < 1 ? 1 : 0));
  return Number(clampNumber(v + (r.step ?? 1) * scale * dir, r).toFixed(digits));
}
