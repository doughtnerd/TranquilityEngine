/**
 * Deterministic per-cell randomness for tilemaps (ADR 0400): a number in [0, 1) from a seed, a cell and a stream,
 * the same on every call and every machine. Auto-tiling's variant choice and the random brush draw from it, so a
 * cell keeps its variant until what it must look like changes, and the same strokes always paint the same map.
 * Pure: integers in, a number out.
 */

/** The stream auto-tiling picks a terrain cell's variant from. */
export const TERRAIN_STREAM = 0;
/** The stream the random brush (and `Tilemap.fillRect` with several ids) picks a cell's tile from. */
export const RANDOM_BRUSH_STREAM = 1;
/** The stream an animated tile with `start: "random"` draws its cell's start offset from (ADR 0421). */
export const ANIMATION_STREAM = 2;

/** A 32-bit avalanche (MurmurHash3's finaliser): every input bit flips about half the output bits. */
function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A uniform number in [0, 1) for cell (x, y) under `seed`, from `stream`. Coordinates and seed are taken as 32-bit integers. */
export function cellRandom(seed: number, x: number, y: number, stream = TERRAIN_STREAM): number {
  let h = mix((seed | 0) ^ 0x9e3779b9);
  h = mix(h ^ Math.imul(x | 0, 0x27d4eb2d));
  h = mix(h ^ Math.imul(y | 0, 0x165667b1));
  h = mix(h ^ Math.imul(stream | 0, 0x61c88647));
  return h / 4294967296;
}

/** A new seed in [0, 2³¹) other than `current`, for re-rolling a map's variants. */
export function newSeed(current: number, random: () => number = Math.random): number {
  const s = Math.floor(random() * 0x8000_0000) % 0x8000_0000;
  return s === current ? (s + 1) % 0x8000_0000 : s;
}
