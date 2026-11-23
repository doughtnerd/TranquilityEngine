// A parameter row's rules (ADR 0349 `ParameterRow`, ADR 0345 parameter specs, ADR 0346 "units in, units out"): where a
// value sits on the slider (log for log parameters such as frequencies, so 200 Hz and 2 kHz are as far apart as 2 kHz
// and 20 kHz), stepping and snapping to the parameter's step, scrubbing by dragging the label (Shift ×10, Alt fine
// ×0.1), and how a value is written. Any catalogue `EffectParamSpec` is a `ParamSpec`.

/** What a row needs to know about its value. */
export interface ParamSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
  /** Default linear. A log range starting at or below 0 is shifted to start at 1 (so 0..10 000 ms still slides by ratio). */
  readonly scale?: "linear" | "log";
  readonly default?: number;
}

/** The slider's resolution: positions run 0..SLIDER_STEPS. */
export const SLIDER_STEPS = 1000;
/** A label drag moves this much of the range per pixel (×10 with Shift, ×0.1 with Alt). */
export const SCRUB_FRACTION_PER_PX = 1 / 300;

const isLog = (spec: ParamSpec) => spec.scale === "log" && spec.max > spec.min;
/** What a log range is shifted by so it starts at 1 or above. */
const logShift = (spec: ParamSpec) => (spec.min > 0 ? 0 : 1 - spec.min);

/** `v` within the spec's range. */
export const clampParam = (spec: ParamSpec, v: number): number => (Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : spec.default ?? spec.min);

/** The decimals the spec's step needs (0.1 → 1, 0.01 → 2, 1 → 0). */
export function stepDecimals(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
}

/** `v` on the spec's step grid (counted from `min`), within range, without float noise. */
export function snapParam(spec: ParamSpec, v: number): number {
  const c = clampParam(spec, v);
  if (!(spec.step > 0)) return c;
  const snapped = spec.min + Math.round((c - spec.min) / spec.step) * spec.step;
  return clampParam(spec, Number(snapped.toFixed(stepDecimals(spec.step))));
}

/** Where `v` sits along the range, 0..1: log for a log spec. */
export function paramToFraction(spec: ParamSpec, v: number): number {
  const c = clampParam(spec, v);
  if (spec.max === spec.min) return 0;
  if (isLog(spec)) {
    const k = logShift(spec);
    return Math.log((c + k) / (spec.min + k)) / Math.log((spec.max + k) / (spec.min + k));
  }
  return (c - spec.min) / (spec.max - spec.min);
}

/** The value at fraction `f` (0..1) of the range, unsnapped. */
export function fractionToParam(spec: ParamSpec, f: number): number {
  const u = Math.min(1, Math.max(0, f));
  if (isLog(spec)) {
    const k = logShift(spec);
    return (spec.min + k) * Math.pow((spec.max + k) / (spec.min + k), u) - k;
  }
  return spec.min + (spec.max - spec.min) * u;
}

/** The slider position (0..SLIDER_STEPS) of `v`. */
export const paramToSlider = (spec: ParamSpec, v: number): number => Math.round(paramToFraction(spec, v) * SLIDER_STEPS);

/** The value at slider position `pos`, snapped to the step. */
export const sliderToParam = (spec: ParamSpec, pos: number): number => snapParam(spec, fractionToParam(spec, pos / SLIDER_STEPS));

/** How a drag's modifier keys scale it: Shift ×10, Alt ×0.1, neither ×1. */
export const dragScale = (mods: { readonly shift?: boolean; readonly alt?: boolean }): number => (mods.shift ? 10 : mods.alt ? 0.1 : 1);

/**
 * The value after scrubbing the label `dx` pixels (accumulated over the drag) from `start`: a fixed share of the range
 * per pixel, in log space for a log spec. Snapped to the step, except a fine (Alt) drag, which snaps to a tenth of it.
 */
export function scrubParam(spec: ParamSpec, start: number, dx: number, mods: { readonly shift?: boolean; readonly alt?: boolean } = {}): number {
  const f = paramToFraction(spec, start) + dx * SCRUB_FRACTION_PER_PX * dragScale(mods);
  const v = fractionToParam(spec, f);
  return mods.alt && !mods.shift ? snapParam({ ...spec, step: spec.step / 10 }, v) : snapParam(spec, v);
}

/**
 * The value a key moves `v` to on the number box or slider, or null for other keys: arrows one step (Shift ten, Alt a
 * tenth), Home and End the ends. A log spec steps by its step too, but never less than 1 % of the value.
 */
export function paramKey(spec: ParamSpec, v: number, key: string, mods: { readonly shift?: boolean; readonly alt?: boolean } = {}): number | null {
  if (key === "Home") return spec.min;
  if (key === "End") return spec.max;
  const dir = key === "ArrowUp" || key === "ArrowRight" ? 1 : key === "ArrowDown" || key === "ArrowLeft" ? -1 : 0;
  if (dir === 0) return null;
  const scale = dragScale(mods);
  const base = isLog(spec) ? Math.max(spec.step, Math.abs(v) * 0.01) : spec.step;
  const fine = mods.alt && !mods.shift;
  return snapParam(fine ? { ...spec, step: spec.step / 10 } : spec, v + dir * base * scale);
}

/** A value as the row writes it: the step's decimals, kHz above 1000 Hz for a log Hz parameter ("2.40 kHz"). */
export function formatParam(spec: ParamSpec, v: number): string {
  if (spec.unit === "Hz" && Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} kHz`;
  const text = v.toFixed(stepDecimals(spec.step)).replace(/^-/, "−");
  return spec.unit ? `${text} ${spec.unit}` : text;
}

/** The number box's text: the step's decimals, no unit. */
export const paramBoxText = (spec: ParamSpec, v: number): string => String(Number(v.toFixed(stepDecimals(spec.step))));

/** A typed value ("2.4k" reads as 2400), clamped and snapped; null when it doesn't read as a number. */
export function parseParam(spec: ParamSpec, text: string): number | null {
  const t = text.trim().replace(/^−/, "-");
  const m = /^(-?\d*\.?\d+(?:e-?\d+)?)\s*(k)?\s*(hz|dbtp|db|ms|s|%|st|ct|:1|×|bits)?$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? snapParam(spec, n) : null;
}
