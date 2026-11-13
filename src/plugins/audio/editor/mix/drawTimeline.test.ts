import { describe, expect, it } from "vitest";
import {
  CLICK_SLOP_PX,
  RULER_HEIGHT,
  TIMELINE_TOKENS,
  TimelineCanvas,
  ZOOM_PER_PX,
  readTimelineColors,
  type TimelineColors,
  type TimelineOptions,
  type TrackData,
} from "./drawTimeline";
import { MIN_SPAN_S, TrackList, timeToX, xToTime, zoomViewport } from "./timelineModel";

/** A 2D context that records every call by name and every fill/stroke style it was given. */
class MockCtx {
  readonly calls: string[] = [];
  readonly styles: string[] = [];
  private fill = "";
  private strokeCol = "";
  font = "";
  set fillStyle(v: string) {
    this.fill = v;
  }
  get fillStyle(): string {
    return this.fill;
  }
  set strokeStyle(v: string) {
    this.strokeCol = v;
  }
  get strokeStyle(): string {
    return this.strokeCol;
  }
  private rec(name: string): void {
    this.calls.push(name);
    if (name === "fillRect" || name === "fillText") this.styles.push(this.fill);
    if (name === "stroke") this.styles.push(this.strokeCol);
  }
  setTransform() { this.rec("setTransform"); }
  fillRect() { this.rec("fillRect"); }
  fillText() { this.rec("fillText"); }
  beginPath() { this.rec("beginPath"); }
  moveTo() { this.rec("moveTo"); }
  lineTo() { this.rec("lineTo"); }
  stroke() { this.rec("stroke"); }
  clear(): void {
    this.calls.length = 0;
    this.styles.length = 0;
  }
  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

class Frames {
  private queue = new Map<number, () => void>();
  private next = 1;
  requested = 0;
  raf = (cb: () => void): number => {
    this.requested++;
    const id = this.next++;
    this.queue.set(id, cb);
    return id;
  };
  caf = (id: number): void => {
    this.queue.delete(id);
  };
  get pending(): number {
    return this.queue.size;
  }
  step(): void {
    const q = [...this.queue.values()];
    this.queue.clear();
    for (const cb of q) cb();
  }
}

const COLORS: TimelineColors = {
  bg: "c-bg", panel: "c-panel", border: "c-border", text: "c-text", muted: "c-muted",
  accent: "c-accent", accent2: "c-accent2", accentSoft: "c-soft", warning: "c-warn", danger: "c-danger",
};

const W = 800;

interface Rig {
  tl: TimelineCanvas;
  g: MockCtx;
  f: Frames;
  tracks: TrackList;
  state: { duration: number; data: Record<string, TrackData>; themeReads: number; theme: TimelineColors };
  events: { cursor: number[]; selection: unknown[]; viewport: number };
}

function rig(over: Partial<TimelineOptions> = {}, duration = 100): Rig {
  const g = new MockCtx();
  const f = new Frames();
  const tracks = new TrackList([
    { id: "cpu", label: "CPU", kind: "line", height: 60, visible: true },
    { id: "underruns", label: "Underruns", kind: "ticks", height: 20, visible: true },
    { id: "voices", label: "Voices", kind: "lanes", height: 90, visible: true },
  ]);
  const state = { duration, data: {} as Record<string, TrackData>, themeReads: 0, theme: COLORS };
  const events = { cursor: [] as number[], selection: [] as unknown[], viewport: 0 };
  const tl = new TimelineCanvas({
    ctx: g as unknown as CanvasRenderingContext2D,
    tracks,
    data: (id) => state.data[id],
    duration: () => state.duration,
    readColors: () => {
      state.themeReads++;
      return state.theme;
    },
    width: W,
    height: 300,
    raf: f.raf,
    caf: f.caf,
    onCursor: (t) => events.cursor.push(t),
    onSelection: (s) => events.selection.push(s),
    onViewport: () => events.viewport++,
    ...over,
  });
  return { tl, g, f, tracks, state, events };
}

/** Takes the first frame and clears the recorded calls. */
function settle(r: Rig): void {
  r.f.step();
  r.g.clear();
}

const TRACK_Y = RULER_HEIGHT + 5;

describe("viewport: wheel zoom", () => {
  it("zooms in around the pointer: the time under it stays under it", () => {
    const r = rig();
    settle(r);
    r.tl.setViewport({ start: 20, end: 60, followLive: false });
    const x = 300;
    const t = xToTime(r.tl.viewport, x, W);
    expect(r.tl.wheel({ x, deltaY: -240 })).toBe(true);
    const v = r.tl.viewport;
    expect(v.end - v.start).toBeCloseTo(40 / Math.pow(ZOOM_PER_PX, 240), 9);
    expect(xToTime(v, x, W)).toBeCloseTo(t, 6);
  });

  it("matches the model's zoomViewport exactly", () => {
    const r = rig();
    r.tl.setViewport({ start: 10, end: 90, followLive: false });
    const before = r.tl.viewport;
    r.tl.wheel({ x: 123, deltaY: -150 });
    expect(r.tl.viewport).toEqual(zoomViewport(before, Math.pow(ZOOM_PER_PX, 150), xToTime(before, 123, W), 100));
  });

  it("zooms out and clamps at the whole capture, and in at MIN_SPAN_S", () => {
    const r = rig();
    r.tl.setViewport({ start: 40, end: 50, followLive: false });
    r.tl.wheel({ x: 400, deltaY: 100000 });
    expect(r.tl.viewport.start).toBe(0);
    expect(r.tl.viewport.end).toBe(100);
    r.tl.wheel({ x: 400, deltaY: -100000 });
    expect(r.tl.viewport.end - r.tl.viewport.start).toBeCloseTo(MIN_SPAN_S, 12);
  });

  it("a horizontal wheel delta pans by that many pixels; a zero delta is ignored", () => {
    const r = rig();
    r.tl.setViewport({ start: 20, end: 60, followLive: false });
    expect(r.tl.wheel({ x: 10, deltaY: 0, deltaX: 80 })).toBe(true);
    expect(r.tl.viewport.start).toBeCloseTo(24, 9);
    expect(r.tl.wheel({ x: 10, deltaY: 0 })).toBe(false);
  });
});

describe("viewport: drag pan", () => {
  it("moves the content with the pointer, through panViewport", () => {
    const r = rig();
    r.tl.setViewport({ start: 20, end: 60, followLive: false });
    r.tl.pointerDown({ x: 400, y: TRACK_Y });
    r.tl.pointerMove({ x: 480, y: TRACK_Y });
    expect(r.tl.viewport.start).toBeCloseTo(16, 9);
    expect(r.tl.viewport.end).toBeCloseTo(56, 9);
    r.tl.pointerMove({ x: 440, y: TRACK_Y });
    expect(r.tl.viewport.start).toBeCloseTo(18, 9);
    r.tl.pointerUp({ x: 440, y: TRACK_Y });
    expect(r.tl.cursor).toBeNull();
  });

  it("clamps at both ends of the capture, and panning back clears follow-live", () => {
    const r = rig();
    expect(r.tl.viewport.followLive).toBe(true);
    r.tl.setViewport({ start: 60, end: 100, followLive: true });
    r.tl.pointerDown({ x: 400, y: TRACK_Y });
    r.tl.pointerMove({ x: 500, y: TRACK_Y });
    expect(r.tl.viewport.followLive).toBe(false);
    r.tl.pointerMove({ x: 5000, y: TRACK_Y });
    expect(r.tl.viewport.start).toBe(0);
    r.tl.pointerMove({ x: -50000, y: TRACK_Y });
    expect(r.tl.viewport.end).toBe(100);
  });

  it("a press that moves under the slop is a click, not a pan", () => {
    const r = rig();
    r.tl.setViewport({ start: 20, end: 60, followLive: false });
    r.tl.pointerDown({ x: 400, y: TRACK_Y });
    r.tl.pointerMove({ x: 400 + CLICK_SLOP_PX - 1, y: TRACK_Y });
    expect(r.tl.viewport.start).toBe(20);
    r.tl.pointerUp({ x: 400, y: TRACK_Y });
    expect(r.tl.cursor).toBeCloseTo(40, 9);
  });
});

describe("cursor", () => {
  it("a click in the tracks sets the cursor to the time under the pointer and reports it", () => {
    const r = rig();
    r.tl.setViewport({ start: 0, end: 100, followLive: false });
    r.tl.pointerDown({ x: 200, y: TRACK_Y });
    r.tl.pointerUp({ x: 200, y: TRACK_Y });
    expect(r.tl.cursor).toBeCloseTo(25, 9);
    expect(r.events.cursor).toEqual([r.tl.cursor]);
  });

  it("dragging in the ruler scrubs it, clamped to [0, duration], without panning", () => {
    const r = rig();
    r.tl.setViewport({ start: 20, end: 60, followLive: false });
    r.tl.pointerDown({ x: 400, y: 4 });
    expect(r.tl.cursor).toBeCloseTo(40, 9);
    r.tl.pointerMove({ x: 600, y: 4 });
    expect(r.tl.cursor).toBeCloseTo(50, 9);
    r.tl.pointerMove({ x: -100000, y: 4 });
    expect(r.tl.cursor).toBe(0);
    r.tl.pointerMove({ x: 100000, y: 4 });
    expect(r.tl.cursor).toBe(100);
    r.tl.pointerUp({ x: 100000, y: 4 });
    expect(r.tl.viewport.start).toBe(20);
    expect(r.events.cursor.length).toBe(4);
  });

  it("moves are ignored with no button down", () => {
    const r = rig();
    r.tl.pointerMove({ x: 300, y: 4 });
    expect(r.tl.cursor).toBeNull();
  });

  it("is drawn as one accent line at the model's x, and not when it is out of view", () => {
    const r = rig();
    r.tl.setViewport({ start: 0, end: 100, followLive: false });
    r.tl.setCursor(50);
    settle(r);
    r.tl.invalidate();
    r.f.step();
    expect(r.g.styles.filter((s) => s === "c-accent").length).toBe(1);
    r.g.clear();
    r.tl.setViewport({ start: 60, end: 100, followLive: false });
    r.f.step();
    expect(r.g.styles.filter((s) => s === "c-accent").length).toBe(0);
  });
});

describe("selection", () => {
  it("shift-drag selects the range between press and pointer, in either direction", () => {
    const r = rig();
    r.tl.setViewport({ start: 0, end: 100, followLive: false });
    r.tl.pointerDown({ x: 400, y: TRACK_Y, shiftKey: true });
    r.tl.pointerMove({ x: 240, y: TRACK_Y, shiftKey: true });
    expect(r.tl.selection).toEqual({ start: xToTime(r.tl.viewport, 240, W), end: 50 });
    r.tl.pointerMove({ x: 560, y: TRACK_Y, shiftKey: true });
    expect(r.tl.selection).toEqual({ start: 50, end: 70 });
    r.tl.pointerUp({ x: 560, y: TRACK_Y });
    expect(r.events.selection.at(-1)).toEqual({ start: 50, end: 70 });
    expect(r.tl.viewport.start).toBe(0);
    expect(r.tl.cursor).toBeNull();
  });

  it("clamps to the capture and a shift-click without travel clears it", () => {
    const r = rig();
    r.tl.setViewport({ start: 0, end: 100, followLive: false });
    r.tl.pointerDown({ x: 400, y: TRACK_Y, shiftKey: true });
    r.tl.pointerMove({ x: 100000, y: TRACK_Y, shiftKey: true });
    expect(r.tl.selection).toEqual({ start: 50, end: 100 });
    r.tl.pointerUp({ x: 100000, y: TRACK_Y });
    r.tl.pointerDown({ x: 300, y: TRACK_Y, shiftKey: true });
    r.tl.pointerUp({ x: 300, y: TRACK_Y });
    expect(r.tl.selection).toBeNull();
    expect(r.events.selection.at(-1)).toBeNull();
  });

  it("is drawn as a soft accent band across the tracks", () => {
    const r = rig();
    r.tl.setViewport({ start: 0, end: 100, followLive: false });
    r.tl.setSelection({ start: 25, end: 75 });
    r.f.step();
    expect(r.g.styles).toContain("c-soft");
    expect(timeToX(r.tl.viewport, 25, W)).toBe(200);
  });
});

describe("dirty flag and frames", () => {
  it("draws the first frame, then never again while nothing changes", () => {
    const r = rig();
    expect(r.f.pending).toBe(1);
    r.f.step();
    expect(r.tl.redrawCount).toBe(1);
    expect(r.f.pending).toBe(0);
    for (let i = 0; i < 5; i++) r.f.step();
    expect(r.tl.redrawCount).toBe(1);
    expect(r.f.requested).toBe(1);
  });

  it("no-op inputs schedule nothing: same cursor, same viewport, same selection, a move with no button", () => {
    const r = rig();
    r.tl.setViewport({ start: 0, end: 100, followLive: false });
    r.tl.setCursor(10);
    r.tl.setSelection({ start: 1, end: 2 });
    settle(r);
    const requested = r.f.requested;
    r.tl.setViewport({ start: 0, end: 100, followLive: false });
    r.tl.setCursor(10);
    r.tl.setSelection({ start: 2, end: 1 });
    r.tl.pointerMove({ x: 5, y: 5 });
    r.tl.wheel({ x: 5, deltaY: 0 });
    r.tl.setSize(W, 300);
    expect(r.tl.isDirty).toBe(false);
    expect(r.f.requested).toBe(requested);
    expect(r.f.pending).toBe(0);
  });

  it("many inputs in one frame cost one frame request and one redraw", () => {
    const r = rig();
    settle(r);
    const before = r.tl.redrawCount;
    const requested = r.f.requested;
    r.tl.setViewport({ start: 20, end: 60, followLive: false });
    for (let i = 0; i < 50; i++) r.tl.wheel({ x: 100 + i, deltaY: -20 });
    r.tl.pointerDown({ x: 400, y: TRACK_Y });
    for (let i = 0; i < 50; i++) r.tl.pointerMove({ x: 400 + i * 3, y: TRACK_Y });
    r.tl.pointerUp({ x: 550, y: TRACK_Y });
    r.tl.setCursor(5);
    expect(r.f.requested - requested).toBe(1);
    expect(r.tl.redrawCount).toBe(before);
    r.f.step();
    expect(r.tl.redrawCount).toBe(before + 1);
    r.f.step();
    expect(r.tl.redrawCount).toBe(before + 1);
  });

  it("an input after a draw schedules the next frame", () => {
    const r = rig();
    settle(r);
    r.tl.setCursor(3);
    expect(r.f.pending).toBe(1);
    r.f.step();
    expect(r.tl.redrawCount).toBe(2);
  });

  it("dispose cancels the pending frame and ignores later input", () => {
    const r = rig();
    r.tl.dispose();
    expect(r.f.pending).toBe(0);
    r.tl.setCursor(4);
    expect(r.f.pending).toBe(0);
    expect(r.tl.redrawCount).toBe(0);
  });

  it("resizing redraws; the viewport callback fires once per real change", () => {
    const r = rig();
    settle(r);
    r.tl.setSize(400, 200, 2);
    r.f.step();
    expect(r.tl.redrawCount).toBe(2);
    expect(r.g.count("setTransform")).toBe(1);
    r.tl.setViewport({ start: 10, end: 50, followLive: false });
    r.tl.setViewport({ start: 10, end: 50, followLive: false });
    expect(r.events.viewport).toBe(1);
  });
});

describe("live data", () => {
  it("dataChanged follows the live edge while pinned and keeps a panned-back window", () => {
    const r = rig({}, 30);
    r.state.duration = 40;
    r.tl.dataChanged();
    expect(r.tl.viewport.end).toBe(40);
    r.tl.setViewport({ start: 5, end: 15, followLive: false });
    r.state.duration = 50;
    r.tl.dataChanged();
    expect(r.tl.viewport.start).toBe(5);
    expect(r.tl.isDirty).toBe(true);
  });

  it("an empty capture draws without throwing", () => {
    const r = rig({}, 0);
    expect(() => r.f.step()).not.toThrow();
    r.tl.pointerDown({ x: 10, y: 4 });
    expect(r.tl.cursor).toBe(0);
  });
});

describe("theme tokens", () => {
  it("reads the theme at construction and on themeChanged only, never per frame", () => {
    const r = rig();
    expect(r.state.themeReads).toBe(1);
    for (let i = 0; i < 20; i++) {
      r.tl.setCursor(i);
      r.f.step();
    }
    r.tl.wheel({ x: 10, deltaY: -100 });
    r.f.step();
    expect(r.state.themeReads).toBe(1);
    expect(r.tl.themeReadCount).toBe(1);
    r.state.theme = { ...COLORS, bg: "light-bg", panel: "light-panel" };
    r.tl.themeChanged();
    expect(r.state.themeReads).toBe(2);
    r.g.clear();
    r.f.step();
    expect(r.g.styles).toContain("light-bg");
    expect(r.g.styles).not.toContain("c-bg");
    expect(r.state.themeReads).toBe(2);
  });

  it("draws only with colours the theme gave it", () => {
    const r = rig();
    r.state.data.cpu = { lines: [{ times: [1, 2, 3], values: [1, 2, 3], color: "accent2" }] };
    r.state.data.underruns = { ticks: [1, 2], tickColor: "warning" };
    r.state.data.voices = { lines: [{ times: [1, 2], values: [1, 2], color: "danger" }] };
    r.tl.setViewport({ start: 0, end: 10, followLive: false });
    r.tl.setCursor(5);
    r.tl.setSelection({ start: 1, end: 4 });
    r.g.clear();
    r.f.step();
    const known = new Set(Object.values(COLORS));
    expect(r.g.styles.length).toBeGreaterThan(10);
    for (const s of r.g.styles) expect(known.has(s)).toBe(true);
    expect(r.g.styles).toContain("c-accent2");
    expect(r.g.styles).toContain("c-warn");
    expect(r.g.styles).toContain("c-danger");
  });

  it("readTimelineColors reads each token once and falls back for an undefined one", () => {
    const asked: string[] = [];
    const c = readTimelineColors((name) => {
      asked.push(name);
      return name === "--accent" ? " #123456 " : "";
    });
    expect(asked.sort()).toEqual(Object.values(TIMELINE_TOKENS).sort());
    expect(c.accent).toBe("#123456");
    expect(c.bg.length).toBeGreaterThan(0);
  });
});

describe("tracks", () => {
  it("draws visible tracks only, labels each, and re-lays out when tracksChanged", () => {
    const r = rig();
    settle(r);
    r.tl.invalidate();
    r.f.step();
    const labels = r.g.count("fillText");
    r.tracks.setVisible("voices", false);
    r.tl.tracksChanged();
    r.g.clear();
    r.f.step();
    expect(r.g.count("fillText")).toBeLessThan(labels);
    expect(r.tl.lastDraw.tracks).toBe(2);
  });

  it("lanes get one band per series; each series is one stroke", () => {
    const r = rig();
    const t = [1, 2, 3, 4];
    r.state.data.voices = {
      lines: [
        { times: t, values: [1, 2, 3, 4], color: "accent" },
        { times: t, values: [4, 3, 2, 1], color: "accent2" },
        { times: t, values: [1, 1, 1, 1], color: "warning" },
      ],
    };
    r.tl.setViewport({ start: 0, end: 10, followLive: false });
    r.g.clear();
    r.f.step();
    expect(r.g.styles.filter((s) => s === "c-accent" || s === "c-accent2" || s === "c-warn").length).toBeGreaterThanOrEqual(3);
    expect(r.g.count("stroke")).toBe(3);
  });
});

describe("work is bounded by the canvas width, not the record count", () => {
  const QUANTUM_S = 128 / 48000;
  const TEN_MIN = 600;

  /** `n` samples across ten minutes: a voice count that climbs to 1,024, plus underrun ticks. */
  function capture(n: number): { times: Float64Array; voices: Float64Array; ticks: Float64Array } {
    const times = new Float64Array(n);
    const voices = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      times[i] = (i / n) * TEN_MIN;
      voices[i] = Math.round(512 + 512 * Math.sin(i / 997)) + (i % 7);
    }
    const ticks = new Float64Array(Math.floor(n / 50));
    for (let i = 0; i < ticks.length; i++) ticks[i] = times[i * 50]!;
    return { times, voices, ticks };
  }

  function loaded(n: number): Rig {
    const r = rig({}, TEN_MIN);
    const c = capture(n);
    r.state.data.cpu = { lines: [{ times: c.times, values: c.voices, color: "accent", yMax: 1100 }] };
    r.state.data.underruns = { ticks: c.ticks };
    r.state.data.voices = {
      lines: [
        { times: c.times, values: c.voices, color: "accent", yMax: 1100 },
        { times: c.times, values: c.voices, color: "accent2", yMax: 1100 },
        { times: c.times, values: c.voices, color: "warning", yMax: 1100 },
      ],
    };
    r.tl.setViewport({ start: 0, end: TEN_MIN, followLive: false });
    r.g.clear();
    r.f.step();
    return r;
  }

  const FULL = Math.round(TEN_MIN / QUANTUM_S); // 450,000 records, one per quantum

  it("a 10-minute capture at 1,024 voices: buckets and canvas calls are capped by width, whatever the record count", () => {
    const small = loaded(5_000);
    const smallCalls = small.g.calls.length;
    const big = loaded(FULL);
    const bigCalls = big.g.calls.length;

    // 3 line series on cpu/voices (1 + 3) and one tick track: at most `W` segments each.
    const maxBuckets = (1 + 3 + 1) * W;
    expect(big.tl.lastDraw.buckets).toBeLessThanOrEqual(maxBuckets);
    expect(small.tl.lastDraw.buckets).toBeLessThanOrEqual(maxBuckets);
    // Same canvas calls to within the buckets themselves; 90x the records adds no calls beyond width.
    expect(bigCalls).toBeLessThanOrEqual(small.g.calls.length + maxBuckets * 2);
    expect(bigCalls).toBeLessThanOrEqual(10 + maxBuckets * 3 + 200);
    expect(big.tl.lastDraw.buckets).toBeGreaterThan(small.tl.lastDraw.buckets - 1);
    expect(smallCalls).toBeGreaterThan(0);
    // 4 line series reduced once and one tick track: 5 reductions.
    expect(big.tl.lastDraw.downsamples).toBe(5);
  });

  it("a narrower canvas draws fewer buckets: the bound is the width", () => {
    const r = loaded(FULL);
    r.tl.setSize(200, 300);
    r.g.clear();
    r.f.step();
    expect(r.tl.lastDraw.buckets).toBeLessThanOrEqual(5 * 200);
  });

  it("moving the cursor or the selection redraws from the cache: nothing is reduced again", () => {
    const r = loaded(FULL);
    expect(r.tl.lastDraw.downsamples).toBe(5);
    r.tl.setCursor(100);
    r.f.step();
    expect(r.tl.lastDraw.downsamples).toBe(0);
    r.tl.setSelection({ start: 10, end: 20 });
    r.f.step();
    expect(r.tl.lastDraw.downsamples).toBe(0);
    r.tl.themeChanged();
    r.f.step();
    expect(r.tl.lastDraw.downsamples).toBe(0);
    r.tl.wheel({ x: 400, deltaY: -100 });
    r.f.step();
    expect(r.tl.lastDraw.downsamples).toBe(5);
    r.tl.dataChanged();
    r.f.step();
    expect(r.tl.lastDraw.downsamples).toBe(5);
  });

  it("logs the measured redraw time (a design target of 2 ms, never asserted)", () => {
    const r = loaded(FULL);
    const cold: number[] = [];
    const warm: number[] = [];
    for (let i = 0; i < 20; i++) {
      r.tl.setViewport({ start: i, end: i + 500 + (i % 3), followLive: false });
      const t0 = performance.now();
      r.f.step();
      cold.push(performance.now() - t0);
      r.tl.setCursor(i + 1);
      const t1 = performance.now();
      r.f.step();
      warm.push(performance.now() - t1);
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
    console.log(`drawTimeline redraw, 10 min, ${FULL} records x 4 series + ticks, width ${W}: viewport change median ${med(cold).toFixed(2)} ms, cursor-only median ${med(warm).toFixed(3)} ms`);
    expect(r.tl.redrawCount).toBeGreaterThan(40);
  });
});
