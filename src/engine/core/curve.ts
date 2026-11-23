/**
 * The engine's curve type (ADR 0158 §3, extended by ADR 0346): a list of keys mapping an input `x` to a value `y`,
 * shared by audio automation and particles. Not audio's: it lives in the core so any system can use it.
 *
 * ```jsonc
 * [[0, 0.5], [4, 1, "smooth"], [10, 0]]   // [x, y] or [x, y, interp]
 * [[0, 0, "bezier", { "in": [-1, 0], "out": [2, 3] }], [6, 1]]   // [x, y, "bezier", handles]
 * ```
 *
 * - Keys are sorted by `x`. Before the first key the value is the first key's `y`; after the last, the last's.
 * - A key's `interp` is the shape of the segment from it to the next key: `"linear"` (default), `"step"` (hold `y`
 *   until the next key), `"smooth"` (smoothstep), `"easeIn"` (quadratic), `"easeOut"` (quadratic).
 * - A `"bezier"` key (ADR 0346) carries two handles, offsets `[dx, dy]` from the key: `in` (toward the previous key)
 *   and `out` (toward the next). The segment from a Bézier key is the cubic from the key through its `out` handle and
 *   the next key's `in` handle (a flat handle a third of the segment long, `[-span / 3, 0]`, when the next key isn't
 *   Bézier) to the next key. Each control point's x is clamped into the segment, so the curve stays a function of x;
 *   the evaluator finds the cubic's parameter at `x` by bisection, `BEZIER_STEPS` halvings. `free` (default false:
 *   mirrored) is an editor rule only; evaluation ignores it.
 * - A particle curve (`[t, v]` keys, `t` in 0..1, linear; `scene/particles.ts`) is a valid `Curve`.
 * - Extensions add new key forms without changing what these forms mean. The core's evaluator
 *   (`native/audio/crates/audio-core/src/automation.rs`) must match this file; a parity test holds them together.
 */

/** The segment shapes a three-element key names (the editor's shape menu). */
export const CURVE_INTERPS = ["linear", "step", "smooth", "easeIn", "easeOut"] as const;
export type CurveInterp = (typeof CURVE_INTERPS)[number];

/**
 * Every key interp, in the order of their codes: the shapes, then `"bezier"` (5). The core's CURVES record and the
 * capture's mix op carry this index.
 */
export const CURVE_KEY_INTERPS = [...CURVE_INTERPS, "bezier"] as const;
export type CurveKeyInterp = (typeof CURVE_KEY_INTERPS)[number];

/** Halvings of the Bézier parameter search (ADR 0346). The core uses the same count. */
export const BEZIER_STEPS = 28;

/** A Bézier key's handles, offsets from the key in the curve's units. */
export interface CurveHandles {
  readonly in: readonly [number, number];
  readonly out: readonly [number, number];
  /** The editor moves the two handles independently (true) or mirrored (false, the default). */
  readonly free?: boolean;
}

/** `[x, y]`, `[x, y, interp]` or `[x, y, "bezier", handles]`. */
export type CurveKey =
  | readonly [number, number]
  | readonly [number, number, CurveInterp]
  | readonly [number, number, "bezier", CurveHandles];
export type Curve = readonly CurveKey[];

/** A key's interp code (`CURVE_KEY_INTERPS` index): 0 linear when it has none. */
export function curveKeyInterpCode(key: CurveKey): number {
  if (key.length < 3) return 0;
  const i = (CURVE_KEY_INTERPS as readonly string[]).indexOf(key[2] as string);
  return i < 0 ? 0 : i;
}

/** A key's Bézier handles, or `undefined` when it isn't a Bézier key. */
export function curveKeyHandles(key: CurveKey): CurveHandles | undefined {
  return key[2] === "bezier" ? (key as readonly [number, number, "bezier", CurveHandles])[3] : undefined;
}

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

const cubic = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const m = 1 - t;
  return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3;
};
const clampSpan = (v: number, span: number): number => (v > 0 ? (v < span ? v : span) : 0);

/**
 * The control points of the Bézier segment from `a` to `b` (span `> 0`), relative x and absolute y:
 * `[c1x, c1y, c2x, c2y]` with both x in `[0, span]`. A missing handle is the flat third-of-segment one.
 */
function bezierControls(a: CurveKey, b: CurveKey): [number, number, number, number] {
  const span = b[0] - a[0];
  const out = curveKeyHandles(a)?.out;
  const into = curveKeyHandles(b)?.in;
  const c1x = out ? clampSpan(out[0], span) : span / 3;
  const c1y = a[1] + (out ? out[1] : 0);
  const c2x = into ? clampSpan(span + into[0], span) : span - span / 3;
  const c2y = b[1] + (into ? into[1] : 0);
  return [c1x, c1y, c2x, c2y];
}

/** The Bézier segment from `a` to `b` at `x` in `[a.x, b.x)`; the span must be positive. */
function bezierAt(a: CurveKey, b: CurveKey, x: number): number {
  const span = b[0] - a[0];
  const [c1x, c1y, c2x, c2y] = bezierControls(a, b);
  const target = x - a[0];
  // x(t) is non-decreasing for control x in [0, span], so bisection finds the parameter.
  let lo = 0, hi = 1;
  for (let i = 0; i < BEZIER_STEPS; i++) {
    const t = (lo + hi) * 0.5;
    if (cubic(0, c1x, c2x, span, t) < target) lo = t; else hi = t;
  }
  return cubic(a[1], c1y, c2y, b[1], (lo + hi) * 0.5);
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
  if (a[2] === "bezier") return bezierAt(a, b, x);
  return a[1] + (b[1] - a[1]) * curveShape(a[2] ?? "linear", (x - a[0]) / span);
}

/**
 * The lowest and highest `y` the curve can reach: its keys, and the control points of its Bézier segments (a cubic
 * stays inside its control points, so this may be wider than the curve itself). `[0, 0]` when empty.
 */
export function curveRange(curve: Curve): [number, number] {
  if (curve.length === 0) return [0, 0];
  let min = Infinity, max = -Infinity;
  const see = (y: number) => { if (y < min) min = y; if (y > max) max = y; };
  curve.forEach((k, i) => {
    see(k[1]);
    const next = curve[i + 1];
    if (k[2] === "bezier" && next && next[0] > k[0]) {
      const [, c1y, , c2y] = bezierControls(k, next);
      see(c1y);
      see(c2y);
    }
  });
  return [min, max];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isHandle = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]);

/**
 * A curve from JSON, leniently: keys that aren't `[x, y]`, `[x, y, interp]` or `[x, y, "bezier", handles]` with
 * finite numbers are dropped, an unknown `interp` becomes linear, and keys are sorted by `x` (stable, so equal `x`
 * keep their order: a jump). A Bézier key's missing or malformed handle becomes the flat third-of-segment handle
 * (`in: [(prevX - x) / 3, 0]`, `out: [(nextX - x) / 3, 0]`, `0` at an end) and a `free` that isn't a boolean is
 * dropped. Each fix is reported in `problems` under `where`. A non-list gives `null` plus a problem.
 */
export function parseCurve(raw: unknown, where: string, problems: string[]): CurveKey[] | null {
  if (!Array.isArray(raw)) {
    problems.push(`${where}: a curve must be a list of [x, y] keys.`);
    return null;
  }
  /** A key, plus which handles still need their default (filled once the keys are sorted). */
  const keys: { key: CurveKey; fill?: { in?: boolean; out?: boolean; free?: boolean } }[] = [];
  raw.forEach((k, i) => {
    if (!Array.isArray(k) || k.length < 2 || !finite(k[0]) || !finite(k[1])) {
      problems.push(`${where}[${i}]: a key must be [x, y] with finite numbers; dropped.`);
      return;
    }
    if (k.length > 2 && k[2] !== "linear") {
      if (k[2] === "bezier") {
        const h: unknown = k[3];
        const obj = h !== null && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : undefined;
        if (!obj) problems.push(`${where}[${i}]: a bezier key needs { in: [dx, dy], out: [dx, dy] }; using flat handles.`);
        else {
          if (!isHandle(obj.in)) problems.push(`${where}[${i}].in: a handle must be [dx, dy] with finite numbers; using a flat handle.`);
          if (!isHandle(obj.out)) problems.push(`${where}[${i}].out: a handle must be [dx, dy] with finite numbers; using a flat handle.`);
          if (obj.free !== undefined && typeof obj.free !== "boolean") problems.push(`${where}[${i}].free: must be true or false; dropped.`);
        }
        const inH = obj && isHandle(obj.in) ? obj.in : undefined;
        const outH = obj && isHandle(obj.out) ? obj.out : undefined;
        const handles: CurveHandles = { in: inH ? [inH[0], inH[1]] : [0, 0], out: outH ? [outH[0], outH[1]] : [0, 0], ...(obj?.free === true ? { free: true } : {}) };
        keys.push({ key: [k[0], k[1], "bezier", handles], fill: !inH || !outH ? { in: !inH, out: !outH } : undefined });
        return;
      }
      if (typeof k[2] === "string" && (CURVE_INTERPS as readonly string[]).includes(k[2])) return void keys.push({ key: [k[0], k[1], k[2] as CurveInterp] });
      problems.push(`${where}[${i}]: interp must be one of ${CURVE_KEY_INTERPS.join(", ")}; using linear.`);
    }
    keys.push({ key: [k[0], k[1]] });
  });
  const sorted = keys.every((k, i) => i === 0 || keys[i - 1].key[0] <= k.key[0]);
  if (!sorted) {
    problems.push(`${where}: keys were not in x order; sorted.`);
    keys.sort((a, b) => a.key[0] - b.key[0]);
  }
  return keys.map(({ key, fill }, i) => {
    if (!fill) return key;
    const h = curveKeyHandles(key)!;
    const prev = keys[i - 1]?.key[0] ?? key[0];
    const next = keys[i + 1]?.key[0] ?? key[0];
    const handles: CurveHandles = { in: fill.in ? [(prev - key[0]) / 3, 0] : h.in, out: fill.out ? [(next - key[0]) / 3, 0] : h.out, ...(h.free ? { free: true } : {}) };
    return [key[0], key[1], "bezier", handles] as const;
  });
}

/**
 * The JSON form of a curve: a fresh array of keys, `[x, y]` for linear, `[x, y, interp]` for a shape, and
 * `[x, y, "bezier", { in, out }]` for a Bézier key (`free` written only when true). `parseCurve` reads it back
 * unchanged.
 */
export function curveToJson(curve: Curve): unknown[] {
  return curve.map((k) => {
    if (k.length < 3 || k[2] === "linear") return [k[0], k[1]];
    const h = curveKeyHandles(k);
    if (!h) return [k[0], k[1], k[2]];
    return [k[0], k[1], "bezier", { in: [h.in[0], h.in[1]], out: [h.out[0], h.out[1]], ...(h.free ? { free: true } : {}) }];
  });
}
