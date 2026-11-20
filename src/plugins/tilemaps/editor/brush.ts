// Tilemap painting in the editor (ADR 0103): the brush the Tile Palette sets up, and the edits a
// stroke makes. Strokes paint the Editor World's Tilemap at once (so painting shows while the
// pointer moves) and commit to the scene document as one write of `layers` when they end.
import { signal, type ReadonlySignal } from "@preact/signals";
import { type GameObject } from "../../../engine";
import { Tilemap } from "../runtime";
import { floodCells, lineCells, rectCells, type Cell, type Stamp } from "../runtime/brushes";
import { FLIP_X, FLIP_Y } from "../runtime/format";
import { brushValueAt, withBrushFlips } from "./brushCells";
import { rotateClockwise } from "../runtime/tileFlips";
import { editor, type OpenScene } from "../../../editor/sdk";

export type BrushTool = "pencil" | "rect" | "fill" | "erase" | "pick";

export const BRUSH_TOOLS: readonly { tool: BrushTool; label: string; key: string; title: string }[] = [
  { tool: "pencil", label: "Pencil", key: "B", title: "Paint the brush cell by cell (B)" },
  { tool: "rect", label: "Rectangle", key: "U", title: "Drag a rectangle to fill with the brush (U)" },
  { tool: "fill", label: "Fill", key: "G", title: "Flood fill the clicked area with the brush (G)" },
  { tool: "erase", label: "Erase", key: "Shift+E", title: "Erase cells, or the terrain when one is picked (Shift+E)" },
  { tool: "pick", label: "Pick", key: "I", title: "Pick a tile from the map; drag to pick a stamp (I, or Alt-click)" },
];

/** The paint tool's id (ADR 0138): also its overlay id and its active-tool id. */
export const PAINT_TOOL_ID = "myco.tilemaps.paint";

/** The active brush tool, the paint tool's mode (ADR 0231); null when the scene view is selecting as usual. */
export const brushTool: ReadonlySignal<BrushTool | null> = editor.viewport.mode<BrushTool>(PAINT_TOOL_ID);
/** What the brush paints: a block of cell values (a single tile is 1 × 1). */
export const brushStamp = signal<Stamp>({ width: 1, height: 1, values: [1] });
/** Paint each cell with one of the stamp's tiles at random (by the tiles' weights) instead of the block. */
export const brushRandom = signal(false);
/** Paint this terrain with auto-tiling instead of the stamp (null: the stamp). */
export const brushTerrain = signal<string | null>(null);
/** Flip flags applied to what is painted. */
export const brushFlags = signal(0);
/** The layer painted, by index. */
export const activeLayer = signal(0);

/** Pick a brush tool: the paint tool becomes the active viewport tool in that mode (null ends painting). */
export function pickBrushTool(t: BrushTool | null): void {
  if (t) editor.viewport.enter(PAINT_TOOL_ID, t);
  else editor.viewport.leave(PAINT_TOOL_ID);
}

/** Brush a single tile. */
export function brushTile(id: number): void {
  brushStamp.value = { width: 1, height: 1, values: [id] };
  brushTerrain.value = null;
  if (!brushTool.peek() || brushTool.peek() === "erase" || brushTool.peek() === "pick") pickBrushTool("pencil");
}

export function flipBrush(axis: "x" | "y" | "rotate"): void {
  const f = brushFlags.peek();
  brushFlags.value = axis === "x" ? f ^ FLIP_X : axis === "y" ? f ^ FLIP_Y : rotateClockwise(f);
}

/** The cells a stroke from `a` to `b` covers. Pencil and erase follow the pointer; a rectangle spans the two corners. */
export function strokeCells(tool: BrushTool, a: Cell, b: Cell): Cell[] {
  return tool === "rect" ? rectCells(a[0], a[1], b[0], b[1]) : lineCells(a[0], a[1], b[0], b[1]);
}

/** Where a flood fill may spread: the map's tiles plus a margin, or 32 × 32 cells around the click when empty. */
function fillBounds(map: Tilemap, x: number, y: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = map.cellBounds();
  if (!b) return { minX: x - 16, minY: y - 16, maxX: x + 15, maxY: y + 15 };
  return { minX: Math.min(b.minX, x) - 1, minY: Math.min(b.minY, y) - 1, maxX: Math.max(b.maxX, x) + 1, maxY: Math.max(b.maxY, y) + 1 };
}

/**
 * Paint `cells` on the map's active layer with the current brush (terrain, random or stamp), or
 * erase them. `origin` anchors the stamp (its bottom-left lands there). Pencil strokes paint the
 * whole stamp at each cell; other tools tile it over the cells.
 */
export function paintCells(map: Tilemap, tool: BrushTool, cells: readonly Cell[], origin: Cell): void {
  const layer = Math.min(activeLayer.peek(), map.layerCount - 1);
  if (layer < 0) return;
  const terrain = brushTerrain.peek();
  if (tool === "erase") {
    if (terrain) map.paintTerrain(cells, null, layer);
    else for (const [x, y] of cells) map.setCell(x, y, 0, layer);
    return;
  }
  if (terrain) {
    map.paintTerrain(cells, terrain, layer);
    return;
  }
  const stamp = brushStamp.peek(), random = brushRandom.peek(), flags = brushFlags.peek();
  const weight = (id: number) => map.tilesetAsset?.tile(id)?.weight ?? 1;
  if (tool === "pencil" && !random && (stamp.width > 1 || stamp.height > 1)) {
    // Each pencil cell places the whole stamp, aligned to the stamp grid from the stroke's start.
    const placed = new Set<string>();
    for (const [x, y] of cells) {
      const sx = origin[0] + Math.floor((x - origin[0]) / stamp.width) * stamp.width;
      const sy = origin[1] + Math.floor((y - origin[1]) / stamp.height) * stamp.height;
      const k = `${sx},${sy}`;
      if (placed.has(k)) continue;
      placed.add(k);
      for (let r = 0; r < stamp.height; r++) {
        for (let c = 0; c < stamp.width; c++) {
          const v = stamp.values[r * stamp.width + c];
          if (v) map.setCell(sx + c, sy + r, withBrushFlips(v, flags), layer);
        }
      }
    }
    return;
  }
  for (const [x, y] of cells) {
    const v = brushValueAt(stamp, x, y, origin, random, flags, weight);
    if (v || tool !== "fill") map.setCell(x, y, v, layer);
  }
}

/** Flood fill from a cell with the brush. */
export function fillAt(map: Tilemap, x: number, y: number): void {
  const layer = Math.min(activeLayer.peek(), map.layerCount - 1);
  if (layer < 0) return;
  const cells = floodCells(x, y, (cx, cy) => map.getCell(cx, cy, layer), fillBounds(map, x, y), 20_000);
  paintCells(map, "fill", cells, [x, y]);
}

/** Pick the brush from the map: one cell, or the block between two cells (empty cells stay empty). */
export function pickFromMap(map: Tilemap, a: Cell, b: Cell = a): void {
  const layer = Math.min(activeLayer.peek(), map.layerCount - 1);
  if (layer < 0) return;
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]) + 1, h = Math.abs(a[1] - b[1]) + 1;
  const values: number[] = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) values.push(map.getCell(x0 + c, y0 + r, layer));
  if (values.every((v) => v === 0)) return;
  brushStamp.value = { width: w, height: h, values };
  brushTerrain.value = null;
  brushFlags.value = 0;
  pickBrushTool("pencil");
}

/** The Tilemap on a World node (the first). */
export function tilemapOf(node: GameObject | null): Tilemap | null {
  return node?.getBehavior(Tilemap) ?? null;
}

/**
 * Write the map's current cells to the document as one undoable step (the Editor World already
 * shows them). `path` is the node's document path; prefab instances get an override.
 */
export function commitTilemap(scene: OpenScene, path: readonly string[], map: Tilemap, label = "Paint tiles"): void {
  const value = map.toLayerData();
  editor.scene.edit(label, () => void editor.scene.writeField({ scene, path, type: "engine.Tilemap" }, "layers", value), scene);
}
