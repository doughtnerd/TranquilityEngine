/**
 * Tile shapes merged per chunk and cached (ADR 0439). A Tilemap's collision (and shadow) shapes are the merge of its
 * tiles; merging a big map whole on every edit is what made editing it slow. This cache keeps one merge result per
 * chunk position and slot (a slot is one set of layers merged together in one mode, such as the colliding layers
 * that share an offset, in outline mode), keyed by the versions of the slot's layers' chunks there and a context key
 * (the tileset and the grid). An edit changes one chunk's version, so only that chunk is merged again; the slot's
 * shapes are the chunks' results put together:
 *
 * - `"rectangles"`: greedy rectangles per chunk (they stop at chunk borders), polygon parts per chunk.
 * - `"outline"`: each chunk traces its own cells' outline into loops. A loop through no point a cell of another chunk
 *   touches is final. The others (border loops) are grouped through the points they share with other chunks' border
 *   loops; a group spanning chunks is traced again together, cancelling the edges two chunks share and chaining the
 *   rest (`cellRegions.ts`), so the outlines are those of a whole-map trace. The groups are kept too, so an edit
 *   re-traces only the groups of the chunks it touched.
 * - One-way runs are kept per chunk and joined across chunk borders, so a plank crossing a border is one run.
 *
 * Cells of one position in several layers of a slot count once (the union), as a whole-map merge counts them.
 * Pure apart from the cache itself: no engine state, on every grid (`collision.ts`'s merge spaces).
 */
import type { ShapeRect2D } from "../../../engine/physics/shapeSource2D";
import { cancelEdges, cellEdges, chainEdgeLoops, chainEdges, greedyRectangles, loopCorners, pointKey, polygonCorners, rowRuns, type OutlineEdge } from "./cellRegions";
import { mergeQuad, mergeSpace, sortTiles, type MergeSpace, type TileCell, type TileCollisionMode, type TileShapes } from "./collision";
import { CHUNK_CELLS, CHUNK_SIZE, cellToChunk } from "./format";
import type { TileGrid } from "./grids";
import type { TileCollision } from "./tileset";

/** A chunk of cells as the cache reads it: its position, its stored cells and a version that changes with them. */
export interface ShapeChunk {
  readonly cx: number;
  readonly cy: number;
  readonly cells: ArrayLike<number>;
  readonly version: number;
}

/** A layer as the cache reads it. */
export interface ShapeLayer {
  /** Tells the layer apart within its slot (its index). */
  readonly id: number;
  /** Chunks by `"cx,cy"`. */
  readonly chunks: ReadonlyMap<string, ShapeChunk>;
  /** A stored cell as a tileset cell value (tile id plus flip flags; 0 nothing). */
  value(stored: number): number;
}

/** A chunk's outline loop through points another chunk's cells touch: final unless another chunk's loop passes there too. */
interface BorderLoop {
  /** The chunk's key. */
  chunk: string;
  /** Its corners in the shapes' units. */
  corners: [number, number][];
  /** Its edges, in merge space, for the trace across chunks. */
  edges: OutlineEdge[];
  /** The keys of its points that cells of other chunks touch. */
  shared: string[];
}

/** One chunk position's merge. Points are in the shapes' units except `border` edges and `runs`, which are in merge space. */
interface ChunkMerge {
  key: string;
  boxes: ShapeRect2D[];
  polygons: [number, number][][];
  oneWayPolygons: [number, number][][];
  loops: [number, number][][];
  border: BorderLoop[];
  runs: ShapeRect2D[];
}

/** Border loops joined through the shared points they pass through, and the outlines they make together. */
interface BorderGroup {
  loops: BorderLoop[];
  outlines: [number, number][][];
}

/** One slot's chunk merges, and its border loops' groups (kept from one call to the next, so an edit regroups only near it). */
interface Slot {
  merges: Map<string, ChunkMerge>;
  /** Border loops by the shared points they pass through. */
  through: Map<string, Set<BorderLoop>>;
  groupOf: Map<BorderLoop, BorderGroup>;
  groups: Set<BorderGroup>;
}

export class TileShapeCache {
  private slots = new Map<string, Slot>();

  /**
   * The tiles of `layers` merged together in `mode`, the same shapes `buildTileShapes` gives for all their cells
   * (rectangles may split differently at chunk borders; each solid cell counts once however many layers have it).
   * `slot` names this set of layers and mode; `context` must change whenever `collisionOf` or `grid` would answer
   * differently (the tileset, the grid's key). `withoutWholeCells` (square grids, ADR 0444) leaves the whole cells'
   * rectangles and outlines out of the result (they are still merged and cached, so the slot serves both).
   */
  shapes(slot: string, layers: readonly ShapeLayer[], collisionOf: (id: number) => TileCollision | undefined, mode: TileCollisionMode, grid: TileGrid, context: string, withoutWholeCells = false): TileShapes {
    const whole = !(withoutWholeCells && grid.shape === "square");
    const space = mergeSpace(grid.shape === "square" ? null : grid);
    const placed = grid.shape === "square" ? null : grid;
    let st = this.slots.get(slot);
    if (!st) this.slots.set(slot, (st = { merges: new Map(), through: new Map(), groupOf: new Map(), groups: new Set() }));
    const old = st.merges;
    const merges = new Map<string, ChunkMerge>();
    const added: ChunkMerge[] = [];
    const positions = new Map<string, { cx: number; cy: number }>();
    for (const l of layers) for (const [k, c] of l.chunks) if (!positions.has(k)) positions.set(k, { cx: c.cx, cy: c.cy });
    const order = [...positions].sort((a, b) => a[1].cy - b[1].cy || a[1].cx - b[1].cx);
    const out: TileShapes = { boxes: [], loops: [], polygons: [], oneWay: [], oneWayPolygons: [] };
    const runs: ShapeRect2D[] = [];
    for (const [k, { cx, cy }] of order) {
      let key = `${context}|${mode}`;
      for (const l of layers) {
        const c = l.chunks.get(k);
        if (c) key += `|${l.id}:${c.version}`;
      }
      let m = old.get(k);
      if (m?.key !== key) added.push((m = mergeChunk(key, cx, cy, k, layers, collisionOf, mode, space, placed)));
      merges.set(k, m);
      if (whole) for (const b of m.boxes) out.boxes.push(b);
      for (const p of m.polygons) out.polygons.push(p);
      for (const p of m.oneWayPolygons) out.oneWayPolygons.push(p);
      if (whole) for (const p of m.loops) out.loops.push(p);
      for (const r of m.runs) runs.push(r);
    }
    const removed: ChunkMerge[] = [];
    for (const [k, m] of old) if (merges.get(k) !== m) removed.push(m);
    st.merges = merges;
    regroupBorders(st, removed, added, space);
    if (whole) for (const g of st.groups) for (const o of g.outlines) out.loops.push(o);
    const joined = joinRuns(runs);
    if (space.toShape) for (const r of joined) out.oneWayPolygons.push(mergeQuad(space, r));
    else out.oneWay = joined;
    return out;
  }

  /** Forget the slots whose names start with `prefix` other than `keep` (layers merged under settings no longer used). */
  retain(prefix: string, keep: ReadonlySet<string>): void {
    for (const k of [...this.slots.keys()]) if (k.startsWith(prefix) && !keep.has(k)) this.slots.delete(k);
  }
}

/**
 * Chunks' border loops put together, for the chunks merged again (`added`, replacing `removed`): the groups those
 * touch are broken up and the loops regrouped through their shared points. A group of one chunk's loops is final as
 * it is (no other chunk's cell touches its points); a group spanning chunks is traced again together, its edges two
 * chunks share cancelling and the rest chaining into loops, as a whole-map trace would.
 */
function regroupBorders(st: Slot, removed: readonly ChunkMerge[], added: readonly ChunkMerge[], space: MergeSpace): void {
  const gone = new Set<BorderLoop>();
  for (const m of removed) for (const l of m.border) gone.add(l);
  const seeds: BorderLoop[] = [];
  const breakUp = (l: BorderLoop) => {
    const g = st.groupOf.get(l);
    if (g && st.groups.delete(g)) for (const o of g.loops) seeds.push(o);
  };
  for (const l of gone) {
    for (const k of l.shared) {
      const s = st.through.get(k);
      s?.delete(l);
      if (s && !s.size) st.through.delete(k);
    }
    breakUp(l);
    st.groupOf.delete(l);
  }
  for (const m of added) {
    for (const l of m.border) {
      for (const k of l.shared) {
        let s = st.through.get(k);
        if (!s) st.through.set(k, (s = new Set()));
        s.add(l);
      }
      seeds.push(l);
    }
  }
  const done = new Set<BorderLoop>();
  for (const seed of seeds) {
    if (gone.has(seed) || done.has(seed)) continue;
    const loops: BorderLoop[] = [];
    const queue = [seed];
    done.add(seed);
    while (queue.length) {
      const l = queue.pop()!;
      loops.push(l);
      breakUp(l); // a new loop may join a group that was whole
      for (const k of l.shared) {
        for (const o of st.through.get(k) ?? []) {
          if (done.has(o)) continue;
          done.add(o);
          queue.push(o);
        }
      }
    }
    const chunks = new Set(loops.map((l) => l.chunk));
    let outlines: [number, number][][];
    if (chunks.size > 1) {
      const toShape = space.toShape;
      const edges: OutlineEdge[] = [];
      for (const l of loops) for (const e of l.edges) edges.push(e);
      outlines = chainEdges(cancelEdges(edges), space.quantum).map((loop) => (toShape ? loop.map(([u, v]) => toShape(u, v)) : loop));
    } else outlines = loops.map((l) => l.corners).filter((c) => c.length >= 3);
    const g: BorderGroup = { loops, outlines };
    st.groups.add(g);
    for (const l of loops) st.groupOf.set(l, g);
  }
}

function mergeChunk(key: string, cx: number, cy: number, k: string, layers: readonly ShapeLayer[], collisionOf: (id: number) => TileCollision | undefined, mode: TileCollisionMode, space: MergeSpace, placed: TileGrid | null): ChunkMerge {
  const cells: TileCell[] = [];
  for (const l of layers) {
    const c = l.chunks.get(k);
    if (!c) continue;
    for (let i = 0; i < CHUNK_CELLS; i++) {
      const raw = c.cells[i];
      if (!raw) continue;
      const value = l.value(raw);
      if (value) cells.push({ x: cx * CHUNK_SIZE + (i % CHUNK_SIZE), y: cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE), value });
    }
  }
  const sorted = sortTiles(cells, collisionOf, placed);
  const m: ChunkMerge = { key, boxes: [], polygons: sorted.polygons, oneWayPolygons: sorted.oneWayPolygons, loops: [], border: [], runs: [] };
  const full = unique(sorted.full.map(([x, y]) => space.toMerge(x, y)));
  const oneWay = unique(sorted.oneWay.map(([x, y]) => space.toMerge(x, y)));
  if (mode === "outline") {
    const edges = cellEdges(full, space.outline, space.quantum);
    // Points a cell of another chunk touches: loops through them wait for the other chunks' edges.
    const foreign = new Set<string>();
    const outside = (u: number, v: number) => {
      const [x, y] = space.toCell(u, v);
      const c = cellToChunk(x, y);
      return c.cx !== cx || c.cy !== cy;
    };
    for (const [u, v] of full) for (const [nu, nv] of space.around(u, v)) if (outside(nu, nv)) for (const p of space.outline(nu, nv)) foreign.add(pointKey(p, space.quantum));
    // The chunk's own cells' boundary is closed loops; a loop through no foreign point is final as it is.
    const toShape = space.toShape;
    for (const loop of chainEdgeLoops(edges)) {
      const c = loopCorners(loop, space.quantum);
      const corners = toShape ? c.map(([u, v]) => toShape(u, v)) : c;
      const sharedKeys = [...new Set(loop.map((e) => e.ka).filter((k) => foreign.has(k)))];
      if (sharedKeys.length) m.border.push({ chunk: k, corners, edges: loop, shared: sharedKeys });
      else if (corners.length >= 3) m.loops.push(corners);
    }
  } else if (space.rectangular) {
    const rects = greedyRectangles(full);
    if (space.toShape) for (const r of rects) m.polygons.push(mergeQuad(space, r));
    else m.boxes = rects;
  } else for (const [u, v] of full) m.polygons.push(polygonCorners(space.outline(u, v)));
  if (space.rectangular) m.runs = rowRuns(oneWay);
  else for (const [u, v] of oneWay) m.oneWayPolygons.push(polygonCorners(space.outline(u, v)));
  return m;
}

/** Cells without repeats (a position solid in two layers counts once). */
function unique(cells: [number, number][]): [number, number][] {
  if (cells.length < 2) return cells;
  const seen = new Set<string>();
  return cells.filter(([x, y]) => {
    const k = `${x},${y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Runs of one row that meet end to end (from neighbouring chunks) joined into one, ordered by row then x. */
function joinRuns(runs: ShapeRect2D[]): ShapeRect2D[] {
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const out: ShapeRect2D[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.y === r.y && last.x + last.w >= r.x) last.w = Math.max(last.w, r.x + r.w - last.x);
    else out.push({ ...r });
  }
  return out;
}
