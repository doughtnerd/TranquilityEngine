// A block of cells under flip flags (ADR 0289, 0435): the one rule the brush's stamps and the selection's in-place
// flips (ADR 0440) both lay cells out by. Cells map through `tileFlips.flipPoint`, so the block and its tiles follow
// tileFlips.ts's one convention. Pure.
import type { Stamp } from "../runtime/brushes";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y, cellValue, flagsOf, tileIdOf } from "../runtime/format";
import { compose, flipPoint } from "../runtime/tileFlips";

/** A cell value with `flags` applied after the tile's own; 0 (empty) stays 0. */
export function withFlips(v: number, flags: number): number {
  return v ? cellValue(tileIdOf(v), compose(flagsOf(v), flags)) : 0;
}

/**
 * Where cell (c, r) of a `width × height` block lands when the block is laid out under `flags`: mirrored, and turned
 * with width and height swapped. Returns the new column and row and the laid-out block's size.
 */
export function orientCell(c: number, r: number, width: number, height: number, flags: number): { c: number; r: number; width: number; height: number } {
  const turned = (flags & FLIP_DIAGONAL) !== 0;
  const w = turned ? height : width, h = turned ? width : height;
  const [u, v] = flipPoint((c + 0.5) / width, (r + 0.5) / height, flags);
  return { c: Math.floor(u * w), r: Math.floor(v * h), width: w, height: h };
}

/**
 * The stamp laid out under the flips `flags`: the block transformed as one tile is (mirrored, and turned with width
 * and height swapped), each tile's own flips composed with `flags`. Without `layout` (hexagonal maps, ADR 0435) only
 * the tiles' images flip: the layout stays and turns are dropped.
 */
export function orientedStamp(stamp: Stamp, flags: number, layout = true): Stamp {
  if (!layout) flags &= FLIP_X | FLIP_Y;
  if (!flags) return stamp;
  if (!layout) return { width: stamp.width, height: stamp.height, values: stamp.values.map((v) => withFlips(v, flags)) };
  const turned = (flags & FLIP_DIAGONAL) !== 0;
  const width = turned ? stamp.height : stamp.width, height = turned ? stamp.width : stamp.height;
  const values = new Array<number>(width * height).fill(0);
  for (let r = 0; r < stamp.height; r++) {
    for (let c = 0; c < stamp.width; c++) {
      const at = orientCell(c, r, stamp.width, stamp.height, flags);
      values[at.r * width + at.c] = withFlips(stamp.values[r * stamp.width + c] ?? 0, flags);
    }
  }
  return { width, height, values };
}
