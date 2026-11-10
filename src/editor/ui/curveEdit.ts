/**
 * Pure helpers behind the curve widget (`CurveEditor.tsx`; ADR 0158 §7, from the particle editor's ADR 0057): key
 * lists stay sorted by `x` within an x range, a key's `interp` is kept through every edit, and pixel mapping is
 * linear over `[xMin, xMax]`. No DOM here, so they're tested headless.
 */
import type { Curve, CurveInterp, CurveKey } from "../../engine/core/curve";

/** A `[x, y]` pair, as colour and alpha keys of a gradient use. */
export type Key<T> = [number, T];
/** Any key list entry: a curve key (`[x, y]` or `[x, y, interp]`), or a `[x, value]` pair with a non-numeric value. */
export type AnyKey = readonly [number, unknown, CurveInterp?];

/** The default x range: a particle curve's `t`. */
export const UNIT_RANGE: [number, number] = [0, 1];

// L6.1a
/**
 * `keys` with a key at `x` (clamped to `xRange`) and value `y` inserted in order, after any existing keys with an
 * equal `x`. The new key takes the `interp` of the key before it (so the segment it splits keeps its shape), and has
 * none when it lands first. Other keys are copied unchanged, `interp` included. `index` is where it landed.
 */
export function addKey<K extends AnyKey>(keys: readonly K[], x: number, y: K[1], xRange: readonly [number, number] = UNIT_RANGE): { keys: K[]; index: number } {
  throw new Error("L6.1a");
}

// L6.1a
/**
 * Key `index` moved to `x` and `y`: `x` is clamped to `xRange` and can't pass the neighbouring keys; the key's `interp`
 * is kept. Other keys are copied. An out-of-range `index` returns a copy.
 */
export function moveKey<K extends AnyKey>(keys: readonly K[], index: number, x: number, y: K[1], xRange: readonly [number, number] = UNIT_RANGE): K[] {
  throw new Error("L6.1a");
}

// L6.1a
/** `keys` without key `index`; the last key is never removed. Always a copy. */
export function removeKey<K extends AnyKey>(keys: readonly K[], index: number): K[] {
  throw new Error("L6.1a");
}

// L6.1a
/**
 * `curve` with key `index`'s interp set (the shape of the segment from it to the next key). `"linear"` is stored as a
 * plain `[x, y]` (the default form), so setting linear on a key without an interp changes nothing. An out-of-range
 * `index` returns a copy; the last key's interp is stored all the same (it shapes nothing). Never mutates.
 */
export function setKeyInterp(curve: Curve, index: number, interp: CurveInterp): CurveKey[] {
  throw new Error("L6.1a");
}

// L6.1a
/**
 * The y range a fitting editor shows: the keys' min and max with 10% padding, a flat curve (spread under 1e-6) gets a
 * window of at least +-0.5 (or half its magnitude) around it, an empty curve gives [0, 1]. A finite `min`/`max` pins
 * that end instead; if both are given and `max > min` they are returned as is. (Particles' `curveRange`, renamed:
 * the engine's `curveRange` in `core/curve.ts` is the raw key min/max.)
 */
export function fitYRange(curve: Curve, min?: number, max?: number): [number, number] {
  throw new Error("L6.1a");
}

// L6.1a
/** `x` in `[xMin, xMax]` mapped linearly to a pixel in `[left, right]` (not clamped). A range with `xMax <= xMin` maps everything to `left`. */
export function xToPixel(x: number, range: readonly [number, number], left: number, right: number): number {
  throw new Error("L6.1a");
}

// L6.1a
/** The inverse of `xToPixel`, clamped to `[xMin, xMax]`. A degenerate range (`xMax <= xMin`) gives `xMin`, as does a `left == right` pixel span. */
export function pixelToX(px: number, range: readonly [number, number], left: number, right: number): number {
  throw new Error("L6.1a");
}

// L6.1a
/** `y` in `[lo, hi]` mapped to a pixel with `lo` at `bottom` and `hi` at `top` (so `top < bottom` in screen space; not clamped). `hi <= lo` maps everything to `bottom`. */
export function yToPixel(y: number, range: readonly [number, number], top: number, bottom: number): number {
  throw new Error("L6.1a");
}

// L6.1a
/** The inverse of `yToPixel`, not clamped (the caller clamps to its bounds). A degenerate range gives `lo`. */
export function pixelToY(py: number, range: readonly [number, number], top: number, bottom: number): number {
  throw new Error("L6.1a");
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
  throw new Error("L6.1a");
}

// L6.1a
/**
 * `n` (>= 2) points `[x, y]` along `curve` for drawing over `xRange`, sorted by x: evenly spaced samples (first at
 * `xMin`, last at `xMax`), plus each key's x that falls inside the range, plus, for a `"step"` segment, a point at the
 * next key's x holding the earlier key's y (just before the jump), so a step draws square. Duplicate points (same x
 * and y) are dropped. Empty curve: `[]`. Values come from `evalCurve`.
 */
export function curveSamples(curve: Curve, n: number, xRange: readonly [number, number] = UNIT_RANGE): [number, number][] {
  throw new Error("L6.1a");
}
