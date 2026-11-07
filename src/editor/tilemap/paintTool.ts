// Scene view tilemap painting (ADR 0103): while a Tilemap node is selected and the Tile Palette has
// a brush, left presses in the scene view paint instead of selecting. Draws the map's grid around
// the pointer and the brush's footprint as an overlay.
import { effect } from "@preact/signals";
import type { Engine, Tilemap } from "../../engine";
import { Quat } from "../../engine/core/math";
import { addEditorOverlay, pointOnPlane, removeEditorOverlay, viewportCanvas } from "../../engine/editor";
import type { EditorOverlay } from "../../engine/render/RenderSurface";
import type { Cell } from "../../engine/tilemap/brushes";
import { isEditable } from "../editable";
import { openScene, playState, selectedPath, selectedWorldNode, selection, tool } from "../state";
import { activeLayer, brushStamp, brushTerrain, brushTool, commitTilemap, fillAt, flipBrush, paintCells, pickBrushTool, pickFromMap, strokeCells, tilemapOf, type BrushTool } from "./brush";

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
  const hit = pointOnPlane(map.node.world, x, y, [n.x, n.y, n.z], [p.x, p.y, p.z]);
  if (!hit) return null;
  const c = map.worldToCell({ x: hit[0], y: hit[1], z: hit[2] });
  return [c.x, c.y];
}

interface PaintState {
  hover: Cell | null;
  /** The press: where it started and where the pointer is, while a stroke is going on. */
  stroke: { tool: BrushTool; start: Cell; last: Cell } | null;
}

/** Install scene view painting on the Editor World. Returns a function that removes it. */
export function installTilemapPainting(engine: Engine): () => void {
  const world = engine.world;
  const state: PaintState = { hover: null, stroke: null };
  addEditorOverlay(world, "tilemap-paint", () => paintOverlay(state));

  // Picking a transform tool, or selecting something that isn't a tilemap, ends painting.
  const stopTool = effect(() => {
    void tool.value;
    if (brushTool.peek()) pickBrushTool(null);
  });
  let lastKey = selection.peek();
  const stopSelection = effect(() => {
    const key = selection.value;
    if (key === lastKey) return;
    lastKey = key;
    if (brushTool.peek() && !paintTarget()) pickBrushTool(null);
    activeLayer.value = 0;
  });

  const onKey = (e: KeyboardEvent) => {
    if (isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!paintTarget()) return;
    const key = e.key.toLowerCase();
    const pick = (t: BrushTool) => {
      e.preventDefault();
      pickBrushTool(t);
    };
    if (key === "escape" && brushTool.peek()) return pick(null as never);
    if (e.shiftKey) {
      if (key === "e") pick("erase");
      return;
    }
    if (key === "b") pick("pencil");
    else if (key === "u") pick("rect");
    else if (key === "g") pick("fill");
    else if (key === "i") pick("pick");
    else if (brushTool.peek() && (key === "x" || key === "y" || key === "z")) {
      e.preventDefault();
      flipBrush(key === "x" ? "x" : key === "y" ? "y" : "rotate");
    }
  };
  window.addEventListener("keydown", onKey);

  const canvas = viewportCanvas(world);
  if (!canvas) {
    return () => {
      stopTool();
      stopSelection();
      window.removeEventListener("keydown", onKey);
      removeEditorOverlay(world, "tilemap-paint");
    };
  }
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onHover = (e: PointerEvent) => {
    if (state.stroke) return;
    const map = brushTool.peek() ? paintTarget() : null;
    if (!map) {
      state.hover = null;
      return;
    }
    const at = local(e);
    state.hover = cellAt(map, at.x, at.y);
  };
  const onLeave = () => {
    if (!state.stroke) state.hover = null;
  };

  // Capture phase, so a paint press doesn't also select or start the transform gizmo.
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const current = brushTool.peek();
    const map = current ? paintTarget() : null;
    const scene = openScene.peek();
    const path = selectedPath();
    if (!current || !map || !scene || !path) return;
    const at = local(e);
    const cell = cellAt(map, at.x, at.y);
    if (!cell) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const strokeTool: BrushTool = e.altKey ? "pick" : current;
    state.stroke = { tool: strokeTool, start: cell, last: cell };
    state.hover = cell;
    if (strokeTool === "fill") {
      fillAt(map, cell[0], cell[1]);
    } else if (strokeTool === "pencil" || strokeTool === "erase") {
      paintCells(map, strokeTool, [cell], cell);
    }

    const move = (m: PointerEvent) => {
      const s = state.stroke;
      if (!s) return;
      const p = local(m);
      const c = cellAt(map, p.x, p.y);
      if (!c || (c[0] === s.last[0] && c[1] === s.last[1])) return;
      if (s.tool === "pencil" || s.tool === "erase") paintCells(map, s.tool, strokeCells(s.tool, s.last, c).slice(1), s.start);
      s.last = c;
      state.hover = c;
    };
    const end = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", end);
      canvas.removeEventListener("pointercancel", end);
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
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  };

  canvas.addEventListener("pointerdown", onDown, { capture: true });
  canvas.addEventListener("pointermove", onHover);
  canvas.addEventListener("pointerleave", onLeave);
  return () => {
    stopTool();
    stopSelection();
    window.removeEventListener("keydown", onKey);
    canvas.removeEventListener("pointerdown", onDown, { capture: true });
    canvas.removeEventListener("pointermove", onHover);
    canvas.removeEventListener("pointerleave", onLeave);
    removeEditorOverlay(world, "tilemap-paint");
  };
}

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
