/**
 * Internal (ADR 0370, 0094): the shared arithmetic of the GPU kernel executor, the same for every
 * backend: how many workgroups cover N items, how N items lie out in a float texture, and the
 * read/write pair a kernel swaps every frame. Pure; no GPU here.
 */

/** Widest a WebGPU dispatch may be in one dimension (`maxComputeWorkgroupsPerDimension`'s guaranteed value). */
export const MAX_WORKGROUPS_PER_DIMENSION = 65535;

/** Width of the float textures that hold one texel per item on WebGL2 (items run row by row). */
export const GRID_WIDTH = 1024;

/** Bytes in one vec4 of f32. */
export const VEC4_BYTES = 16;

/**
 * Workgroups (x, y) that cover `items` with `workgroup` invocations each: x up to the per-dimension
 * limit, y the rows of x. The kernel recovers its item as `gid.x + gid.y * nwg.x * workgroup` and skips
 * items past the end.
 */
export function dispatchGroups(items: number, workgroup: number): [number, number] {
  const n = Math.ceil(Math.max(0, items) / workgroup);
  if (n === 0) return [0, 0];
  const x = Math.min(n, MAX_WORKGROUPS_PER_DIMENSION);
  return [x, Math.ceil(n / x)];
}

/** A float texture's size for `items` texels, `maxWidth` wide at most (at least 1 × 1). */
export interface GridLayout {
  width: number;
  height: number;
}

/** The size of a texture that holds `items` texels row by row, `maxWidth` wide at most. */
export function gridLayout(items: number, maxWidth = GRID_WIDTH): GridLayout {
  const n = Math.max(1, Math.ceil(items));
  const width = Math.min(maxWidth, n);
  return { width, height: Math.ceil(n / width) };
}

/** The texel (x, y) of item `index` in a grid `width` wide. */
export function texelOf(index: number, width: number): [number, number] {
  return [index % width, Math.floor(index / width)];
}

/**
 * Pads `data` (vec4s, item after item) to a grid's full rows, as `texSubImage2D` of the whole grid
 * needs. Returns `data` itself when it already fills the grid.
 */
export function padToGrid(data: Float32Array, grid: GridLayout): Float32Array {
  const n = grid.width * grid.height * 4;
  if (data.length === n) return data;
  const out = new Float32Array(n);
  out.set(data.subarray(0, Math.min(n, data.length)));
  return out;
}

/**
 * The two copies of a kernel's state: it reads one and writes the other, then they swap. `read` is
 * the latest state after a `swap`.
 */
export class PingPong<T> {
  /** Index of the copy holding the latest state. */
  cur = 0;
  constructor(readonly both: readonly [T, T]) {}
  /** The copy holding the latest state (this frame's input). */
  get read(): T {
    return this.both[this.cur];
  }
  /** The copy this frame writes. */
  get write(): T {
    return this.both[1 - this.cur];
  }
  /** After a frame: what was written becomes the latest state. */
  swap(): void {
    this.cur = 1 - this.cur;
  }
}
