/**
 * Tile collision shapes (ADR 0105). Pure: turns a layer's cells into a few merged shapes in cell
 * units (cell (x, y) covers x..x+1, y..y+1), which the physics backend scales by the cell size and
 * builds as Rapier colliders.
 *
 * - Whole-cell solid tiles merge into the fewest rectangles a greedy scan finds ("rectangles"
 *   mode), or into closed outlines around each solid region ("outline" mode).
 * - Polygon tiles become convex parts (flipped and turned with their cell).
 * - One-way tiles merge into horizontal runs, one per row, kept apart so each can decide on its
 *   own whether a body passes.
 */
import { convexParts } from "../physics/polygon";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y, flagsOf, tileIdOf } from "./format";
import type { TileCollision } from "./tileset";

export type TileCollisionMode = "rectangles" | "outline";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileShapes {
  /** Solid rectangles ("rectangles" mode). */
  boxes: Rect[];
  /** Closed outlines with the solid on the left of each edge (counter-clockwise outside, clockwise around holes) ("outline" mode). */
  loops: [number, number][][];
  /** Convex solid polygons from polygon tiles. */
  polygons: [number, number][][];
  /** One-way platform rectangles (one row high). */
  oneWay: Rect[];
  /** Convex one-way polygons. */
  oneWayPolygons: [number, number][][];
}

/** A cell with a tile: its coordinates and value (tile id plus flip flags). */
export interface TileCell {
  x: number;
  y: number;
  value: number;
}

/** Map a point in a tile's own cell units through the cell's flip flags. */
export function flipPoint(px: number, py: number, flags: number): [number, number] {
  // In image space (t down): the diagonal flip first, then the horizontal and vertical flips (as Tiled).
  let s = px, t = 1 - py;
  if (flags & FLIP_DIAGONAL) [s, t] = [t, s];
  if (flags & FLIP_X) s = 1 - s;
  if (flags & FLIP_Y) t = 1 - t;
  return [s, 1 - t];
}

/** Merge solid cells into rectangles: grow each run along x, then up while the whole run is free and solid. */
export function greedyRectangles(cells: readonly (readonly [number, number])[]): Rect[] {
  if (!cells.length) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const grid = new Uint8Array(w * h); // 1 solid, 2 taken
  for (const [x, y] of cells) grid[(y - minY) * w + (x - minX)] = 1;
  const out: Rect[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y * w + x] !== 1) continue;
      let rw = 1;
      while (x + rw < w && grid[y * w + x + rw] === 1) rw++;
      let rh = 1;
      grow: while (y + rh < h) {
        for (let i = 0; i < rw; i++) if (grid[(y + rh) * w + x + i] !== 1) break grow;
        rh++;
      }
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) grid[(y + j) * w + x + i] = 2;
      out.push({ x: x + minX, y: y + minY, w: rw, h: rh });
    }
  }
  return out;
}

/** Horizontal runs of cells, per row. */
export function rowRuns(cells: readonly (readonly [number, number])[]): Rect[] {
  const rows = new Map<number, number[]>();
  for (const [x, y] of cells) {
    let r = rows.get(y);
    if (!r) rows.set(y, (r = []));
    r.push(x);
  }
  const out: Rect[] = [];
  for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    let start = xs[0], prev = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      const x = xs[i];
      if (x === prev + 1) {
        prev = x;
        continue;
      }
      if (x === prev) continue;
      out.push({ x: start, y, w: prev - start + 1, h: 1 });
      start = prev = x;
    }
  }
  return out;
}

/**
 * Outlines of the union of solid cells: closed loops with the solid on the left of each edge,
 * collinear edges merged. Cells touching only at a corner get separate loops.
 */
export function traceOutlines(cells: readonly (readonly [number, number])[]): [number, number][][] {
  const solid = new Set(cells.map(([x, y]) => `${x},${y}`));
  const has = (x: number, y: number) => solid.has(`${x},${y}`);
  // Directed unit edges, keyed by start vertex.
  const edges = new Map<string, [number, number, number, number][]>();
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = `${ax},${ay}`;
    let l = edges.get(k);
    if (!l) edges.set(k, (l = []));
    l.push([ax, ay, bx, by]);
  };
  for (const [x, y] of cells) {
    if (!has(x, y - 1)) add(x, y, x + 1, y); // bottom, going +x
    if (!has(x + 1, y)) add(x + 1, y, x + 1, y + 1); // right, going +y
    if (!has(x, y + 1)) add(x + 1, y + 1, x, y + 1); // top, going -x
    if (!has(x - 1, y)) add(x, y + 1, x, y); // left, going -y
  }
  const loops: [number, number][][] = [];
  const take = (k: string, dx: number, dy: number): [number, number, number, number] | undefined => {
    const l = edges.get(k);
    if (!l?.length) return undefined;
    let pick = 0;
    if (l.length > 1) {
      // Two edges leave this vertex (cells meeting at a corner): take the left turn, keeping each cell's loop apart.
      pick = l.findIndex((e) => dx * (e[3] - e[1]) - dy * (e[2] - e[0]) > 0);
      if (pick < 0) pick = 0;
    }
    const [e] = l.splice(pick, 1);
    if (!l.length) edges.delete(k);
    return e;
  };
  while (edges.size) {
    const startKey = edges.keys().next().value as string;
    let e = take(startKey, 0, 0)!;
    const pts: [number, number][] = [[e[0], e[1]]];
    for (let guard = 0; guard < 1e7; guard++) {
      const dx = e[2] - e[0], dy = e[3] - e[1];
      const next = take(`${e[2]},${e[3]}`, dx, dy);
      if (!next) break;
      pts.push([next[0], next[1]]);
      e = next;
    }
    // Drop points in the middle of straight runs.
    const simple: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) simple.push(b);
    }
    if (simple.length >= 3) loops.push(simple);
  }
  return loops;
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
    else (c.oneWay ? shapes.oneWayPolygons : shapes.polygons).push(...polygonParts(c.polygon, x, y, flagsOf(value)));
  }
  if (mode === "outline") shapes.loops = traceOutlines(full);
  else shapes.boxes = greedyRectangles(full);
  shapes.oneWay = rowRuns(oneWay);
  return shapes;
}
