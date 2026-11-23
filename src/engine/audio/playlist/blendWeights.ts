/**
 * Blend weights (ADR 0343 "Blend"; the prototype's `levelGains`, PL:868–875, and its 2D triangulation, PL:706–721): how
 * much of each entry a Blend plays for an input position. The runtime applies these to the entries' voices; the Studio
 * draws the same numbers.
 *
 * Positions are normalised to 0..1 per axis by the caller (a scalar parameter by its min..max, voice time by the axis's
 * seconds).
 *
 * - **1D crossfade:** piecewise linear between the two neighbouring entries; outside the outermost entries the nearest
 *   one plays alone.
 * - **1D layer:** the first entry (lowest x) is always 1; entry j ramps 0 → 1 between the previous entry's x and its own
 *   (cumulative stems).
 * - **Equal power** (crossfade only): each weight becomes √weight.
 * - **2D:** a Bowyer–Watson Delaunay triangulation of the points; inside a triangle barycentric weights; outside the hull
 *   the input is projected onto the nearest hull edge (two weights). One point gets 1; with fewer than three points (or
 *   all points on a line) the nearest segment between two points is used.
 *
 * - **Explicit regions** (ADR 0350, 1D only): an entry with a region plays by it (`regionWeight`); the layer/crossfade
 *   mode and equal power only shape the regions derived for entries without one, so old files keep their weights.
 *
 * Pure; no plugin, no DOM.
 */
import { fadeInLevel, fadeOutLevel } from "./fadeShapes";
import type { FadeShape } from "./types";
import { evalCurve, type Curve } from "../../core/curve";

/** A 2D point, normalised. */
export interface BlendPoint { x: number; y: number }

/**
 * ADR 0350: an entry's explicit region on a 1D axis, in the same normalised units as `xs` (the caller normalises
 * `BlendRegion`'s axis units). Shapes absent: the blend's `curve` (`linear` → linear, `equalPower` → equalPower).
 */
export interface Region1D {
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
  shapeIn?: FadeShape;
  shapeOut?: FadeShape;
}

/** ADR 0350: the weight an explicit region gives at `x`: 0 outside [start, end], the fades' levels at their edges, else 1. */
export function regionWeight(r: Region1D, x: number, curve: "linear" | "equalPower"): number {
  if (x < r.start || x > r.end) return 0;
  const def: FadeShape = curve === "equalPower" ? "equalPower" : "linear";
  let w = 1;
  if (r.fadeIn > 0 && x < r.start + r.fadeIn) w *= fadeInLevel(r.shapeIn ?? def, (x - r.start) / r.fadeIn);
  if (r.fadeOut > 0 && x > r.end - r.fadeOut) w *= fadeOutLevel(r.shapeOut ?? def, (x - (r.end - r.fadeOut)) / r.fadeOut);
  return w;
}

/**
 * The region ADR 0343's rules give an entry with none (ADR 0350 "derived"), in normalised units: crossfade from the
 * previous entry's x to its own and out to the next one's (the outermost ones reach past the axis); layer from the
 * previous one's x to its own and never out (the lowest always plays). Its fades are linear; the weights the derived
 * regions give are `blendWeights1D`'s for entries without a region (with √ for equal power in crossfade mode).
 */
export function derivedRegion(xs: readonly number[], index: number, fade: "crossfade" | "layer"): Region1D {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]! || a - b);
  const k = order.indexOf(index);
  const x = xs[index]!;
  const prev = k > 0 ? xs[order[k - 1]!]! : null;
  const next = k < order.length - 1 ? xs[order[k + 1]!]! : null;
  const far = 1e6;
  if (fade === "layer") {
    if (prev === null) return { start: -far, end: far, fadeIn: 0, fadeOut: 0 };
    return { start: prev, end: far, fadeIn: x - prev, fadeOut: 0 };
  }
  return { start: prev ?? -far, end: next ?? far, fadeIn: prev === null ? 0 : x - prev, fadeOut: next === null ? 0 : next - x };
}

/**
 * Weights for a 1D blend: `xs` are the entries' normalised positions in entry order; the result is in entry order.
 * ADR 0350: an entry with an explicit region (`regions[i]`) takes `regionWeight`; the others keep ADR 0343's weights.
 */
export function blendWeights1D(
  xs: readonly number[], x: number, fade: "crossfade" | "layer", curve: "linear" | "equalPower",
  regions?: readonly (Region1D | undefined)[], weightCurves?: readonly (Curve | undefined)[],
): number[] {
  const anyCurve = weightCurves?.some((c) => c !== undefined) ?? false;
  // With weight curves the derived weights are read linear (the curve replaces the √ of equal power for its entry).
  const w = derivedWeights1D(xs, x, fade, anyCurve ? "linear" : curve);
  const root = anyCurve && curve === "equalPower" && fade === "crossfade";
  for (let i = 0; i < w.length; i++) {
    const r = regions?.[i];
    const c = weightCurves?.[i];
    if (r) w[i] = regionWeight(r, x, curve);
    if (c) w[i] = shapeWeight(c, w[i]!);
    else if (root && !r) w[i] = Math.sqrt(w[i]!);
  }
  return w;
}

/** ADR 0350: a weight through an entry's weight curve, clamped to 0..1. */
export function shapeWeight(c: Curve, w: number): number {
  return clamp01(evalCurve(c, clamp01(w)));
}

function derivedWeights1D(xs: readonly number[], x: number, fade: "crossfade" | "layer", curve: "linear" | "equalPower"): number[] {
  const n = xs.length;
  const w = new Array<number>(n).fill(0);
  if (n === 0) return w;
  // Sorted by position; ties keep entry order (stable sort).
  const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]! || a - b);
  if (fade === "layer") {
    w[order[0]!] = 1;
    for (let k = 1; k < n; k++) {
      const lo = xs[order[k - 1]!]!, hi = xs[order[k]!]!;
      w[order[k]!] = hi <= lo ? (x >= hi ? 1 : 0) : clamp01((x - lo) / (hi - lo));
    }
    return w;
  }
  if (x <= xs[order[0]!]!) w[order[0]!] = 1;
  else if (x >= xs[order[n - 1]!]!) w[order[n - 1]!] = 1;
  else {
    for (let k = 0; k < n - 1; k++) {
      const a = order[k]!, b = order[k + 1]!;
      const lo = xs[a]!, hi = xs[b]!;
      if (x < lo || x > hi) continue;
      if (hi <= lo) { w[b] = 1; break; }
      const t = (x - lo) / (hi - lo);
      w[a] = 1 - t;
      w[b] = t;
      break;
    }
  }
  if (curve === "equalPower") for (let i = 0; i < n; i++) w[i] = Math.sqrt(w[i]!);
  return w;
}

/** Weights for a 2D blend at `p` over `points` (entry order). Equal power, when asked, is applied by the caller's `curve` here too. */
export function blendWeights2D(points: readonly BlendPoint[], p: BlendPoint, curve: "linear" | "equalPower" = "linear", weightCurves?: readonly (Curve | undefined)[]): number[] {
  const w = rawWeights2D(points, p, weightCurves?.some((c) => c !== undefined) ? "linear" : curve);
  if (!weightCurves || !weightCurves.some((c) => c !== undefined)) return w;
  // ADR 0350: each entry's raw weight through its curve (√ for one without, under equal power); under equal power the
  // shaped weights are normalised to constant power (a no-op when no entry has a curve: Σ(√w)² = Σw = 1).
  let power = 0;
  for (let i = 0; i < w.length; i++) {
    const c = weightCurves[i];
    w[i] = c ? shapeWeight(c, w[i]!) : curve === "equalPower" ? Math.sqrt(w[i]!) : w[i]!;
    power += w[i]! * w[i]!;
  }
  if (curve === "equalPower" && power > 1e-12) {
    const k = 1 / Math.sqrt(power);
    for (let i = 0; i < w.length; i++) w[i] = w[i]! * k;
  }
  return w;
}

function rawWeights2D(points: readonly BlendPoint[], p: BlendPoint, curve: "linear" | "equalPower"): number[] {
  const n = points.length;
  const w = new Array<number>(n).fill(0);
  if (n === 0) return w;
  if (n === 1) { w[0] = 1; return w; }
  const tris = n >= 3 ? delaunay(points) : [];
  let done = false;
  if (tris.length > 0) {
    for (const [a, b, c] of tris) {
      const bc = barycentric(points[a]!, points[b]!, points[c]!, p);
      if (bc && bc[0] >= -1e-9 && bc[1] >= -1e-9 && bc[2] >= -1e-9) {
        w[a] = clamp01(bc[0]); w[b] = clamp01(bc[1]); w[c] = clamp01(bc[2]);
        done = true;
        break;
      }
    }
    if (!done) {
      // Outside the hull: the nearest hull edge (an edge used by exactly one triangle).
      const edges = hullEdges(tris);
      projectOntoNearest(points, edges, p, w);
      done = true;
    }
  }
  if (!done) {
    // Fewer than three points, or all on a line: the nearest segment between any two points.
    const pairs: [number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
    projectOntoNearest(points, pairs, p, w);
  }
  if (curve === "equalPower") for (let i = 0; i < n; i++) w[i] = Math.sqrt(w[i]!);
  return w;
}

/** Bowyer–Watson Delaunay triangulation; triangles as point-index triples. Empty when the points are all on one line. */
export function delaunay(points: readonly BlendPoint[]): [number, number, number][] {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of points) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
  const d = Math.max(maxX - minX, maxY - minY, 1e-9) * 20;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const all: BlendPoint[] = [...points, { x: cx - d, y: cy - d }, { x: cx + d, y: cy - d }, { x: cx, y: cy + d }];
  let tris: [number, number, number][] = [[n, n + 1, n + 2]];
  for (let i = 0; i < n; i++) {
    const q = all[i]!;
    const bad: [number, number, number][] = [];
    const keep: [number, number, number][] = [];
    for (const t of tris) (inCircumcircle(all[t[0]]!, all[t[1]]!, all[t[2]]!, q) ? bad : keep).push(t);
    // The boundary of the hole: edges of bad triangles not shared with another bad triangle.
    const count = new Map<string, [number, number]>();
    const seen = new Map<string, number>();
    for (const t of bad) {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as [number, number][]) {
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
        count.set(k, [a, b]);
      }
    }
    for (const [k, e] of count) if (seen.get(k) === 1) keep.push([e[0], e[1], i]);
    tris = keep;
  }
  return tris.filter((t) => t[0] < n && t[1] < n && t[2] < n && Math.abs(area2(points[t[0]]!, points[t[1]]!, points[t[2]]!)) > 1e-12);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const area2 = (a: BlendPoint, b: BlendPoint, c: BlendPoint): number => (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);

function inCircumcircle(a: BlendPoint, b: BlendPoint, c: BlendPoint, p: BlendPoint): boolean {
  // Orientation-independent: the determinant's sign flips with the triangle's winding.
  const ax = a.x - p.x, ay = a.y - p.y, bx = b.x - p.x, by = b.y - p.y, cx = c.x - p.x, cy = c.y - p.y;
  const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  return area2(a, b, c) > 0 ? det > 0 : det < 0;
}

function barycentric(a: BlendPoint, b: BlendPoint, c: BlendPoint, p: BlendPoint): [number, number, number] | null {
  const den = area2(a, b, c);
  if (Math.abs(den) < 1e-12) return null;
  const wa = area2(p, b, c) / den;
  const wb = area2(a, p, c) / den;
  return [wa, wb, 1 - wa - wb];
}

function hullEdges(tris: readonly [number, number, number][]): [number, number][] {
  const uses = new Map<string, { e: [number, number]; n: number }>();
  for (const t of tris) {
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as [number, number][]) {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      const u = uses.get(k);
      if (u) u.n++;
      else uses.set(k, { e: [a, b], n: 1 });
    }
  }
  return [...uses.values()].filter((u) => u.n === 1).map((u) => u.e);
}

/** Projects `p` onto the nearest of `edges` and writes the two endpoint weights into `w`. */
function projectOntoNearest(points: readonly BlendPoint[], edges: readonly [number, number][], p: BlendPoint, w: number[]): void {
  // Ties go to the shorter segment (neighbouring points before a span across others).
  let best = Infinity, bestLen = Infinity, bi = -1, bj = -1, bt = 0;
  for (const [i, j] of edges) {
    const a = points[i]!, b = points[j]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2) : 0;
    const qx = a.x + t * dx - p.x, qy = a.y + t * dy - p.y;
    const dist = qx * qx + qy * qy;
    if (dist < best - 1e-12 || (Math.abs(dist - best) <= 1e-12 && len2 < bestLen)) { best = dist; bestLen = len2; bi = i; bj = j; bt = t; }
  }
  if (bi < 0) return;
  w[bi] = 1 - bt;
  w[bj] = (w[bj] ?? 0) + bt;
}
