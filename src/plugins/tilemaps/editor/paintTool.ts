// Scene view tilemap painting (ADR 0103), a viewport tool (ADR 0137): while a Tilemap node is selected
// and the Tile Palette has a brush, the tool is active and left presses in the scene view paint
// instead of selecting. Draws the map's grid around the pointer and the brush's footprint as an overlay.
import { effect } from "@preact/signals";
import type { Tilemap } from "../runtime";
import { Quat } from "../../../engine/core/math";
import { viewport } from "../../../engine/editor";
import type { EditorOverlay } from "../../../engine/editor";
import type { Cell } from "../runtime/brushes";
import type { ViewportToolContribution } from "../../../editor/sdk";
import { activeViewportTool, openScene, playState, selectedPath, selectedWorldNode, selection } from "../../../editor/state";
import { activeLayer, brushStamp, brushTerrain, brushTool, commitTilemap, fillAt, flipBrush, paintCells, pickBrushTool, pickFromMap, strokeCells, tilemapOf, type BrushTool } from "./brush";

/** The paint tool's id: also its overlay id and its active-tool id. */
export const PAINT_TOOL_ID = "myco.tilemaps.paint";

const GRID = 0x5a6270;
const BRUSH = 0x4fc3f7;
const ERASE = 0xef5350;
const PICK = 0xffd54f;
/** Grid cells drawn on each side of the pointer. */
const GRID_REACH = 12;

/** The selected node's Tilemap while painting is possible. */
export function paintTarget(): Tilemap | null {
  if (playState.value !== "edit") return null;
  return tilemapOf(selectedWorldNode());
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
  /** The press: where it started and where the pointer is, while a stroke is going on. */
  stroke: { tool: BrushTool; start: Cell; last: Cell } | null;
}

/** Keys that pick a brush tool while a tilemap is selected (plus Shift+E erase, X/Y/Z flip). */
export const PAINT_TOOL_KEYS: Record<string, BrushTool> = { b: "pencil", u: "rect", g: "fill", i: "pick" };

/** The scene view tilemap paint tool. */
export const paintTool: ViewportToolContribution = {
  id: PAINT_TOOL_ID,
  install(view) {
    const state: PaintState = { hover: null, stroke: null };
    view.overlay(() => paintOverlay(state));
    view.setCursor("crosshair");

    // A brush makes the tool active; anything else becoming active (a transform tool, collider
    // editing, Escape, play) drops the brush.
    const stopBrush = effect(() => {
      const t = brushTool.value;
      if (t && activeViewportTool.peek() !== PAINT_TOOL_ID) view.activate();
      else if (!t) view.deactivate();
    });
    const stopActive = effect(() => {
      if (activeViewportTool.value !== PAINT_TOOL_ID && brushTool.peek()) pickBrushTool(null);
    });
    // Selecting something that isn't a tilemap ends painting.
    let lastKey = selection.peek();
    const stopSelection = effect(() => {
      const key = selection.value;
      if (key === lastKey) return;
      lastKey = key;
      if (brushTool.peek() && !paintTarget()) pickBrushTool(null);
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
        flipBrush(key === "x" ? "x" : key === "y" ? "y" : "rotate");
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
      const scene = openScene.peek();
      const path = selectedPath();
      if (!current || !map || !scene || !path) return null;
      const cell = cellAt(map, p.x, p.y);
      if (!cell) return null;
      const strokeTool: BrushTool = p.alt ? "pick" : current;
      state.stroke = { tool: strokeTool, start: cell, last: cell };
      state.hover = cell;
      if (strokeTool === "fill") fillAt(map, cell[0], cell[1]);
      else if (strokeTool === "pencil" || strokeTool === "erase") paintCells(map, strokeTool, [cell], cell);

      // Released or cancelled, the stroke commits what it painted as one undo step.
      const finish = () => {
        const s = state.stroke;
        state.stroke = null;
        if (!s) return;
        if (s.tool === "pick") {
          pickFromMap(map, s.start, s.last);
          return;
        }
        if (s.tool === "rect") paintCells(map, "rect", strokeCells("rect", s.start, s.last), [Math.min(s.start[0], s.last[0]), Math.min(s.start[1], s.last[1])]);
        const label = s.tool === "erase" ? "Erase tiles" : s.tool === "fill" ? "Fill tiles" : brushTerrain.peek() ? "Paint terrain" : "Paint tiles";
        commitTilemap(scene, path, map, label);
      };
      return {
        move(m) {
          const s = state.stroke;
          if (!s) return;
          const c = cellAt(map, m.x, m.y);
          if (!c || (c[0] === s.last[0] && c[1] === s.last[1])) return;
          if (s.tool === "pencil" || s.tool === "erase") paintCells(map, s.tool, strokeCells(s.tool, s.last, c).slice(1), s.start);
          s.last = c;
          state.hover = c;
        },
        end: finish,
        cancel: finish,
      };
    });

    return () => {
      stopBrush();
      stopActive();
      stopSelection();
    };
  },
};

/** The grid around the pointer and the brush footprint (or the rectangle being dragged). */
function paintOverlay(state: PaintState): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const t = brushTool.peek();
  const map = t ? paintTarget() : null;
  const hover = state.hover;
  if (!map || !hover || !map.node.transform) return overlay;
  const tr = map.node.transform;
  const cs = map.cellSize;
  const w = (cx: number, cy: number): [number, number, number] => {
    const p = tr.localToWorld({ x: cx * cs.x, y: cy * cs.y, z: 0 });
    return [p.x, p.y, p.z];
  };
  const [hx, hy] = hover;
  const segs: number[] = [];
  for (let i = -GRID_REACH; i <= GRID_REACH + 1; i++) {
    segs.push(...w(hx + i, hy - GRID_REACH), ...w(hx + i, hy + GRID_REACH + 1));
    segs.push(...w(hx - GRID_REACH, hy + i), ...w(hx + GRID_REACH + 1, hy + i));
  }
  overlay.segments = [{ positions: new Float32Array(segs), color: GRID }];
  const s = state.stroke;
  const tool = s?.tool ?? t;
  let x0 = hx, y0 = hy, x1 = hx + 1, y1 = hy + 1;
  if (s && (s.tool === "rect" || s.tool === "pick")) {
    x0 = Math.min(s.start[0], s.last[0]);
    y0 = Math.min(s.start[1], s.last[1]);
    x1 = Math.max(s.start[0], s.last[0]) + 1;
    y1 = Math.max(s.start[1], s.last[1]) + 1;
  } else if (tool === "pencil" && !brushTerrain.peek()) {
    const st = brushStamp.peek();
    x1 = hx + st.width;
    y1 = hy + st.height;
  }
  const color = tool === "erase" ? ERASE : tool === "pick" ? PICK : BRUSH;
  overlay.lines.push({ points: [w(x0, y0), w(x1, y0), w(x1, y1), w(x0, y1)], closed: true, color });
  return overlay;
}
