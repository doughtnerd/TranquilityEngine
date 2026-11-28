/**
 * Chunk geometry for tilemap rendering (ADR 0103). Pure: one chunk of one layer becomes one
 * vertex buffer per texture (usually one), quads in the tilemap's local units, so the render
 * backend draws a whole chunk in one call and rebuilds only chunks that changed. A caller can split a chunk's tiles
 * further into groups (a y-sorted layer's rows, ADR 0440; a square chunk's animated tiles, ADR 0437).
 *
 * Each tile's sprite is placed in its cell's box (`TileGrid.cellBox`, ADR 0437) by its anchor (ADR 0119). On
 * non-square grids, where tall tiles overlap the rows behind them, a mesh's quads come in painter's order
 * (`TileGrid.drawKey`: higher on screen first).
 */
import { CHUNK_SIZE, FLIP_DIAGONAL, flagsOf, tileIdOf } from "./format";
import { tileGrid, type TileGrid } from "./grids";
import { sourceCorner } from "./tileFlips";

/** What a tile draws: a texture, its UV rectangle (v up) and its size in cells. */
export interface TileFrame {
  texture: string;
  /** `[u0, v0, u1, v1]`, v up (bottom row first). */
  uv: [number, number, number, number];
  /** Width and height in cells (1 × 1 for a slice the tileset's tile size). */
  size: [number, number];
  /** Where the sprite sits in its cell (ADR 0119): the sprite's point `[x, y]` (0..1 from its bottom-left) lands on the same point of the cell. Default `[0, 0]`: corners together, overhanging up and right. */
  anchor?: [number, number];
}

export interface ChunkMesh {
  texture: string;
  /** The group its tiles were put in beside the texture (`buildChunkMeshes`' `groupOf`; "" without one). */
  group: string;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Quads in this mesh. */
  quads: number;
  /** Each quad's cell: its index in the chunk's `cells` (row by row from the bottom-left cell). */
  cells: Int32Array;
}

// Corners in drawing order (bottom-left, bottom-right, top-right, top-left) as (s, t) with t down.
const CORNERS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

/** A square grid for a cell size, or the grid as given. */
function layoutOf(grid: TileGrid | { x: number; y: number }): TileGrid {
  return "cellBoxPoint" in grid ? grid : tileGrid({ shape: "square", cellSize: grid });
}

/**
 * Build a chunk's meshes. `cells` are the chunk's 256 values (row by row from its bottom-left
 * cell); `grid` is the map's grid (or, for a square one, just one cell's size in local units); `frameOf` resolves
 * a cell's tile id (it also gets the cell's index; null skips the tile, e.g. while its texture loads). Tiles go in one
 * mesh per texture or, with `groupOf`, per texture and group; meshes come in the order their first tile is drawn.
 */
export function buildChunkMeshes(
  cells: ArrayLike<number>,
  cx: number,
  cy: number,
  grid: TileGrid | { x: number; y: number },
  frameOf: (id: number, cell: number) => TileFrame | null,
  groupOf?: (cell: number, id: number) => string,
): ChunkMesh[] {
  const layout = layoutOf(grid);
  const cellX = (i: number) => cx * CHUNK_SIZE + (i % CHUNK_SIZE), cellY = (i: number) => cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
  let order: number[] | null = null;
  if (layout.shape !== "square") {
    const keys = new Float64Array(cells.length);
    for (let i = 0; i < cells.length; i++) keys[i] = layout.drawKey(cellX(i), cellY(i));
    order = Array.from({ length: cells.length }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
  }
  const groups = new Map<string, { texture: string; group: string; frames: TileFrame[]; cells: number[] }>();
  for (let k = 0; k < cells.length; k++) {
    const i = order ? order[k] : k;
    const v = cells[i];
    if (!v) continue;
    const id = tileIdOf(v);
    const frame = frameOf(id, i);
    if (!frame) continue;
    const group = groupOf ? groupOf(i, id) : "";
    const key = group ? `${frame.texture}\n${group}` : frame.texture;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { texture: frame.texture, group, frames: [], cells: [] }));
    g.frames.push(frame);
    g.cells.push(i);
  }
  const out: ChunkMesh[] = [];
  for (const g of groups.values()) {
    const n = g.cells.length;
    const positions = new Float32Array(n * 12), uvs = new Float32Array(n * 8), indices = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) {
      const i = g.cells[q];
      writeTileQuad(positions, uvs, q, layout, cellX(i), cellY(i), g.frames[q], flagsOf(cells[i]));
      const b = q * 4;
      indices.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    }
    out.push({ texture: g.texture, group: g.group, positions, uvs, indices, quads: n, cells: Int32Array.from(g.cells) });
  }
  return out;
}

/**
 * Write quad `q` of a mesh (its 4 corners' xyz in `positions`, uv in `uvs`): cell (x, y)'s tile drawing `frame` with
 * flip `flags`, placed in the cell's box by the frame's size and anchor (ADR 0119, 0437). What `buildChunkMeshes` lays
 * each tile out with, and what an animated tile's quad is rewritten with when its frame changes.
 */
export function writeTileQuad(positions: Float32Array, uvs: Float32Array, q: number, grid: TileGrid | { x: number; y: number }, x: number, y: number, frame: TileFrame, flags: number): void {
  const layout = layoutOf(grid);
  const { x: w, y: h } = layout.params.cellSize;
  const [fw, fh] = flags & FLIP_DIAGONAL ? [frame.size[1], frame.size[0]] : frame.size;
  const [u0, v0, u1, v1] = frame.uv;
  const ox = frame.anchor ? frame.anchor[0] * (1 - fw) : 0, oy = frame.anchor ? frame.anchor[1] * (1 - fh) : 0;
  for (let c = 0; c < 4; c++) {
    const [s, t] = CORNERS[c];
    if (layout.shape !== "square") {
      const [px, py] = layout.cellBoxPoint(x, y, ox + s * fw, oy + (1 - t) * fh);
      positions[q * 12 + c * 3] = px;
      positions[q * 12 + c * 3 + 1] = py;
    } else {
      // Square grids keep the arithmetic they have always had, to the last bit.
      positions[q * 12 + c * 3] = (x + ox + s * fw) * w;
      positions[q * 12 + c * 3 + 1] = (y + oy + (1 - t) * fh) * h;
    }
    positions[q * 12 + c * 3 + 2] = 0;
    const [ss, st] = sourceCorner(s, t, flags);
    uvs[q * 8 + c * 2] = u0 + ss * (u1 - u0);
    uvs[q * 8 + c * 2 + 1] = v1 - st * (v1 - v0);
  }
}
