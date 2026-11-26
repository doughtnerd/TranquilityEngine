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
 * On other grids (ADR 0421, given a `TileGrid`) the shapes are in local units instead:
 * - Isometric and staggered: whole-cell and one-way tiles merge in diamond space as above, then go through the grid's
 *   affine map (a rectangle becomes a parallelogram in `polygons` or `oneWayPolygons`, an outline stays an outline).
 * - Hexagonal: one hexagon per solid cell ("rectangles") or the traced union of their outlines ("outline"); one-way
 *   cells are one-way hexagons.
 * - Polygon tiles are in their cell box's units on every grid, so a polygon drawn over the sprite fits it.
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

/**
 * Build the shapes for a layer's tiles. `collisionOf` gives each tile id's collision. Without `grid`, or on a square
 * one, the shapes are in cell units; on other grids in local units.
 */
export function buildTileShapes(cells: Iterable<TileCell>, collisionOf: (id: number) => TileCollision | undefined, mode: TileCollisionMode = "rectangles", grid?: TileGrid): TileShapes {
  const placed = grid && grid.shape !== "square" ? grid : null;
  const full: [number, number][] = [], oneWay: [number, number][] = [];
  const shapes: TileShapes = { boxes: [], loops: [], polygons: [], oneWay: [], oneWayPolygons: [] };
  for (const { x, y, value } of cells) {
    const c = collisionOf(tileIdOf(value));
    if (!c || c === "none") continue;
    if (c === "full") full.push([x, y]);
    else if (c === "oneWay") oneWay.push([x, y]);
    else for (const p of tilePolygons(c)) (p.oneWay ? shapes.oneWayPolygons : shapes.polygons).push(...polygonParts(p.polygon, x, y, flagsOf(value), placed));
  }
  if (placed) {
    placeWholeCells(shapes, placed, full, oneWay, mode);
    return shapes;
  }
  if (mode === "outline") shapes.loops = traceOutlines(full);
  else shapes.boxes = greedyRectangles(full);
  shapes.oneWay = rowRuns(oneWay);
  return shapes;
}

/** Whole-cell and one-way tiles on a non-square grid, in local units (ADR 0421). */
function placeWholeCells(shapes: TileShapes, grid: TileGrid, full: [number, number][], oneWay: [number, number][], mode: TileCollisionMode): void {
  const d = grid.diamond;
  if (d) {
    // Merge in diamond space, then map through the grid's affine map (orientation kept, so loops keep the solid on the left).
    const toDiamond = (cells: [number, number][]) => cells.map(([x, y]) => d.toDiamond(x, y));
    const quad = (r: { x: number; y: number; w: number; h: number }): GridPoint[] => [d.toLocal(r.x, r.y), d.toLocal(r.x + r.w, r.y), d.toLocal(r.x + r.w, r.y + r.h), d.toLocal(r.x, r.y + r.h)];
    if (mode === "outline") shapes.loops = traceOutlines(toDiamond(full)).map((loop) => loop.map(([u, v]) => d.toLocal(u, v)));
    else shapes.polygons.push(...greedyRectangles(toDiamond(full)).map(quad));
    shapes.oneWayPolygons.push(...rowRuns(toDiamond(oneWay)).map(quad));
    return;
  }
  const outline = (x: number, y: number) => grid.cellOutline(x, y);
  if (mode === "outline") shapes.loops = traceCellOutlines(full, outline);
  else for (const [x, y] of full) shapes.polygons.push(polygonCorners(outline(x, y)));
  for (const [x, y] of oneWay) shapes.oneWayPolygons.push(polygonCorners(outline(x, y)));
}
