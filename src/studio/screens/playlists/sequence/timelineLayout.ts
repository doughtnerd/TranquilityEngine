// The Sequence timeline's geometry (proto §4 "Timeline"): the rows (a track and, with its lanes caret open, one row per
// automation lane), what a y lands on (a track, a lane, or the empty fill below the tracks, where a dropped sample
// makes a new track), the visible span (fit, zoom about a time, scroll, the scrollbar's thumb dragged or stretched),
// time ↔ x, and the edges snapping looks for. Pure.
import type { SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import type { TimeSpan } from "../../../components/timeRulerModel";
import { clampTimeline, followView, MIN_SPAN, pxToTime, scrollTimeline, thumbOf, timeToPx, viewFromThumb, zoomPercentOf, zoomTimeline } from "../../../components/timelineView";
import { allClips, clipLength, type SourceOf } from "./sequenceModel";

/** Track header width, px (proto: 168). */
export const HEADER_WIDTH = 168;
export const TRACK_HEIGHT = 68;
export const LANE_HEIGHT = 54;
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

export { clampTimeline, followView, MIN_SPAN, pxToTime, scrollTimeline, thumbOf, timeToPx, viewFromThumb, zoomTimeline };

/** The whole sequence with a little room after its end. */
export const fitTimeline = (length: number): TimeSpan => ({ start: 0, end: Math.max(1, length * 1.08) });

/** How far the view may scroll: the sequence plus room to drop after it. */
export const scrollLimit = (length: number): number => Math.max(4, length * 1.5);

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

/** The zoom readout under the tracks: the share of the fitted view now shown ("100%", "400%"). */
export const zoomPercent = (view: TimeSpan, length: number): number => zoomPercentOf(view, fitTimeline(length).end - fitTimeline(length).start);

const SECOND_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const SAMPLE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
const BAR_STEPS = [1, 2, 4, 8, 16, 32, 64];

/**
 * The ruler's labelled ticks (proto A2 `.ruler`: short labels at a nice step, about one per 90 px): "0", "600 ms" under a
 * tenth of a second, "1.2 s"; sample counts ("48,000"); bar numbers in the bars display ("1", "2"…, never beats).
 */
export function rulerMarks(view: TimeSpan, width: number, format: "timecode" | "samples" | "bars", ctx: { readonly rate: number; readonly bpm: number | null; readonly meter: string | null }): { readonly t: number; readonly label: string }[] {
  const span = view.end - view.start;
  if (!(span > 0) || width <= 0) return [];
  const want = Math.max(2, Math.floor(width / 90));
  const pick = (steps: readonly number[], unit: number) => steps.find((s) => span / (s * unit) <= want) ?? steps[steps.length - 1]!;
  const out: { t: number; label: string }[] = [];
  if (format === "bars" && ctx.bpm) {
    const bar = (60 / ctx.bpm) * (Number((ctx.meter ?? "4/4").split("/")[0]) || 4);
    const step = pick(BAR_STEPS, bar);
    for (let b = Math.ceil(view.start / (bar * step)) * step; b * bar <= view.end + 1e-9; b += step) out.push({ t: b * bar, label: String(b + 1) });
    return out;
  }
  if (format === "samples") {
    const step = pick(SAMPLE_STEPS, 1 / ctx.rate);
    for (let n = Math.ceil((view.start * ctx.rate) / step) * step; n / ctx.rate <= view.end + 1e-9; n += step) out.push({ t: n / ctx.rate, label: n.toLocaleString("en-US") });
    return out;
  }
  const step = pick(SECOND_STEPS, 1);
  const decimals = step >= 1 ? 0 : step === 0.25 || step < 0.1 ? (step < 0.01 ? 3 : 2) : 1;
  for (let i = Math.ceil(view.start / step - 1e-9); i * step <= view.end + 1e-9; i++) {
    const t = Math.round(i * step * 1e6) / 1e6;
    out.push({ t, label: t === 0 ? "0" : step < 0.1 && t < 1 ? `${Math.round(t * 1000)} ms` : `${t.toFixed(decimals)} s` });
  }
  return out;
}
