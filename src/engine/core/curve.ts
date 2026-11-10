/**
 * The engine's curve type (ADR 0158 §3): a list of keys mapping an input `x` to a value `y`, shared by audio automation
 * now and meant for particles and animation later. Not audio's: it lives in the core so any system can use it.
 *
 * ```jsonc
 * [[0, 0.5], [4, 1, "smooth"], [10, 0]]   // [x, y] or [x, y, interp]
 * ```
 *
 * - Keys are sorted by `x`. Before the first key the value is the first key's `y`; after the last, the last's.
 * - A key's `interp` is the shape of the segment from it to the next key: `"linear"` (default), `"step"` (hold `y`
 *   until the next key), `"smooth"` (smoothstep), `"easeIn"` (quadratic), `"easeOut"` (quadratic).
 * - A particle curve (`[t, v]` keys, `t` in 0..1, linear; `scene/particles.ts`) is a valid `Curve`.
 * - Extensions add new key forms (tangents, say) without changing what these forms mean. The core's evaluator
 *   (`native/audio/crates/audio-core`) must match this file; a parity test holds them together.
 */

export const CURVE_INTERPS = ["linear", "step", "smooth", "easeIn", "easeOut"] as const;
export type CurveInterp = (typeof CURVE_INTERPS)[number];

/** `[x, y]` or `[x, y, interp]`. */
export type CurveKey = readonly [number, number] | readonly [number, number, CurveInterp];
export type Curve = readonly CurveKey[];

/** The shape of a segment at `u` in 0..1 (0 at the segment's first key, 1 at its last). */
export function curveShape(interp: CurveInterp, u: number): number {
  switch (interp) {
    case "step": return 0;
    case "smooth": return u * u * (3 - 2 * u);
    case "easeIn": return u * u;
    case "easeOut": return 1 - (1 - u) * (1 - u);
    default: return u;
  }
}

/** The curve's value at `x`. An empty curve is 0. Keys must be sorted (`parseCurve` sorts them). */
export function evalCurve(curve: Curve, x: number): number {
  const n = curve.length;
  if (n === 0) return 0;
  if (!(x > curve[0][0])) return curve[0][1]; // also NaN
  if (x >= curve[n - 1][0]) return curve[n - 1][1];
  // Binary search for the segment [lo, lo + 1] with x in [x_lo, x_lo+1).
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid][0] <= x) lo = mid; else hi = mid;
  }
  const a = curve[lo], b = curve[hi];
  const span = b[0] - a[0];
  if (span <= 0) return b[1];
  return a[1] + (b[1] - a[1]) * curveShape(a[2] ?? "linear", (x - a[0]) / span);
}

/** The lowest and highest `y` the curve reaches at its keys (every shape stays between its two keys). `[0, 0]` when empty. */
export function curveRange(curve: Curve): [number, number] {
  if (curve.length === 0) return [0, 0];
  let min = Infinity, max = -Infinity;
  for (const k of curve) { if (k[1] < min) min = k[1]; if (k[1] > max) max = k[1]; }
  return [min, max];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A curve from JSON, leniently: keys that aren't `[x, y]` or `[x, y, interp]` with finite numbers are dropped, an
 * unknown `interp` becomes linear, and keys are sorted by `x` (stable, so equal `x` keep their order: a jump).
 * Each fix is reported in `problems` under `where`. A non-list gives `null` plus a problem.
 */
export function parseCurve(raw: unknown, where: string, problems: string[]): CurveKey[] | null {
  if (!Array.isArray(raw)) {
    problems.push(`${where}: a curve must be a list of [x, y] keys.`);
    return null;
  }
  const keys: CurveKey[] = [];
  raw.forEach((k, i) => {
    if (!Array.isArray(k) || k.length < 2 || !finite(k[0]) || !finite(k[1])) {
      problems.push(`${where}[${i}]: a key must be [x, y] with finite numbers; dropped.`);
      return;
    }
    if (k.length > 2 && k[2] !== "linear") {
      if (typeof k[2] === "string" && (CURVE_INTERPS as readonly string[]).includes(k[2])) return void keys.push([k[0], k[1], k[2] as CurveInterp]);
      problems.push(`${where}[${i}]: interp must be one of ${CURVE_INTERPS.join(", ")}; using linear.`);
    }
    keys.push([k[0], k[1]]);
  });
  const sorted = keys.every((k, i) => i === 0 || keys[i - 1][0] <= k[0]);
  if (!sorted) {
    problems.push(`${where}: keys were not in x order; sorted.`);
    keys.sort((a, b) => a[0] - b[0]);
  }
  return keys;
}
