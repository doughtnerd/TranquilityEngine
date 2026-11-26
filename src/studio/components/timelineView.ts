// The visible span of a zoomable timeline (the Sequence editor, the Take and Profiler timelines): clamp, zoom about a
// time, scroll, follow the playhead, the scrollbar's thumb dragged or stretched, time ↔ x, and what a wheel event does.
// One model for every timeline that zooms, so they feel alike. Pure.
import type { TimeSpan } from "./timeRulerModel";

/** The narrowest span a view may zoom to, seconds. */
export const MIN_SPAN = 0.05;

/** `view` kept inside `[0, limit]` and no narrower than `MIN_SPAN`. */
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

/** The zoom readout: the share of `full` seconds now shown ("100%" whole, "400%" a quarter). */
export const zoomPercentOf = (view: TimeSpan, full: number): number => Math.round((full / Math.max(1e-9, view.end - view.start)) * 100);

export interface WheelLike {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly deltaX: number;
  readonly deltaY: number;
}

/**
 * What a wheel event does to a view: Ctrl/⌘ + wheel (and a trackpad pinch, which arrives as a wheel with ctrlKey) zooms
 * about `at`; Shift + wheel or a sideways swipe scrolls (`width` px is the lane's width); anything else leaves the view
 * (null: let the page scroll).
 */
export function wheelTimeline(view: TimeSpan, e: WheelLike, at: number, width: number, limit: number): TimeSpan | null {
  if (e.ctrlKey || e.metaKey) return zoomTimeline(view, Math.exp(-e.deltaY * 0.002), at, limit);
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return scrollTimeline(view, ((e.deltaX || e.deltaY) / Math.max(1, width)) * (view.end - view.start), limit);
  return null;
}
