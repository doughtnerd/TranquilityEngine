/**
 * Regions of grid cells (ADR 0105): solid cells (cell (x, y) covers x..x+1, y..y+1) merged into
 * rectangles, per-row runs or closed outlines; and, for cells of any shape (ADR 0421), outlines traced by cancelling
 * the edges cells share. Pure; the tile collision shapes (`collision.ts`) use it.
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

/**
 * Outlines of the union of cells of any shape (ADR 0421), given each cell's corners counter-clockwise (`outline`,
 * `TileGrid.cellOutline`): every cell's edges are collected, an edge two cells share (one each way) cancels, and the
 * rest chain into closed loops with the solid on the left, collinear points merged. Where two loops touch at a point
 * the trace takes the sharpest left turn, keeping them apart. Neighbouring cells must share their corners (hexagons
 * of one grid do, their flat sides' ends included). Points match to a millionth of a cell's size.
 */
export function traceCellOutlines(cells: readonly (readonly [number, number])[], outline: (x: number, y: number) => readonly (readonly [number, number])[]): [number, number][][] {
  if (!cells.length) return [];
  const quantum = extent(outline(cells[0][0], cells[0][1])) * 1e-6 || 1e-6;
  const key = (p: readonly [number, number]) => `${Math.round(p[0] / quantum)},${Math.round(p[1] / quantum)}`;
  interface Edge {
    a: [number, number];
    b: [number, number];
    ka: string;
    kb: string;
  }
  // Directed edges by "from|to", with how many are left once shared ones cancel.
  const edges = new Map<string, { e: Edge; n: number }>();
  const seen = new Set<string>();
  for (const [x, y] of cells) {
    if (seen.has(`${x},${y}`)) continue;
    seen.add(`${x},${y}`);
    const pts = outline(x, y);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ka = key(a), kb = key(b);
      if (ka === kb) continue;
      const reverse = edges.get(`${kb}|${ka}`);
      if (reverse && reverse.n > 0) {
        reverse.n--;
        continue;
      }
      const own = edges.get(`${ka}|${kb}`);
      if (own) own.n++;
      else edges.set(`${ka}|${kb}`, { e: { a: [a[0], a[1]], b: [b[0], b[1]], ka, kb }, n: 1 });
    }
  }
  const from = new Map<string, Edge[]>();
  let left = 0;
  for (const { e, n } of edges.values()) {
    for (let i = 0; i < n; i++) {
      let l = from.get(e.ka);
      if (!l) from.set(e.ka, (l = []));
      l.push(e);
      left++;
    }
  }
  /** How far `e` turns left after an edge going (dx, dy): larger is a sharper left turn. */
  const turn = (dx: number, dy: number, e: Edge) => {
    const ex = e.b[0] - e.a[0], ey = e.b[1] - e.a[1];
    return Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
  };
  const remove = (e: Edge) => {
    const l = from.get(e.ka)!;
    l.splice(l.indexOf(e), 1);
    if (!l.length) from.delete(e.ka);
    left--;
  };
  const loops: [number, number][][] = [];
  while (left > 0) {
    const start = from.values().next().value![0];
    remove(start);
    const pts: [number, number][] = [start.a];
    let e = start;
    for (let guard = 0; guard < 1e7; guard++) {
      const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1];
      let best: Edge | null = null, bestTurn = -Infinity;
      for (const c of from.get(e.kb) ?? []) {
        const t = turn(dx, dy, c);
        if (t > bestTurn) (best = c), (bestTurn = t);
      }
      // Back at the start: close unless another edge leaving here is the sharper left turn (the loop touches itself).
      if (e.kb === start.ka && (!best || turn(dx, dy, start) >= bestTurn)) break;
      if (!best) break;
      remove(best);
      pts.push(best.a);
      e = best;
    }
    const simple = polygonCorners(pts, quantum);
    if (simple.length >= 3) loops.push(simple);
  }
  return loops;
}

/** The largest width or height of a set of points. */
function extent(points: readonly (readonly [number, number])[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY, 0);
}

/** A closed polygon with its collinear points dropped (a point counts as collinear within `tolerance` of the line). */
export function polygonCorners(points: readonly (readonly [number, number])[], tolerance = extent(points) * 1e-6): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[(i + points.length - 1) % points.length], b = points[i], c = points[(i + 1) % points.length];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / len > tolerance) out.push([b[0], b[1]]);
  }
  return out;
}
