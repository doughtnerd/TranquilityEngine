// What the Blend views draw (the prototype's 1D lane and 2D plane; ADR 0343 "Blend"), from the engine's own weights
// (`blendWeights.ts`), so the Studio shows the numbers the runtime plays: each entry's weight curve over the axis, the
// input position from the test values, the 2D triangulation and the triangle the input sits in, and keyboard nudges.
// Pure.
import { blendWeights1D, blendWeights2D, delaunay, derivedRegion, type Region1D } from "../../../engine/audio/playlist/blendWeights";
import type { BlendAxis, BlendRegion, BlendSettings, Entry } from "../../../engine/audio/playlist/types";
import type { Curve } from "../../../engine/core/curve";
import { isLabelled, parameterDefault, type ParameterDef } from "../../../engine/audio/parameters";
import { axisRange, normalise, type AxisRange } from "./blendPlacement";

/** Each entry's weight at `samples` evenly spaced positions over 0..1 (entry order): `[x, weight]` pairs. */
export function laneCurves(
  xs: readonly number[], fade: BlendSettings["fade"], curve: BlendSettings["curve"], samples = 101,
  regions?: readonly (Region1D | undefined)[], weightCurves?: readonly (Curve | undefined)[],
): [number, number][][] {
  const out: [number, number][][] = xs.map(() => []);
  for (let k = 0; k < samples; k++) {
    const x = k / (samples - 1);
    const w = blendWeights1D(xs, x, fade, curve, regions, weightCurves);
    w.forEach((v, i) => out[i]!.push([x, v]));
  }
  return out;
}

/** An axis's input value now, in its units: a parameter's test value (else its default), or the voice-time scrub. */
export function axisInput(axis: BlendAxis, defs: readonly ParameterDef[], values: Readonly<Record<string, number>>, voiceTime: number): number {
  if ("voiceTime" in axis) return Math.min(axis.voiceTime, Math.max(0, voiceTime));
  const def = defs.find((d) => d.name === axis.parameter);
  return values[axis.parameter] ?? (def && !isLabelled(def) ? parameterDefault(def) : 0);
}

/** The entries' normalised positions over the blend's axes (unplaced entries at the start). */
export function normalisedPoints(entries: readonly Entry[], ranges: readonly AxisRange[]): { x: number; y: number }[] {
  return entries.map((e) => ({ x: normalise(e.x ?? ranges[0]![0], ranges[0]!), y: ranges[1] ? normalise(e.y ?? (ranges[1][0] + ranges[1][1]) / 2, ranges[1]) : 0 }));
}

/** Each entry's weight at the input now. */
export function liveWeights(b: { blend: BlendSettings | null; entries: readonly Entry[] }, defs: readonly ParameterDef[], values: Readonly<Record<string, number>>, voiceTime: number): number[] {
  if (!b.blend) return [];
  const ranges = b.blend.axes.map((a) => axisRange(a, defs));
  const pts = normalisedPoints(b.entries, ranges);
  const ix = normalise(axisInput(b.blend.axes[0], defs, values, voiceTime), ranges[0]!);
  const curves = weightCurvesOf(b.entries);
  if (b.blend.axes.length === 1) return blendWeights1D(pts.map((p) => p.x), ix, b.blend.fade, b.blend.curve, regionsOf(b.entries, ranges[0]!), curves);
  const iy = normalise(axisInput(b.blend.axes[1]!, defs, values, voiceTime), ranges[1]!);
  return blendWeights2D(pts, { x: ix, y: iy }, b.blend.fade === "layer" ? "linear" : b.blend.curve, curves);
}

// --- ADR 0350: regions (1D) and weight curves ----------------------------------------------------------------------

/** The entries' explicit regions normalised over `range` (not clamped: a region may reach past the axis), or undefined. */
export function regionsOf(entries: readonly Entry[], range: AxisRange): (Region1D | undefined)[] | undefined {
  if (!entries.some((e) => e.region)) return undefined;
  const span = range[1] - range[0] || 1;
  return entries.map(({ region: r }) => r && {
    start: (r.start - range[0]) / span, end: (r.end - range[0]) / span, fadeIn: r.fadeIn / span, fadeOut: r.fadeOut / span,
    ...(r.shapeIn ? { shapeIn: r.shapeIn } : {}), ...(r.shapeOut ? { shapeOut: r.shapeOut } : {}),
  });
}

/** The entries' weight curves, or undefined when none has one. */
export function weightCurvesOf(entries: readonly Entry[]): (Curve | undefined)[] | undefined {
  return entries.some((e) => e.weightCurve) ? entries.map((e) => e.weightCurve) : undefined;
}

const tidy = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * The region entry `i` plays by, in the axis's units: its own, or the one ADR 0343's rules derive from its neighbours
 * (`derivedRegion`), with an end past the axis clamped to it (what the lane draws and a first drag starts from).
 */
export function shownRegion(entries: readonly Entry[], i: number, range: AxisRange, fade: BlendSettings["fade"]): { region: BlendRegion; explicit: boolean } {
  const own = entries[i]?.region;
  if (own) return { region: own, explicit: true };
  const xs = normalisedPoints(entries, [range]).map((p) => p.x);
  const d = derivedRegion(xs, i, fade);
  const span = range[1] - range[0] || 1;
  const start = Math.max(range[0], range[0] + d.start * span), end = Math.min(range[1], range[0] + d.end * span);
  return { region: { start: tidy(start), end: tidy(end), fadeIn: tidy(Math.min(d.fadeIn * span, end - start)), fadeOut: tidy(Math.min(d.fadeOut * span, end - start)) }, explicit: false };
}

/** A region's four handles: its start and end edges and the inner ends of its two fades. */
export type RegionHandle = "start" | "end" | "fadeIn" | "fadeOut";

/**
 * `r` with one handle dragged to `value` (axis units): an edge moves and keeps its fade's width (squeezed to fit), a
 * fade's inner end sets its width; start ≤ end and each fade stays within the region.
 */
export function dragRegion(r: BlendRegion, handle: RegionHandle, value: number): BlendRegion {
  let { start, end, fadeIn, fadeOut } = r;
  if (handle === "start") start = Math.min(value, end);
  else if (handle === "end") end = Math.max(value, start);
  else if (handle === "fadeIn") fadeIn = Math.max(0, value - start);
  else fadeOut = Math.max(0, end - value);
  const span = end - start;
  return { ...r, start: tidy(start), end: tidy(end), fadeIn: tidy(Math.min(fadeIn, span)), fadeOut: tidy(Math.min(fadeOut, span)) };
}

/**
 * ADR 0350: the 2D plane's influence map: an `n` × `n` grid of cells (normalised centres), each with the entry that
 * weighs most there and its shaped weight (the engine's `blendWeights2D`, weight curves applied), for a tint per cell.
 */
export function influenceGrid(points: readonly { x: number; y: number }[], curve: BlendSettings["curve"], curves: readonly (Curve | undefined)[] | undefined, n = 16): { x: number; y: number; entry: number; weight: number }[] {
  const out: { x: number; y: number; entry: number; weight: number }[] = [];
  if (points.length === 0) return out;
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) {
      const p = { x: (k + 0.5) / n, y: (j + 0.5) / n };
      const w = blendWeights2D(points, p, curve, curves);
      let best = 0;
      for (let i = 1; i < w.length; i++) if (w[i]! > w[best]!) best = i;
      out.push({ ...p, entry: best, weight: w[best]! });
    }
  }
  return out;
}

/** Where a handle sits on the axis (units). */
export function handleAt(r: BlendRegion, handle: RegionHandle): number {
  return handle === "start" ? r.start : handle === "end" ? r.end : handle === "fadeIn" ? r.start + r.fadeIn : r.end - r.fadeOut;
}

/** `r` with a handle nudged by the arrow keys: 1 % of the range (Shift 10 %), as the nodes are. */
export function nudgeRegion(r: BlendRegion, handle: RegionHandle, range: AxisRange, dir: -1 | 1, big: boolean): BlendRegion {
  const step = (range[1] - range[0]) * (big ? 0.1 : 0.01);
  return dragRegion(r, handle, handleAt(r, handle) + dir * step);
}

/** The 2D triangulation's edges (index pairs, each once). */
export function triangleEdges(points: readonly { x: number; y: number }[]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const t of points.length >= 3 ? delaunay(points) : []) {
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as const) {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(a < b ? [a, b] : [b, a]);
      }
    }
  }
  return out;
}

/** The triangle the input plays from (the entries with weight above zero, when three do), or null. */
export function activeTriangle(weights: readonly number[]): [number, number, number] | null {
  const on = weights.map((w, i) => [w, i] as const).filter(([w]) => w > 1e-6).map(([, i]) => i);
  return on.length === 3 ? [on[0]!, on[1]!, on[2]!] : null;
}

/** A position nudged by the arrow keys: 1 % of the range (Shift 10 %), clamped. */
export function nudge(value: number, range: AxisRange, dir: -1 | 1, big: boolean): number {
  const step = (range[1] - range[0]) * (big ? 0.1 : 0.01);
  return Math.round(Math.min(range[1], Math.max(range[0], value + dir * step)) * 1e6) / 1e6;
}

/** An axis's name ("speed", "Voice time · 2 s"). */
export const axisName = (a: BlendAxis): string => ("voiceTime" in a ? `Voice time · ${a.voiceTime} s` : a.parameter);
