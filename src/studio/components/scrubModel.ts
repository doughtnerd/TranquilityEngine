// Label scrubbing's rules (Unity-style, owner's prototype, spec §1.3/§3.4): drag a number field's label left or right
// to change the field. Past a 3 px dead zone, every 2 px is one step; Shift ×10, Alt ×0.1 (fine); the value stays in
// the field's min..max; Escape puts the start value back. A field's step is its `step` (number inputs), the last
// decimal it shows (a typed "1.25" steps by 0.01), or 10 ms for a timecode ("00:01.250"). Pure: `labelScrub.ts`
// drives it from pointer events, `NumberField` and `SliderField` through their own labels.

/** Pixels the pointer moves before a press on a label becomes a scrub (a smaller move is still a click). */
export const SCRUB_DEAD_ZONE_PX = 3;
/** Pixels of drag per step. */
export const SCRUB_PX_PER_STEP = 2;
/** A scrubbable label's tooltip. */
export const SCRUB_TOOLTIP = "Drag left or right to change (Shift ×10, Alt fine)";

export interface ScrubMods {
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/** How the modifiers scale a step: Shift ×10, Alt ×0.1, neither ×1. */
export const scrubScale = (mods: ScrubMods): number => (mods.shift ? 10 : mods.alt ? 0.1 : 1);

/** The decimals a number's text shows ("1.25" → 2). */
export function textDecimals(text: string): number {
  const s = String(text).trim();
  const k = s.indexOf(".");
  return k < 0 ? 0 : s.length - k - 1;
}

/**
 * The value after dragging `dx` pixels (since the scrub started) from `start`: one `step` per 2 px, scaled by the
 * modifiers, kept in `min..max`. Rounded to the step's decimals (one more for a fine drag), so no float noise.
 */
export function scrubNumber(start: number, step: number, dx: number, mods: ScrubMods = {}, range: { readonly min?: number; readonly max?: number } = {}): number {
  const scale = scrubScale(mods);
  const s = step > 0 ? step : 1;
  let v = start + Math.round(dx / SCRUB_PX_PER_STEP) * s * scale;
  if (range.min !== undefined && Number.isFinite(range.min)) v = Math.max(range.min, v);
  if (range.max !== undefined && Number.isFinite(range.max)) v = Math.min(range.max, v);
  const decimals = Math.min(6, textDecimals(String(s)) + (scale < 1 ? 1 : 0));
  return Number(v.toFixed(decimals));
}

/** What kind of text a field holds, as far as scrubbing goes: a number input, a timecode, a plain decimal; null: not scrubbable. */
export type ScrubKind = "number" | "timecode" | "decimal";

const TIMECODE = /^(\d{1,3}):(\d{2})\.(\d{3})$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A field's kind from its `type` attribute and current text (text fields scrub only while they hold a number or a timecode). */
export function scrubKind(type: string | null | undefined, text: string): ScrubKind | null {
  const t = (type ?? "").toLowerCase();
  if (t === "number") return "number";
  if (t !== "" && t !== "text") return null;
  const v = text.trim();
  if (TIMECODE.test(v)) return "timecode";
  if (DECIMAL.test(v)) return "decimal";
  return null;
}

/** A scrub in progress over a field's text. */
export interface TextScrub {
  readonly kind: ScrubKind;
  readonly start: number;
  readonly step: number;
  /** Decimals written. */
  readonly decimals: number;
  readonly min?: number;
  readonly max?: number;
}

/** Seconds of a timecode "mm:ss.mmm". */
export function parseTimecode(text: string): number | null {
  const m = TIMECODE.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000 : null;
}

/** A timecode "mm:ss.mmm" (two-digit minutes at least, spec §3.14) for `seconds` (0 or more). */
export function formatTimecode(seconds: number): string {
  const v = Math.max(0, seconds);
  let m = Math.floor(v / 60);
  let s = Number((v - m * 60).toFixed(3));
  if (s >= 60) {
    m += 1;
    s -= 60;
  }
  return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`;
}

/** The scrub a field starts, from its attributes and text; null when it can't scrub. */
export function startTextScrub(field: { readonly type?: string | null; readonly value: string; readonly step?: string; readonly min?: string; readonly max?: string }): TextScrub | null {
  const kind = scrubKind(field.type, field.value);
  if (!kind) return null;
  const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : Number.isFinite(Number(s)) ? Number(s) : undefined);
  const range = { min: num(field.min), max: num(field.max) };
  if (kind === "timecode") return { kind, start: parseTimecode(field.value) ?? 0, step: 0.01, decimals: 3, ...range };
  if (kind === "decimal") {
    const decimals = textDecimals(field.value);
    return { kind, start: Number(field.value.trim()), step: Math.pow(10, -decimals), decimals, ...range };
  }
  const stepText = field.step && Number(field.step) > 0 ? field.step : "1";
  const v = Number(field.value);
  return { kind, start: Number.isFinite(v) && field.value.trim() !== "" ? v : 0, step: Number(stepText), decimals: textDecimals(stepText), ...range };
}

/** The field's text after dragging `dx` pixels with `mods` (a timecode never goes below 0). */
export function textScrubValue(s: TextScrub, dx: number, mods: ScrubMods = {}): string {
  const scale = scrubScale(mods);
  let v = s.start + Math.round(dx / SCRUB_PX_PER_STEP) * s.step * scale;
  if (s.min !== undefined) v = Math.max(s.min, v);
  if (s.max !== undefined) v = Math.min(s.max, v);
  if (s.kind === "timecode") return formatTimecode(v);
  return v.toFixed(Math.min(6, s.decimals + (scale < 1 ? 1 : 0)));
}
