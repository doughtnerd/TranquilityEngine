// Ed3 (api-and-models §7, contract H6): dragging cues, region edges and tempo markers in the segment view, with snapping
// (`segmentSnap.ts`) and undo. `SegmentView.tsx`'s drag hook calls `beginDrag` on a pointer-down over a handle, `move` on
// each pointer move (it applies the preview through the asset document with `coalesce: true`, so one drag is one undo step)
// and `cancel` on Escape. Ed2's skeleton: `beginDrag` returns null (nothing draggable) until Ed3 fills it.
import {
  compileTempoMap, positionTextToTicks, secondsToTicks, ticksToPositionText, ticksToSeconds, type SegmentGrid, type TempoMap,
} from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import type { SegmentNode, TempoMarker } from "../../../../engine/audio/musicFormat";
import { snapTicks, type SnapMode } from "./segmentSnap";
import { xToSeconds, type Viewport } from "./segmentViewModel";

/** Something the view draws that can be dragged. */
export type DragHandle =
  | { readonly kind: "cue"; /** `MusicCue.name` */ readonly name: string }
  | { readonly kind: "region"; /** `MusicRegion.id` */ readonly id: string; readonly edge: "from" | "to" }
  | { readonly kind: "tempo"; /** index in `SegmentNode.tempo`; marker 0 is not draggable */ readonly index: number };

/** What a drag works from; the view builds it at pointer-down and the session keeps it. */
export interface DragContext {
  /** The segment as it is at pointer-down: the session's base, and what `cancel` restores. */
  readonly segment: SegmentNode;
  /** `compileSegmentGrid(segment, ...)` of that segment. */
  readonly grid: SegmentGrid;
  /** The viewport at pointer-down (the view does not rescale during a drag). */
  readonly view: Viewport;
  /** The snap mode chosen in the toolbar; the session uses `"off"` while `modifiers.alt` is held. */
  readonly snap: SnapMode;
}

/** The result of a pointer move. */
export interface DragPreview {
  /** The whole segment with the handle moved (positions stay canonical `bar:beat:tick` text). */
  readonly segment: SegmentNode;
  /** The position text the handle now sits at, for the readout next to the pointer (`"12:3:0"`). */
  readonly text: string;
}

export interface DragModifiers {
  readonly alt: boolean;
}

export interface DragSession {
  /** Pointer at x (CSS px, the same origin as the viewport). Null when the position is not allowed (the view keeps the last preview). */
  move(x: number, modifiers: DragModifiers): DragPreview | null;
  /** The segment to restore: `context.segment`. */
  cancel(): SegmentNode;
}

/** The undo step's label for a drag of `handle`. */
export function dragLabel(handle: DragHandle): string {
  switch (handle.kind) {
    case "cue": return `Move cue ${handle.name}`;
    case "region": return `Move region ${handle.id} ${handle.edge}`;
    case "tempo": return `Move tempo marker ${handle.index + 1}`;
  }
}

/** The tick of the audio's end, or `Infinity` when its length is unknown. */
const endTicksOf = (grid: SegmentGrid): number => (Number.isFinite(grid.endSeconds) ? secondsToTicks(grid, grid.endSeconds) : Infinity);

/** Ticks of a stored position text (`"end"` with no length is `Infinity`), or null when it is not usable. */
function ticksOfText(grid: SegmentGrid, text: string): number | null {
  const t = positionTextToTicks(grid, text, endTicksOf(grid));
  return t === null || Number.isNaN(t) ? null : t;
}

/** The file second the pointer means: the handle's own second at pointer-down plus the pointer's travel, so a grab off-centre does not jump. */
function pointerSeconds(grid: SegmentGrid, view: Viewport, startTicks: number, startX: number, x: number): number {
  const base = Number.isFinite(startTicks) ? ticksToSeconds(grid, startTicks) : xToSeconds(view, startX);
  return base + (x - startX) / view.pxPerSecond;
}

interface Placed { readonly ticks: number; readonly text: string }

/**
 * Where a cue or region edge dropped at file `seconds` lands: snapped to `mode`, never before `1:1:0`, and stored as a
 * position on the grid. `"start"` (only where `allowStart`) when the grid has a pickup and the pointer is at or before the
 * file start; `"end"` (only where `allowEnd`) when the audio's length is known and the pointer is at or past it.
 */
function place(grid: SegmentGrid, seconds: number, mode: SnapMode, allowStart: boolean, allowEnd: boolean): Placed | null {
  if (allowStart && grid.gridOffset > 0 && seconds <= 0) return { ticks: secondsToTicks(grid, 0), text: "start" };
  const raw = secondsToTicks(grid, seconds);
  const endT = endTicksOf(grid);
  if (allowEnd && Number.isFinite(endT) && raw >= endT) return { ticks: endT, text: "end" };
  const ticks = snapTicks(grid, raw, mode);
  if (allowEnd && ticks >= endT) return { ticks: endT, text: "end" };
  const text = ticksToPositionText(grid, ticks);
  return text === null ? null : { ticks, text };
}

/** A session that previews `apply(placed)` of the base segment; the base object itself when nothing changed. */
function session(context: DragContext, startTicks: number, startX: number, allowStart: boolean, allowEnd: boolean,
  apply: (p: Placed) => SegmentNode | null): DragSession {
  const { segment, grid, view } = context;
  return {
    move(x, modifiers) {
      const mode = modifiers.alt ? "off" : context.snap;
      const p = place(grid, pointerSeconds(grid, view, startTicks, startX, x), mode, allowStart, allowEnd);
      if (!p) return null;
      const next = apply(p);
      return next ? { segment: next, text: p.text } : null;
    },
    cancel: () => segment,
  };
}

function cueSession(name: string, context: DragContext, startX: number): DragSession | null {
  const { segment, grid } = context;
  const cue = segment.cues.find((c) => c.name === name);
  const gi = grid.cueNames.indexOf(name);
  if (!cue || gi < 0) return null;
  return session(context, grid.cueTicks[gi], startX, true, true, (p) =>
    p.text === cue.at ? segment : { ...segment, cues: segment.cues.map((c) => (c === cue ? { ...c, at: p.text } : c)) });
}

function regionSession(id: string, edge: "from" | "to", context: DragContext, startX: number): DragSession | null {
  const { segment, grid } = context;
  const region = segment.regions.find((r) => r.id === id);
  if (!region) return null;
  const own = ticksOfText(grid, region[edge]);
  const other = ticksOfText(grid, region[edge === "from" ? "to" : "from"]);
  if (own === null || other === null) return null;
  return session(context, own, startX, edge === "from", edge === "to", (p) => {
    if (edge === "from" ? !(p.ticks < other) : !(p.ticks > other)) return null; // the edges keep their order
    return p.text === region[edge] ? segment : { ...segment, regions: segment.regions.map((r) => (r === region ? { ...r, [edge]: p.text } : r)) };
  });
}

/**
 * Move tempo marker `index`. Every later marker, cue and region keeps its ticks, so it stays on its beat and only moves
 * in seconds (the span before the marker gets longer or shorter); their position text is rewritten against the
 * recompiled map, which only changes when the marker is a metre change (bar numbers after it shift). The marker snaps
 * to a beat (a bar line when it changes the metre or the mode is `bar`) strictly between its neighbours.
 */
function tempoSession(index: number, context: DragContext, startX: number): DragSession | null {
  const { segment, grid, view } = context;
  const tempo = segment.tempo;
  // Handles index the compiled spans; a marker the compile dropped would misalign them.
  if (index < 1 || index >= tempo.length || grid.count !== tempo.length) return null;
  const prev = compileTempoMap(tempo.slice(0, index), segment.gridOffset);
  const last = prev.count - 1;
  const lo = grid.startTick[index - 1];
  const hi = index + 1 < grid.count ? grid.startTick[index + 1] : Infinity;
  const marker = tempo[index], before = tempo[index - 1];
  const metreChange = marker.beatsPerBar !== before.beatsPerBar || marker.beatUnit !== before.beatUnit;
  const startTicks = grid.startTick[index];

  const rewrite = (map: TempoMap, text: string): string => {
    const t = ticksOfText(grid, text);
    return t === null || !Number.isFinite(t) || text === "start" ? text : (ticksToPositionText(map, t) ?? text);
  };

  const build = (t: number): { segment: SegmentNode; text: string } | null => {
    // Marker texts one by one, each against the map of the markers before it.
    const markers: TempoMarker[] = tempo.slice(0, index);
    let text = "";
    for (let j = index; j < tempo.length; j++) {
      const at = ticksToPositionText(compileTempoMap(markers, segment.gridOffset), j === index ? t : grid.startTick[j]);
      if (at === null) return null;
      if (j === index) text = at;
      markers.push({ ...tempo[j], at });
    }
    const next = compileTempoMap(markers, segment.gridOffset);
    if (next.count !== tempo.length || next.startTick[index] !== t) return null; // a later metre change lost its bar line
    for (let j = index + 1; j < next.count; j++) if (next.startTick[j] !== grid.startTick[j]) return null;
    return {
      text,
      segment: {
        ...segment,
        tempo: markers,
        cues: segment.cues.map((c) => ({ ...c, at: rewrite(next, c.at) })),
        regions: segment.regions.map((r) => ({ ...r, from: rewrite(next, r.from), to: rewrite(next, r.to) })),
      },
    };
  };

  return {
    move(x, modifiers) {
      const mode = modifiers.alt ? "off" : context.snap;
      let t = snapTicks(prev, secondsToTicks(prev, pointerSeconds(grid, view, startTicks, startX, x)), metreChange || mode === "bar" ? "bar" : "beat");
      if (metreChange) {
        const o = prev.barOriginTick[last], bar = prev.ticksPerBar[last];
        t = o + Math.round((t - o) / bar) * bar;
      } else t = Math.round(t / MUSIC_TICKS_PER_BEAT) * MUSIC_TICKS_PER_BEAT;
      if (!(t > lo && t < hi)) return null;
      if (t === startTicks) return { segment, text: marker.at };
      return build(t);
    },
    cancel: () => segment,
  };
}

/** Start dragging `handle`; null when it is not draggable (unknown name or id, marker 0, a readonly case the view checks). */
export function beginDrag(handle: DragHandle, context: DragContext, startX: number): DragSession | null {
  switch (handle.kind) {
    case "cue": return cueSession(handle.name, context, startX);
    case "region": return regionSession(handle.id, handle.edge, context, startX);
    case "tempo": return tempoSession(handle.index, context, startX);
  }
}
