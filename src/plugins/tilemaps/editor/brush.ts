// Tilemap painting in the editor (ADR 0103, 0289): the brush the Tile Palette sets up, and the strokes
// it paints. The brush owns the stamp's layout under its flips, the stroke rules and the footprint.
// Strokes paint the Editor World's Tilemap at once (so painting shows while the pointer moves) and
// commit to the scene document as one write of `layers` when they end. On every grid shape (ADR 0421) the brush works
// in cell space: rectangles are cell-space rectangles (diamonds on an isometric map), flood fill follows the cells
// sharing a side, and stamps keep their layout. On hexagonal maps a quarter turn isn't a symmetry, so the brush only
// flips tiles' images there: Rotate is off and a multi-cell stamp's layout is neither mirrored nor turned.
import { signal, type ReadonlySignal } from "@preact/signals";
import { type GameObject } from "../../../engine";
import { Tilemap } from "../runtime";
import { floodCells, lineCells, rectCells, type Cell, type Stamp } from "../runtime/brushes";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y, cellValue, flagsOf, tileIdOf } from "../runtime/format";
import { compose, flipPoint, rotateClockwise } from "../runtime/tileFlips";
import { pickWeighted } from "../runtime/tileset";
import { cellRandom, newSeed, RANDOM_BRUSH_STREAM } from "../runtime/cellHash";
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

/** Pick a brush tool: the paint tool becomes the active viewport tool in that mode (null ends painting). */
export function pickBrushTool(t: BrushTool | null): void {
  if (t) editor.viewport.enter(PAINT_TOOL_ID, t);
  else editor.viewport.leave(PAINT_TOOL_ID);
}

/**
 * Brush a stamp (a single tile is 1 × 1): the block as it is, or with `random` one of its tiles per
 * cell. Picks the pencil unless a painting tool (pencil, rectangle, fill) is already picked.
 */
export function chooseStamp(stamp: Stamp, random = false): void {
  brushStamp.value = stamp;
  brushTerrain.value = null;
  brushRandom.value = random;
  const t = brushTool.peek();
  if (!t || t === "erase" || t === "pick") pickBrushTool("pencil");
}

/** Brush a terrain with auto-tiling (null: back to the stamp). Picks the pencil unless another tool but Pick is picked. */
export function chooseTerrain(name: string | null): void {
  brushTerrain.value = name;
  const t = brushTool.peek();
  if (name && (!t || t === "pick")) pickBrushTool("pencil");
}

/** Whether the brush can turn on `map`'s grid: not on hexagonal maps (ADR 0421). */
export function canRotateOn(map: Tilemap | null): boolean {
  return map?.gridShape !== "hexagonal";
}

/** Flip or turn the brush. Turning does nothing when `map` is hexagonal (ADR 0421). */
export function flipBrush(axis: "x" | "y" | "rotate", map: Tilemap | null = null): void {
  if (axis === "rotate" && !canRotateOn(map)) return;
  const f = brushFlags.peek();
  brushFlags.value = axis === "x" ? f ^ FLIP_X : axis === "y" ? f ^ FLIP_Y : rotateClockwise(f);
}

/** A rectangle of cells, `x0..x1 × y0..y1` with the ends exclusive: what a stroke covers or the brush would paint. */
export interface Footprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
 * The brush read is the Tile Palette's (stamp, flips, random, terrain) as it is now.
 */
export function beginStroke(map: Tilemap, tool: BrushTool, cell: Cell): BrushStroke {
  const start: Cell = [cell[0], cell[1]];
  let last: Cell = start;
  const painter = brushPainter(map);
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
      if (tool === "rect") painter?.paint("rect", rectCells(start[0], start[1], last[0], last[1]), [Math.min(start[0], last[0]), Math.min(start[1], last[1])]);
      return true;
    },
    footprint() {
      if (tool === "rect" || tool === "pick") {
        return { x0: Math.min(start[0], last[0]), y0: Math.min(start[1], last[1]), x1: Math.max(start[0], last[0]) + 1, y1: Math.max(start[1], last[1]) + 1 };
      }
      return footprintOf(shape, last, start);
    },
  };
}

/**
 * The cells `tool` would paint pressed on `cell`: the brush's stamp as it is laid out (flipped and turned) for the
 * pencil, else the cell. `map` decides the layout's turns (none on hexagonal maps).
 */
export function footprintAt(tool: BrushTool, cell: Cell, map: Tilemap | null = null): Footprint {
  return footprintOf(footprintShape(tool, map), cell, cell);
}

/** The block `tool` paints at a cell with the brush as it is now: the pencil's stamp as laid out, else one cell. */
function footprintShape(tool: BrushTool, map: Tilemap | null): { width: number; height: number } {
  if (tool !== "pencil" || brushTerrain.peek() || brushRandom.peek()) return { width: 1, height: 1 };
  const { width, height } = orientedStamp(brushStamp.peek(), brushFlags.peek(), canRotateOn(map));
  return { width, height };
}

/** A block of `shape` at a cell, on the grid of such blocks from `origin` (where a pencil stroke's stamps land). */
function footprintOf(shape: { width: number; height: number }, [x, y]: Cell, origin: Cell): Footprint {
  const [sx, sy] = stampCorner(x, y, origin, shape.width, shape.height);
  return { x0: sx, y0: sy, x1: sx + shape.width, y1: sy + shape.height };
}

/** The bottom-left of the stamp placement holding cell (x, y), on the grid of `width × height` stamps from `origin`. */
function stampCorner(x: number, y: number, origin: Cell, width: number, height: number): Cell {
  return [origin[0] + Math.floor((x - origin[0]) / width) * width, origin[1] + Math.floor((y - origin[1]) / height) * height];
}

/**
 * The stamp as painted with the brush's flips `flags`: the block's layout transformed as one tile is
 * (mirrored, and turned with width and height swapped), each tile's own flips composed with `flags`.
 * Cells map through `flipPoint`, so the block and its tiles follow tileFlips.ts's one convention.
 * Without `layout` (hexagonal maps, ADR 0421) only the tiles' images flip: the layout stays and turns are dropped.
 */
function orientedStamp(stamp: Stamp, flags: number, layout = true): Stamp {
  if (!layout) flags &= FLIP_X | FLIP_Y;
  if (!flags) return stamp;
  if (!layout) return { width: stamp.width, height: stamp.height, values: stamp.values.map((v) => withFlips(v, flags)) };
  const turned = (flags & FLIP_DIAGONAL) !== 0;
  const width = turned ? stamp.height : stamp.width, height = turned ? stamp.width : stamp.height;
  const values = new Array<number>(width * height).fill(0);
  for (let r = 0; r < stamp.height; r++) {
    for (let c = 0; c < stamp.width; c++) {
      const [u, v] = flipPoint((c + 0.5) / stamp.width, (r + 0.5) / stamp.height, flags);
      values[Math.floor(v * height) * width + Math.floor(u * width)] = withFlips(stamp.values[r * stamp.width + c] ?? 0, flags);
    }
  }
  return { width, height, values };
}

/** A stamp value with `flags` applied after the tile's own; 0 (empty) stays 0. */
function withFlips(v: number, flags: number): number {
  return v ? cellValue(tileIdOf(v), compose(flagsOf(v), flags)) : 0;
}

/** The layer the brush paints on `map`: the active one, clamped to the map's layers (-1 when it has none). */
function paintLayer(map: Tilemap): number {
  return Math.min(activeLayer.peek(), map.layerCount - 1);
}

/** Where a flood fill may spread: the map's tiles plus a margin, or 32 × 32 cells around the click when empty. */
function fillBounds(map: Tilemap, x: number, y: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = map.cellBounds();
  if (!b) return { minX: x - 16, minY: y - 16, maxX: x + 15, maxY: y + 15 };
  return { minX: Math.min(b.minX, x) - 1, minY: Math.min(b.minY, y) - 1, maxX: Math.max(b.maxX, x) + 1, maxY: Math.max(b.maxY, y) + 1 };
}

/**
 * The cells sharing a side with a cell, for flood fill on a non-square grid (ADR 0421): every neighbour of a hexagon,
 * the N E S W neighbours of a diamond. Undefined on square grids (the fill's own 4 neighbours).
 */
function sideNeighbours(map: Tilemap): ((x: number, y: number) => readonly (readonly [number, number])[]) | undefined {
  const grid = map._grid();
  if (grid.shape === "square") return undefined;
  if (grid.neighbourCount === 6) return (x, y) => grid.neighbours(x, y);
  return (x, y) => grid.neighbours(x, y).filter((_, i) => i % 2 === 0);
}

/** Paints `map`'s active layer with the brush as it is now (null when the map has no layer). */
function brushPainter(map: Tilemap): { paint(tool: BrushTool, cells: readonly Cell[], origin: Cell): void; fill(at: Cell): void } | null {
  const layer = paintLayer(map);
  if (layer < 0) return null;
  const terrain = brushTerrain.peek(), random = brushRandom.peek();
  const stamp = orientedStamp(brushStamp.peek(), brushFlags.peek(), canRotateOn(map));
  const weight = (id: number) => map.tilesetAsset?.tile(id)?.weight ?? 1;
  const choices = stamp.values.filter((n) => n !== 0).map((value) => ({ value, weight: weight(tileIdOf(value)) }));
  const seed = map.variantSeed;
  /** The value painted at a cell: the stamp tiled from `origin`, or one of its tiles by weight, drawn from the cell and the map's seed. */
  const valueAt = (x: number, y: number, origin: Cell): number => {
    if (random) return pickWeighted(choices, () => cellRandom(seed, x, y, RANDOM_BRUSH_STREAM))?.value ?? 0;
    const c = (((x - origin[0]) % stamp.width) + stamp.width) % stamp.width;
    const r = (((y - origin[1]) % stamp.height) + stamp.height) % stamp.height;
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
    if (tool === "pencil" && !random && (stamp.width > 1 || stamp.height > 1)) {
      const placed = new Set<string>();
      for (const [x, y] of cells) {
        const [sx, sy] = stampCorner(x, y, origin, stamp.width, stamp.height);
        const k = `${sx},${sy}`;
        if (placed.has(k)) continue;
        placed.add(k);
        for (let r = 0; r < stamp.height; r++) {
          for (let c = 0; c < stamp.width; c++) {
            const v = stamp.values[r * stamp.width + c];
            if (v) map.setCell(sx + c, sy + r, v, layer);
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
      paint("fill", floodCells(x, y, (cx, cy) => map.getCell(cx, cy, layer), fillBounds(map, x, y), 20_000, sideNeighbours(map)), [x, y]);
    },
  };
}

/** Pick the brush from the map: one cell, or the block between two cells (empty cells stay empty). */
function pickFromMap(map: Tilemap, a: Cell, b: Cell): void {
  const layer = paintLayer(map);
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
