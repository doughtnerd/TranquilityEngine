// What the Blend views draw (the prototype's 1D lane and 2D plane; ADR 0329 "Blend"), from the engine's own weights
// (`blendWeights.ts`), so the Studio shows the numbers the runtime plays: each entry's weight curve over the axis, the
// input position from the test values, the 2D triangulation and the triangle the input sits in, and keyboard nudges.
// Pure.
import { blendWeights1D, blendWeights2D, delaunay } from "../../../engine/audio/playlist/blendWeights";
import type { BlendAxis, BlendSettings, Entry } from "../../../engine/audio/playlist/types";
import { isLabelled, parameterDefault, type ParameterDef } from "../../../engine/audio/parameters";
import { axisRange, normalise, type AxisRange } from "./blendPlacement";

/** Each entry's weight at `samples` evenly spaced positions over 0..1 (entry order): `[x, weight]` pairs. */
export function laneCurves(xs: readonly number[], fade: BlendSettings["fade"], curve: BlendSettings["curve"], samples = 101): [number, number][][] {
  const out: [number, number][][] = xs.map(() => []);
  for (let k = 0; k < samples; k++) {
    const x = k / (samples - 1);
    const w = blendWeights1D(xs, x, fade, curve);
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
  if (b.blend.axes.length === 1) return blendWeights1D(pts.map((p) => p.x), ix, b.blend.fade, b.blend.curve);
  const iy = normalise(axisInput(b.blend.axes[1]!, defs, values, voiceTime), ranges[1]!);
  return blendWeights2D(pts, { x: ix, y: iy }, b.blend.curve);
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
