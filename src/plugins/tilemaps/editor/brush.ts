// Tilemap painting in the editor (ADR 0103, 0289): the brush the Tile Palette sets up, and the strokes
// it paints. The brush owns the stamp's layout under its flips, the stroke rules and the footprint.
// Strokes paint the Editor World's Tilemap at once (so painting shows while the pointer moves) and
// commit to the scene document as one write of `layers` when they end. On every grid shape (ADR 0437) the brush works
// in cell space: rectangles are cell-space rectangles (diamonds on an isometric map), flood fill follows the cells
// sharing a side (`TileGrid.sides`), and stamps keep their layout. Where a quarter turn isn't a symmetry of the grid
// (`TileGrid.quarterTurn`: hexagonal maps) the brush only flips tiles' images: Rotate is off and a multi-cell stamp's
// layout is neither mirrored nor turned. On staggered and hexagonal maps a stamp picked or copied from the map keeps its
// shape wherever it's placed (ADR 0444): it remembers its frame and the grid places its cells (`TileGrid.placeCell`,
// ADR 0448); the footprint is those cells. The brush asks the grid; it never branches on the grid's shape.
// The brush skips locked layers (ADR 0441). A stamp of several named layers (a selection copied across layers, a saved
// stamp, ADR 0442) pastes with the pencil into the map's layers of the same names. The brush remembers the tileset its
// tile ids are of, so a stamp copied from one Tilemap paints another with another tileset by tile uuid.
import { signal, type ReadonlySignal } from "@preact/signals";
import { type GameObject } from "../../../engine";
import { Tilemap } from "../runtime";
import { floodCells, lineCells, rectCells, type Cell, type Stamp } from "../runtime/brushes";
import { FLIP_X, FLIP_Y, tileIdOf } from "../runtime/format";
import { rotateClockwise } from "../runtime/tileFlips";
import { pickWeighted, type Tileset } from "../runtime/tileset";
import { cellRandom, newSeed, RANDOM_BRUSH_STREAM } from "../runtime/cellHash";
import { blockTargets, layerLocked } from "./selectionLogic";
import { orientedFrame, orientedStamp } from "./stampLayout";
import type { BlockFrame } from "../runtime/grids";
import { blockOfStamp, retargetBlock, stampOfBlock, type StampBlock } from "./stampLibrary";
import { editor, persisted, type OpenScene } from "../../../editor/sdk";

export type BrushTool = "pencil" | "rect" | "fill" | "erase" | "pick" | "select";

export const BRUSH_TOOLS: readonly { tool: BrushTool; label: string; key: string; title: string }[] = [
  { tool: "select", label: "Select", key: "S", title: "Select cells to copy, cut, move, flip or delete (S; Shift adds, Alt subtracts, Ctrl/⌘+A selects every used cell)" },
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
/**
 * Paint each cell with one of the stamp's tiles at random (by the tiles' weights) instead of the block. The pick is a
 * hash of the cell and the map's `variantSeed` (ADR 0400), as auto-tiling's variants are, so the same strokes paint the
 * same map; Re-roll gives the map a new seed.
 */
export const brushRandom = signal(false);
/** Paint this terrain with auto-tiling instead of the stamp (null: the stamp). */
export const brushTerrain = signal<string | null>(null);
/** Flip flags applied to what is painted. */
export const brushFlags = signal(0);
/** The layer painted, by index. */
export const activeLayer = signal(0);
/**
 * ADR 0442: the stamp's named layers when it has several (a selection copied across layers, a saved stamp): the
 * pencil pastes each into the map's layer of the same name. Null: `brushStamp` alone, into the active layer.
 */
export const brushLayers = signal<StampBlock | null>(null);
/**
 * ADR 0444: where the brush's stamp was laid out on a staggered or hexagonal map (picked or copied there, or saved so),
 * so it keeps its shape wherever it's painted. Null: its cells land cell for cell (a palette block).
 */
export const brushFrame = signal<BlockFrame | null>(null);
/** ADR 0442: the tileset the brush's tile ids are of (null: the painted map's). Another map's tileset gets the tiles by uuid. */
export const brushSource = signal<Tileset | null>(null);
/**
 * ADR 0442: the prefabs the prefab brush places (project paths), several for random mode. While any is chosen, the
 * pencil, rectangle and eraser place and remove prefab instances instead of tiles (`prefabBrush.ts`).
 */
export const brushPrefabs = signal<readonly string[]>([]);
/**
 * ADR 0441: while a Tilemap is being painted, its other layers draw at `DIM_FACTOR` of their opacity in the edit view.
 * Per user, saved with the editor's settings, never in the scene.
 */
export const dimInactiveLayers = persisted("myco.tilemaps.dimInactiveLayers", false);
/** How much of their opacity the inactive layers keep while dimmed. */
export const DIM_FACTOR = 0.35;

/** Pick a brush tool: the paint tool becomes the active viewport tool in that mode (null ends painting). */
export function pickBrushTool(t: BrushTool | null): void {
  if (t) editor.viewport.enter(PAINT_TOOL_ID, t);
  else editor.viewport.leave(PAINT_TOOL_ID);
}

/** Picks the pencil unless a painting tool (pencil, rectangle, fill) is already picked. */
function pickPaintingTool(): void {
  const t = brushTool.peek();
  if (!t || t === "erase" || t === "pick" || t === "select") pickBrushTool("pencil");
}

/**
 * Brush a stamp (a single tile is 1 × 1): the block as it is, or with `random` one of its tiles per
 * cell. `source` is the tileset its ids are of (absent: the painted map's). Picks the pencil unless a painting tool
 * (pencil, rectangle, fill) is already picked.
 */
export function chooseStamp(stamp: Stamp, random = false, source: Tileset | null = null): void {
  brushStamp.value = stamp;
  brushLayers.value = null;
  brushFrame.value = null;
  brushSource.value = source;
  brushTerrain.value = null;
  brushPrefabs.value = [];
  brushRandom.value = random;
  pickPaintingTool();
}

/**
 * Brush a block of named layers (ADR 0442) of `source`'s tiles: with one layer it paints the active layer, with several
 * the layers of the same names. The brush's flips start over. Picks the pencil unless a painting tool is picked.
 */
export function chooseBlock(block: StampBlock, source: Tileset | null): void {
  brushStamp.value = stampOfBlock(block);
  brushLayers.value = block.layers.length > 1 ? block : null;
  brushFrame.value = block.frame ?? null;
  brushSource.value = source;
  brushTerrain.value = null;
  brushPrefabs.value = [];
  brushRandom.value = false;
  brushFlags.value = 0;
  pickPaintingTool();
}

/** Brush a terrain with auto-tiling (null: back to the stamp). Picks the pencil unless another tool but Pick is picked. */
export function chooseTerrain(name: string | null): void {
  brushTerrain.value = name;
  if (name) brushPrefabs.value = [];
  const t = brushTool.peek();
  if (name && (!t || t === "pick" || t === "select")) pickBrushTool("pencil");
}

/** Brush prefabs (ADR 0442; empty: back to tiles), with several one at random per cell. Picks the pencil unless the pencil, rectangle or eraser is picked. */
export function choosePrefabs(paths: readonly string[]): void {
  brushPrefabs.value = paths;
  if (paths.length === 0) return;
  brushTerrain.value = null;
  const t = brushTool.peek();
  if (t !== "pencil" && t !== "rect" && t !== "erase") pickBrushTool("pencil");
}

/** Whether the brush can turn on `map`'s grid: where a quarter turn is a symmetry of it (not on hexagonal maps, ADR 0437). */
export function canRotateOn(map: Tilemap | null): boolean {
  return turnRefusal(map) === null;
}

/** Why what is painted or selected can't turn a quarter turn on `map`'s grid, for a tooltip or message; null when it can. */
export function turnRefusal(map: Tilemap | null): string | null {
  const grid = map?._grid();
  return !grid || grid.quarterTurn ? null : `A quarter turn isn't a symmetry of a ${grid.shape} grid`;
}

/** Flip or turn the brush. Turning does nothing where the grid can't turn (`canRotateOn`, ADR 0437). */
export function flipBrush(axis: "x" | "y" | "rotate", map: Tilemap | null = null): void {
  if (axis === "rotate" && !canRotateOn(map)) return;
  const f = brushFlags.peek();
  brushFlags.value = axis === "x" ? f ^ FLIP_X : axis === "y" ? f ^ FLIP_Y : rotateClockwise(f);
}

/**
 * A rectangle of cells, `x0..x1 × y0..y1` with the ends exclusive: what a stroke covers or the brush would paint. A
 * stamp with a frame (ADR 0444) also lists its `cells` (where the grid places them, keeping its shape on staggered and
 * hexagonal maps), which the rectangle bounds.
 */
export interface Footprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells?: Cell[];
}

/**
 * One stroke of a brush tool on a map, from the press to the release (ADR 0289). The brush owns the
 * stroke's rules: what each tool paints as the pointer moves, where a stamp lands, what the release
 * does and the footprint shown meanwhile. The caller (the scene view's paint tool) feeds it cells.
 */
export interface BrushStroke {
  readonly tool: BrushTool;
  /** The cell the stroke started on. */
  readonly start: Cell;
  /** The cell the pointer is on now. */
  readonly last: Cell;
  /** The pointer moved onto a cell: pencil and erase paint the cells between. False when it is the cell it was on. */
  moveTo(cell: Cell): boolean;
  /** Released: a rectangle paints, a pick takes the block into the brush. True when the map's cells may have changed (commit them). */
  finish(): boolean;
  /** The cells the stroke covers or would paint now: the dragged rectangle, or the brush at the pointer. */
  footprint(): Footprint;
}

/**
 * Start a stroke with `tool` on the cell pressed: pencil and erase paint it, fill floods from it.
 * The brush read is the Tile Palette's (stamp, flips, random, terrain) as it is now. A locked active layer (ADR 0441)
 * isn't painted, filled or picked from, and says so; a stamp of several layers still paints the unlocked layers it names.
 * The selection tool's strokes (`select`) only track the dragged rectangle: the paint tool acts on the selection.
 */
export function beginStroke(map: Tilemap, tool: BrushTool, cell: Cell): BrushStroke {
  const start: Cell = [cell[0], cell[1]];
  let last: Cell = start;
  const painter = tool === "pick" || tool === "select" ? null : brushPainter(map, tool);
  if (!painter && tool !== "select") tellIfLocked(map);
  const shape = footprintShape(tool, map);
  if (tool === "fill") painter?.fill(start);
  else if (tool === "pencil" || tool === "erase") painter?.paint(tool, [start], start);
  return {
    tool,
    start,
    get last() {
      return last;
    },
    moveTo(c) {
      if (c[0] === last[0] && c[1] === last[1]) return false;
      if (tool === "pencil" || tool === "erase") painter?.paint(tool, lineCells(last[0], last[1], c[0], c[1]).slice(1), start);
      last = [c[0], c[1]];
      return true;
    },
    finish() {
      if (tool === "pick") {
        pickFromMap(map, start, last);
        return false;
      }
      if (tool === "select") return false;
      if (tool === "rect") painter?.paint("rect", rectCells(start[0], start[1], last[0], last[1]), [Math.min(start[0], last[0]), Math.min(start[1], last[1])]);
      return painter !== null;
    },
    footprint() {
      if (tool === "rect" || tool === "pick" || tool === "select") {
        return { x0: Math.min(start[0], last[0]), y0: Math.min(start[1], last[1]), x1: Math.max(start[0], last[0]) + 1, y1: Math.max(start[1], last[1]) + 1 };
      }
      return footprintOf(shape, last, start, map);
    },
  };
}

/** Says in the status bar that the active layer is locked, when it is (ADR 0441). */
function tellIfLocked(map: Tilemap): void {
  const layer = paintLayer(map);
  if (layer >= 0 && layerLocked(map, layer)) editor.messages.info(`The layer “${map.toLayerData()[layer]?.name ?? layer}” is locked. Unlock it in the Tile Palette to paint it.`);
}

/**
 * The cells `tool` would paint pressed on `cell`: the brush's stamp as it is laid out (flipped and turned) for the
 * pencil, else the cell. `map` decides the layout's turns (none on hexagonal maps).
 */
export function footprintAt(tool: BrushTool, cell: Cell, map: Tilemap | null = null): Footprint {
  return footprintOf(footprintShape(tool, map), cell, cell, map);
}

/** The block `tool` paints at a cell with the brush as it is now: the pencil's stamp as laid out (with its frame), else one cell. */
function footprintShape(tool: BrushTool, map: Tilemap | null): { width: number; height: number; frame: BlockFrame | null } {
  if (tool !== "pencil" || brushTerrain.peek() || brushRandom.peek() || brushPrefabs.peek().length > 0) return { width: 1, height: 1, frame: null };
  const stamp = brushStamp.peek(), flags = brushFlags.peek(), layout = canRotateOn(map);
  const { width, height } = orientedStamp(stamp, flags, layout);
  return { width, height, frame: orientedFrame(brushFrame.peek(), stamp.width, stamp.height, flags, layout) };
}

/**
 * A block of `shape` at a cell, on the grid of such blocks from `origin` (where a pencil stroke's stamps land). A block
 * with a frame (ADR 0444) lists the cells `map`'s grid places it on.
 */
function footprintOf(shape: { width: number; height: number; frame: BlockFrame | null }, [x, y]: Cell, origin: Cell, map: Tilemap | null): Footprint {
  const [sx, sy] = stampCorner(x, y, origin, shape.width, shape.height);
  const grid = map?._grid();
  if (!grid || !shape.frame) return { x0: sx, y0: sy, x1: sx + shape.width, y1: sy + shape.height };
  const cells: Cell[] = [];
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let r = 0; r < shape.height; r++) {
    for (let c = 0; c < shape.width; c++) {
      const [px, py] = grid.placeCell(shape.frame, [sx, sy], c, r);
      cells.push([px, py]);
      box.x0 = Math.min(box.x0, px);
      box.y0 = Math.min(box.y0, py);
      box.x1 = Math.max(box.x1, px + 1);
      box.y1 = Math.max(box.y1, py + 1);
    }
  }
  return { ...box, cells };
}

/** The bottom-left of the stamp placement holding cell (x, y), on the grid of `width × height` stamps from `origin`. */
function stampCorner(x: number, y: number, origin: Cell, width: number, height: number): Cell {
  return [origin[0] + Math.floor((x - origin[0]) / width) * width, origin[1] + Math.floor((y - origin[1]) / height) * height];
}

/** The layer the brush paints on `map`: the active one, clamped to the map's layers (-1 when it has none). */
function paintLayer(map: Tilemap): number {
  return Math.min(activeLayer.peek(), map.layerCount - 1);
}

/**
 * The brush's block as tiles of `map`'s tileset (ADR 0442): as it is when the brush's tiles are that tileset's, else
 * matched by uuid, the tiles the map's tileset lacks left out with a message.
 */
function brushBlockFor(map: Tilemap): StampBlock {
  const block = brushLayers.peek() ?? blockOfStamp(brushStamp.peek(), "", brushFrame.peek());
  const from = brushSource.peek(), to = map.tilesetAsset;
  if (!from || !to || from === to || from.data === to.data) return block;
  const moved = retargetBlock(block, from, to);
  if (moved.missing > 0) editor.messages.info(`${moved.missing === 1 ? "1 tile isn't" : `${moved.missing} tiles aren't`} in this Tilemap's tileset; skipped.`);
  return moved.block;
}

/** Where a flood fill may spread: the map's tiles plus a margin, or 32 × 32 cells around the click when empty. */
function fillBounds(map: Tilemap, x: number, y: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = map.cellBounds();
  if (!b) return { minX: x - 16, minY: y - 16, maxX: x + 15, maxY: y + 15 };
  return { minX: Math.min(b.minX, x) - 1, minY: Math.min(b.minY, y) - 1, maxX: Math.max(b.maxX, x) + 1, maxY: Math.max(b.maxY, y) + 1 };
}

/**
 * Paints `map` with the brush as it is now for a stroke of `tool`: the active layer, or with the pencil and a stamp of
 * several layers the unlocked layers it names. Null when there's no layer to paint (none, or locked).
 */
function brushPainter(map: Tilemap, tool: BrushTool): { paint(tool: BrushTool, cells: readonly Cell[], origin: Cell): void; fill(at: Cell): void } | null {
  const active = paintLayer(map);
  const terrain = brushTerrain.peek(), random = brushRandom.peek();
  const flags = brushFlags.peek(), layout = canRotateOn(map);
  const block = brushBlockFor(map);
  const grid = map._grid();
  const frame = orientedFrame(block.frame, block.width, block.height, flags, layout);
  const layered = tool === "pencil" && !terrain && !random && block.layers.length > 1;
  const targets = layered
    ? blockTargets(map, block, active).map((t) => ({ layer: t.layer, stamp: orientedStamp({ width: block.width, height: block.height, values: t.values }, flags, layout) }))
    : active >= 0 && !layerLocked(map, active)
      ? [{ layer: active, stamp: orientedStamp(stampOfBlock(block), flags, layout) }]
      : [];
  if (targets.length === 0) return null;
  const layer = targets[0].layer, stamp = targets[0].stamp;
  const weight = (id: number) => map.tilesetAsset?.tile(id)?.weight ?? 1;
  const choices = stamp.values.filter((n) => n !== 0).map((value) => ({ value, weight: weight(tileIdOf(value)) }));
  const seed = map.variantSeed;
  /** The value painted at a cell: the stamp tiled from `origin`, or one of its tiles by weight, drawn from the cell and the map's seed. */
  const valueAt = (x: number, y: number, origin: Cell): number => {
    if (random) return pickWeighted(choices, () => cellRandom(seed, x, y, RANDOM_BRUSH_STREAM))?.value ?? 0;
    const { c, r } = grid.blockCellAt(frame, stampCorner(x, y, origin, stamp.width, stamp.height), x, y, stamp.width, stamp.height);
    return stamp.values[r * stamp.width + c] ?? 0;
  };
  /**
   * Paint `cells` (or erase them). `origin` anchors the stamp: pencil strokes place the whole stamp
   * on the stamp grid from there; other tools tile it over the cells.
   */
  const paint = (tool: BrushTool, cells: readonly Cell[], origin: Cell): void => {
    if (tool === "erase") {
      if (terrain) map.paintTerrain(cells, null, layer);
      else for (const [x, y] of cells) map.setCell(x, y, 0, layer);
      return;
    }
    if (terrain) {
      map.paintTerrain(cells, terrain, layer);
      return;
    }
    if (tool === "pencil" && !random && (layered || stamp.width > 1 || stamp.height > 1)) {
      const placed = new Set<string>();
      for (const [x, y] of cells) {
        const [sx, sy] = stampCorner(x, y, origin, stamp.width, stamp.height);
        const k = `${sx},${sy}`;
        if (placed.has(k)) continue;
        placed.add(k);
        for (const t of targets) {
          for (let r = 0; r < t.stamp.height; r++) {
            for (let c = 0; c < t.stamp.width; c++) {
              const v = t.stamp.values[r * t.stamp.width + c];
              if (!v) continue;
              const [px, py] = grid.placeCell(frame, [sx, sy], c, r);
              map.setCell(px, py, v, t.layer);
            }
          }
        }
      }
      return;
    }
    for (const [x, y] of cells) {
      const v = valueAt(x, y, origin);
      if (v || tool !== "fill") map.setCell(x, y, v, layer);
    }
  };
  return {
    paint,
    fill([x, y]) {
      paint("fill", floodCells(x, y, (cx, cy) => map.getCell(cx, cy, layer), fillBounds(map, x, y), 20_000, (cx, cy) => grid.sides(cx, cy)), [x, y]);
    },
  };
}

/** Pick the brush from the map: one cell, or the block between two cells (empty cells stay empty). A locked layer isn't picked from. */
function pickFromMap(map: Tilemap, a: Cell, b: Cell): void {
  const layer = paintLayer(map);
  if (layer < 0 || layerLocked(map, layer)) return;
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]) + 1, h = Math.abs(a[1] - b[1]) + 1;
  const values: number[] = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) values.push(map.getCell(x0 + c, y0 + r, layer));
  if (values.every((v) => v === 0)) return;
  brushStamp.value = { width: w, height: h, values };
  brushLayers.value = null;
  brushFrame.value = map._grid().frameAt(x0, y0);
  brushSource.value = map.tilesetAsset;
  brushTerrain.value = null;
  brushPrefabs.value = [];
  brushFlags.value = 0;
  pickBrushTool("pencil");
}

/** The Tilemap on a World node (the first). */
export function tilemapOf(node: GameObject | null): Tilemap | null {
  return node?.getBehavior(Tilemap) ?? null;
}

/**
 * Re-roll a map's variants (ADR 0400): a new `variantSeed`, and every terrain cell re-picked with it (each keeps its
 * shape; equally fitting variants are drawn again), as one undoable step. Cells painted with the random brush keep
 * their tiles: the map doesn't know which they were. Nothing changes when the scene can't be edited now.
 */
export function rerollVariants(scene: OpenScene, path: readonly string[], map: Tilemap): void {
  const seed = newSeed(map.variantSeed);
  editor.scene.edit(
    "Re-roll tile variants",
    () => {
      map.variantSeed = seed;
      map.retileTerrain();
      const place = { scene, path, type: "engine.Tilemap" };
      editor.scene.writeField(place, "variantSeed", seed);
      editor.scene.writeField(place, "layers", map.toLayerData());
    },
    scene,
  );
}

/**
 * Write the map's current cells to the document as one undoable step (the Editor World already
 * shows them). `path` is the node's document path; prefab instances get an override.
 */
export function commitTilemap(scene: OpenScene, path: readonly string[], map: Tilemap, label = "Paint tiles"): void {
  const value = map.toLayerData();
  editor.scene.edit(label, () => void editor.scene.writeField({ scene, path, type: "engine.Tilemap" }, "layers", value), scene);
}
