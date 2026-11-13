/**
 * The profiler timeline's canvas engine (ADR 0171 section 7, task Pf3a): draws the `TrackList` onto a 2D context it is
 * given and turns pointer and wheel input it is given into viewport, cursor and selection changes, every one of them
 * through `timelineModel`. No Preact and no DOM lookups here (the panel, Pf4, owns the canvas element and forwards its
 * events); the clock is injectable so a test steps frames by hand.
 *
 * Redraw: any change sets one dirty flag; at most one `requestAnimationFrame` is pending, and it draws only when the
 * flag is still set, so a hundred wheel events in a frame cost one redraw and an idle timeline costs none.
 *
 * Work per redraw is bounded by the canvas width: each series is reduced to one min/max bucket per pixel column
 * (`downsampleMinMax`, `downsampleTicks`) and emits at most one path segment per bucket, however many records the
 * capture holds. The reduced buckets are cached until the viewport, the width or the data change, so moving the cursor
 * or the selection redraws from the cache. Colours come only from theme tokens, read once per theme change.
 */

import {
  clampViewport,
  downsampleMinMax,
  downsampleTicks,
  followLiveViewport,
  panViewport,
  timeToX,
  xToTime,
  zoomViewport,
  type Buckets,
  type Track,
  type TrackList,
  type Viewport,
} from "./timelineModel";

/** The theme tokens the timeline draws with (`src/editor/ui/editor.css`). */
export const TIMELINE_TOKENS = {
  bg: "--bg-sunken",
  panel: "--panel",
  border: "--border",
  text: "--text",
  muted: "--muted",
  accent: "--accent",
  accent2: "--accent2",
  accentSoft: "--accent-soft",
  warning: "--warning",
  danger: "--danger",
} as const;

export type TimelineColorKey = keyof typeof TIMELINE_TOKENS;
export type TimelineColors = Readonly<Record<TimelineColorKey, string>>;

/** Fallbacks for a token a custom theme leaves undefined. */
const FALLBACK: TimelineColors = {
  bg: "#050708",
  panel: "#0f1517",
  border: "#283435",
  text: "#f4efe6",
  muted: "#989893",
  accent: "#2ad4d4",
  accent2: "#8bd12a",
  accentSoft: "rgb(42 212 212 / 0.22)",
  warning: "#f0b429",
  danger: "#ff6b6b",
};

/** Reads every token once through `get` (a custom-property lookup); call it on a theme change, never per frame. */
export function readTimelineColors(get: (name: string) => string): TimelineColors {
  const out = { ...FALLBACK };
  for (const key of Object.keys(TIMELINE_TOKENS) as TimelineColorKey[]) {
    const v = get(TIMELINE_TOKENS[key]).trim();
    if (v) out[key] = v;
  }
  return out;
}

/** A lookup over an element's computed style, for `readTimelineColors`. */
export function cssVarReader(el: Element): (name: string) => string {
  const style = getComputedStyle(el);
  return (name) => style.getPropertyValue(name);
}

/** A line over time; `values` the same length as `times` (ascending seconds). */
export interface LineSeries {
  readonly times: ArrayLike<number>;
  readonly values: ArrayLike<number>;
  readonly color: TimelineColorKey;
  /** The scale's top; defaults to the largest bucket maximum in view. */
  readonly yMax?: number;
}

/** What a track shows: `lines` for "line" (one shared scale) and "lanes" (one band per series), `ticks` for "ticks". */
export interface TrackData {
  readonly lines?: readonly LineSeries[];
  readonly ticks?: ArrayLike<number>;
  readonly tickColor?: TimelineColorKey;
}

export interface TimelineSelection {
  readonly start: number;
  readonly end: number;
}

export interface TimelinePointer {
  /** Pixels from the canvas's left and top edge. */
  readonly x: number;
  readonly y: number;
  readonly shiftKey?: boolean;
}

export interface TimelineWheel {
  readonly x: number;
  readonly deltaX?: number;
  readonly deltaY: number;
}

/** What the last redraw did; the tests assert on it, never on time. */
export interface DrawStats {
  /** Series reduced to buckets this frame (0 when the cache held). */
  readonly downsamples: number;
  /** Buckets that emitted a path segment. */
  readonly buckets: number;
  readonly tracks: number;
}

export interface TimelineOptions {
  readonly ctx: CanvasRenderingContext2D;
  readonly tracks: TrackList;
  /** The data of a track; called when the cache is cold, not per frame. */
  readonly data: (trackId: string) => TrackData | undefined;
  /** The capture's length in seconds (grows while live). */
  readonly duration: () => number;
  /** Reads the theme; called at construction and by `themeChanged()` only. */
  readonly readColors: () => TimelineColors;
  readonly width: number;
  readonly height: number;
  readonly dpr?: number;
  readonly raf?: (cb: () => void) => number;
  readonly caf?: (handle: number) => void;
  readonly onViewport?: (v: Viewport) => void;
  readonly onCursor?: (t: number) => void;
  readonly onSelection?: (s: TimelineSelection | null) => void;
}

export const RULER_HEIGHT = 18;
/** Pointer travel (px) below which a track-area press is a click, not a pan. */
export const CLICK_SLOP_PX = 3;
/** Zoom per wheel pixel: factor = ZOOM_PER_PX ** -deltaY, so one 100 px notch up zooms in by about 1.16. */
export const ZOOM_PER_PX = 1.0015;
const RULER_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const MIN_LABEL_PX = 80;
const BAND_PAD = 2;

type Mode = "none" | "cursor" | "pending" | "pan" | "select";

interface SeriesCache {
  readonly kind: "line" | "ticks";
  readonly lines?: readonly { buckets: Buckets; color: TimelineColorKey; yMax: number }[];
  readonly ticks?: Uint8Array;
  readonly tickColor: TimelineColorKey;
}

export class TimelineCanvas {
  private readonly opt: TimelineOptions;
  private readonly raf: (cb: () => void) => number;
  private readonly caf: (h: number) => void;
  private ctx: CanvasRenderingContext2D;
  private colors: TimelineColors;
  private w: number;
  private h: number;
  private dpr: number;
  private vp: Viewport;
  private cur: number | null = null;
  private sel: TimelineSelection | null = null;
  private dirty = true;
  private frame: number | null = null;
  private dataVersion = 0;
  private cacheKey = "";
  private cache = new Map<string, SeriesCache>();
  private mode: Mode = "none";
  private downX = 0;
  private lastX = 0;
  private anchorT = 0;
  private redraws = 0;
  private stats: DrawStats = { downsamples: 0, buckets: 0, tracks: 0 };
  private themeReads = 0;
  private disposed = false;

  constructor(opt: TimelineOptions) {
    this.opt = opt;
    this.ctx = opt.ctx;
    this.w = Math.max(1, Math.floor(opt.width));
    this.h = Math.max(1, Math.floor(opt.height));
    this.dpr = opt.dpr && opt.dpr > 0 ? opt.dpr : 1;
    this.raf = opt.raf ?? ((cb) => globalThis.requestAnimationFrame(() => cb()));
    this.caf = opt.caf ?? ((hd) => globalThis.cancelAnimationFrame(hd));
    this.colors = this.readTheme();
    const d = this.duration();
    this.vp = followLiveViewport({ start: 0, end: d > 0 ? d : 1, followLive: true }, d);
    this.schedule();
  }

  // ---- state -------------------------------------------------------------------------------------------------------

  get viewport(): Viewport {
    return this.vp;
  }
  get cursor(): number | null {
    return this.cur;
  }
  get selection(): TimelineSelection | null {
    return this.sel;
  }
  get redrawCount(): number {
    return this.redraws;
  }
  get lastDraw(): DrawStats {
    return this.stats;
  }
  /** How many times the theme was read (construction plus each `themeChanged`). */
  get themeReadCount(): number {
    return this.themeReads;
  }
  get frameScheduled(): boolean {
    return this.frame !== null;
  }
  get isDirty(): boolean {
    return this.dirty;
  }

  setViewport(v: Viewport): void {
    this.applyViewport(clampViewport(v, this.duration()));
  }

  setCursor(t: number | null): void {
    const next = t === null || !Number.isFinite(t) ? null : this.clampTime(t);
    if (next === this.cur) return;
    this.cur = next;
    this.invalidate();
  }

  setSelection(s: TimelineSelection | null): void {
    const next = s && Number.isFinite(s.start) && Number.isFinite(s.end) ? this.normSel(s.start, s.end) : null;
    if (next === this.sel || (next && this.sel && next.start === this.sel.start && next.end === this.sel.end)) return;
    this.sel = next;
    this.invalidate();
  }

  /** The canvas was resized (CSS pixels) or its pixel ratio changed. */
  setSize(width: number, height: number, dpr = this.dpr): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr > 0 ? dpr : 1;
    this.invalidate();
  }

  /** The capture grew or its series changed: follows the live edge if pinned, drops the bucket cache, redraws. */
  dataChanged(): void {
    this.dataVersion++;
    if (this.vp.followLive) this.vp = followLiveViewport(this.vp, this.duration());
    else this.vp = clampViewport(this.vp, this.duration());
    this.invalidate();
  }

  /** The track list changed (order, visibility, height). */
  tracksChanged(): void {
    this.dataVersion++;
    this.invalidate();
  }

  /** The theme changed: read the tokens again, once, then redraw. */
  themeChanged(): void {
    this.colors = this.readTheme();
    this.invalidate();
  }

  /** Marks the canvas dirty and makes sure one frame is pending. */
  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) this.caf(this.frame);
    this.frame = null;
  }

  // ---- input -------------------------------------------------------------------------------------------------------

  /** Wheel zooms around the pointer's time; a horizontal delta pans. Returns true when the event was used. */
  wheel(e: TimelineWheel): boolean {
    const d = this.duration();
    let v = this.vp;
    if (e.deltaY) {
      const factor = Math.pow(ZOOM_PER_PX, -e.deltaY);
      v = zoomViewport(v, factor, xToTime(v, e.x, this.w), d);
    }
    if (e.deltaX) v = panViewport(v, (e.deltaX / this.w) * (v.end - v.start), d);
    if (!e.deltaY && !e.deltaX) return false;
    this.applyViewport(v);
    return true;
  }

  /** A press: in the ruler it scrubs the cursor; shift in the tracks starts a selection; else a pan or a click. */
  pointerDown(e: TimelinePointer): void {
    this.downX = this.lastX = e.x;
    if (e.y < RULER_HEIGHT) {
      this.mode = "cursor";
      this.moveCursorTo(e.x);
    } else if (e.shiftKey) {
      this.mode = "select";
      this.anchorT = this.clampTime(xToTime(this.vp, e.x, this.w));
    } else {
      this.mode = "pending";
    }
  }

  pointerMove(e: TimelinePointer): void {
    if (this.mode === "none") return;
    if (this.mode === "cursor") {
      this.moveCursorTo(e.x);
    } else if (this.mode === "select") {
      const t = this.clampTime(xToTime(this.vp, e.x, this.w));
      this.setSelection({ start: this.anchorT, end: t });
      this.notifySelection();
    } else {
      if (this.mode === "pending") {
        if (Math.abs(e.x - this.downX) < CLICK_SLOP_PX) return;
        this.mode = "pan";
      }
      const dx = e.x - this.lastX;
      this.lastX = e.x;
      if (dx !== 0) this.applyViewport(panViewport(this.vp, (-dx / this.w) * (this.vp.end - this.vp.start), this.duration()));
    }
  }

  /** Release: a track-area click sets the cursor; a shift-click without travel clears the selection. */
  pointerUp(e: TimelinePointer): void {
    const mode = this.mode;
    this.mode = "none";
    if (mode === "pending") this.moveCursorTo(e.x);
    else if (mode === "select" && Math.abs(e.x - this.downX) < CLICK_SLOP_PX) {
      this.setSelection(null);
      this.notifySelection();
    }
  }

  pointerCancel(): void {
    this.mode = "none";
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private readTheme(): TimelineColors {
    this.themeReads++;
    return this.opt.readColors();
  }

  private duration(): number {
    const d = this.opt.duration();
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  private clampTime(t: number): number {
    return Math.min(Math.max(t, 0), this.duration());
  }

  private normSel(a: number, b: number): TimelineSelection {
    const lo = this.clampTime(Math.min(a, b));
    const hi = this.clampTime(Math.max(a, b));
    return { start: lo, end: hi };
  }

  private moveCursorTo(x: number): void {
    const t = this.clampTime(xToTime(this.vp, x, this.w));
    this.setCursor(t);
    this.opt.onCursor?.(t);
  }

  private notifySelection(): void {
    this.opt.onSelection?.(this.sel);
  }

  private applyViewport(v: Viewport): void {
    const o = this.vp;
    if (v.start === o.start && v.end === o.end && v.followLive === o.followLive) return;
    this.vp = v;
    this.invalidate();
    this.opt.onViewport?.(v);
  }

  private schedule(): void {
    if (this.disposed || this.frame !== null) return;
    this.frame = this.raf(() => this.onFrame());
  }

  private onFrame(): void {
    this.frame = null;
    if (this.disposed || !this.dirty) return;
    this.dirty = false;
    this.redraw();
  }

  private visibleTracks(): Track[] {
    return this.opt.tracks.tracks.filter((t) => t.visible);
  }

  private buildCache(): number {
    const key = `${this.vp.start}|${this.vp.end}|${this.w}|${this.dataVersion}`;
    if (key === this.cacheKey) return 0;
    this.cacheKey = key;
    this.cache = new Map();
    let n = 0;
    for (const t of this.visibleTracks()) {
      const data = this.opt.data(t.id);
      if (!data) continue;
      if (t.kind === "ticks") {
        this.cache.set(t.id, { kind: "ticks", ticks: data.ticks ? downsampleTicks(data.ticks, this.vp, this.w) : undefined, tickColor: data.tickColor ?? "danger" });
        n++;
        continue;
      }
      const lines = (data.lines ?? []).map((s) => {
        const buckets = downsampleMinMax(s.times, s.values, this.vp, this.w);
        let top = s.yMax ?? 0;
        if (s.yMax === undefined) for (let i = 0; i < this.w; i++) if (buckets.filled[i] && buckets.max[i]! > top) top = buckets.max[i]!;
        n++;
        return { buckets, color: s.color, yMax: top > 0 ? top : 1 };
      });
      this.cache.set(t.id, { kind: "line", lines, tickColor: "danger" });
    }
    return n;
  }

  private redraw(): void {
    const g = this.ctx;
    const c = this.colors;
    const w = this.w;
    const downsamples = this.buildCache();
    let buckets = 0;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, w, this.h);
    this.drawRuler(g, c);

    const tracks = this.visibleTracks();
    let y = RULER_HEIGHT;
    for (const t of tracks) {
      g.fillStyle = c.panel;
      g.fillRect(0, y, w, t.height - 1);
      g.fillStyle = c.border;
      g.fillRect(0, y + t.height - 1, w, 1);
      const entry = this.cache.get(t.id);
      if (entry) buckets += this.drawTrack(g, c, t, entry, y);
      g.fillStyle = c.muted;
      g.fillText(t.label, 6, y + 10);
      y += t.height;
    }

    const bottom = Math.max(y, RULER_HEIGHT);
    if (this.sel) {
      const x0 = Math.max(0, timeToX(this.vp, this.sel.start, w));
      const x1 = Math.min(w, timeToX(this.vp, this.sel.end, w));
      if (x1 > x0) {
        g.fillStyle = c.accentSoft;
        g.fillRect(x0, 0, x1 - x0, bottom);
      }
    }
    if (this.cur !== null) {
      const x = timeToX(this.vp, this.cur, w);
      if (x >= 0 && x <= w) {
        g.fillStyle = c.accent;
        g.fillRect(Math.round(x), 0, 1, bottom);
      }
    }
    this.redraws++;
    this.stats = { downsamples, buckets, tracks: tracks.length };
  }

  private drawRuler(g: CanvasRenderingContext2D, c: TimelineColors): void {
    const span = this.vp.end - this.vp.start;
    const w = this.w;
    g.fillStyle = c.panel;
    g.fillRect(0, 0, w, RULER_HEIGHT);
    if (!(span > 0)) return;
    const step = RULER_STEPS.find((s) => (s / span) * w >= MIN_LABEL_PX) ?? RULER_STEPS[RULER_STEPS.length - 1]!;
    g.fillStyle = c.muted;
    g.font = "10px system-ui, sans-serif";
    for (let t = Math.ceil(this.vp.start / step) * step; t < this.vp.end; t += step) {
      const x = Math.round(timeToX(this.vp, t, w));
      g.fillRect(x, RULER_HEIGHT - 5, 1, 5);
      g.fillText(formatTime(t, step), x + 3, 10);
    }
  }

  /** Draws one track's reduced series; returns the buckets that emitted a segment. */
  private drawTrack(g: CanvasRenderingContext2D, c: TimelineColors, t: Track, e: SeriesCache, top: number): number {
    const w = this.w;
    let n = 0;
    if (e.kind === "ticks") {
      if (!e.ticks) return 0;
      g.strokeStyle = c[e.tickColor];
      g.beginPath();
      for (let x = 0; x < w; x++) {
        if (!e.ticks[x]) continue;
        g.moveTo(x + 0.5, top + 2);
        g.lineTo(x + 0.5, top + t.height - 3);
        n++;
      }
      g.stroke();
      return n;
    }
    const lines = e.lines ?? [];
    const lanes = t.kind === "lanes";
    const count = Math.max(1, lines.length);
    lines.forEach((s, i) => {
      const bandH = lanes ? t.height / count : t.height;
      const y0 = top + (lanes ? i * bandH : 0) + BAND_PAD;
      const y1 = top + (lanes ? (i + 1) * bandH : t.height) - BAND_PAD - 1;
      const scale = (v: number) => y1 - Math.min(Math.max(v / s.yMax, 0), 1) * (y1 - y0);
      g.strokeStyle = c[s.color];
      g.beginPath();
      for (let x = 0; x < w; x++) {
        if (!s.buckets.filled[x]) continue;
        g.moveTo(x + 0.5, scale(s.buckets.max[x]!));
        g.lineTo(x + 0.5, scale(s.buckets.min[x]!) + 1);
        n++;
      }
      g.stroke();
    });
    return n;
  }
}

function formatTime(t: number, step: number): string {
  if (step >= 1) {
    const m = Math.floor(t / 60);
    const s = Math.round(t - m * 60);
    return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
  }
  return `${(t * 1000).toFixed(step < 0.01 ? 1 : 0)}ms`;
}
