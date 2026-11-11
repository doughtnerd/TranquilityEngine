// Ed2 (api-and-models §7): the pure model of the segment view. The view (`SegmentView.tsx`) draws what this module computes:
// the viewport (which file seconds are on screen), the bar and beat ruler and grid lines from the compiled tempo map, the
// tempo and metre lane, and the playhead and marker positions. No DOM, no signals, no Babylon.
//
// Coordinates: the view's x axis is FILE seconds (the stems' own time), so the waveforms need no shift. The grid's bar 1 beat 1
// sits at `gridOffset` file seconds (`ticksToSeconds` applies it); a pickup before it has negative ticks and a bar-less ruler.
// Stubs tagged `L-Ed2a` are filled by that leaf; everything else here is the lead's.
import { ticksToPosition, ticksToSeconds, secondsToTicks, type TempoMap } from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT, type BarBeatTick } from "../../../../engine/audio/musicPosition";
import { isMusicContainer, type MusicNode, type SegmentNode } from "../../../../engine/audio/musicFormat";

// --- the viewport (lead) --------------------------------------------------------------------------------------------

/** Which part of the segment is on screen: the file second at the left edge, the scale, and the drawn width. */
export interface Viewport {
  /** File seconds at x = 0. May be negative (the pickup before the grid starts is reachable). */
  readonly startSeconds: number;
  /** Pixels per second, clamped by `clampViewport` to `[MIN_PX_PER_SECOND, MAX_PX_PER_SECOND]`. */
  readonly pxPerSecond: number;
  /** The width of the drawn area in CSS pixels. */
  readonly widthPx: number;
}

/** Zoom limits: the whole of a 10 minute segment in a 300 px strip, to 1 ms per 2 px. */
export const MIN_PX_PER_SECOND = 0.5;
export const MAX_PX_PER_SECOND = 2000;

/** File seconds at the right edge. */
export const viewEndSeconds = (view: Viewport): number => view.startSeconds + view.widthPx / view.pxPerSecond;

/** x (CSS px) of a file second. */
export const secondsToX = (view: Viewport, seconds: number): number => (seconds - view.startSeconds) * view.pxPerSecond;

/** File second at x. */
export const xToSeconds = (view: Viewport, x: number): number => view.startSeconds + x / view.pxPerSecond;

/** x of integer `ticks` of the map (the pickup's negative ticks give an x left of the grid start). */
export const ticksToX = (map: TempoMap, view: Viewport, ticks: number): number => secondsToX(view, ticksToSeconds(map, ticks));

/** The integer tick (rounded) nearest to x. */
export const xToTicks = (map: TempoMap, view: Viewport, x: number): number => Math.round(secondsToTicks(map, xToSeconds(view, x)));

/**
 * Keep a viewport usable: the scale inside its limits, a drawn width of at least 1, and the visible span overlapping
 * `[-padSeconds, totalSeconds + padSeconds]` so scrolling cannot lose the clip (when the clip is shorter than the width
 * the clip sits at the left, with the pad before it).
 */
export function clampViewport(view: Viewport, totalSeconds: number, padSeconds = 0): Viewport {
  const pxPerSecond = Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, Number.isFinite(view.pxPerSecond) ? view.pxPerSecond : 100));
  const widthPx = Math.max(1, view.widthPx);
  const span = widthPx / pxPerSecond;
  const total = Math.max(0, totalSeconds);
  const lo = 0 - padSeconds; // not `-padSeconds`: that is -0 for a pad of 0
  const hi = Math.max(lo, total + padSeconds - span);
  const startSeconds = Math.min(hi, Math.max(lo, Number.isFinite(view.startSeconds) ? view.startSeconds : 0));
  return { startSeconds, pxPerSecond, widthPx };
}

/** Zoom by `factor` (> 1 zooms in) keeping the second under `anchorX` where it is, then clamp. */
export function zoomAt(view: Viewport, factor: number, anchorX: number, totalSeconds: number, padSeconds = 0): Viewport {
  const anchor = xToSeconds(view, anchorX);
  const pxPerSecond = Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, view.pxPerSecond * factor));
  return clampViewport({ ...view, pxPerSecond, startSeconds: anchor - anchorX / pxPerSecond }, totalSeconds, padSeconds);
}

/** Scroll by `dx` pixels (positive: later in the clip), then clamp. */
export function scrollBy(view: Viewport, dx: number, totalSeconds: number, padSeconds = 0): Viewport {
  return clampViewport({ ...view, startSeconds: view.startSeconds + dx / view.pxPerSecond }, totalSeconds, padSeconds);
}

/** The scale at which `[0, totalSeconds]` just fits `widthPx`, starting at the pad. */
export function fitViewport(widthPx: number, totalSeconds: number, padSeconds = 0): Viewport {
  const span = Math.max(totalSeconds, 0.001) + 2 * padSeconds;
  return clampViewport({ startSeconds: -padSeconds, pxPerSecond: Math.max(1, widthPx) / span, widthPx }, totalSeconds, padSeconds);
}

/**
 * Keep the playhead on screen while playing: when it is off the right edge (or left of the view), page so it sits a
 * quarter of the way in. Unchanged when it is visible.
 */
export function followPlayhead(view: Viewport, playheadSeconds: number, totalSeconds: number, padSeconds = 0): Viewport {
  const x = secondsToX(view, playheadSeconds);
  if (x >= 0 && x <= view.widthPx) return view;
  return clampViewport({ ...view, startSeconds: playheadSeconds - (view.widthPx * 0.25) / view.pxPerSecond }, totalSeconds, padSeconds);
}

// --- the ruler and grid lines (L-Ed2a) ------------------------------------------------------------------------------

/** Options of `gridLines`. The view passes the defaults; tests pass their own to avoid depending on them. */
export interface GridLineOptions {
  /** A beat line is drawn only when beats are at least this many px apart (default 10). */
  readonly minBeatPx?: number;
  /** Bar lines are thinned to the bars where `(bar - 1) % 2^n === 0` until they are at least this many px apart (default 48). */
  readonly minBarPx?: number;
}

export const DEFAULT_MIN_BEAT_PX = 10;
export const DEFAULT_MIN_BAR_PX = 48;

/** One vertical line of the ruler and the lanes' grid. */
export interface GridLine {
  /** x in CSS px for the viewport it was computed for. */
  readonly x: number;
  /** Integer ticks from `1:1:0`. */
  readonly ticks: number;
  /** File seconds (`ticksToSeconds`). */
  readonly seconds: number;
  /** `bar`: beat 1 of a bar; `beat`: any other beat. */
  readonly kind: "bar" | "beat";
  /** Bar number (1-based) of the line. */
  readonly bar: number;
  /** Beat in the bar (1-based). */
  readonly beat: number;
  /** The bar number as text on a bar line that is labelled (`"12"`), else absent. */
  readonly label?: string;
  /** Index of the tempo map span whose marker sits exactly on this line (a tempo or metre change), else absent. */
  readonly marker?: number;
}

/**
 * L-Ed2a. The grid lines whose x falls in `[0, view.widthPx]` (a line exactly at an edge is included), ascending by
 * ticks, computed from the compiled map, not from a fixed beat length: bar lines follow each span's metre
 * (`barOriginTick + k * ticksPerBar`, bar number `startBar + k`), beat lines every 960 ticks within a bar, and the span
 * starts are lines of their own whatever the zoom: a metre change (always on beat 1) starts a new bar at its marker, and a tempo-only marker
 * mid-bar is a `beat` line carrying `marker`. Only the visible span is walked (binary search the first span and bar;
 * never iterate from tick 0), the work is bounded by the lines returned plus `map.count`, and a view of a whole
 * segment at `MIN_PX_PER_SECOND` returns a few dozen lines, not thousands: thin the bar lines by powers of two per
 * `options.minBarPx` (n chosen per span from that span's own bar width, so every span's labelled bars are at least that far apart) and drop the beat lines (never the marker lines) below `minBeatPx`. Only bar lines are labelled.
 * The pickup (negative ticks) has no bar numbers and no lines. Pure.
 */
export function gridLines(map: TempoMap, view: Viewport, options: GridLineOptions = {}): GridLine[] {
  const minBeatPx = options.minBeatPx ?? DEFAULT_MIN_BEAT_PX;
  const minBarPx = options.minBarPx ?? DEFAULT_MIN_BAR_PX;
  const out: GridLine[] = [];
  // The visible ticks, widened by a tick each side; every line is then kept or dropped on its exact x.
  const loI = Math.max(0, Math.floor(secondsToTicks(map, view.startSeconds)) - 1);
  const hiI = Math.ceil(secondsToTicks(map, viewEndSeconds(view))) + 1;
  if (!Number.isFinite(loI) || !Number.isFinite(hiI) || hiI < loI) return out;

  /** Appends the line at integer `ticks` of span `s` when its x is on screen. */
  const emit = (s: number, ticks: number, marker: boolean): void => {
    const seconds = map.gridOffset + map.startSeconds[s] + (ticks - map.startTick[s]) / map.ticksPerSecond[s];
    const x = secondsToX(view, seconds);
    if (!(x >= 0 && x <= view.widthPx)) return;
    // Beats from the bar line at or before the span's marker: bar and beat follow the span's own metre.
    const j = (ticks - map.barOriginTick[s]) / MUSIC_TICKS_PER_BEAT;
    const bpb = map.beatsPerBar[s];
    const bar = map.startBar[s] + Math.floor(j / bpb);
    const beat = (j % bpb) + 1;
    const isBar = beat === 1;
    const line: GridLine = {
      x, ticks, seconds, kind: isBar ? "bar" : "beat", bar, beat,
      ...(isBar ? { label: String(bar) } : {}),
      ...(marker ? { marker: s } : {}),
    };
    out.push(line);
  };

  for (let s = spanIndexAt(map, loI); s < map.count && map.startTick[s] <= hiI; s++) {
    const start = map.startTick[s];
    const next = s + 1 < map.count ? map.startTick[s + 1] : Infinity;
    // A change's marker is a line of its own, whatever the zoom (span 0 starts at 1:1:0, which is no change).
    if (s >= 1 && start >= loI) emit(s, start, true);
    const lo = Math.max(loI, start);
    const hi = Math.min(hiI, next - 1);
    if (lo > hi) continue;
    const origin = map.barOriginTick[s];
    const tpb = map.ticksPerBar[s];
    const bpb = map.beatsPerBar[s];
    const barPx = (tpb / map.ticksPerSecond[s]) * view.pxPerSecond;
    const beatPx = (MUSIC_TICKS_PER_BEAT / map.ticksPerSecond[s]) * view.pxPerSecond;
    // Thin the bars by the least power of two that keeps this span's bars at least minBarPx apart.
    let n = 1;
    while (n * barPx < minBarPx && n < 1 << 30) n *= 2;
    if (beatPx >= minBeatPx) {
      // Every beat of the span on screen; a bar line is kept only on the thinned bars.
      for (let j = Math.ceil((lo - origin) / MUSIC_TICKS_PER_BEAT); origin + j * MUSIC_TICKS_PER_BEAT <= hi; j++) {
        const ticks = origin + j * MUSIC_TICKS_PER_BEAT;
        if (ticks === start && s >= 1) continue; // emitted above
        const isBar = j % bpb === 0;
        if (isBar && (map.startBar[s] + j / bpb - 1) % n !== 0) continue;
        emit(s, ticks, false);
      }
    } else {
      // Beats too narrow to draw: walk the thinned bar lines only. The first kept bar is found by arithmetic.
      let k = Math.ceil((lo - origin) / tpb);
      k += (n - ((map.startBar[s] - 1 + k) % n)) % n;
      for (; origin + k * tpb <= hi; k += n) {
        const ticks = origin + k * tpb;
        if (ticks === start && s >= 1) continue; // emitted above
        emit(s, ticks, false);
      }
    }
  }
  return out;
}

/** Index of the last span whose marker tick is `<= ticks` (0 before the grid). Private, so the module's imports stay as they are. */
function spanIndexAt(map: TempoMap, ticks: number): number {
  let lo = 0, hi = map.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.startTick[mid] <= ticks) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** One span of the tempo and metre lane. */
export interface TempoLaneItem {
  /** The span's index in the map (the marker index; a drag of the marker uses it). */
  readonly index: number;
  /** x of the span's marker (may be < 0 or > width when the span is only partly visible). */
  readonly x: number;
  /** x where the span ends (the next marker; the last span ends at `Infinity`, drawn to the right edge). */
  readonly endX: number;
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly beatUnit: number;
  /** `"120 bpm"` (the bpm as the shortest decimal, at most 2 decimals) plus, on the first span and where the metre differs from the previous span's, `" 4/4"`. */
  readonly text: string;
  /** True for the first span or when the metre differs from the previous span's. */
  readonly metreChange: boolean;
}

/**
 * L-Ed2a. The spans of the map that overlap `[0, view.widthPx]`, in marker order, with their text. A span overlaps when
 * its `endX >= 0` and its `x <= view.widthPx`. Pure.
 */
export function tempoLane(map: TempoMap, view: Viewport): TempoLaneItem[] {
  const out: TempoLaneItem[] = [];
  for (let s = spanIndexAt(map, secondsToTicks(map, view.startSeconds)); s < map.count; s++) {
    const x = ticksToX(map, view, map.startTick[s]);
    if (x > view.widthPx) break;
    const endX = s + 1 < map.count ? ticksToX(map, view, map.startTick[s + 1]) : Infinity;
    if (endX < 0) continue;
    const bpm = map.bpm[s];
    const beatsPerBar = map.beatsPerBar[s];
    const beatUnit = map.beatUnit[s];
    const metreChange = s === 0 || beatsPerBar !== map.beatsPerBar[s - 1] || beatUnit !== map.beatUnit[s - 1];
    const bpmText = String(Math.round(bpm * 100) / 100);
    const text = `${bpmText} bpm` + (metreChange ? ` ${beatsPerBar}/${beatUnit}` : "");
    out.push({ index: s, x, endX, bpm, beatsPerBar, beatUnit, text, metreChange });
  }
  return out;
}

/** The position text under x for the status line (`"12:3:480"`), or null before the grid or past the last bar. */
export function positionAtX(map: TempoMap, view: Viewport, x: number): BarBeatTick | null {
  return ticksToPosition(map, xToTicks(map, view, x));
}

/**
 * L-Ed2a. The tick of the nearest grid line (bar or beat, per `kind`) to x, for hover feedback and as the base of
 * Ed3's snapping: `"beat"` rounds to a multiple of 960 ticks, `"bar"` to the nearest bar line of the span it falls in
 * (a metre change's marker counts as a bar line). Never negative: x left of the grid gives 0. Pure.
 */
export function nearestGridTicks(map: TempoMap, view: Viewport, x: number, kind: "bar" | "beat"): number {
  const t = secondsToTicks(map, xToSeconds(view, x));
  if (kind === "beat") return Math.max(0, Math.round(t / MUSIC_TICKS_PER_BEAT) * MUSIC_TICKS_PER_BEAT) + 0;
  // Bar lines of the span x falls in, plus the next span's start when that start is a bar line (a metre change).
  const s = spanIndexAt(map, t);
  const origin = map.barOriginTick[s];
  const tpb = map.ticksPerBar[s];
  const next = s + 1 < map.count ? map.startTick[s + 1] : Infinity;
  const k0 = Math.ceil((map.startTick[s] - origin) / tpb);
  const kMax = Number.isFinite(next) ? Math.ceil((next - origin) / tpb) - 1 : Infinity;
  const candidates: number[] = [];
  if (k0 <= kMax) {
    candidates.push(origin + Math.min(kMax, Math.max(k0, Math.round((t - origin) / tpb))) * tpb);
  }
  if (Number.isFinite(next) && map.startBeat[s + 1] === 1) candidates.push(next);
  if (candidates.length === 0) {
    // A span with no bar line of its own (tempo markers only, inside one bar): the grid's bar lines either side of x.
    const f = Math.max(0, Math.floor((t - origin) / tpb));
    candidates.push(origin + f * tpb, origin + (f + 1) * tpb);
  }
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c - t) < Math.abs(best - t)) best = c;
  return Math.max(0, best) + 0;
}

/** The ticks of one beat, re-exported so the view and Ed3 need not import the grid for the constant. */
export const TICKS_PER_BEAT = MUSIC_TICKS_PER_BEAT;

// --- finding a segment in an event (lead) ---------------------------------------------------------------------------

/** The segment node with `id` anywhere under `root` (children and `library` of the music containers), or null. */
export function findSegment(root: MusicNode | undefined, id: string): SegmentNode | null {
  if (!root) return null;
  if (root.type === "segment") return root.id === id ? root : null;
  if (!isMusicContainer(root)) return null;
  for (const n of [...root.children, ...root.library]) {
    const hit = findSegment(n, id);
    if (hit) return hit;
  }
  return null;
}

/** `root` with the segment `id` replaced by `next` (structure shared elsewhere); `root` itself when `id` is not there. */
export function replaceSegment(root: MusicNode, id: string, next: SegmentNode): MusicNode {
  if (root.type === "segment") return root.id === id ? next : root;
  if (!isMusicContainer(root)) return root;
  const children = root.children.map((n) => replaceSegment(n, id, next));
  const library = root.library.map((n) => replaceSegment(n, id, next) as SegmentNode);
  const same = children.every((n, i) => n === root.children[i]) && library.every((n, i) => n === root.library[i]);
  return same ? root : { ...root, children, library };
}
