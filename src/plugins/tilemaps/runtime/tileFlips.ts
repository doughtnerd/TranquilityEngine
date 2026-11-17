/**
 * The algebra of the 8 tile orientations (ADR 0103): the flag bits of `format.ts` read as
 * transforms of a tile's unit cell, in Tiled's convention. This module is the one place that
 * convention is stated; nothing else may restate it.
 *
 * Convention: a set of flags transforms the tile image by the diagonal flip (swap the axes)
 * first, then the horizontal flip (FLIP_X), then the vertical flip (FLIP_Y). The 8 orientations
 * form a group (the symmetries of a square): `compose` is its product, `0` the identity,
 * `inverse` the inverse. Pure; collision maps polygon points through `flipPoint`, chunk meshes
 * map drawn corners back to the texture with `sourceCorner`, the brush composes.
 */
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y } from "./format";

/** The flags of applying `first`, then `second`: `flipPoint(...flipPoint(x, y, first), second)` equals `flipPoint(x, y, compose(first, second))`. */
export function compose(first: number, second: number): number {
  const d1 = (first & FLIP_DIAGONAL) !== 0, x1 = (first & FLIP_X) !== 0, y1 = (first & FLIP_Y) !== 0;
  const d2 = (second & FLIP_DIAGONAL) !== 0, x2 = (second & FLIP_X) !== 0, y2 = (second & FLIP_Y) !== 0;
  // After `first` the axes carry the mirror signs (x1, y1); a diagonal swap in `second` exchanges them.
  const x = x2 !== (d2 ? y1 : x1), y = y2 !== (d2 ? x1 : y1);
  return (d1 !== d2 ? FLIP_DIAGONAL : 0) | (x ? FLIP_X : 0) | (y ? FLIP_Y : 0);
}

/** The flags that undo `flags`: `compose(flags, inverse(flags))` is 0. */
export function inverse(flags: number): number {
  if (!(flags & FLIP_DIAGONAL)) return flags; // pure flips are their own inverse
  return FLIP_DIAGONAL | (flags & FLIP_X ? FLIP_Y : 0) | (flags & FLIP_Y ? FLIP_X : 0);
}

/** A quarter turn clockwise (the diagonal flip, then a horizontal flip). */
export const TURN_CLOCKWISE = FLIP_DIAGONAL | FLIP_X;

/** `flags` followed by a quarter turn clockwise. */
export function rotateClockwise(flags: number): number {
  return compose(flags, TURN_CLOCKWISE);
}

/** Map a point in a tile's own cell units (y up) through the cell's flip flags. */
export function flipPoint(px: number, py: number, flags: number): [number, number] {
  // In image space (t down): the diagonal flip first, then the horizontal and vertical flips.
  let s = px, t = 1 - py;
  if (flags & FLIP_DIAGONAL) [s, t] = [t, s];
  if (flags & FLIP_X) s = 1 - s;
  if (flags & FLIP_Y) t = 1 - t;
  return [s, 1 - t];
}

/** The texture coordinate (s, t ∈ 0..1, t down) a drawn corner of a flipped tile samples: the inverse transform applied. */
export function sourceCorner(s: number, t: number, flags: number): [number, number] {
  // Each of the three steps is its own inverse; undo them in reverse order.
  if (flags & FLIP_Y) t = 1 - t;
  if (flags & FLIP_X) s = 1 - s;
  if (flags & FLIP_DIAGONAL) [s, t] = [t, s];
  return [s, t];
}
