// Time ↔ x for the Studio's lanes (ADR 0349 `ValueLane`, `SpanLane`, `GainLanes`): one shape every lane takes, a
// function from time (seconds) to x (pixels in the lane), so lanes line up under whatever ruler draws the time (the
// Samples screen's `TimeRuler`, the Take and Profiler timelines). This module builds a linear axis for owners that
// don't have one yet and the small helpers lanes share; it draws nothing.

/** Seconds to pixels in the lane. */
export type TimeToX = (t: number) => number;

/** A linear axis over `[start, end]` seconds drawn `width` pixels wide. */
export interface TimeAxis {
  readonly start: number;
  readonly end: number;
  readonly width: number;
  readonly toX: TimeToX;
  /** Pixels back to seconds. */
  readonly toTime: (x: number) => number;
}

/** A linear axis; an empty or reversed range reads as one second wide, so nothing divides by zero. */
export function linearTimeAxis(start: number, end: number, width: number): TimeAxis {
  const span = end > start ? end - start : 1;
  const w = Math.max(0, width);
  return { start, end: start + span, width: w, toX: (t) => ((t - start) / span) * w, toTime: (x) => start + (w > 0 ? (x / w) * span : 0) };
}

/** The axis zoomed by `factor` (>1 zooms in) about time `at`, kept within `[min, max]` and no narrower than `minSpan`. */
export function zoomTimeAxis(axis: TimeAxis, factor: number, at: number, limits: { readonly min: number; readonly max: number; readonly minSpan?: number }): TimeAxis {
  const full = limits.max - limits.min;
  const span = Math.min(full, Math.max(limits.minSpan ?? 0.01, (axis.end - axis.start) / (factor > 0 ? factor : 1)));
  const k = (at - axis.start) / (axis.end - axis.start);
  let start = at - k * span;
  start = Math.min(limits.max - span, Math.max(limits.min, start));
  return linearTimeAxis(start, start + span, axis.width);
}

/** The pixel box of `[a, b]` seconds: at least `minWidth` wide, so a click-short span can still be seen and hit. */
export function spanBox(toX: TimeToX, a: number, b: number, minWidth = 2): { readonly x: number; readonly width: number } {
  const x0 = toX(Math.min(a, b));
  const x1 = toX(Math.max(a, b));
  return { x: x0, width: Math.max(minWidth, x1 - x0) };
}

/** Seconds as a lane writes them: "1:05.250" from a minute, else "4.200 s". */
export function formatTime(t: number): string {
  const sign = t < 0 ? "−" : "";
  const a = Math.abs(t);
  if (a < 60) return `${sign}${a.toFixed(3)} s`;
  const m = Math.floor(a / 60);
  return `${sign}${m}:${(a - m * 60).toFixed(3).padStart(6, "0")}`;
}
