/**
 * The profiler timeline's pure model (ADR 0171 section 7): the viewport (zoom, pan, clamp,
 * follow-live), min/max downsampling into pixel buckets that never drops a tick, and the
 * track list. No DOM, no canvas.
 */

/** A view onto capture time, in seconds. `followLive` pins `end` to the capture's duration as it grows. */
export interface Viewport {
  readonly start: number;
  readonly end: number;
  readonly followLive: boolean;
}

/** The narrowest span the viewport allows (seconds). */
export const MIN_SPAN_S = 0.005;

/**
 * Clamp into [0, duration], span in [MIN_SPAN_S, max(duration, MIN_SPAN_S)]; followLive keeps end = duration.
 * When the duration is below MIN_SPAN_S the window starts at 0 and is MIN_SPAN_S wide (end > duration).
 */
export function clampViewport(v: Viewport, duration: number): Viewport {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const maxSpan = Math.max(d, MIN_SPAN_S);
  let span = v.end - v.start;
  if (!Number.isFinite(span)) span = maxSpan;
  span = Math.min(Math.max(span, MIN_SPAN_S), maxSpan);
  const maxStart = Math.max(0, d - span);
  let start: number;
  if (v.followLive) start = maxStart;
  else {
    start = Number.isFinite(v.start) ? v.start : 0;
    start = Math.min(Math.max(start, 0), maxStart);
  }
  return { start, end: start + span, followLive: v.followLive };
}

/** Zoom by `factor` (> 1 zooms in) around `anchor` (seconds, kept at the same screen position), then clamp. */
export function zoomViewport(v: Viewport, factor: number, anchor: number, duration: number): Viewport {
  if (!(factor > 0) || !Number.isFinite(factor)) return clampViewport(v, duration);
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const span = v.end - v.start;
  const next = Math.min(Math.max(span / factor, MIN_SPAN_S), Math.max(d, MIN_SPAN_S));
  const frac = span > 0 ? (anchor - v.start) / span : 0;
  const start = anchor - frac * next;
  return clampViewport({ start, end: start + next, followLive: v.followLive }, duration);
}

/** Pan by `delta` seconds, then clamp; panning back from the live edge clears followLive, reaching it again doesn't set it. */
export function panViewport(v: Viewport, delta: number, duration: number): Viewport {
  const followLive = v.followLive && !(delta < 0);
  return clampViewport({ start: v.start + delta, end: v.end + delta, followLive }, duration);
}

/** Follow live: keep the span, end = duration, followLive true. */
export function followLiveViewport(v: Viewport, duration: number): Viewport {
  return clampViewport({ start: v.start, end: v.end, followLive: true }, duration);
}

export function timeToX(v: Viewport, t: number, width: number): number {
  return ((t - v.start) / (v.end - v.start)) * width;
}

export function xToTime(v: Viewport, x: number, width: number): number {
  return v.start + (x / width) * (v.end - v.start);
}

/** Min/max per pixel bucket; `filled[i]` is 0 where no sample falls in bucket i. Reuses `out` when its length matches. */
export interface Buckets {
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly filled: Uint8Array;
}

/** First index whose time is >= t. */
function lowerBound(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bucketOf(t: number, start: number, span: number, buckets: number): number {
  const b = Math.floor(((t - start) / span) * buckets);
  return b < 0 ? 0 : b >= buckets ? buckets - 1 : b;
}

/**
 * `times` ascending (seconds), `values` the same length; samples in [v.start, v.end) go to
 * floor((t - start) / span x buckets). Binary search to the window; O(window) after.
 */
export function downsampleMinMax(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  v: Viewport,
  buckets: number,
  out?: Buckets,
): Buckets {
  const n = Math.max(0, Math.floor(buckets));
  const res: Buckets =
    out && out.min.length === n && out.max.length === n && out.filled.length === n
      ? out
      : { min: new Float32Array(n), max: new Float32Array(n), filled: new Uint8Array(n) };
  res.min.fill(0);
  res.max.fill(0);
  res.filled.fill(0);
  const span = v.end - v.start;
  if (n === 0 || !(span > 0)) return res;
  const count = Math.min(times.length, values.length);
  for (let i = lowerBound(times, v.start); i < count; i++) {
    const t = times[i]!;
    if (t >= v.end) break;
    const b = bucketOf(t, v.start, span, n);
    const x = values[i]!;
    if (res.filled[b] === 0) {
      res.min[b] = x;
      res.max[b] = x;
      res.filled[b] = 1;
    } else {
      if (x < res.min[b]!) res.min[b] = x;
      if (x > res.max[b]!) res.max[b] = x;
    }
  }
  return res;
}

/** Tick tracks (underruns, late commands, ladder steps, markers): every tick in [v.start, v.end) sets its bucket to 1, never dropped, however dense. */
export function downsampleTicks(times: ArrayLike<number>, v: Viewport, buckets: number, out?: Uint8Array): Uint8Array {
  const n = Math.max(0, Math.floor(buckets));
  const res = out && out.length === n ? out : new Uint8Array(n);
  res.fill(0);
  const span = v.end - v.start;
  if (n === 0 || !(span > 0)) return res;
  for (let i = lowerBound(times, v.start); i < times.length; i++) {
    const t = times[i]!;
    if (t >= v.end) break;
    res[bucketOf(t, v.start, span, n)] = 1;
  }
  return res;
}

/** The profiler's track list: order, visibility, height. */
export interface Track {
  readonly id: string;
  readonly label: string;
  readonly kind: "line" | "ticks" | "lanes";
  readonly height: number;
  readonly visible: boolean;
}

export class TrackList {
  private list: readonly Track[];

  get tracks(): readonly Track[] {
    return this.list;
  }

  constructor(tracks: readonly Track[] = []) {
    const seen = new Set<string>();
    for (const t of tracks) {
      if (seen.has(t.id)) throw new Error(`duplicate track id "${t.id}"`);
      seen.add(t.id);
    }
    this.list = [...tracks];
  }

  add(t: Track): void {
    if (this.list.some((x) => x.id === t.id)) throw new Error(`duplicate track id "${t.id}"`);
    this.list = [...this.list, t];
  }

  remove(id: string): void {
    this.list = this.list.filter((x) => x.id !== id);
  }

  move(id: string, toIndex: number): void {
    const from = this.list.findIndex((x) => x.id === id);
    if (from < 0) return;
    const rest = this.list.filter((_, i) => i !== from);
    const to = Math.min(Math.max(Math.trunc(toIndex), 0), rest.length);
    rest.splice(to, 0, this.list[from]!);
    this.list = rest;
  }

  setVisible(id: string, visible: boolean): void {
    this.list = this.list.map((x) => (x.id === id ? { ...x, visible } : x));
  }
}
