// Scene view tilemap painting (ADR 0103), a viewport tool (ADR 0138): while a Tilemap node is selected
// and the Tile Palette has a brush, the tool is active in that brush's mode (ADR 0231) and left presses in
// the scene view paint instead of selecting. Each stroke is one undo step (Escape mid-stroke puts it back).
// Draws the map's grid around the pointer and the brush's footprint (the brush's, ADR 0289) as an overlay: on
// isometric, staggered and hexagonal maps (ADR 0437) the cells' own outlines, and the footprint as the outline of its cells.
// ADR 0442: the selection tool (S) drags cell rectangles (Shift adds, Alt subtracts), moves the selection by dragging
// inside it (Alt-drag copies), and acts on it with Ctrl/⌘+C, Ctrl/⌘+X, Delete, X, Y and Z (Ctrl/⌘+A selects every used
// cell, Escape selects nothing); the selection is outlined cell by cell. With prefabs chosen, the pencil, rectangle and
// eraser place and remove prefab instances (`prefabBrush.ts`). ADR 0441: while painting with Dim inactive layers on,
// the map's other layers draw at 35 % in the edit view.
import { effect } from "@preact/signals";
import type { Tilemap } from "../runtime";
import { Quat } from "../../../engine/core/math";
import { viewport } from "../../../engine/editor";
import type { EditorOverlay } from "../../../engine/editor";
import type { Cell } from "../runtime/brushes";
import { traceCellOutlines } from "../runtime/cellRegions";
import {
  DIM_FACTOR,
  PAINT_TOOL_ID,
  activeLayer,
  beginStroke,
  brushTerrain,
  brushTool,
  canRotateOn,
  commitTilemap,
  dimInactiveLayers,
  flipBrush,
  footprintAt,
  pickBrushTool,
  tilemapOf,
  type BrushStroke,
  type BrushTool,
  type Footprint,
} from "./brush";
import { beginPrefabStroke, commitPrefabStroke, paintsPrefabs, type PrefabStroke } from "./prefabBrush";
import { cellKey, keyCell, movedSelection, type CellSelection } from "./selectionLogic";
import { clearTileSelection, copyTiles, cutTiles, deleteTiles, moveTiles, selectAllUsed, selectCells, selectionOf, tileSelection, transformTiles } from "./tileSelection";
import { type ViewportToolContribution, editor } from "../../../editor/sdk";

const GRID = 0x5a6270;
const BRUSH = 0x4fc3f7;
const ERASE = 0xef5350;
const PICK = 0xffd54f;
const SELECTION = 0xffb74d;
/** Grid cells drawn on each side of the pointer. */
const GRID_REACH = 12;

/** The selected node's Tilemap while painting is possible (the scene can be edited now: not while playing). */
function paintTarget(): Tilemap | null {
  if (editor.scene.whyNotEdit() !== null) return null;
  return tilemapOf(editor.scene.selection.node());
}

/** The cell under a canvas point on the map's plane. */
export function cellAt(map: Tilemap, x: number, y: number): Cell | null {
  const t = map.node.transform;
  if (!t) return null;
  const n = Quat.rotate(t.worldRotation, { x: 0, y: 0, z: 1 });
  const p = t.worldPosition;
  const hit = viewport(map.node.world).pointOnPlane(x, y, [n.x, n.y, n.z], [p.x, p.y, p.z]);
  if (!hit) return null;
  const c = map.worldToCell({ x: hit[0], y: hit[1], z: hit[2] });
  return [c.x, c.y];
}

interface PaintState {
  hover: Cell | null;
  /** The brush's stroke while the press goes on. */
  stroke: BrushStroke | null;
  /** A prefab brush stroke while the press goes on (ADR 0442). */
  prefabStroke: PrefabStroke | null;
  /** The selection being moved: where the drag started and the cell it's on now (ADR 0442). */
  moving: { from: Cell; to: Cell; copy: boolean } | null;
}

/** Keys that pick a brush tool while a tilemap is selected (plus Shift+E erase, X/Y/Z flip). */
const PAINT_TOOL_KEYS: Record<string, BrushTool> = { b: "pencil", u: "rect", g: "fill", i: "pick", s: "select" };

/** True when a key event comes from a text field or another place with its own keys. */
function ownKeys(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], .monaco-editor, .asset-browser, .dialog");
}

/** The Tilemap the dim view opacity was set on and how many layers it had then (ADR 0441). */
let dimmed: { map: Tilemap; layers: number } | null = null;

/** Dim the painted map's inactive layers in the edit view, or undim the map dimmed before. */
function applyDim(map: Tilemap | null, active: number): void {
  if (dimmed && dimmed.map !== map) {
    for (let i = 0; i < dimmed.layers; i++) dimmed.map._setViewOpacity(i, null);
    dimmed = null;
  }
  if (!map) return;
  const layers = map.layerCount;
  for (let i = 0; i < Math.max(layers, dimmed?.layers ?? 0); i++) map._setViewOpacity(i, i === active || i >= layers ? null : DIM_FACTOR);
  dimmed = { map, layers };
}

/** The scene view tilemap paint tool. */
export const paintTool: ViewportToolContribution<BrushTool> = {
  id: PAINT_TOOL_ID,
  // Selecting something that isn't a tilemap ends painting (the host also ends it on a transform tool, collider
  // editing, Escape, play and another scene).
  endsOnSelection: () => !paintTarget(),
  install(view) {
    const state: PaintState = { hover: null, stroke: null, prefabStroke: null, moving: null };
    view.overlay(() => paintOverlay(state));
    view.setCursor("crosshair");

    // Another node selected paints its first layer, and the tile selection (of the map before) goes.
    let lastKey = editor.scene.selection.peekActive();
    const stopSelection = effect(() => {
      const key = editor.scene.selection.active;
      if (key === lastKey) return;
      lastKey = key;
      activeLayer.value = 0;
      if (tileSelection.peek().map !== paintTarget()) clearTileSelection();
    });

    // ADR 0441: Dim inactive layers, while the paint tool is active on a map.
    const stopDim = effect(() => {
      const on = dimInactiveLayers.value && brushTool.value !== null;
      void editor.scene.selection.active;
      const active = activeLayer.value;
      applyDim(on ? paintTarget() : null, active);
    });

    view.onKey((e) => {
      const map = paintTarget();
      if (!map) return false;
      const key = e.key.toLowerCase();
      const selecting = brushTool.peek() === "select" && selectionOf(map).size > 0;
      if (brushTool.peek() && key === "escape" && selectionOf(map).size > 0) return clearTileSelection();
      if (selecting && (key === "delete" || key === "backspace")) return deleteTiles();
      if (e.shiftKey) {
        if (key !== "e") return false;
        pickBrushTool("erase");
        return true;
      }
      const t = PAINT_TOOL_KEYS[key];
      if (t) {
        pickBrushTool(t);
        return true;
      }
      if (brushTool.peek() && (key === "x" || key === "y" || key === "z")) {
        // Z (turn) is off on hexagonal maps (ADR 0437): the key isn't the paint tool's there.
        if (key === "z" && !canRotateOn(map)) return false;
        const axis = key === "x" ? "x" : key === "y" ? "y" : "rotate";
        if (selecting) transformTiles(axis);
        else flipBrush(axis, map);
        return true;
      }
      return false;
    });

    // Ctrl/⌘ + C, X and A reach no viewport tool's keys (they're the editor's node shortcuts), so the selection tool
    // takes them here first while it has a selection of the selected map (A: while it's the active tool).
    const onModifiedKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || ownKeys(e.target)) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "x" && key !== "a") return;
      const map = brushTool.peek() ? paintTarget() : null;
      if (!map) return;
      let done = false;
      if (key === "a" && brushTool.peek() === "select") {
        selectAllUsed(map);
        done = true;
      } else if (key !== "a" && selectionOf(map).size > 0) done = key === "c" ? copyTiles() : cutTiles();
      if (!done) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onModifiedKey, true);

    view.onHover((p) => {
      const map = p && brushTool.peek() ? paintTarget() : null;
      state.hover = map && p ? cellAt(map, p.x, p.y) : null;
    });

    view.onPress((p) => {
      if (p.button !== 0) return null;
      const current = brushTool.peek();
      const map = current ? paintTarget() : null;
      const scene = editor.scene.peekOpen();
      const path = editor.scene.selection.path();
      if (!current || !map || !scene || !path) return null;
      const cell = cellAt(map, p.x, p.y);
      if (!cell) return null;

      if (current === "select") {
        const selected = selectionOf(map);
        // Inside the selection (no Shift): move it, Alt copies. The move is the gesture's one undo step.
        if (!p.shift && selected.has(cellKey(cell[0], cell[1]))) {
          const copy = p.alt;
          const drag = view.gesture(copy ? "Copy tiles" : "Move tiles", {
            move(m) {
              const c = state.moving && cellAt(map, m.x, m.y);
              if (!c || !state.moving) return;
              state.moving.to = c;
              state.hover = c;
            },
            end() {
              const m = state.moving;
              state.moving = null;
              if (m) moveTiles(m.to[0] - m.from[0], m.to[1] - m.from[1], m.copy, m.from);
            },
            cancel: () => void (state.moving = null),
          });
          if (!drag) return null;
          state.moving = { from: cell, to: cell, copy };
          return drag;
        }
        // Elsewhere: a rectangle that replaces, adds to (Shift) or takes from (Alt) the selection. Not a document edit.
        const mode = p.shift ? "add" : p.alt ? "subtract" : "replace";
        state.stroke = beginStroke(map, "select", cell);
        state.hover = cell;
        return {
          move(m) {
            const c = state.stroke && cellAt(map, m.x, m.y);
            if (c && state.stroke?.moveTo(c)) state.hover = c;
          },
          end() {
            const s = state.stroke;
            state.stroke = null;
            if (s) selectCells(map, s.start, s.last, mode);
          },
          cancel: () => void (state.stroke = null),
        };
      }

      const strokeTool: BrushTool = p.alt ? "pick" : current;

      // ADR 0442: the prefab brush. Released, the stroke's node removes and adds are the gesture's one undo step.
      if (strokeTool !== "pick" && paintsPrefabs(strokeTool)) {
        const prefabTool = strokeTool as "pencil" | "rect" | "erase";
        const label = prefabTool === "erase" ? "Erase prefabs" : "Paint prefabs";
        const drag = view.gesture(label, {
          move(m) {
            const c = state.prefabStroke && cellAt(map, m.x, m.y);
            if (c && state.prefabStroke?.moveTo(c)) state.hover = c;
          },
          end() {
            const s = state.prefabStroke;
            state.prefabStroke = null;
            if (s) commitPrefabStroke(scene, path, map, s.tool === "erase" ? "erase" : "paint", s.cells(), label);
          },
          cancel: () => void (state.prefabStroke = null),
        });
        if (!drag) return null;
        state.prefabStroke = beginPrefabStroke(prefabTool, cell);
        state.hover = cell;
        return drag;
      }

      const label = strokeTool === "erase" ? "Erase tiles" : strokeTool === "fill" ? "Fill tiles" : strokeTool === "pick" ? "Pick tiles" : brushTerrain.peek() ? "Paint terrain" : "Paint tiles";
      // Released, the stroke commits what it painted, as the gesture's one undo step; Escape puts it back.
      const finish = () => {
        const s = state.stroke;
        state.stroke = null;
        if (s?.finish()) commitTilemap(scene, path, map, label);
      };
      const drag = view.gesture(label, {
        move(m) {
          const c = state.stroke && cellAt(map, m.x, m.y);
          if (c && state.stroke?.moveTo(c)) state.hover = c;
        },
        end: finish,
        // A cancelled stroke still commits what the World shows (the host reverts it on Escape); a pick is just dropped.
        cancel: (reason) => {
          if (reason === "escape" && state.stroke?.tool === "pick") state.stroke = null;
          else finish();
        },
      });
      if (!drag) return null;
      state.stroke = beginStroke(map, strokeTool, cell);
      state.hover = cell;
      return drag;
    });

    return () => {
      stopSelection();
      stopDim();
      applyDim(null, 0);
      window.removeEventListener("keydown", onModifiedKey, true);
    };
  },
};

/** World-space point of a local point on the map's plane. */
function toWorld(map: Tilemap, [x, y]: readonly [number, number]): [number, number, number] {
  const p = map.node.transform!.localToWorld.transformPoint({ x, y, z: 0 });
  return [p.x, p.y, p.z];
}

/** The grid around the pointer, the brush footprint (or the rectangle being dragged) and the tile selection. */
function paintOverlay(state: PaintState): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const t = brushTool.peek();
  const map = t ? paintTarget() : null;
  if (!t || !map || !map.node.transform) return overlay;
  const selected = selectionOf(map);
  if (selected.size > 0) {
    const m = state.moving;
    selectionOverlay(overlay, map, m ? movedSelection(map, selected, m.to[0] - m.from[0], m.to[1] - m.from[1], m.from) : selected);
  }
  const hover = state.hover;
  if (!hover) return overlay;
  const tr = map.node.transform;
  const s = state.stroke ?? state.prefabStroke;
  const tool = s?.tool ?? t;
  const footprint = state.stroke
    ? state.stroke.footprint()
    : state.prefabStroke?.tool === "rect"
      ? { x0: Math.min(state.prefabStroke.start[0], hover[0]), y0: Math.min(state.prefabStroke.start[1], hover[1]), x1: Math.max(state.prefabStroke.start[0], hover[0]) + 1, y1: Math.max(state.prefabStroke.start[1], hover[1]) + 1 }
      : footprintAt(t, hover, map);
  const color = tool === "erase" ? ERASE : tool === "pick" ? PICK : tool === "select" ? SELECTION : BRUSH;
  if (state.moving) return overlay;
  if (map.gridShape !== "square") return gridOverlay(overlay, map, hover, footprint, color);
  const cs = map.cellSize;
  const w = (cx: number, cy: number): [number, number, number] => {
    const p = tr.localToWorld.transformPoint({ x: cx * cs.x, y: cy * cs.y, z: 0 });
    return [p.x, p.y, p.z];
  };
  const [hx, hy] = hover;
  const segs: number[] = [];
  for (let i = -GRID_REACH; i <= GRID_REACH + 1; i++) {
    segs.push(...w(hx + i, hy - GRID_REACH), ...w(hx + i, hy + GRID_REACH + 1));
    segs.push(...w(hx - GRID_REACH, hy + i), ...w(hx + GRID_REACH + 1, hy + i));
  }
  overlay.segments = [{ positions: new Float32Array(segs), color: GRID }];
  const { x0, y0, x1, y1 } = footprint;
  overlay.lines.push({ points: [w(x0, y0), w(x1, y0), w(x1, y1), w(x0, y1)], closed: true, color });
  return overlay;
}

/** Footprints larger than this many cells are traced by their border cells only (the hole inside is dropped). */
const TRACE_LIMIT = 16_384;

/**
 * The selection's outline (ADR 0442), where it would land while it is being moved (ADR 0444: keeping its shape): its
 * cells' outlines traced as shapes on the map's grid (squares, diamonds, hexagons). A large selection is traced by its
 * edge cells only.
 */
function selectionOverlay(overlay: EditorOverlay, map: Tilemap, selected: CellSelection): void {
  let cells = [...selected].map(keyCell);
  const all = cells.length <= TRACE_LIMIT;
  if (!all) cells = cells.filter(([x, y]) => !(selected.has(cellKey(x + 1, y)) && selected.has(cellKey(x - 1, y)) && selected.has(cellKey(x, y + 1)) && selected.has(cellKey(x, y - 1))));
  const outline = (x: number, y: number) => map.cellOutline(x, y).map((p): [number, number] => [p.x, p.y]);
  for (const loop of traceCellOutlines(cells, outline)) if (all || area(loop) > 0) overlay.lines.push({ points: loop.map((p) => toWorld(map, p)), closed: true, color: SELECTION });
}

/**
 * The overlay on a non-square grid (ADR 0437): each cell's outline around the pointer, and the footprint's cells
 * outlined as one shape.
 */
function gridOverlay(overlay: EditorOverlay, map: Tilemap, [hx, hy]: Cell, footprint: Footprint, color: number): EditorOverlay {
  const { x0, y0, x1, y1 } = footprint;
  const w = (p: readonly [number, number]) => toWorld(map, p);
  const segs: number[] = [];
  for (let y = hy - GRID_REACH; y <= hy + GRID_REACH; y++) {
    for (let x = hx - GRID_REACH; x <= hx + GRID_REACH; x++) {
      const pts = map.cellOutline(x, y).map((p) => w([p.x, p.y]));
      for (let i = 0; i < pts.length; i++) segs.push(...pts[i], ...pts[(i + 1) % pts.length]);
    }
  }
  overlay.segments = [{ positions: new Float32Array(segs), color: GRID }];
  // A stamp that keeps its shape (ADR 0444) lists the cells it lands on; otherwise the footprint is its rectangle.
  const all = footprint.cells ? footprint.cells.length <= TRACE_LIMIT : (x1 - x0) * (y1 - y0) <= TRACE_LIMIT;
  let cells: Cell[] = [];
  if (footprint.cells) cells = all ? footprint.cells : edgeCells(footprint.cells);
  else for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (all || y === y0 || y === y1 - 1 || x === x0 || x === x1 - 1) cells.push([x, y]);
  const outline = (x: number, y: number) => map.cellOutline(x, y).map((p): [number, number] => [p.x, p.y]);
  for (const loop of traceCellOutlines(cells, outline)) if (all || area(loop) > 0) overlay.lines.push({ points: loop.map(w), closed: true, color });
  return overlay;
}

/** The cells of `cells` with a neighbour (in offset coordinates) outside them: what a large footprint is traced by. */
function edgeCells(cells: readonly Cell[]): Cell[] {
  const keys = new Set(cells.map(([x, y]) => cellKey(x, y)));
  return cells.filter(([x, y]) => !(keys.has(cellKey(x + 1, y)) && keys.has(cellKey(x - 1, y)) && keys.has(cellKey(x, y + 1)) && keys.has(cellKey(x, y - 1))));
}

/** Twice a loop's signed area (positive counter-clockwise: an outer outline, not a hole). */
function area(loop: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}
