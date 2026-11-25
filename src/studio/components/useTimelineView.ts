// The visible span of a zoomable timeline as component state (Take and Profiler timelines): fitted until the user zooms
// or scrolls, kept inside `[0, limit]` as the limit moves (a take still being recorded keeps growing). The model is
// `timelineView.ts`.
import type { Signal } from "@preact/signals";
import { useState } from "preact/hooks";
import type { TimeSpan } from "./timeRulerModel";
import { clampTimeline, MIN_SPAN, followView, wheelTimeline, zoomTimeline, type WheelLike } from "./timelineView";

export interface TimelineView {
  /** The seconds on show. */
  readonly view: TimeSpan;
  /** Narrower than the whole `[0, limit]`. */
  readonly zoomed: boolean;
  readonly limit: number;
  /** Show `view` (the whole range is the fitted view). */
  set(view: TimeSpan): void;
  fit(): void;
  zoomBy(factor: number, at: number): void;
  /** Handle a wheel event over the lanes: true when it zoomed or scrolled (the caller prevents the page scroll). */
  wheel(e: WheelLike, at: number, width: number): boolean;
  /** Page the view to keep `t` visible (replay following the playhead); only when zoomed. */
  follow(t: number): void;
}

/**
 * `shared`, when given, holds the span instead of the component (null while fitted), so two timelines of one recording
 * show the same seconds (`recordingView.ts`).
 */
export function useTimelineView(duration: number, shared?: Signal<TimeSpan | null>): TimelineView {
  const limit = Math.max(MIN_SPAN, duration);
  const [own, setOwn] = useState<TimeSpan | null>(null);
  const zoomed = shared ? shared.value : own;
  const setZoomed = (v: TimeSpan | null) => (shared ? (shared.value = v) : setOwn(v));
  const view = zoomed ? clampTimeline(zoomed, limit) : { start: 0, end: limit };
  const isZoomed = !!zoomed && view.end - view.start < limit - 1e-9;
  const set = (v: TimeSpan) => {
    const c = clampTimeline(v, limit);
    setZoomed(c.end - c.start >= limit - 1e-9 ? null : c);
  };
  return {
    view,
    zoomed: isZoomed,
    limit,
    set,
    fit: () => setZoomed(null),
    zoomBy: (factor, at) => set(zoomTimeline(view, factor, at, limit)),
    wheel: (e, at, width) => {
      const next = wheelTimeline(view, e, at, width, limit);
      if (!next) return false;
      set(next);
      return true;
    },
    follow: (t) => {
      if (!isZoomed) return;
      const next = followView(view, t, limit);
      if (next !== view) set(next);
    },
  };
}
