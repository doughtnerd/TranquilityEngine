// Scene view tilemap painting (ADR 0103), a viewport tool (ADR 0138): while a Tilemap node is selected
// and the Tile Palette has a brush, the tool is active in that brush's mode (ADR 0231) and left presses in
// the scene view paint instead of selecting. Each stroke is one undo step (Escape mid-stroke puts it back).
// Draws the map's grid around the pointer and the brush's footprint (the brush's, ADR 0289) as an overlay: on
// isometric, staggered and hexagonal maps (ADR 0421) the cells' own outlines, and the footprint as the outline of its cells.
import { effect } from "@preact/signals";
import type { Tilemap } from "../runtime";
import { Quat } from "../../../engine/core/math";
import { viewport } from "../../../engine/editor";
import type { EditorOverlay } from "../../../engine/editor";
import type { Cell } from "../runtime/brushes";
import { traceCellOutlines } from "../runtime/cellRegions";
import { PAINT_TOOL_ID, activeLayer, beginStroke, brushTerrain, brushTool, canRotateOn, commitTilemap, flipBrush, footprintAt, pickBrushTool, tilemapOf, type BrushStroke, type BrushTool, type Footprint } from "./brush";
import { type ViewportToolContribution, editor } from "../../../editor/sdk";

const GRID = 0x5a6270;
const BRUSH = 0x4fc3f7;
const ERASE = 0xef5350;
const PICK = 0xffd54f;
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
}

/** Keys that pick a brush tool while a tilemap is selected (plus Shift+E erase, X/Y/Z flip). */
const PAINT_TOOL_KEYS: Record<string, BrushTool> = { b: "pencil", u: "rect", g: "fill", i: "pick" };

/** The scene view tilemap paint tool. */
export const paintTool: ViewportToolContribution<BrushTool> = {
  id: PAINT_TOOL_ID,
  // Selecting something that isn't a tilemap ends painting (the host also ends it on a transform tool, collider
  // editing, Escape, play and another scene).
  endsOnSelection: () => !paintTarget(),
  install(view) {
    const state: PaintState = { hover: null, stroke: null };
    view.overlay(() => paintOverlay(state));
    view.setCursor("crosshair");

    // Another node selected paints its first layer.
    let lastKey = editor.scene.selection.peekActive();
    const stopSelection = effect(() => {
      const key = editor.scene.selection.active;
      if (key === lastKey) return;
      lastKey = key;
      activeLayer.value = 0;
    });

    view.onKey((e) => {
      if (!paintTarget()) return false;
      const key = e.key.toLowerCase();
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
        // Z (turn) is off on hexagonal maps (ADR 0421): the key isn't the paint tool's there.
        if (key === "z" && !canRotateOn(paintTarget())) return false;
        flipBrush(key === "x" ? "x" : key === "y" ? "y" : "rotate", paintTarget());
        return true;
      }
      return false;
    });

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
      const strokeTool: BrushTool = p.alt ? "pick" : current;
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

    return stopSelection;
  },
};

/** The grid around the pointer and the brush footprint (or the rectangle being dragged). */
function paintOverlay(state: PaintState): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const t = brushTool.peek();
  const map = t ? paintTarget() : null;
  const hover = state.hover;
  if (!t || !map || !hover || !map.node.transform) return overlay;
  const tr = map.node.transform;
  const s = state.stroke;
  const tool = s?.tool ?? t;
  const footprint = s ? s.footprint() : footprintAt(t, hover, map);
  const color = tool === "erase" ? ERASE : tool === "pick" ? PICK : BRUSH;
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
 * The overlay on a non-square grid (ADR 0421): each cell's outline around the pointer, and the footprint's cells
 * outlined as one shape.
 */
function gridOverlay(overlay: EditorOverlay, map: Tilemap, [hx, hy]: Cell, { x0, y0, x1, y1 }: Footprint, color: number): EditorOverlay {
  const tr = map.node.transform!;
  const w = ([x, y]: readonly [number, number]): [number, number, number] => {
    const p = tr.localToWorld.transformPoint({ x, y, z: 0 });
    return [p.x, p.y, p.z];
  };
  const segs: number[] = [];
  for (let y = hy - GRID_REACH; y <= hy + GRID_REACH; y++) {
    for (let x = hx - GRID_REACH; x <= hx + GRID_REACH; x++) {
      const pts = map.cellOutline(x, y).map((p) => w([p.x, p.y]));
      for (let i = 0; i < pts.length; i++) segs.push(...pts[i], ...pts[(i + 1) % pts.length]);
    }
  }
  overlay.segments = [{ positions: new Float32Array(segs), color: GRID }];
  const cells: Cell[] = [];
  const all = (x1 - x0) * (y1 - y0) <= TRACE_LIMIT;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (all || y === y0 || y === y1 - 1 || x === x0 || x === x1 - 1) cells.push([x, y]);
  const outline = (x: number, y: number) => map.cellOutline(x, y).map((p): [number, number] => [p.x, p.y]);
  for (const loop of traceCellOutlines(cells, outline)) if (all || area(loop) > 0) overlay.lines.push({ points: loop.map(w), closed: true, color });
  return overlay;
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
