// Ed2 (api-and-models §7, contract H6): the segment view. Stem lanes with waveforms (Ed1's peaks, only the visible span
// drawn), the bar and beat ruler and grid lines and the tempo and metre lane (from `segmentViewModel.ts`, which compiles
// them from the tempo map), cues, regions, entry and exit, zoom, scroll and the playhead, on one canvas. Drags go
// through the hook that calls `segmentDrag.ts` (Ed3). Colours come from the theme tokens, read when drawing.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { editor, openAssetDocument, Panel } from "../../../../editor/sdk";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, positionTextToTicks, secondsToTicks, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import { openSegment } from "./index";
import { beginDrag, dragLabel, type DragHandle, type DragSession } from "./segmentDrag";
import { SNAP_MODES, type SnapMode } from "./segmentSnap";
import {
  clampViewport, findSegment, fitViewport, followPlayhead, gridLines, positionAtX, replaceSegment, scrollBy, secondsToX, tempoLane,
  ticksToX, xToSeconds, zoomAt, type Viewport,
} from "./segmentViewModel";
import { peaksFor } from "./peaksHost";
import type { PeaksService } from "./peaks";
import { TransportBar } from "./TransportBar";
import { musicTransport } from "./transportHost";
import { auditionOverrides, NO_OVERRIDES, stingerNames } from "../event/auditionHost";
import { auditionValues } from "../event/eventParameters";
import { binAt, binSpan, pickLevel, type PeakMips } from "./peaksMip";
import "./segmentView.css";

/** How the view changes its segment: `drag` merges a drag's quick changes into one undo step. */
export type SegmentChange = (next: SegmentNode, options: { label: string; drag?: boolean }) => void;

export interface SegmentViewProps {
  readonly segment: SegmentNode;
  /** Length of the longest stem in seconds when known (the grid's `"end"`); NaN or absent: unknown. */
  readonly endSeconds?: number;
  /** The peaks service for the stem lanes; absent: lanes draw empty. */
  readonly peaks?: Pick<PeaksService, "get" | "peek">;
  /** File seconds of the playhead, or absent when nothing plays. */
  readonly playheadSeconds?: number;
  readonly snap?: SnapMode;
  readonly readOnly?: boolean;
  readonly onChange?: SegmentChange;
  /** A click on the ruler asks to move the playhead to this file second. */
  readonly onSeek?: (seconds: number) => void;
}

/**
 * The drag hook (H6): pointer-down on a handle starts `beginDrag`; moves apply the preview through `onChange` with
 * `drag: true`; Escape cancels and restores the segment the drag began from. Ed3 fills `beginDrag`; until then it returns
 * null and no session starts.
 */
export function useSegmentDrag(props: SegmentViewProps, view: Viewport) {
  const session = useRef<{ drag: DragSession; handle: DragHandle } | null>(null);
  const latest = useRef({ props, view });
  latest.current = { props, view };

  const start = (handle: DragHandle, x: number): boolean => {
    const { props: p, view: v } = latest.current;
    if (p.readOnly || !p.onChange) return false;
    const grid = compileSegmentGrid(p.segment, { endSeconds: p.endSeconds });
    const drag = beginDrag(handle, { segment: p.segment, grid, view: v, snap: p.snap ?? "beat" }, x);
    if (!drag) return false;
    session.current = { drag, handle };
    return true;
  };
  const move = (x: number, alt: boolean) => {
    const s = session.current;
    if (!s) return;
    const preview = s.drag.move(x, { alt });
    if (preview) latest.current.props.onChange?.(preview.segment, { label: dragLabel(s.handle), drag: true });
  };
  const end = () => void (session.current = null);
  const cancel = () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    latest.current.props.onChange?.(s.drag.cancel(), { label: dragLabel(s.handle), drag: true });
  };
  return { start, move, end, cancel, active: () => session.current !== null };
}

// --- layout (CSS px) ------------------------------------------------------------------------------------------------

const RULER_H = 22;
const TEMPO_H = 20;
const REGION_H = 12;
const LANE_H = 64;
const TOP_H = RULER_H + TEMPO_H + REGION_H;
/** The padding before 0 and after the end the view can scroll into, seconds. */
const PAD_SECONDS = 0.5;
/** Seconds shown when nothing says how long the segment is (no stems decoded yet). */
const DEFAULT_TOTAL_SECONDS = 10;
const HANDLE_GRAB_PX = 5;

/** A draggable thing at x, with the rows it sits in. */
interface HandleBox { readonly handle: DragHandle; readonly x: number; readonly y0: number; readonly y1: number }

/** Resolve a position text to ticks against the grid (`"end"` needs the segment length). */
function textTicks(grid: SegmentGrid, text: string): number | null {
  const end = Number.isFinite(grid.endSeconds) ? secondsToTicks(grid, grid.endSeconds) : NaN;
  const t = positionTextToTicks(grid, text, end);
  return t !== null && Number.isFinite(t) ? t : null;
}

/** The handles at the viewport: cues in the ruler, regions' edges in the region row, tempo markers 1.. in the tempo lane. */
function handlesOf(segment: SegmentNode, grid: SegmentGrid, view: Viewport): HandleBox[] {
  const out: HandleBox[] = [];
  grid.cueNames.forEach((name, i) => {
    if (Number.isFinite(grid.cueTicks[i])) out.push({ handle: { kind: "cue", name }, x: ticksToX(grid, view, grid.cueTicks[i]), y0: 0, y1: RULER_H });
  });
  for (const r of segment.regions) {
    const a = textTicks(grid, r.from), b = textTicks(grid, r.to);
    if (a !== null) out.push({ handle: { kind: "region", id: r.id, edge: "from" }, x: ticksToX(grid, view, a), y0: RULER_H + TEMPO_H, y1: TOP_H });
    if (b !== null) out.push({ handle: { kind: "region", id: r.id, edge: "to" }, x: ticksToX(grid, view, b), y0: RULER_H + TEMPO_H, y1: TOP_H });
  }
  for (let i = 1; i < grid.count; i++) {
    out.push({ handle: { kind: "tempo", index: i }, x: ticksToX(grid, view, grid.startTick[i]), y0: RULER_H, y1: RULER_H + TEMPO_H });
  }
  return out;
}

const cssVar = (style: CSSStyleDeclaration, name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;

/** The longest decoded stem in seconds (0 when none is decoded yet). */
function stemSeconds(segment: SegmentNode, peaks: SegmentViewProps["peaks"]): number {
  let longest = 0;
  for (const t of segment.tracks) {
    const m = peaks?.peek(t.clip);
    if (m && m.rate > 0) longest = Math.max(longest, m.frames / m.rate);
  }
  return longest;
}

/** Draw one stem's waveform into the lane at `y`: one min/max column per pixel, from the bins of the visible span only. */
function drawLane(g: CanvasRenderingContext2D, mips: PeakMips, view: Viewport, y: number, color: string): void {
  const startFrame = xToSeconds(view, 0) * mips.rate;
  const endFrame = xToSeconds(view, view.widthPx) * mips.rate;
  const level = mips.levels[pickLevel(mips.levels, startFrame, endFrame, view.widthPx)];
  const span = binSpan(level, startFrame, endFrame);
  if (span.end <= span.first) return;
  const mid = y + LANE_H / 2;
  const half = LANE_H / 2 - 3;
  const framesPerPx = mips.rate / view.pxPerSecond;
  g.fillStyle = color;
  const x0 = Math.max(0, Math.floor(secondsToX(view, (span.first * level.binFrames) / mips.rate)));
  const x1 = Math.min(view.widthPx, Math.ceil(secondsToX(view, (span.end * level.binFrames) / mips.rate)));
  for (let x = x0; x < x1; x++) {
    const f0 = startFrame + x * framesPerPx;
    const b0 = Math.max(span.first, Math.floor(f0 / level.binFrames));
    const b1 = Math.min(span.end, Math.max(b0 + 1, Math.ceil((f0 + framesPerPx) / level.binFrames)));
    let lo = 32767, hi = -32768;
    for (let b = b0; b < b1; b++) {
      for (let c = 0; c < level.channels; c++) {
        const p = binAt(level, c, b);
        if (p.min < lo) lo = p.min;
        if (p.max > hi) hi = p.max;
      }
    }
    if (hi < lo) continue;
    const top = mid - (hi / 32768) * half, bottom = mid - (lo / 32768) * half;
    g.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

function draw(canvas: HTMLCanvasElement, props: SegmentViewProps, grid: SegmentGrid, view: Viewport, totalH: number, hover: number | null): void {
  const dpr = window.devicePixelRatio || 1;
  const w = view.widthPx;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(totalH * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(totalH * dpr);
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const st = getComputedStyle(canvas);
  const c = {
    bg: cssVar(st, "--bg-sunken", "#000"), panel: cssVar(st, "--panel", "#111"), surface: cssVar(st, "--surface", "#222"),
    text: cssVar(st, "--text", "#fff"), muted: cssVar(st, "--muted", "#999"), faint: cssVar(st, "--faint", "#666"), border: cssVar(st, "--border", "#333"),
    accent: cssVar(st, "--accent", "#2ad"), accent2: cssVar(st, "--accent2", "#8d2"), accentText: cssVar(st, "--accent-text", "#000"),
    warning: cssVar(st, "--warning", "#fb4"), accentSoft: cssVar(st, "--accent-soft", "rgba(40,200,200,.2)"), danger: cssVar(st, "--danger", "#f66"),
  };
  g.clearRect(0, 0, w, totalH);
  g.fillStyle = c.bg;
  g.fillRect(0, TOP_H, w, totalH - TOP_H);
  g.fillStyle = c.panel;
  g.fillRect(0, 0, w, TOP_H);
  g.font = "11px system-ui, sans-serif";
  g.textBaseline = "middle";

  // Stem lanes.
  props.segment.tracks.forEach((t, i) => {
    const y = TOP_H + i * LANE_H;
    g.fillStyle = c.surface;
    g.globalAlpha = i % 2 ? 0.25 : 0.55;
    g.fillRect(0, y, w, LANE_H);
    g.globalAlpha = 1;
    const mips = props.peaks?.peek(t.clip);
    if (mips) drawLane(g, mips, view, y, c.accent);
    else { g.fillStyle = c.faint; g.fillText("decoding…", 8, y + LANE_H / 2); }
    g.fillStyle = c.border;
    g.fillRect(0, y + LANE_H - 1, w, 1);
    g.fillStyle = c.text;
    g.fillText(t.name, 6, y + 9);
  });

  // Regions: bands in the region row, a wash over the lanes.
  for (const r of props.segment.regions) {
    const a = textTicks(grid, r.from), b = textTicks(grid, r.to);
    if (a === null || b === null) continue;
    const xa = ticksToX(grid, view, a), xb = ticksToX(grid, view, b);
    g.fillStyle = c.accentSoft;
    g.fillRect(xa, RULER_H + TEMPO_H, xb - xa, REGION_H);
    g.fillRect(xa, TOP_H, xb - xa, totalH - TOP_H);
    g.fillStyle = c.accent2;
    g.fillRect(xa, RULER_H + TEMPO_H, 2, REGION_H);
    g.fillRect(xb - 2, RULER_H + TEMPO_H, 2, REGION_H);
    g.fillStyle = c.text;
    g.fillText(r.id, Math.max(xa, 0) + 5, RULER_H + TEMPO_H + REGION_H / 2);
  }

  // Grid lines through the ruler and the lanes; the bar number on each labelled bar line; tempo and metre changes in the warning colour.
  for (const l of gridLines(grid, view)) {
    const x = Math.round(l.x) + 0.5;
    const strong = l.kind === "bar" || l.marker !== undefined;
    g.fillStyle = l.marker !== undefined ? c.warning : l.kind === "bar" ? c.muted : c.border;
    g.globalAlpha = strong ? 0.9 : 0.6;
    g.fillRect(x, l.kind === "bar" ? 4 : RULER_H - 7, 1, l.kind === "bar" ? RULER_H - 4 : 7);
    g.globalAlpha = strong ? 0.35 : 0.18;
    g.fillRect(x, TOP_H, 1, totalH - TOP_H);
    g.globalAlpha = 1;
    if (l.label !== undefined) {
      g.fillStyle = c.text;
      g.fillText(l.label, x + 3, 9);
    }
  }

  // Tempo and metre lane.
  g.fillStyle = c.border;
  g.fillRect(0, RULER_H, w, 1);
  for (const item of tempoLane(grid, view)) {
    g.fillStyle = item.metreChange ? c.warning : c.accent;
    g.fillRect(Math.round(item.x), RULER_H + 1, 2, TEMPO_H - 2);
    g.fillStyle = c.text;
    g.save();
    g.beginPath();
    const left = Math.max(0, item.x);
    g.rect(left, RULER_H, Math.min(w, item.endX) - left, TEMPO_H);
    g.clip();
    g.fillText(item.text, left + 6, RULER_H + TEMPO_H / 2);
    g.restore();
  }
  g.fillStyle = c.border;
  g.fillRect(0, RULER_H + TEMPO_H, w, 1);

  // Cues (flags in the ruler), entry and exit.
  grid.cueNames.forEach((name, i) => {
    const t = grid.cueTicks[i];
    if (!Number.isFinite(t)) return;
    const x = ticksToX(grid, view, t);
    if (x < -200 || x > w + 40) return;
    g.fillStyle = c.accent2;
    g.fillRect(Math.round(x), 0, 2, totalH);
    g.fillRect(Math.round(x), 0, g.measureText(name).width + 8, 12);
    g.fillStyle = c.accentText;
    g.fillText(name, x + 4, 6);
  });
  for (const [t, label] of [[grid.entryTicks, "in"], [grid.exitTicks, "out"]] as const) {
    if (!Number.isFinite(t)) continue;
    const x = ticksToX(grid, view, t);
    g.fillStyle = c.danger;
    g.globalAlpha = 0.7;
    g.fillRect(Math.round(x), RULER_H + TEMPO_H, 1, totalH - RULER_H - TEMPO_H);
    g.globalAlpha = 1;
    g.fillText(label, x + 3, TOP_H + 8);
  }

  // Hover line and playhead.
  if (hover !== null) {
    g.fillStyle = c.muted;
    g.globalAlpha = 0.5;
    g.fillRect(Math.round(hover), 0, 1, totalH);
    g.globalAlpha = 1;
  }
  if (props.playheadSeconds !== undefined) {
    const x = secondsToX(view, props.playheadSeconds);
    if (x >= -6 && x <= w + 6) {
      g.fillStyle = c.text;
      g.fillRect(Math.round(x), 0, 1, totalH);
      g.beginPath();
      g.moveTo(x - 5, 0);
      g.lineTo(x + 5, 0);
      g.lineTo(x, 7);
      g.closePath();
      g.fill();
    }
  }
}

export function SegmentView(props: SegmentViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [view, setView] = useState<Viewport | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [snap, setSnap] = useState<SnapMode>(props.snap ?? "beat");
  const [, setPeaksTick] = useState(0); // bumped when a stem's peaks arrive, so the lane draws
  const compiled = useMemo(() => {
    const problems: string[] = [];
    return { grid: compileSegmentGrid(props.segment, { endSeconds: props.endSeconds, problems }), problems };
  }, [props.segment, props.endSeconds]);
  const { grid, problems } = compiled;

  const clips = props.segment.tracks.map((t) => t.clip).join("\n");
  useEffect(() => {
    let live = true;
    for (const t of props.segment.tracks) {
      if (!props.peaks?.peek(t.clip)) props.peaks?.get(t.clip).then(() => live && setPeaksTick((n) => n + 1), () => {});
    }
    return () => void (live = false);
  }, [props.peaks, clips]);

  const known = props.endSeconds !== undefined && Number.isFinite(props.endSeconds) ? props.endSeconds : 0;
  const total = Math.max(known, stemSeconds(props.segment, props.peaks)) || DEFAULT_TOTAL_SECONDS;
  const current: Viewport = { ...clampViewport(view ?? fitViewport(width, total, PAD_SECONDS), total, PAD_SECONDS), widthPx: width };
  const currentRef = useRef(current);
  currentRef.current = current;
  const totalRef = useRef(total);
  totalRef.current = total;
  const drag = useSegmentDrag({ ...props, snap }, current);
  const totalH = TOP_H + Math.max(1, props.segment.tracks.length) * LANE_H;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(1, Math.floor(el.clientWidth)));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // Ctrl or cmd + wheel zooms about the pointer; the plain wheel scrolls.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = currentRef.current;
      const x = e.clientX - el.getBoundingClientRect().left;
      if (e.ctrlKey || e.metaKey) setView(zoomAt(v, Math.exp(-e.deltaY * 0.002), x, totalRef.current, PAD_SECONDS));
      else setView(scrollBy(v, Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY, totalRef.current, PAD_SECONDS));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Page along with the playhead while it plays.
  useEffect(() => {
    if (props.playheadSeconds === undefined) return;
    const v = currentRef.current;
    const next = followPlayhead(v, props.playheadSeconds, totalRef.current, PAD_SECONDS);
    if (next !== v) setView(next);
  }, [props.playheadSeconds]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && drag.active() && drag.cancel();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  useEffect(() => {
    if (canvas.current) draw(canvas.current, props, grid, current, totalH, hoverX);
  });

  const localX = (e: PointerEvent) => e.clientX - (canvas.current?.getBoundingClientRect().left ?? 0);
  const localY = (e: PointerEvent) => e.clientY - (canvas.current?.getBoundingClientRect().top ?? 0);

  const onDown = (e: PointerEvent) => {
    const x = localX(e), y = localY(e);
    const hit = handlesOf(props.segment, grid, current)
      .filter((h) => y >= h.y0 && y <= h.y1 && Math.abs(h.x - x) <= HANDLE_GRAB_PX)
      .sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    if (hit && drag.start(hit.handle, x)) canvas.current?.setPointerCapture(e.pointerId);
    else if (y < RULER_H) props.onSeek?.(Math.max(0, xToSeconds(current, x)));
  };
  const onMove = (e: PointerEvent) => {
    const x = localX(e);
    setHoverX(x);
    if (drag.active()) drag.move(x, e.altKey);
  };
  const onUp = () => drag.end();

  const pos = hoverX === null ? null : positionAtX(grid, current, hoverX);
  const zoomBy = (f: number) => setView(zoomAt(current, f, width / 2, total, PAD_SECONDS));
  return (
    <div class="segment-view" ref={box}>
      <div class="segment-toolbar">
        <button type="button" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => zoomBy(1.5)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => setView(fitViewport(width, total, PAD_SECONDS))}>Fit</button>
        <label>
          Snap{" "}
          <select value={snap} onChange={(e) => setSnap((e.target as HTMLSelectElement).value as SnapMode)}>
            {SNAP_MODES.map((m) => <option value={m}>{m}</option>)}
          </select>
        </label>
        <span class="segment-readout">
          {hoverX === null ? "" : `${pos ? `${pos.bar}:${pos.beat}:${pos.tick}` : "pickup"}  ${xToSeconds(current, hoverX).toFixed(3)} s`}
        </span>
      </div>
      <canvas
        ref={canvas}
        class="segment-canvas"
        style={{ width: `${width}px`, height: `${totalH}px` }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHoverX(null)}
      />
      {problems.length > 0 && <ul class="segment-problems">{problems.map((p) => <li>{p}</li>)}</ul>}
    </div>
  );
}

/** The registered panel: the segment named by `openSegment`, edited through its event's asset document. */
export function SegmentViewPanel() {
  const open = openSegment.value;
  const project = editor.project.current;
  editor.project.version; // the file list changes with it
  if (!project || !open) return <Panel><p class="empty">Open a segment from the Event editor.</p></Panel>;
  if (!project.files.includes(open.event)) return <Panel><p class="empty">{open.event} isn't in the project any more.</p></Panel>;
  return (
    <Panel>
      <OpenSegment key={`${open.event}#${open.segmentId}`} path={open.event} segmentId={open.segmentId} />
    </Panel>
  );
}

function OpenSegment({ path, segmentId }: { path: string; segmentId: string }) {
  const project = editor.project.current!;
  const doc = openAssetDocument<AudioEventAsset>(project, path, "audioEvent");
  useEffect(() => () => void doc.flush(), [doc]);
  const event = doc.value.value;
  const segment = useMemo(() => findSegment(event.musicRoot, segmentId), [event.musicRoot, segmentId]);
  const grid = useMemo(() => (segment ? compileSegmentGrid(segment, { endSeconds: NaN }) : null), [segment]);
  // The transport (ticking, solo and mute, its lifetime) is the transport service's (F-33): a tab switch to Segment
  // Properties unmounts this view, and the audition goes on.
  useEffect(() => { if (grid) musicTransport.tick(grid); }, [grid]);
  // F-15: the Event editor's slider values (moved ones over the defaults) reach the played instance.
  const parameters = auditionValues(event.parameters, auditionOverrides.value[path] ?? NO_OVERRIDES);
  if (!segment || !grid) return <p class="empty">{path} has no segment “{segmentId}”.</p>;
  const onChange: SegmentChange = (next, o) => {
    if (!event.musicRoot) return;
    doc.edit({ ...event, musicRoot: replaceSegment(event.musicRoot, segmentId, next) }, o.drag ? { coalesce: true, label: o.label } : { label: o.label });
  };
  const request = (seconds: number) => ({ event: path, segmentId, grid, parameters, startAtSegment: true, from: { kind: "seconds", seconds } as const });
  return (
    <div class="segment-panel-root" data-asset-document={doc.path}>
      <TransportBar
        transport={musicTransport}
        event={path}
        segmentId={segmentId}
        grid={grid}
        cues={segment.cues.map((c) => c.name)}
        stingers={stingerNames(event.musicRoot)}
        parameters={parameters}
      />
      <SegmentView
        segment={segment}
        peaks={peaksFor(project)}
        readOnly={doc.readOnly}
        onChange={onChange}
        playheadSeconds={musicTransport.playhead.value}
        onSeek={(seconds) => void musicTransport.seek(request(seconds))}
      />
    </div>
  );
}

