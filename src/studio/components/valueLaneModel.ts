// A value lane's drawing (ADR 0349 `ValueLane`): a value over time (a game parameter in a take, voices and CPU, a bus's
// gain, loudness in a capture) as a polyline, its value at the cursor for the header, a reference line (a voice limit,
// a loudness target), and its vertical range. Points are sorted by time; between points the value is linear, or held
// (`step`) for values that jump. Long series are thinned to a few points per pixel column.
import type { TimeToX } from "./timeAxis";

export interface ValuePoint {
  /** Seconds. */
  readonly t: number;
  readonly v: number;
}

export type Interp = "linear" | "step";

/** The value at `t`: held before the first point and after the last; null with no points. */
export function valueAt(points: readonly ValuePoint[], t: number, interp: Interp = "linear"): number | null {
  const n = points.length;
  if (n === 0) return null;
  if (t <= points[0]!.t) return points[0]!.v;
  if (t >= points[n - 1]!.t) return points[n - 1]!.v;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!, b = points[hi]!;
  if (interp === "step" || b.t === a.t) return a.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/** The lane's vertical range: the points' (and the reference line's) extent, or `fixed` when given; never zero tall. */
export function valueRange(points: readonly ValuePoint[], fixed?: readonly [number, number] | null, ref?: number | null): [number, number] {
  if (fixed) return fixed[1] > fixed[0] ? [fixed[0], fixed[1]] : [fixed[0], fixed[0] + 1];
  let lo = Infinity, hi = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.v)) continue;
    lo = Math.min(lo, p.v);
    hi = Math.max(hi, p.v);
  }
  if (ref != null && Number.isFinite(ref)) {
    lo = Math.min(lo, ref);
    hi = Math.max(hi, ref);
  }
  if (lo === Infinity) return [0, 1];
  if (hi === lo) return [lo - 0.5, hi + 0.5];
  return [lo, hi];
}

/** The y of `v` in a lane `height` tall over `range` (top is the range's max), `pad` pixels kept clear top and bottom. */
export function valueToY(v: number, range: readonly [number, number], height: number, pad = 2): number {
  const [lo, hi] = range;
  const c = Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  const inner = Math.max(0, height - 2 * pad);
  return pad + inner * (1 - (c - lo) / (hi - lo || 1));
}

/**
 * The polyline's points ("x,y x,y …") over the lane `width` × `height`: points outside the lane's width are dropped
 * except the neighbours that carry the line to its edges; `step` draws stairs; more than two points per pixel column are
 * thinned to the column's first, lowest, highest and last.
 */
export function lanePolyline(points: readonly ValuePoint[], toX: TimeToX, range: readonly [number, number], width: number, height: number, interp: Interp = "linear"): string {
  const out: [number, number][] = [];
  let column = NaN;
  let bucket: [number, number][] = [];
  const flush = () => {
    if (bucket.length <= 4) out.push(...bucket);
    else {
      let lo = bucket[0]!, hi = bucket[0]!;
      for (const p of bucket) {
        if (p[1] > lo[1]) lo = p;
        if (p[1] < hi[1]) hi = p;
      }
      const keep = [bucket[0]!, lo, hi, bucket[bucket.length - 1]!].filter((p, i, a) => a.indexOf(p) === i);
      keep.sort((a, b) => a[0] - b[0]);
      out.push(...keep);
    }
    bucket = [];
  };
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const x = toX(p.t);
    const nextX = i + 1 < n ? toX(points[i + 1]!.t) : Infinity;
    const prevX = i > 0 ? toX(points[i - 1]!.t) : -Infinity;
    if (nextX < 0 || prevX > width) continue;
    const y = valueToY(p.v, range, height);
    const col = Math.floor(x);
    if (col !== column) {
      flush();
      column = col;
    }
    if (interp === "step" && i > 0 && prevX <= width && nextX >= 0) {
      const prev = points[i - 1]!;
      if (out.length + bucket.length > 0) bucket.push([x, valueToY(prev.v, range, height)]);
    }
    bucket.push([x, y]);
  }
  flush();
  return out.map(([x, y]) => `${round(x)},${round(y)}`).join(" ");
}

const round = (n: number) => Math.round(n * 10) / 10;

/** A value for the header: `unit` after it, `decimals` places, "—" for none. */
export function formatValue(v: number | null, unit = "", decimals = 2): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const text = v.toFixed(decimals).replace(/^-/, "−");
  return unit ? `${text} ${unit}` : text;
}
