/**
 * A tile's flip flags as transforms of its unit cell (ADR 0103): the diagonal flip, then the
 * horizontal and vertical flips (as Tiled). Pure; collision maps polygon points through them,
 * the chunk meshes map drawn corners back to the texture.
 */
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y } from "./format";

/** Map a point in a tile's own cell units through the cell's flip flags. */
export function flipPoint(px: number, py: number, flags: number): [number, number] {
  // In image space (t down): the diagonal flip first, then the horizontal and vertical flips (as Tiled).
  let s = px, t = 1 - py;
  if (flags & FLIP_DIAGONAL) [s, t] = [t, s];
  if (flags & FLIP_X) s = 1 - s;
  if (flags & FLIP_Y) t = 1 - t;
  return [s, 1 - t];
}

/** The texture coordinate (s, t ∈ 0..1, t down) a drawn corner of a flipped tile samples. */
export function sourceCorner(s: number, t: number, flags: number): [number, number] {
  // Drawn = vertical ∘ horizontal ∘ diagonal (source), each its own inverse, so undo them in reverse.
  if (flags & FLIP_Y) t = 1 - t;
  if (flags & FLIP_X) s = 1 - s;
  if (flags & FLIP_DIAGONAL) [s, t] = [t, s];
  return [s, t];
}
