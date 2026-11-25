// The zoomable timelines' shared view model: clamp, zoom about a time, scroll, the scrollbar thumb, following the
// playhead and what a wheel event does; and the Take and Profiler ruler's labels over a zoomed view.
import { describe, expect, it } from "vitest";
import { rulerMarks } from "../screens/profiler/runRulerModel";
import { clampTimeline, followView, MIN_SPAN, scrollTimeline, thumbOf, viewFromThumb, wheelTimeline, zoomPercentOf, zoomTimeline } from "./timelineView";

const wheel = (o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; deltaX: number; deltaY: number }>) => ({ ctrlKey: false, metaKey: false, shiftKey: false, deltaX: 0, deltaY: 0, ...o });

describe("the timeline view", () => {
  it("keeps the view inside [0, limit] and no narrower than the minimum", () => {
    expect(clampTimeline({ start: -3, end: 2 }, 10)).toEqual({ start: 0, end: 5 });
    expect(clampTimeline({ start: 8, end: 14 }, 10)).toEqual({ start: 4, end: 10 });
    expect(clampTimeline({ start: 1, end: 1 }, 10).end - 1).toBeCloseTo(MIN_SPAN);
    expect(clampTimeline({ start: 0, end: 50 }, 10)).toEqual({ start: 0, end: 10 });
  });

  it("zooms about a time, keeping it under the pointer", () => {
    const v = zoomTimeline({ start: 0, end: 10 }, 2, 4, 10);
    expect(v.end - v.start).toBeCloseTo(5);
    expect((4 - v.start) / (v.end - v.start)).toBeCloseTo(0.4);
    expect(zoomTimeline(v, 0.5, 4, 10)).toEqual({ start: 0, end: 10 });
  });

  it("scrolls and stops at the ends", () => {
    expect(scrollTimeline({ start: 2, end: 4 }, 1, 10)).toEqual({ start: 3, end: 5 });
    expect(scrollTimeline({ start: 2, end: 4 }, 100, 10)).toEqual({ start: 8, end: 10 });
    expect(scrollTimeline({ start: 2, end: 4 }, -100, 10)).toEqual({ start: 0, end: 2 });
  });

  it("maps the scrollbar thumb both ways", () => {
    const v = { start: 2, end: 5 };
    const t = thumbOf(v, 10);
    expect(t).toEqual({ left: 0.2, width: 0.3 });
    const back = viewFromThumb(t.left, t.width, 10);
    expect(back.start).toBeCloseTo(2);
    expect(back.end).toBeCloseTo(5);
    // Stretching an end zooms.
    const narrow = viewFromThumb(0.2, 0.1, 10);
    expect(narrow.start).toBeCloseTo(2);
    expect(narrow.end).toBeCloseTo(3);
  });

  it("pages to a playhead that left the view and leaves one that is in it", () => {
    const v = { start: 0, end: 4 };
    expect(followView(v, 2, 20)).toBe(v);
    const next = followView(v, 6, 20);
    expect(next.end - next.start).toBeCloseTo(4);
    expect(next.start).toBeCloseTo(5.6);
  });

  it("reads the zoom as a share of the whole", () => {
    expect(zoomPercentOf({ start: 0, end: 10 }, 10)).toBe(100);
    expect(zoomPercentOf({ start: 3, end: 5 }, 10)).toBe(500);
  });

  it("zooms on Ctrl/⌘ + wheel (a pinch), scrolls on Shift + wheel or a sideways swipe, else lets the page scroll", () => {
    const v = { start: 0, end: 10 };
    const zoomed = wheelTimeline(v, wheel({ ctrlKey: true, deltaY: -100 }), 5, 500, 10)!;
    expect(zoomed.end - zoomed.start).toBeLessThan(10);
    expect(wheelTimeline(v, wheel({ metaKey: true, deltaY: 100 }), 5, 500, 10)).toEqual(v);
    const z = { start: 2, end: 4 };
    // 100 px of a 500 px lane showing 2 s is 0.4 s.
    expect(wheelTimeline(z, wheel({ shiftKey: true, deltaY: 100 }), 3, 500, 10)!.start).toBeCloseTo(2.4);
    expect(wheelTimeline(z, wheel({ deltaX: -50, deltaY: 5 }), 3, 500, 10)!.start).toBeCloseTo(1.8);
    expect(wheelTimeline(z, wheel({ deltaY: 100 }), 3, 500, 10)).toBeNull();
  });
});

describe("the run ruler's labels over a view", () => {
  it("labels the whole recording from 0 as before", () => {
    const m = rulerMarks(32, 800);
    expect(m.labels[0]).toEqual({ t: 0, text: "0" });
    expect(m.labels[1]!.t).toBe(4);
  });

  it("labels a zoomed view at multiples of the step, inside it", () => {
    const m = rulerMarks(8, 800, 20);
    expect(m.labels.length).toBeGreaterThan(1);
    for (const l of m.labels) {
      expect(l.t).toBeGreaterThanOrEqual(20);
      expect(l.t).toBeLessThanOrEqual(28);
    }
    expect(m.labels[0]!.t % m.tick).toBeCloseTo(0);
  });

  it("goes finer than half a second for a view under a second", () => {
    const m = rulerMarks(0.5, 800, 3);
    expect(m.tick).toBeLessThan(0.125);
    expect(new Set(m.labels.map((l) => l.text)).size).toBe(m.labels.length);
  });
});
