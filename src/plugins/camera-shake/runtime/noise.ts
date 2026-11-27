/**
 * Smooth, seeded 1D gradient noise (Perlin's, in one dimension): what camera shake's noise channels sample (ADR 0435).
 * Pure and deterministic: the same seed and time give the same value on every machine, so recorded runs replay.
 */

/** A 32-bit integer hash of `seed` and lattice point `i` (a small avalanche mix). */
function hash(seed: number, i: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The gradient at lattice point `i`: a slope in -1..1. */
const gradient = (seed: number, i: number): number => (hash(seed, i) / 0xffffffff) * 2 - 1;

/** Perlin's quintic fade, 6t⁵ − 15t⁴ + 10t³. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Gradient noise at `t` (one lattice cell per unit of `t`) for `seed`: continuous with a continuous slope, 0 at whole
 * numbers, and within -1..1 (scaled so it reaches about ±1).
 */
export function noise1(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = gradient(seed, i) * f;
  const b = gradient(seed, i + 1) * (f - 1);
  return 2 * (a + (b - a) * fade(f));
}
