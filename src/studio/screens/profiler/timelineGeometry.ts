// The Profiler timeline's drawing maths (ADR 0334): a line track's SVG path in a fixed box (`BOX_W` x `BOX_H`, stretched
// to the track by the view), reduced to at most one min/max pair per bucket through the editor profiler's
// `downsampleMinMax`, so a ten-minute capture costs as much to draw as a ten-second one; a step path for a parameter
// (held until its next change); and where a time sits as a share of the capture. Pure.
import { downsampleMinMax } from "../../../plugins/audio/editor/mix/timelineModel";

export const BOX_W = 1000;
export const BOX_H = 100;
/** Buckets a line is reduced to (two points each at most). */
export const LINE_BUCKETS = 500;

export interface LineInput {
  readonly times: ArrayLike<number>;
  readonly values: ArrayLike<number>;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

/** A time as a percentage of the capture (0..100), for absolutely placed elements. */
export const pct = (t: number, duration: number): number => (duration > 0 ? clamp01(t / duration) * 100 : 0);

/** The y of `v` on a scale from `min` (bottom) to `max` (top), in the box. */
export const yOf = (v: number, min: number, max: number): number => BOX_H - clamp01((v - min) / (max - min || 1)) * BOX_H;

/** The line's path over the whole capture (`duration` seconds) on the scale [min, max]; "" with no samples. */
export function linePath(line: LineInput, duration: number, min: number, max: number, buckets = LINE_BUCKETS): string {
  if (!(duration > 0) || line.times.length === 0) return "";
  // The window is half-open, so it ends a hair past the capture: the sample at its very end is drawn too.
  const b = downsampleMinMax(line.times, line.values, { start: 0, end: duration * (1 + 1e-9) + 1e-9, followLive: false }, buckets);
  const parts: string[] = [];
  let pen = false;
  for (let i = 0; i < buckets; i++) {
    if (!b.filled[i]) continue; // a bucket with no sample: the line runs on to the next one
    const x = fmt(((i + 0.5) / buckets) * BOX_W);
    const lo = yOf(b.min[i]!, min, max);
    const hi = yOf(b.max[i]!, min, max);
    parts.push(`${pen ? "L" : "M"}${x} ${fmt(hi)}`);
    if (lo !== hi) parts.push(`L${x} ${fmt(lo)}`);
    pen = true;
  }
  return parts.join(" ");
}

/** A held value's path: flat from each change to the next, and to the capture's end after the last. */
export function stepPath(line: LineInput, duration: number, min: number, max: number): string {
  const n = line.times.length;
  if (!(duration > 0) || n === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = fmt(clamp01(line.times[i]! / duration) * BOX_W);
    const x1 = fmt(i + 1 < n ? clamp01(line.times[i + 1]! / duration) * BOX_W : BOX_W);
    const y = fmt(yOf(line.values[i]!, min, max));
    parts.push(`${i === 0 ? "M" : "L"}${x0} ${y}`, `L${x1} ${y}`);
  }
  return parts.join(" ");
}

/** The smallest and largest finite value (for a parameter's own scale), padded so a flat line sits mid-track. */
export function extent(values: ArrayLike<number>): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

/** The value in force at `t` (the last sample at or before it), or null before the first. */
export function valueAt(line: LineInput, t: number): number | null {
  let lo = 0;
  let hi = line.times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line.times[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : line.values[found]!;
}

/** `m:ss.s` for a ruler or a message ("1:02.5", "0:04.0"). */
export function clockText(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

/** Ruler ticks: a step of 1, 2, 5, 10, 15, 30 or 60 s giving at most `max` labels over `duration`. */
export function rulerTicks(duration: number, max = 10): number[] {
  if (!(duration > 0)) return [];
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => duration / s <= max) ?? 600;
  const out: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}
