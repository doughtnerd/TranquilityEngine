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

// ---- min/max pyramid (Pf3b) -------------------------------------------------------------------------------------------
//
// `downsampleMinMax` is O(samples in the window): on a 10-minute capture at one record per quantum a fully zoomed-out
// viewport reads 450,000 samples per series per redraw. The pyramid answers the same question exactly in
// O(buckets x log n): level k holds the min and max of every complete block of PYRAMID_BASE << k samples, a bucket is
// covered by the coarsest whole blocks that fit inside it and raw samples only at its two edges. Nothing is dropped or
// approximated; the result equals `downsampleMinMax` bucket for bucket.
//
// Assumes finite sample values and an append-only series (samples already covered are never rewritten in place).

/** Samples per block at level 0 of the pyramid. */
export const PYRAMID_BASE = 8;
const BASE_SHIFT = 3;

/** What the last pyramid query touched; the tests assert on it, never on time. */
export interface PyramidWork {
  /** Raw samples read (bucket edges and the unbuilt tail). */
  samples: number;
  /** Pyramid blocks read. */
  blocks: number;
  /** Time-array probes made by the bucket-boundary searches. */
  probes: number;
}

export interface MinMaxPyramid {
  readonly values: ArrayLike<number>;
  /** Samples covered so far (only complete blocks are stored). */
  covered: number;
  /** `levels[k]` holds blocks of PYRAMID_BASE << k samples; `blocks` of its entries are filled. */
  readonly levels: { min: Float32Array; max: Float32Array; blocks: number }[];
  readonly lastQuery: PyramidWork;
}

export function createMinMaxPyramid(values: ArrayLike<number>): MinMaxPyramid {
  const p: MinMaxPyramid = { values, covered: 0, levels: [], lastQuery: { samples: 0, blocks: 0, probes: 0 } };
  extendMinMaxPyramid(p);
  return p;
}

function growTo(a: Float32Array, n: number): Float32Array {
  if (a.length >= n) return a;
  const b = new Float32Array(Math.max(n, a.length * 2, 16));
  b.set(a);
  return b;
}

/**
 * Covers samples appended to `p.values` since the last call: O(new samples). Returns false (after starting over) when
 * the series shrank, which is not an append.
 */
export function extendMinMaxPyramid(p: MinMaxPyramid, count = p.values.length): boolean {
  let ok = true;
  if (count < p.covered) {
    p.levels.length = 0;
    p.covered = 0;
    ok = false;
  }
  const values = p.values;
  for (let k = 0; ; k++) {
    const size = PYRAMID_BASE << k;
    const target = Math.floor(count / size);
    if (target === 0) break;
    let lvl = p.levels[k];
    if (!lvl) p.levels[k] = lvl = { min: new Float32Array(16), max: new Float32Array(16), blocks: 0 };
    if (lvl.blocks >= target) continue;
    lvl.min = growTo(lvl.min, target);
    lvl.max = growTo(lvl.max, target);
    for (let j = lvl.blocks; j < target; j++) {
      let mn: number;
      let mx: number;
      if (k === 0) {
        const s = j << BASE_SHIFT;
        mn = mx = values[s]!;
        for (let i = s + 1; i < s + PYRAMID_BASE; i++) {
          const x = values[i]!;
          if (x < mn) mn = x;
          if (x > mx) mx = x;
        }
      } else {
        const lo = p.levels[k - 1]!;
        const a = 2 * j;
        mn = Math.min(lo.min[a]!, lo.min[a + 1]!);
        mx = Math.max(lo.max[a]!, lo.max[a + 1]!);
      }
      lvl.min[j] = mn;
      lvl.max[j] = mx;
    }
    lvl.blocks = target;
  }
  p.covered = count;
  return ok;
}

/**
 * First index in [from, to] whose bucket is >= `b` (`to` if none), galloping from `from` then binary searching, so a
 * short gap costs O(log gap). Bucket order follows time order (the formula is monotone), so this is exact.
 */
function firstInBucket(times: ArrayLike<number>, from: number, to: number, b: number, start: number, span: number, n: number, w: PyramidWork): number {
  let lo = from;
  let step = 1;
  let hi = from;
  while (hi < to) {
    w.probes++;
    if (bucketOf(times[hi]!, start, span, n) >= b) break;
    lo = hi + 1;
    hi = Math.min(to, hi + step);
    step *= 2;
  }
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    w.probes++;
    if (bucketOf(times[mid]!, start, span, n) < b) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Exactly `downsampleMinMax(times, p.values, v, buckets, out)`, in O(buckets x log n); covers newly appended samples first. */
export function downsampleMinMaxPyramid(p: MinMaxPyramid, times: ArrayLike<number>, v: Viewport, buckets: number, out?: Buckets): Buckets {
  const n = Math.max(0, Math.floor(buckets));
  const res: Buckets =
    out && out.min.length === n && out.max.length === n && out.filled.length === n
      ? out
      : { min: new Float32Array(n), max: new Float32Array(n), filled: new Uint8Array(n) };
  res.min.fill(0);
  res.max.fill(0);
  res.filled.fill(0);
  const w = p.lastQuery;
  w.samples = 0;
  w.blocks = 0;
  w.probes = 0;
  const span = v.end - v.start;
  if (n === 0 || !(span > 0)) return res;
  const values = p.values;
  const count = Math.min(times.length, values.length);
  extendMinMaxPyramid(p, values.length);
  // The window [lo, hi): the samples the linear pass visits.
  let lo = lowerBound(times, v.start);
  let a = lo;
  let z = count;
  while (a < z) {
    const mid = (a + z) >>> 1;
    w.probes++;
    if (times[mid]! < v.end) a = mid + 1;
    else z = mid;
  }
  const hi = Math.max(lo, a);
  const top = p.levels.length;
  for (let b = 0; b < n && lo < hi; b++) {
    const e = b === n - 1 ? hi : firstInBucket(times, lo, hi, b + 1, v.start, span, n, w);
    if (e <= lo) continue;
    let mn = Infinity;
    let mx = -Infinity;
    let i = lo;
    while (i < e) {
      // The coarsest block that starts at i (alignment) and ends inside the bucket.
      let k = i === 0 ? top - 1 : Math.min(31 - Math.clz32(i & -i) - BASE_SHIFT, top - 1);
      while (k >= 0 && i + (PYRAMID_BASE << k) > e) k--;
      if (k >= 0) {
        const lvl = p.levels[k]!;
        const j = i >> (BASE_SHIFT + k);
        if (lvl.min[j]! < mn) mn = lvl.min[j]!;
        if (lvl.max[j]! > mx) mx = lvl.max[j]!;
        i += PYRAMID_BASE << k;
        w.blocks++;
      } else {
        const x = values[i]!;
        if (x < mn) mn = x;
        if (x > mx) mx = x;
        i++;
        w.samples++;
      }
    }
    res.min[b] = mn;
    res.max[b] = mx;
    res.filled[b] = 1;
    lo = e;
  }
  return res;
}

/**
 * Exactly `downsampleTicks`, in O(min(ticks in view, buckets) x log gap): a bucket holds a tick iff its index range is
 * non-empty, so dense ticks are never walked one by one. `work` (optional) counts probes and the ticks that set a bucket.
 */
export function downsampleTicksIndexed(times: ArrayLike<number>, v: Viewport, buckets: number, out?: Uint8Array, work?: PyramidWork): Uint8Array {
  const n = Math.max(0, Math.floor(buckets));
  const res = out && out.length === n ? out : new Uint8Array(n);
  res.fill(0);
  const span = v.end - v.start;
  if (n === 0 || !(span > 0)) return res;
  const w = work ?? { samples: 0, blocks: 0, probes: 0 };
  const count = times.length;
  let i = lowerBound(times, v.start);
  while (i < count) {
    const t = times[i]!;
    if (t >= v.end) break;
    const b = bucketOf(t, v.start, span, n);
    res[b] = 1;
    w.samples++;
    if (b === n - 1) break;
    i = firstInBucket(times, i + 1, count, b + 1, v.start, span, n, w);
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
