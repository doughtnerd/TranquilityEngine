// Where a new Blend entry goes (the prototype's `place1D` / `place2D`, PL:931–945). Positions are in the axis's units
// (a parameter's min..max, or 0..seconds of voice time); ranges come from the caller. Pure.
import type { BlendAxis } from "../../../engine/audio/playlist/types";
import { parameterRange, type ParameterDef } from "../../../engine/audio/eventFormat";

/** An axis's range in its units. */
export type AxisRange = readonly [number, number];

/** The range of a Blend axis: voice time 0..seconds, a parameter its min..max (a labelled one 0..labels−1), an unknown one 0..1. */
export function axisRange(axis: BlendAxis, parameters: readonly ParameterDef[]): AxisRange {
  if ("voiceTime" in axis) return [0, axis.voiceTime];
  const def = parameters.find((p) => p.name === axis.parameter);
  if (!def) return [0, 1];
  const [lo, hi] = parameterRange(def);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

const tidy = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * A 1D Blend with a new entry: every entry is re-spaced evenly over the range (3 → 0, ½, 1; 4 → thirds), and the new
 * one takes the place of the widest gap (leftmost on ties; the ends count as gaps), so the 1st is leftmost, the 2nd
 * rightmost, the 3rd in the middle. `xs` are the existing entries' positions (undefined: unplaced, read as the range's
 * start). Returns the existing entries' new positions (in their order) and the new entry's.
 */
export function place1D(xs: readonly (number | undefined)[], range: AxisRange): { xs: number[]; x: number } {
  const [a, b] = range;
  const span = b - a || 1;
  const n = xs.length;
  if (n === 0) return { xs: [], x: a };
  const vals = xs.map((x) => x ?? a);
  const order = vals.map((_, i) => i).sort((i, j) => vals[i]! - vals[j]! || i - j);
  const sorted = order.map((i) => vals[i]!);
  let best = { w: sorted[0]! - a, at: 0 };
  for (let k = 0; k < n - 1; k++) {
    const w = sorted[k + 1]! - sorted[k]!;
    if (w > best.w) best = { w, at: k + 1 };
  }
  if (b - sorted[n - 1]! > best.w) best = { w: b - sorted[n - 1]!, at: n };
  const slots: (number | "new")[] = [...order];
  slots.splice(best.at, 0, "new");
  const out = new Array<number>(n);
  let x = a;
  slots.forEach((s, k) => {
    const v = tidy(a + (k * span) / n);
    if (s === "new") x = v;
    else out[s] = v;
  });
  return { xs: out, x };
}

/** The 2D spots in the order a new entry tries them: edge middles (top, right, bottom, left), corners clockwise from the top right, then the points between. */
export const SPOTS_2D: readonly (readonly [number, number])[] = [
  [0.5, 1], [1, 0.5], [0.5, 0], [0, 0.5],
  [1, 1], [1, 0], [0, 0], [0, 1],
  [0.75, 1], [1, 0.75], [1, 0.25], [0.75, 0], [0.25, 0], [0, 0.25], [0, 0.75], [0.25, 1],
];

/** How close (normalised, per axis) an entry must be to a spot to take it. */
const TAKEN = 0.12;

/** A 2D Blend's new entry: the first free spot (`SPOTS_2D`), else the centre. Points are the existing entries' positions in units. */
export function place2D(points: readonly { readonly x?: number; readonly y?: number }[], rx: AxisRange, ry: AxisRange): { x: number; y: number } {
  const nx = (v: number) => (v - rx[0]) / (rx[1] - rx[0] || 1);
  const ny = (v: number) => (v - ry[0]) / (ry[1] - ry[0] || 1);
  const pts = points.filter((p) => p.x !== undefined).map((p) => [nx(p.x!), ny(p.y ?? (ry[0] + ry[1]) / 2)] as const);
  const spot = SPOTS_2D.find((q) => !pts.some((o) => Math.abs(o[0] - q[0]) < TAKEN && Math.abs(o[1] - q[1]) < TAKEN)) ?? ([0.5, 0.5] as const);
  return { x: tidy(rx[0] + spot[0] * (rx[1] - rx[0])), y: tidy(ry[0] + spot[1] * (ry[1] - ry[0])) };
}

/** Entries spread when a playlist becomes a Blend (the prototype's `modeInit`): x over 10–90 % of the range, y alternating 15 % / 85 % in 2D. */
export function spreadPositions(n: number, rx: AxisRange, ry?: AxisRange): { x: number; y?: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const f = n === 1 ? 0.5 : 0.1 + (0.8 * i) / (n - 1);
    const x = tidy(rx[0] + f * (rx[1] - rx[0]));
    return ry ? { x, y: tidy(ry[0] + (i % 2 === 0 ? 0.15 : 0.85) * (ry[1] - ry[0])) } : { x };
  });
}

/** A position normalised to 0..1 over a range (clamped). */
export const normalise = (v: number, r: AxisRange): number => Math.min(1, Math.max(0, (v - r[0]) / (r[1] - r[0] || 1)));
/** A 0..1 position back in a range's units. */
export const denormalise = (f: number, r: AxisRange): number => tidy(r[0] + f * (r[1] - r[0]));
