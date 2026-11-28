/**
 * Tile collision shapes (ADR 0105). Pure: turns a layer's cells into a few merged shapes in cell
 * units (cell (x, y) covers x..x+1, y..y+1), which the Tilemap offers as a 2D collision shape
 * source (ADR 0136) for any 2D collider on its node to build.
 *
 * - Whole-cell solid tiles merge into the fewest rectangles a greedy scan finds ("rectangles"
 *   mode), or into closed outlines around each solid region ("outline" mode).
 * - Polygon tiles become convex parts (flipped and turned with their cell).
 * - One-way tiles merge into horizontal runs, one per row, kept apart so each can decide on its
 *   own whether a body passes.
 *
 * On other grids (ADR 0437, given a `TileGrid`) the shapes are in local units instead:
 * - Isometric and staggered: whole-cell and one-way tiles merge in diamond space as above, then go through the grid's
 *   affine map (a rectangle becomes a parallelogram in `polygons` or `oneWayPolygons`, an outline stays an outline).
 * - Hexagonal: one hexagon per solid cell ("rectangles") or the traced union of their outlines ("outline"); one-way
 *   cells are one-way hexagons.
 * - Polygon tiles are in their cell box's units on every grid, so a polygon drawn over the sprite fits it.
 *
 * The Tilemap merges per chunk and caches the results (`tileShapeCache.ts`, ADR 0439); the parts both share are here:
 * sorting a chunk's tiles by how they collide (`sortTiles`) and the space whole cells merge in (`mergeSpace`).
 */
import { convexParts } from "../../../engine/physics/polygon";
import type { CollisionShapes2D, ShapeMerge2D, ShapeRect2D } from "../../../engine/physics/shapeSource2D";
import { greedyRectangles, polygonCorners, rowRuns, traceCellOutlines, traceOutlines } from "./cellRegions";
import { flagsOf, tileIdOf } from "./format";
import type { GridPoint, TileGrid } from "./grids";
import { flipPoint } from "./tileFlips";
import { tilePolygons, type TileCollision } from "./tileset";

/** How whole-cell tiles merge (ADR 0105): the core 2D shape source's merge modes (ADR 0136). */
export type TileCollisionMode = ShapeMerge2D;

export type Rect = ShapeRect2D;

/** Tile collision shapes in cell units (local units on non-square grids): the core shape set without its unit (the Tilemap adds it). */
export type TileShapes = Omit<CollisionShapes2D, "unit">;

/** A cell with a tile: its coordinates and value (tile id plus flip flags). */
export interface TileCell {
  x: number;
  y: number;
  value: number;
}

/** A polygon tile's convex parts, placed in its cell (its box on non-square grids) and flipped with it. */
function polygonParts(polygon: readonly [number, number][], x: number, y: number, flags: number, grid: TileGrid | null): [number, number][][] {
  const pts = polygon.map(([px, py]) => {
    const [fx, fy] = flipPoint(px, py, flags);
    return grid ? grid.cellBoxPoint(x, y, fx, fy) : ([x + fx, y + fy] as [number, number]);
  });
  const parts = convexParts(pts);
  return (parts ?? []).map((p) => p.map(([a, b]) => [a, b] as [number, number]));
}

/** Tiles sorted by how they collide: whole cells and one-way cells (grid cells), and polygon tiles' placed convex parts. */
export interface SortedTiles {
  full: [number, number][];
  oneWay: [number, number][];
  polygons: [number, number][][];
  oneWayPolygons: [number, number][][];
}

/** Sort tiles by their collision (`collisionOf` each tile id's); polygon parts are placed on `grid` (cell units without one). */
export function sortTiles(cells: Iterable<TileCell>, collisionOf: (id: number) => TileCollision | undefined, grid: TileGrid | null): SortedTiles {
  const out: SortedTiles = { full: [], oneWay: [], polygons: [], oneWayPolygons: [] };
  for (const { x, y, value } of cells) {
    const c = collisionOf(tileIdOf(value));
    if (!c || c === "none") continue;
    if (c === "full") out.full.push([x, y]);
    else if (c === "oneWay") out.oneWay.push([x, y]);
    else for (const p of tilePolygons(c)) (p.oneWay ? out.oneWayPolygons : out.polygons).push(...polygonParts(p.polygon, x, y, flagsOf(value), grid));
  }
  return out;
}

/**
 * Where whole cells merge (ADR 0437): square cells in cell units; isometric and staggered cells in diamond space, each
 * one diamond-space unit square, mapped to local units afterwards; hexagons as they are, in local units.
 */
export interface MergeSpace {
  /** Whole cells merge into rectangles and runs here (square cells and diamonds); false: each cell is its own polygon. */
  readonly rectangular: boolean;
  /** A grid cell's cell in merge space. */
  toMerge(x: number, y: number): GridPoint;
  /** The grid cell of a merge-space cell. */
  toCell(u: number, v: number): GridPoint;
  /** A merge-space cell's corners, counter-clockwise. */
  outline(u: number, v: number): GridPoint[];
  /** Merge-space cells that may share a corner with (u, v). */
  around(u: number, v: number): GridPoint[];
  /** Points closer than this are the same point. */
  readonly quantum: number;
  /** A merge-space point in the shapes' units (null: the same). */
  readonly toShape: ((u: number, v: number) => GridPoint) | null;
}

const OFFSETS_8: readonly GridPoint[] = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
const unitSquare = (u: number, v: number): GridPoint[] => [[u, v], [u + 1, v], [u + 1, v + 1], [u, v + 1]];
const around8 = (u: number, v: number): GridPoint[] => OFFSETS_8.map(([du, dv]) => [u + du, v + dv]);
const same = (x: number, y: number): GridPoint => [x, y];

/** The merge space of a grid (cell units for a square grid or none). */
export function mergeSpace(grid: TileGrid | null): MergeSpace {
  const d = grid?.diamond;
  if (d) return { rectangular: true, toMerge: d.toDiamond, toCell: d.fromDiamond, outline: unitSquare, around: around8, quantum: 1e-6, toShape: d.toLocal };
  if (grid && !grid.cellUnits) {
    // Two rings of neighbours: on a hexagonal grid squashed to diamonds (hexSide 0) a corner touches a cell two rows away.
    const around = (x: number, y: number): GridPoint[] => {
      const out = new Map<string, GridPoint>();
      for (const n of grid.neighbours(x, y)) for (const m of [n, ...grid.neighbours(n[0], n[1])]) out.set(`${m[0]},${m[1]}`, m);
      return [...out.values()];
    };
    const { x: w, y: h } = grid.params.cellSize;
    return { rectangular: false, toMerge: same, toCell: same, outline: (x, y) => grid.cellOutline(x, y), around, quantum: Math.max(Math.abs(w), Math.abs(h)) * 1e-6 || 1e-6, toShape: null };
  }
  return { rectangular: true, toMerge: same, toCell: same, outline: unitSquare, around: around8, quantum: 1e-6, toShape: null };
}

/** A merge-space rectangle (`greedyRectangles`, `rowRuns`) as a counter-clockwise quad in the shapes' units. */
export function mergeQuad(space: MergeSpace, r: ShapeRect2D): [number, number][] {
  const p = space.toShape ?? same;
  return [p(r.x, r.y), p(r.x + r.w, r.y), p(r.x + r.w, r.y + r.h), p(r.x, r.y + r.h)];
}

/**
 * Build the shapes for a layer's tiles. `collisionOf` gives each tile id's collision. Without `grid`, or on a square
 * one, the shapes are in cell units; on other grids in local units.
 */
export function buildTileShapes(cells: Iterable<TileCell>, collisionOf: (id: number) => TileCollision | undefined, mode: TileCollisionMode = "rectangles", grid?: TileGrid): TileShapes {
  const placed = grid && !grid.cellUnits ? grid : null;
  const { full, oneWay, polygons, oneWayPolygons } = sortTiles(cells, collisionOf, placed);
  const shapes: TileShapes = { boxes: [], loops: [], polygons, oneWay: [], oneWayPolygons };
  if (placed) {
    placeWholeCells(shapes, placed, full, oneWay, mode);
    return shapes;
  }
  if (mode === "outline") shapes.loops = traceOutlines(full);
  else shapes.boxes = greedyRectangles(full);
  shapes.oneWay = rowRuns(oneWay);
  return shapes;
}

/** Whole-cell and one-way tiles on a non-square grid, in local units (ADR 0437). */
function placeWholeCells(shapes: TileShapes, grid: TileGrid, full: [number, number][], oneWay: [number, number][], mode: TileCollisionMode): void {
  const space = mergeSpace(grid);
  if (space.rectangular) {
    // Merge in diamond space, then map through the grid's affine map (orientation kept, so loops keep the solid on the left).
    const toMerge = (cells: [number, number][]) => cells.map(([x, y]) => space.toMerge(x, y));
    const toLocal = space.toShape!;
    if (mode === "outline") shapes.loops = traceOutlines(toMerge(full)).map((loop) => loop.map(([u, v]) => toLocal(u, v)));
    else shapes.polygons.push(...greedyRectangles(toMerge(full)).map((r) => mergeQuad(space, r)));
    shapes.oneWayPolygons.push(...rowRuns(toMerge(oneWay)).map((r) => mergeQuad(space, r)));
    return;
  }
  const outline = (x: number, y: number) => grid.cellOutline(x, y);
  if (mode === "outline") shapes.loops = traceCellOutlines(full, outline);
  else for (const [x, y] of full) shapes.polygons.push(polygonCorners(outline(x, y)));
  for (const [x, y] of oneWay) shapes.oneWayPolygons.push(polygonCorners(outline(x, y)));
}
