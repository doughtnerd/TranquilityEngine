/**
 * Pure helpers behind the curve widget (`CurveEditor.tsx`; ADR 0158 §7, from the particle editor's ADR 0057): key
 * lists stay sorted by `x` within an x range, a key's `interp` is kept through every edit, and pixel mapping is
 * linear over `[xMin, xMax]`. No DOM here, so they're tested headless.
 */
import type { Curve, CurveInterp, CurveKey } from "../../engine/core/curve";
import { evalCurve } from "../../engine/core/curve";

/** A `[x, y]` pair, as colour and alpha keys of a gradient use. */
export type Key<T> = [number, T];
/** Any key list entry: a curve key (`[x, y]` or `[x, y, interp]`), or a `[x, value]` pair with a non-numeric value. */
export type AnyKey = readonly [number, unknown, CurveInterp?];

/** The default x range: a particle curve's `t`. */
export const UNIT_RANGE: [number, number] = [0, 1];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** A shallow copy of one key, keeping its length (so an `interp` survives). */
const copyKey = <T extends readonly unknown[]>(k: T): T => k.slice() as unknown as T;
const copyKeys = <K extends readonly unknown[]>(keys: readonly K[]): K[] => keys.map((k) => copyKey(k));

// L6.1a
/**
 * `keys` with a key at `x` (clamped to `xRange`) and value `y` inserted in order, after any existing keys with an
 * equal `x`. The new key takes the `interp` of the key before it (so the segment it splits keeps its shape), and has
 * none when it lands first. Other keys are copied unchanged, `interp` included. `index` is where it landed.
 */
export function addKey<K extends AnyKey>(keys: readonly K[], x: number, y: K[1], xRange: readonly [number, number] = UNIT_RANGE): { keys: K[]; index: number } {
  const at = clamp(x, xRange[0], xRange[1]);
  let index = keys.findIndex((k) => k[0] > at);
  if (index < 0) index = keys.length;
  const before: unknown = index > 0 ? keys[index - 1][2] : undefined;
  const fresh: unknown[] = before !== undefined && before !== "linear" ? [at, y, before] : [at, y];
  const next = copyKeys(keys);
  next.splice(index, 0, fresh as unknown as K);
  return { keys: next, index };
}

// L6.1a
/**
 * Key `index` moved to `x` and `y`: `x` is clamped to `xRange` and can't pass the neighbouring keys; the key's `interp`
 * is kept. Other keys are copied. An out-of-range `index` returns a copy.
 */
export function moveKey<K extends AnyKey>(keys: readonly K[], index: number, x: number, y: K[1], xRange: readonly [number, number] = UNIT_RANGE): K[] {
  if (index < 0 || index >= keys.length) return copyKeys(keys);
  const lo = index > 0 ? keys[index - 1][0] : xRange[0];
  const hi = index < keys.length - 1 ? keys[index + 1][0] : xRange[1];
  const at = Math.min(hi, Math.max(lo, clamp(x, xRange[0], xRange[1])));
  return keys.map((k, i) => {
    if (i !== index) return copyKey(k);
    const moved: unknown[] = [at, y];
    if (k.length > 2) moved.push(k[2]);
    return moved as unknown as K;
  });
}

// L6.1a
/** `keys` without key `index`; the last key is never removed. Always a copy. */
export function removeKey<K extends AnyKey>(keys: readonly K[], index: number): K[] {
  const next = copyKeys(keys);
  if (next.length <= 1 || index < 0 || index >= next.length) return next;
  next.splice(index, 1);
  return next;
}

// L6.1a
/**
 * `curve` with key `index`'s interp set (the shape of the segment from it to the next key). `"linear"` is stored as a
 * plain `[x, y]` (the default form), so setting linear on a key without an interp changes nothing. An out-of-range
 * `index` returns a copy; the last key's interp is stored all the same (it shapes nothing). Never mutates.
 */
export function setKeyInterp(curve: Curve, index: number, interp: CurveInterp): CurveKey[] {
  const next: CurveKey[] = curve.map((k) => copyKey(k));
  if (index < 0 || index >= next.length) return next;
  const [x, y] = curve[index];
  next[index] = interp === "linear" ? [x, y] : [x, y, interp];
  return next;
}

// L6.1a
/**
 * The y range a fitting editor shows: the keys' min and max with 10% padding, a flat curve (spread under 1e-6) gets a
 * window of at least +-0.5 (or half its magnitude) around it. An empty curve counts as the span [0, 1], which pads to
 * [-0.1, 1.1]. A finite `min`/`max` pins that end instead; if both are given and `max > min` they are returned as is.
 * (Particles' `curveRange`, renamed: the engine's `curveRange` in `core/curve.ts` is the raw key min/max.)
 */
export function fitYRange(curve: Curve, min?: number, max?: number): [number, number] {
  const pinMin = typeof min === "number" && Number.isFinite(min) ? min : undefined;
  const pinMax = typeof max === "number" && Number.isFinite(max) ? max : undefined;
  if (pinMin !== undefined && pinMax !== undefined && pinMax > pinMin) return [pinMin, pinMax];
  let lo = 0;
  let hi = 1;
  if (curve.length > 0) {
    lo = Infinity;
    hi = -Infinity;
    for (const k of curve) {
      if (k[1] < lo) lo = k[1];
      if (k[1] > hi) hi = k[1];
    }
  }
  if (hi - lo < 1e-6) {
    const half = Math.max(0.5, Math.abs(lo) / 2);
    lo -= half;
    hi += half;
  } else {
    const pad = (hi - lo) * 0.1;
    lo -= pad;
    hi += pad;
  }
  return [pinMin ?? lo, pinMax ?? hi];
}

// L6.1a
/** `x` in `[xMin, xMax]` mapped linearly to a pixel in `[left, right]` (not clamped). A range with `xMax <= xMin` maps everything to `left`. */
export function xToPixel(x: number, range: readonly [number, number], left: number, right: number): number {
  const [xMin, xMax] = range;
  if (xMax <= xMin) return left;
  return left + ((x - xMin) / (xMax - xMin)) * (right - left);
}

// L6.1a
/** The inverse of `xToPixel`, clamped to `[xMin, xMax]`. A degenerate range (`xMax <= xMin`) gives `xMin`, as does a `left == right` pixel span. */
export function pixelToX(px: number, range: readonly [number, number], left: number, right: number): number {
  const [xMin, xMax] = range;
  if (xMax <= xMin || left === right) return xMin;
  return clamp(xMin + ((px - left) / (right - left)) * (xMax - xMin), xMin, xMax);
}

// L6.1a
/** `y` in `[lo, hi]` mapped to a pixel with `lo` at `bottom` and `hi` at `top` (so `top < bottom` in screen space; not clamped). `hi <= lo` maps everything to `bottom`. */
export function yToPixel(y: number, range: readonly [number, number], top: number, bottom: number): number {
  const [lo, hi] = range;
  if (hi <= lo) return bottom;
  return bottom - ((y - lo) / (hi - lo)) * (bottom - top);
}

// L6.1a
/** The inverse of `yToPixel`, not clamped (the caller clamps to its bounds). A degenerate range gives `lo`. */
export function pixelToY(py: number, range: readonly [number, number], top: number, bottom: number): number {
  const [lo, hi] = range;
  if (hi <= lo || top === bottom) return lo;
  return lo + ((bottom - py) / (bottom - top)) * (hi - lo);
}

// L6.1a
/**
 * Grid line positions strictly inside `(xMin, xMax)`: multiples of the smallest "nice" step (1, 2 or 5 times a power
 * of ten) that gives at most `target` interior lines, rounded to kill float noise. Example: range [0, 1], target 4:
 * step 0.5 gives 1 line, 0.2 gives 4 (`[0.2, 0.4, 0.6, 0.8]`), 0.1 gives 9; the smallest step within the target is 0.2,
 * so `[0.2, 0.4, 0.6, 0.8]`. Range [0, 30], target 4: step 10 gives `[10, 20]`, step 5 gives 5 lines (too many), so
 * `[10, 20]`. A degenerate range (`xMax <= xMin`) or `target < 1` gives `[]`.
 */
export function axisTicks(range: readonly [number, number], target: number): number[] {
  const [xMin, xMax] = range;
  const span = xMax - xMin;
  if (!(span > 0) || !(target >= 1)) return [];
  const ticksAt = (step: number): number[] => {
    const out: number[] = [];
    for (let k = Math.floor(xMin / step); k <= Math.ceil(xMax / step); k++) {
      const v = Number((k * step).toPrecision(12));
      if (v > xMin && v < xMax) out.push(v);
    }
    return out;
  };
  // Candidates ascend from a step about a tenth of the span's magnitude (well below it) upwards.
  for (let exp = Math.floor(Math.log10(span)) - 1; Number.isFinite(exp) && exp < 400; exp++) {
    for (const m of [1, 2, 5]) {
      const ticks = ticksAt(m * 10 ** exp);
      if (ticks.length <= target) return ticks;
    }
  }
  return [];
}

// L6.1a
/**
 * `n` (>= 2) points `[x, y]` along `curve` for drawing over `xRange`, sorted by x: evenly spaced samples (first at
 * `xMin`, last at `xMax`), plus each key's x that falls inside the range, plus, for a `"step"` segment, a point at the
 * next key's x holding the earlier key's y (just before the jump), so a step draws square. Duplicate points (same x
 * and y) are dropped. Empty curve: `[]`. Values come from `evalCurve`.
 */
export function curveSamples(curve: Curve, n: number, xRange: readonly [number, number] = UNIT_RANGE): [number, number][] {
  if (curve.length === 0) return [];
  const [xMin, xMax] = xRange;
  const count = Math.max(2, Math.floor(n) || 2);
  // Hold points go first so that, after a stable sort, they come before any other point at the same x.
  const points: [number, number][] = [];
  for (let i = 0; i < curve.length - 1; i++) {
    const next = curve[i + 1][0];
    if (curve[i][2] === "step" && next >= xMin && next <= xMax) points.push([next, curve[i][1]]);
  }
  for (let i = 0; i < count; i++) {
    const x = i === count - 1 ? xMax : xMin + ((xMax - xMin) * i) / (count - 1);
    points.push([x, evalCurve(curve, x)]);
  }
  for (const k of curve) {
    if (k[0] >= xMin && k[0] <= xMax) points.push([k[0], evalCurve(curve, k[0])]);
  }
  points.sort((a, b) => a[0] - b[0]);
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const p of points) {
    const id = `${p[0]}|${p[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}
