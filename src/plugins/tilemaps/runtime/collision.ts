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
 */
import { convexParts } from "../../../engine/physics/polygon";
import type { CollisionShapes2D, ShapeMerge2D, ShapeRect2D } from "../../../engine/physics/shapeSource2D";
import { greedyRectangles, rowRuns, traceOutlines } from "./cellRegions";
import { flagsOf, tileIdOf } from "./format";
import { flipPoint } from "./tileFlips";
import { tilePolygons, type TileCollision } from "./tileset";

/** How whole-cell tiles merge (ADR 0105): the core 2D shape source's merge modes (ADR 0136). */
export type TileCollisionMode = ShapeMerge2D;

export type Rect = ShapeRect2D;

/** Tile collision shapes in cell units: the core shape set without its unit (the Tilemap adds its cell size). */
export type TileShapes = Omit<CollisionShapes2D, "unit">;

/** A cell with a tile: its coordinates and value (tile id plus flip flags). */
export interface TileCell {
  x: number;
  y: number;
  value: number;
}

/** A polygon tile's convex parts, placed in its cell and flipped with it. */
function polygonParts(polygon: readonly [number, number][], x: number, y: number, flags: number): [number, number][][] {
  const pts = polygon.map(([px, py]) => {
    const [fx, fy] = flipPoint(px, py, flags);
    return [x + fx, y + fy] as [number, number];
  });
  const parts = convexParts(pts);
  return (parts ?? []).map((p) => p.map(([a, b]) => [a, b] as [number, number]));
}

/** Build the shapes for a layer's tiles. `collisionOf` gives each tile id's collision. */
export function buildTileShapes(cells: Iterable<TileCell>, collisionOf: (id: number) => TileCollision | undefined, mode: TileCollisionMode = "rectangles"): TileShapes {
  const full: [number, number][] = [], oneWay: [number, number][] = [];
  const shapes: TileShapes = { boxes: [], loops: [], polygons: [], oneWay: [], oneWayPolygons: [] };
  for (const { x, y, value } of cells) {
    const c = collisionOf(tileIdOf(value));
    if (!c || c === "none") continue;
    if (c === "full") full.push([x, y]);
    else if (c === "oneWay") oneWay.push([x, y]);
    else for (const p of tilePolygons(c)) (p.oneWay ? shapes.oneWayPolygons : shapes.polygons).push(...polygonParts(p.polygon, x, y, flagsOf(value)));
  }
  if (mode === "outline") shapes.loops = traceOutlines(full);
  else shapes.boxes = greedyRectangles(full);
  shapes.oneWay = rowRuns(oneWay);
  return shapes;
}
