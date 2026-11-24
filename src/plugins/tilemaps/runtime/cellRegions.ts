/**
 * Regions of grid cells (ADR 0105): solid cells (cell (x, y) covers x..x+1, y..y+1) merged into
 * rectangles, per-row runs or closed outlines. Pure; the tile collision shapes (`collision.ts`) use it.
 */
import type { ShapeRect2D } from "../../../engine/physics/shapeSource2D";

/** Merge solid cells into rectangles: grow each run along x, then up while the whole run is free and solid. */
export function greedyRectangles(cells: readonly (readonly [number, number])[]): ShapeRect2D[] {
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
  const out: ShapeRect2D[] = [];
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
export function rowRuns(cells: readonly (readonly [number, number])[]): ShapeRect2D[] {
  const rows = new Map<number, number[]>();
  for (const [x, y] of cells) {
    let r = rows.get(y);
    if (!r) rows.set(y, (r = []));
    r.push(x);
  }
  const out: ShapeRect2D[] = [];
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
    const sdx = e[2] - e[0], sdy = e[3] - e[1];
    const pts: [number, number][] = [[e[0], e[1]]];
    for (let guard = 0; guard < 1e7; guard++) {
      const dx = e[2] - e[0], dy = e[3] - e[1];
      const key = `${e[2]},${e[3]}`;
      // Back at the start: close the loop when the first edge is the turn the trace would take here (a left turn
      // at a shared corner), so a start on a corner two cells share doesn't run on into the other cell's loop.
      if (key === startKey && (!edges.has(key) || dx * sdy - dy * sdx > 0)) break;
      const next = take(key, dx, dy);
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
