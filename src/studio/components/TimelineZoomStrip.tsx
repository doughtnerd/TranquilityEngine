// The zoom strip under a zoomable timeline (the Sequence editor's, shared): Zoom out, Zoom in and Fit with the zoom
// percentage, then a scrollbar whose thumb drags to scroll, whose ends drag to zoom, whose empty track recentres the
// view and which double-clicks to fit. A view over a `TimelineView`.
import { Icon } from "./Icon";
import { thumbOf, viewFromThumb, zoomPercentOf } from "./timelineView";
import type { TimelineView } from "./useTimelineView";
import { formatTime } from "./timeRulerModel";
import "./timelineZoomStrip.css";

export interface TimelineZoomStripProps {
  readonly timeline: TimelineView;
  /** The time Zoom in and Zoom out centre on (the playhead); default the middle of the view. */
  readonly anchor?: number;
}

const STEP = 1.5;
const RATE = { rate: 48000 } as const;
const clock = (t: number) => formatTime(Math.max(0, t), "timecode", RATE);

export function TimelineZoomStrip({ timeline, anchor }: TimelineZoomStripProps) {
  const { view, limit } = timeline;
  const thumb = thumbOf(view, limit);
  const pct = zoomPercentOf(view, limit);
  const centre = anchor !== undefined && anchor >= view.start && anchor <= view.end ? anchor : (view.start + view.end) / 2;
  const startDrag = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const bar = el.parentElement!.getBoundingClientRect();
    const target = e.target as HTMLElement;
    const part = target.classList.contains("start") ? "start" : target.classList.contains("end") ? "end" : "body";
    const t0 = thumbOf(view, limit);
    const x0 = e.clientX;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const f = (ev.clientX - x0) / Math.max(1, bar.width);
      if (part === "body") timeline.set(viewFromThumb(t0.left + f, t0.width, limit));
      else if (part === "start") timeline.set(viewFromThumb(t0.left + f, t0.width - f, limit));
      else timeline.set(viewFromThumb(t0.left, t0.width + f, limit));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    e.preventDefault();
  };
  return (
    <div class="tz-strip">
      <div class="tz-zoom" role="group" aria-label="Zoom">
        <button type="button" class="tz-btn" aria-label="Zoom out" title="Zoom out · Shift + wheel or a sideways swipe scrolls" disabled={!timeline.zoomed} onClick={() => timeline.zoomBy(1 / STEP, centre)}>
          <Icon name="zoomOut" size={13} />
        </button>
        <button type="button" class="tz-btn" aria-label="Zoom in" title="Zoom in · Ctrl/⌘ + wheel or pinch zooms at the pointer" onClick={() => timeline.zoomBy(STEP, centre)}>
          <Icon name="zoomIn" size={13} />
        </button>
        <button type="button" class="tz-btn" aria-label="Fit" title="Fit the whole timeline · or double-click the scrollbar" disabled={!timeline.zoomed} onClick={timeline.fit}>
          <Icon name="fit" size={13} />
        </button>
        <span class="tz-pct">{pct}%</span>
      </div>
      <div
        class="tz-scrollbar"
        role="scrollbar"
        aria-orientation="horizontal"
        aria-label="Scroll and zoom the timeline"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(thumb.left * 100)}
        title={`Showing ${clock(view.start)} – ${clock(view.end)} of ${clock(limit)} · drag to scroll · drag an end to zoom · double-click to fit`}
        onDblClick={timeline.fit}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget || e.button !== 0) return;
          const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const f = (e.clientX - bar.left) / Math.max(1, bar.width);
          timeline.set(viewFromThumb(f - thumb.width / 2, thumb.width, limit));
        }}
      >
        <div class="tz-thumb" style={{ left: `${thumb.left * 100}%`, width: `${Math.max(1, thumb.width * 100)}%` }} onPointerDown={startDrag}>
          <span class="tz-thumb-edge start" title="Drag to zoom" />
          <span class="tz-thumb-edge end" title="Drag to zoom" />
        </div>
      </div>
    </div>
  );
}
