/**
 * Chunk geometry for tilemap rendering (ADR 0103). Pure: one chunk of one layer becomes one
 * vertex buffer per texture (usually one), quads in the tilemap's local units, so the render
 * backend draws a whole chunk in one call and rebuilds only chunks that changed.
 *
 * Each tile's sprite is placed in its cell's box (`TileGrid.cellBox`, ADR 0421) by its anchor (ADR 0119). On
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
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Quads in this mesh. */
  quads: number;
}

// Corners in drawing order (bottom-left, bottom-right, top-right, top-left) as (s, t) with t down.
const CORNERS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

/**
 * Build a chunk's meshes. `cells` are the chunk's 256 values (row by row from its bottom-left
 * cell); `grid` is the map's grid (or, for a square one, just one cell's size in local units); `frameOf` resolves
 * tile ids (null skips the tile, e.g. while its texture loads).
 */
export function buildChunkMeshes(cells: ArrayLike<number>, cx: number, cy: number, grid: TileGrid | { x: number; y: number }, frameOf: (id: number) => TileFrame | null): ChunkMesh[] {
  const layout = "cellBoxPoint" in grid ? grid : tileGrid({ shape: "square", cellSize: grid });
  const cellX = (i: number) => cx * CHUNK_SIZE + (i % CHUNK_SIZE), cellY = (i: number) => cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
  const { x: w, y: h } = layout.params.cellSize;
  let order: number[] | null = null;
  if (layout.shape !== "square") {
    const keys = new Float64Array(cells.length);
    for (let i = 0; i < cells.length; i++) keys[i] = layout.drawKey(cellX(i), cellY(i));
    order = Array.from({ length: cells.length }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
  }
  const groups = new Map<string, { frames: TileFrame[]; cells: number[] }>();
  for (let k = 0; k < cells.length; k++) {
    const i = order ? order[k] : k;
    const v = cells[i];
    if (!v) continue;
    const frame = frameOf(tileIdOf(v));
    if (!frame) continue;
    let g = groups.get(frame.texture);
    if (!g) groups.set(frame.texture, (g = { frames: [], cells: [] }));
    g.frames.push(frame);
    g.cells.push(i);
  }
  const out: ChunkMesh[] = [];
  for (const [texture, g] of groups) {
    const n = g.cells.length;
    const positions = new Float32Array(n * 12), uvs = new Float32Array(n * 8), indices = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) {
      const i = g.cells[q], frame = g.frames[q], flags = flagsOf(cells[i]);
      const x = cellX(i), y = cellY(i);
      const [fw, fh] = flags & FLIP_DIAGONAL ? [frame.size[1], frame.size[0]] : frame.size;
      const [u0, v0, u1, v1] = frame.uv;
      const ox = frame.anchor ? frame.anchor[0] * (1 - fw) : 0, oy = frame.anchor ? frame.anchor[1] * (1 - fh) : 0;
      for (let c = 0; c < 4; c++) {
        const [s, t] = CORNERS[c];
        if (order) {
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
      const b = q * 4;
      indices.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    }
    out.push({ texture, positions, uvs, indices, quads: n });
  }
  return out;
}
