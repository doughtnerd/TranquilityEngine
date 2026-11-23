// The waveform's model (ADR 0349 `Waveform`): the visible span of a sample (zoom at a point, scroll, fit, clamp to the
// sample with a 5 ms narrowest view), time ↔ pixel, and the min/max column per pixel drawn from the peaks pyramid
// (`peaksMip.ts`: the level whose bins are about a pixel wide). Pure: no DOM, no canvas.
import { binAt, binSpan, pickLevel, type PeakMips } from "../../plugins/audio/editor/music/peaksMip";
import type { TimeSpan } from "./timeRulerModel";

export type { PeakMips } from "../../plugins/audio/editor/music/peaksMip";

/** The narrowest view, seconds (the prototype's). */
export const MIN_VIEW_SECONDS = 0.005;

export const timeToX = (t: number, view: TimeSpan, width: number): number => ((t - view.start) / (view.end - view.start)) * width;
export const xToTime = (x: number, view: TimeSpan, width: number): number => view.start + (x / Math.max(1, width)) * (view.end - view.start);

/** `view` kept inside `[0, length]` and at least `MIN_VIEW_SECONDS` wide (a span wider than the sample is the sample). */
export function clampView(view: TimeSpan, length: number): TimeSpan {
  const len = Math.max(MIN_VIEW_SECONDS, length);
  let span = Math.min(len, Math.max(MIN_VIEW_SECONDS, view.end - view.start));
  if (!Number.isFinite(span)) span = len;
  let start = Math.min(Math.max(0, view.start), len - span);
  if (!Number.isFinite(start)) start = 0;
  return { start, end: start + span };
}

/** Zoom by `factor` (>1 zooms in) keeping `anchor` (seconds) under the same pixel. */
export function zoomAt(view: TimeSpan, factor: number, anchor: number, length: number): TimeSpan {
  const span = (view.end - view.start) / factor;
  const frac = (anchor - view.start) / (view.end - view.start);
  return clampView({ start: anchor - frac * span, end: anchor - frac * span + span }, length);
}

/** Scroll by `seconds` (negative: earlier). */
export const scrollBy = (view: TimeSpan, seconds: number, length: number): TimeSpan => clampView({ start: view.start + seconds, end: view.end + seconds }, length);

/** The whole sample. */
export const fitView = (length: number): TimeSpan => clampView({ start: 0, end: length }, length);

/** A span shown with a 5 % margin each side (Zoom to selection, Z). */
export function zoomTo(span: TimeSpan, length: number): TimeSpan {
  const w = Math.max(MIN_VIEW_SECONDS, span.end - span.start);
  return clampView({ start: span.start - w * 0.05, end: span.end + w * 0.05 }, length);
}

/** The view moved so `t` shows (page-follow: when it leaves the view, the next page starts at it). */
export function followTime(view: TimeSpan, t: number, length: number): TimeSpan {
  if (t >= view.start && t <= view.end) return view;
  const span = view.end - view.start;
  return clampView({ start: t, end: t + span }, length);
}

/** One column per pixel: the lowest and highest value (−1..1) under it, all channels merged; NaN where no audio. */
export interface WaveColumns {
  readonly min: Float32Array;
  readonly max: Float32Array;
}

/** The columns of `view` `width` px wide from `mips` (empty when there are none yet). */
export function waveColumns(mips: PeakMips | null | undefined, view: TimeSpan, width: number): WaveColumns {
  const w = Math.max(0, Math.floor(width));
  const min = new Float32Array(w).fill(NaN);
  const max = new Float32Array(w).fill(NaN);
  if (!mips || mips.levels.length === 0 || w === 0 || !(mips.rate > 0)) return { min, max };
  const f0 = view.start * mips.rate, f1 = view.end * mips.rate;
  const level = mips.levels[pickLevel(mips.levels, f0, f1, w)];
  const framesPerPx = (f1 - f0) / w;
  for (let x = 0; x < w; x++) {
    const a = f0 + x * framesPerPx, b = Math.max(a + 1, f0 + (x + 1) * framesPerPx);
    if (b <= 0 || a >= mips.frames) continue;
    const { first, end } = binSpan(level, Math.max(0, a), Math.min(mips.frames, b));
    let lo = Infinity, hi = -Infinity;
    for (let bin = first; bin < Math.max(first + 1, end) && bin < level.bins; bin++) {
      for (let c = 0; c < level.channels; c++) {
        const v = binAt(level, c, bin);
        if (v.min < lo) lo = v.min;
        if (v.max > hi) hi = v.max;
      }
    }
    if (lo <= hi) {
      min[x] = lo / 32768;
      max[x] = hi / 32767;
    }
  }
  return { min, max };
}

/** A coloured band over the waveform (a loop, the play scope, a deleted snippet). */
export interface WaveBand {
  readonly start: number;
  readonly end: number;
  /** A theme token without `var()` ("--range-loop"). */
  readonly color: string;
  /** Hatched (a deleted snippet: silence in place). */
  readonly hatched?: boolean;
  readonly label?: string;
}

/** The pixel extent of a band in the view, or null when it's off screen. A zero-length band (a hold point) is 2 px. */
export function bandRect(band: WaveBand, view: TimeSpan, width: number): { x: number; w: number } | null {
  if (band.end < view.start || band.start > view.end) return null;
  const x0 = Math.max(0, timeToX(band.start, view, width));
  const x1 = Math.min(width, timeToX(band.end, view, width));
  return { x: x0, w: Math.max(2, x1 - x0) };
}
