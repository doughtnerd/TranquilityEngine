// The Sequence timeline's geometry (proto §4 "Timeline"): the rows (a track and, with its lanes caret open, one row per
// automation lane), what a y lands on (a track, a lane, or the empty fill below the tracks, where a dropped sample
// makes a new track), the visible span (fit, zoom about a time, scroll, the scrollbar's thumb dragged or stretched),
// time ↔ x, and the edges snapping looks for. Pure.
import type { SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import type { TimeSpan } from "../../../components/timeRulerModel";
import { allClips, clipLength, type SourceOf } from "./sequenceModel";

/** Track header width, px (proto: 168). */
export const HEADER_WIDTH = 168;
export const TRACK_HEIGHT = 58;
export const LANE_HEIGHT = 34;
/** Pointer travel before a press becomes a drag (proto: 3 px). */
export const DRAG_THRESHOLD = 3;

export interface LaneRow {
  readonly automation: string;
  readonly y: number;
  readonly h: number;
}
export interface TrackRow {
  readonly track: Track;
  readonly ti: number;
  readonly y: number;
  readonly h: number;
  readonly lanes: readonly LaneRow[];
}

/** The track rows top to bottom, each followed by its open lanes; and the rows' total height. */
export function trackRows(s: SequenceSettings, openLanes: ReadonlySet<string>): { rows: TrackRow[]; height: number } {
  let y = 0;
  const rows = s.tracks.map((track, ti) => {
    const top = y;
    y += TRACK_HEIGHT;
    const lanes = openLanes.has(track.id) ? track.automation.map((a) => {
      const lane = { automation: a.id, y, h: LANE_HEIGHT };
      y += LANE_HEIGHT;
      return lane;
    }) : [];
    return { track, ti, y: top, h: TRACK_HEIGHT, lanes };
  });
  return { rows, height: y };
}

export type RowHit = { readonly kind: "track"; readonly ti: number } | { readonly kind: "lane"; readonly ti: number; readonly automation: string } | { readonly kind: "below" };

/** What a y (px from the top of the rows) is over. */
export function rowAt(rows: readonly TrackRow[], y: number): RowHit {
  for (const r of rows) {
    if (y >= r.y && y < r.y + r.h) return { kind: "track", ti: r.ti };
    for (const l of r.lanes) if (y >= l.y && y < l.y + l.h) return { kind: "lane", ti: r.ti, automation: l.automation };
  }
  return { kind: "below" };
}

/** The track index a y is over (a lane counts as its track), clamped to the rows; -1 with none. */
export function trackIndexAt(rows: readonly TrackRow[], y: number): number {
  if (!rows.length) return -1;
  const h = rowAt(rows, y);
  if (h.kind !== "below") return h.ti;
  return y < 0 ? 0 : rows.length - 1;
}

// --- the view --------------------------------------------------------------------------------------------------------

export const MIN_SPAN = 0.05;

/** The whole sequence with a little room after its end. */
export const fitTimeline = (length: number): TimeSpan => ({ start: 0, end: Math.max(1, length * 1.08) });

/** How far the view may scroll: the sequence plus room to drop after it. */
export const scrollLimit = (length: number): number => Math.max(4, length * 1.5);

export function clampTimeline(view: TimeSpan, limit: number): TimeSpan {
  let span = Math.max(MIN_SPAN, Math.min(limit, view.end - view.start));
  let start = Math.max(0, Math.min(limit - span, view.start));
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(span)) span = limit;
  return { start, end: start + span };
}

/** Zoom by `factor` (>1 zooms in) about time `at`. */
export function zoomTimeline(view: TimeSpan, factor: number, at: number, limit: number): TimeSpan {
  const span = (view.end - view.start) / (factor > 0 ? factor : 1);
  const k = (at - view.start) / Math.max(1e-9, view.end - view.start);
  return clampTimeline({ start: at - k * span, end: at - k * span + span }, limit);
}

export const scrollTimeline = (view: TimeSpan, seconds: number, limit: number): TimeSpan => clampTimeline({ start: view.start + seconds, end: view.end + seconds }, limit);

/** The scrollbar thumb as fractions of the track. */
export function thumbOf(view: TimeSpan, limit: number): { left: number; width: number } {
  return { left: view.start / limit, width: (view.end - view.start) / limit };
}

/** The view a dragged or stretched thumb shows (scrollbar-zoom: stretching an end zooms). */
export function viewFromThumb(left: number, width: number, limit: number): TimeSpan {
  return clampTimeline({ start: left * limit, end: (left + width) * limit }, limit);
}

/** Keep `t` in view while following the playhead: page when it leaves the right edge. */
export function followView(view: TimeSpan, t: number, limit: number): TimeSpan {
  if (t >= view.start && t <= view.end - (view.end - view.start) * 0.02) return view;
  const span = view.end - view.start;
  return clampTimeline({ start: t - span * 0.1, end: t - span * 0.1 + span }, limit);
}

export const timeToPx = (t: number, view: TimeSpan, width: number): number => ((t - view.start) / (view.end - view.start)) * width;
export const pxToTime = (x: number, view: TimeSpan, width: number): number => view.start + (x / Math.max(1, width)) * (view.end - view.start);

/** Edges snapping looks for: 0, the end, clip edges (not the ones being moved), loop ends, markers, the playhead. */
export function snapEdges(s: SequenceSettings, sourceOf: SourceOf, length: number, opts: { readonly exclude?: readonly string[]; readonly playhead?: number; readonly excludeLoop?: string; readonly excludeMarker?: string } = {}): number[] {
  const out = [0, length];
  for (const c of allClips(s)) {
    if (opts.exclude?.includes(c.clip.id)) continue;
    out.push(c.clip.at, c.clip.at + clipLength(c.clip, sourceOf(c.clip)));
  }
  for (const l of s.loops) if (l.id !== opts.excludeLoop) out.push(l.start, l.end);
  for (const m of s.markers) if (m.id !== opts.excludeMarker) out.push(m.at);
  if (opts.playhead !== undefined) out.push(opts.playhead);
  return out;
}

/** The span to zoom to for Z: the selected clips (or the whole sequence) with a margin. */
export function zoomToSpan(a: number, b: number, limit: number): TimeSpan {
  const pad = Math.max(0.05, (b - a) * 0.08);
  return clampTimeline({ start: a - pad, end: b + pad }, limit);
}
