/**
 * Second-input curves, "And by" (ADR 0362 §5): a curve lane driven by its own input (time, a game parameter) that also
 * follows a second game parameter. One model for the formats that store it (playlist voice curves, sequence clip and
 * track automation, the Mixer's bus and bus-effect automation in `audio.json`), the runtime that plays it and the curve
 * editor that previews it.
 *
 * ```jsonc
 * "by": { "input": "Speed", "mode": "morph", "curve": [[0, -6], [2, 0]] }          // High curve over the lane's input
 * "by": { "input": "Speed", "mode": "scale", "curve": [[0, 0.5], [100, 1.5]] }      // × over the second input (0..2)
 * "by": { "input": "Speed", "mode": "rate",  "curve": [[0, 0.5], [100, 2]] }        // time lanes: clock × (0.25..4)
 * "by": { "input": "Surface", "mode": "labels", "labels": { "Wood": [[0, -3]] } }    // per label; the first is the lane's
 * ```
 *
 * - **morph** blends the lane's curve (Low) and `curve` (High) by where the second input sits in its range (0 at its
 *   minimum, 1 at its maximum).
 * - **scale** multiplies the lane's value by `curve` at the second input (1 where it has no curve).
 * - **rate** (time lanes only) reads the lane at its time × `curve` at the second input: the second input scales the
 *   clock. A change of rate takes effect at once (the lane is read at the new rate from its start; it isn't integrated).
 * - **labels** (a labelled second input) picks one curve per label: the first label is the lane's own curve, the
 *   others `labels[label]` (a label without one uses the lane's curve).
 *
 * The runtime never evaluates two inputs per sample: it plays the lane's **slice** at the second input's value now
 * (`sliceCurveBy`, a curve over the lane's own input) and re-slices when the second input changes.
 *
 * Pure; no plugin, no DOM.
 */
import { curveKeyHandles, curveToJson, evalCurve, type Curve, type CurveKey } from "../core/curve";
import { isLabelled, parameterRange, type ParameterDef } from "./parameters";
import { isRecord, type JsonRecord } from "./lenientRead";

export const CURVE_BY_MODES = ["morph", "scale", "rate", "labels"] as const;
export type CurveByMode = (typeof CURVE_BY_MODES)[number];

/** A lane's second input. */
export interface CurveBy {
  /** The second input: a game parameter's name (the lane's playlist's own, or a global one). */
  readonly input: string;
  readonly mode: CurveByMode;
  /** Morph: the High curve, over the lane's own input. Scale and rate: the × curve, over the second input. */
  readonly curve?: Curve;
  /** Labels: the curve of each label after the first, over the lane's own input. */
  readonly labels?: Readonly<Record<string, Curve>>;
}

/** Where the second input is now: its value, its range, and its labels when it is labelled (value = label index). */
export interface SecondValue {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly labels?: readonly string[];
}

/** At most this many label curves in one `by` (the core's local and global parameter labels are bounded likewise). */
export const MAX_BY_LABELS = 64;
/** The most keys a slice gets (the core's curve table holds 64 keys a curve). */
export const MAX_SLICE_KEYS = 64;

/** The second input `def` at `value`. */
export function secondValueOf(def: ParameterDef, value: number): SecondValue {
  const [min, max] = parameterRange(def);
  return isLabelled(def) ? { value, min, max, labels: def.labels } : { value, min, max };
}

/** Where the second input sits in its range, 0..1. */
export function byShare(s: SecondValue): number {
  const max = s.max > s.min ? s.max : s.min + 1;
  const u = (s.value - s.min) / (max - s.min);
  return u > 0 ? (u < 1 ? u : 1) : 0;
}

/** The × of a scale or rate `by` at the second input (1 without a curve; a rate is at least 1/64). */
export function byMultiplier(by: CurveBy, s: SecondValue): number {
  const m = by.curve && by.curve.length > 0 ? evalCurve(by.curve, s.value) : 1;
  if (!Number.isFinite(m)) return 1;
  return by.mode === "rate" ? Math.max(1 / 64, m) : m;
}

/** The label the second input is on (its index rounded into range), undefined when it has none. */
export function byLabel(s: SecondValue): string | undefined {
  const labels = s.labels;
  if (!labels || labels.length === 0) return undefined;
  const i = Math.round(Math.min(labels.length - 1, Math.max(0, Number.isFinite(s.value) ? s.value : 0)));
  return labels[i];
}

/** The curve a labels `by` plays for the second input now: the label's own, or the lane's (`main`). */
function labelCurve(main: Curve, by: CurveBy, s: SecondValue): Curve {
  const label = byLabel(s);
  return label !== undefined && label !== s.labels![0] ? (by.labels?.[label] ?? main) : main;
}

/**
 * The lane's value at `x` (its own input) with the second input at `s`. `ev` evaluates the lane's curves (Low, High,
 * the labels' curves; the editor passes its log-lane evaluator); the × curves are always plain curves.
 */
export function evalCurveBy(main: Curve, by: CurveBy, x: number, s: SecondValue, ev: (c: Curve, x: number) => number = evalCurve): number {
  switch (by.mode) {
    case "morph": {
      const w = byShare(s);
      const high = by.curve && by.curve.length > 0 ? by.curve : main;
      return ev(main, x) * (1 - w) + ev(high, x) * w;
    }
    case "scale": return ev(main, x) * byMultiplier(by, s);
    case "rate": return ev(main, x * byMultiplier(by, s));
    case "labels": return ev(labelCurve(main, by, s), x);
  }
}

const withY = (k: CurveKey, y: number, dy: (d: number) => number): CurveKey => {
  const h = curveKeyHandles(k);
  if (h) return [k[0], y, "bezier", { in: [h.in[0], dy(h.in[1])], out: [h.out[0], dy(h.out[1])], ...(h.free ? { free: true } : {}) }];
  return k.length > 2 ? [k[0], y, k[2] as Exclude<CurveKey[2], "bezier" | undefined>] : [k[0], y];
};

const withX = (k: CurveKey, x: number, dx: (d: number) => number): CurveKey => {
  const h = curveKeyHandles(k);
  if (h) return [x, k[1], "bezier", { in: [dx(h.in[0]), h.in[1]], out: [dx(h.out[0]), h.out[1]], ...(h.free ? { free: true } : {}) }];
  return k.length > 2 ? [x, k[1], k[2] as Exclude<CurveKey[2], "bezier" | undefined>] : [x, k[1]];
};

/** True when `a` and `b` have keys at the same x with the same shapes (a High copied from Low and moved up or down). */
function sameShape(a: Curve, b: Curve): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!;
    if (p[0] !== q[0] || (p[2] ?? "linear") !== (q[2] ?? "linear")) return false;
    const hp = curveKeyHandles(p), hq = curveKeyHandles(q);
    if (hp && hq && (hp.in[0] !== hq.in[0] || hp.out[0] !== hq.out[0])) return false;
  }
  return true;
}

/** `(1 − w)·a + w·b` of two curves: exact when they share their keys' x and shapes, else resampled in linear keys. */
function blend(a: Curve, b: Curve, w: number): Curve {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const mix = (p: number, q: number) => p * (1 - w) + q * w;
  if (sameShape(a, b)) {
    return a.map((k, i) => {
      const q = b[i]!;
      const hp = curveKeyHandles(k), hq = curveKeyHandles(q);
      if (hp && hq) return [k[0], mix(k[1], q[1]), "bezier", { in: [hp.in[0], mix(hp.in[1], hq.in[1])], out: [hp.out[0], mix(hp.out[1], hq.out[1])] }] as CurveKey;
      return withY(k, mix(k[1], q[1]), (d) => d);
    });
  }
  return resample((x) => mix(evalCurve(a, x), evalCurve(b, x)), [...a, ...b]);
}

/**
 * `f` as linear keys over the x span of `keys`: a key at each distinct key x, the segments between subdivided evenly
 * (at most `MAX_SLICE_KEYS` keys in all), and a jump where a step key ends (a key just before the next x).
 */
function resample(f: (x: number) => number, keys: Curve): Curve {
  const xs = [...new Set(keys.map((k) => k[0]))].sort((p, q) => p - q);
  if (xs.length <= 1) return [[xs[0] ?? 0, f(xs[0] ?? 0)]];
  // A step key holds its value to its own curve's next key, which is one of `xs`: a jump may land at any later x.
  const firstStep = Math.min(...keys.filter((k) => k[2] === "step").map((k) => k[0]));
  const segments = xs.length - 1;
  const jumps = xs.slice(1).filter((b) => b > firstStep).length;
  const per = Math.max(1, Math.floor((MAX_SLICE_KEYS - 1 - jumps) / segments));
  const out: CurveKey[] = [];
  for (let i = 0; i < segments; i++) {
    const a = xs[i]!, b = xs[i + 1]!;
    for (let s = 0; s < per; s++) {
      const x = a + ((b - a) * s) / per;
      out.push([x, f(x)]);
    }
    if (b > firstStep) {
      // The left limit at b: just before it.
      const e = b - (b - a) * 1e-6;
      if (e > out[out.length - 1]![0]) out.push([e, f(e)]);
    }
  }
  const last = xs[xs.length - 1]!;
  out.push([last, f(last)]);
  return out.length > MAX_SLICE_KEYS ? out.slice(0, MAX_SLICE_KEYS - 1).concat([out[out.length - 1]!]) : out;
}

/**
 * The lane's slice at the second input `s`: a curve over the lane's own input that the runtime plays as the lane's
 * curve until the second input moves. Exact for scale, rate and labels (and for morph between two curves of the same
 * keys' x and shapes); a morph of differently keyed curves is resampled in linear keys. `main` itself when the second
 * input changes nothing (morph at Low, × 1, the first label).
 */
export function sliceCurveBy(main: Curve, by: CurveBy, s: SecondValue): Curve {
  switch (by.mode) {
    case "morph": return blend(main, by.curve && by.curve.length > 0 ? by.curve : main, byShare(s));
    case "scale": {
      const m = byMultiplier(by, s);
      return m === 1 ? main : main.map((k) => withY(k, k[1] * m, (d) => d * m));
    }
    case "rate": {
      const r = byMultiplier(by, s);
      return r === 1 ? main : main.map((k) => withX(k, k[0] / r, (d) => d / r));
    }
    case "labels": return labelCurve(main, by, s);
  }
}

// --- the format ------------------------------------------------------------------------------------------------------

/** What a lane's `by` may be: `time` lanes allow rate. */
export interface CurveByLane {
  readonly time: boolean;
}

/**
 * A lane's `by` from JSON, leniently: undefined (with a problem) when it isn't `{ input, mode }` with a parameter name and
 * a known mode, or is rate on a lane that isn't keyed on time. A bad curve or label curve is dropped with a problem.
 * `readCurve` is the format's own curve reader (its key limit and problems).
 */
export function parseCurveBy(raw: unknown, where: string, lane: CurveByLane, readCurve: (raw: unknown, where: string) => Curve | null, problem: (where: string, message: string) => void): CurveBy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) return void problem(where, "must be { input, mode }; dropped.");
  if (typeof raw.input !== "string" || raw.input === "") return void problem(`${where}.input`, "must name a game parameter; the lane follows no second input.");
  if (typeof raw.mode !== "string" || !(CURVE_BY_MODES as readonly string[]).includes(raw.mode)) {
    return void problem(`${where}.mode`, `must be one of ${CURVE_BY_MODES.join(", ")}; the lane follows no second input.`);
  }
  const mode = raw.mode as CurveByMode;
  if (mode === "rate" && !lane.time) return void problem(`${where}.mode`, "rate scales a lane's clock, so it needs a lane keyed on time; the lane follows no second input.");
  const out: { input: string; mode: CurveByMode; curve?: Curve; labels?: Record<string, Curve> } = { input: raw.input, mode };
  if (mode === "labels") {
    if (raw.curve !== undefined) problem(`${where}.curve`, "a labels lane has a curve per label (labels); dropped.");
    if (raw.labels !== undefined) {
      if (!isRecord(raw.labels)) problem(`${where}.labels`, "must be an object of label → curve; dropped.");
      else {
        const labels: Record<string, Curve> = {};
        for (const [label, v] of Object.entries(raw.labels)) {
          if (Object.keys(labels).length >= MAX_BY_LABELS) { problem(`${where}.labels`, `at most ${MAX_BY_LABELS} label curves; the rest are dropped.`); break; }
          const c = readCurve(v, `${where}.labels.${label}`);
          if (c && c.length > 0) labels[label] = c;
          else if (c) problem(`${where}.labels.${label}`, "has no keys; dropped.");
        }
        if (Object.keys(labels).length > 0) out.labels = labels;
      }
    }
  } else {
    if (raw.labels !== undefined) problem(`${where}.labels`, `labels belong to a labels lane, not ${mode}; dropped.`);
    if (raw.curve !== undefined) {
      const c = readCurve(raw.curve, `${where}.curve`);
      if (c && c.length > 0) out.curve = c;
      else if (c) problem(`${where}.curve`, "has no keys; dropped.");
    }
  }
  return out;
}

/** A `by` as JSON (`parseCurveBy` reads it back unchanged). */
export function curveByToJson(by: CurveBy): JsonRecord {
  const out: JsonRecord = { input: by.input, mode: by.mode };
  if (by.curve && by.curve.length > 0) out.curve = curveToJson(by.curve);
  if (by.labels && Object.keys(by.labels).length > 0) out.labels = Object.fromEntries(Object.entries(by.labels).map(([l, c]) => [l, curveToJson(c)]));
  return out;
}

/**
 * Why `by` can't run as written, or null when it can: its input names no parameter `def` (undefined), labels on a
 * parameter that has none, or rate on a lane not keyed on time. The formats that know their parameters check it in the
 * parse; a playlist's lint checks it against its own and the project's parameters.
 */
export function curveByProblem(by: CurveBy, def: ParameterDef | undefined, lane: CurveByLane): string | null {
  if (!def) return `the second input "${by.input}" is no game parameter, so the lane ignores it`;
  if (by.mode === "labels" && !isLabelled(def)) return `"${by.input}" has no labels, so a per-label lane can't follow it; the lane ignores it`;
  if (by.mode === "rate" && !lane.time) return "rate scales a lane's clock, so it needs a lane keyed on time; the lane ignores it";
  return null;
}
