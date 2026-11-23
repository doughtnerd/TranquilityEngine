// The number box's rules (`PanelFields.tsx`): how a value shows, what a typed text commits and what an arrow step
// gives, clamped to the box's range. Pure.

export interface NumberBoxRange {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

const clamp = (r: NumberBoxRange, v: number): number => Math.min(r.max ?? Infinity, Math.max(r.min ?? -Infinity, v));

/** The text a value shows with `digits` decimals (trailing zeros dropped). */
export const numberBoxText = (v: number, digits: number): string => String(Number(v.toFixed(digits)));

/** The value typed `text` commits (a comma reads as a point; clamped), or null when it changes nothing or isn't a number. */
export function numberBoxCommit(text: string, r: NumberBoxRange): number | null {
  const v = Number(text.trim().replace(",", "."));
  if (text.trim() === "" || !Number.isFinite(v)) return null;
  const c = clamp(r, v);
  return c === r.value ? null : c;
}

/** The value one arrow step up (`dir` 1) or down (-1) gives: `step` (default 1), ×10 with Shift, clamped. */
export function numberBoxStep(r: NumberBoxRange, dir: 1 | -1, big: boolean): number {
  return clamp(r, Number((r.value + (r.step ?? 1) * (big ? 10 : 1) * dir).toFixed(6)));
}
