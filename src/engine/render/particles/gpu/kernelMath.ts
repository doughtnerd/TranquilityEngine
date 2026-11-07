// Internal (ADR 0094): the integer hashes and noise every kernel executor shares. The WGSL and GLSL
// preludes (`kernelShader.ts`) implement the same functions with u32 arithmetic, so the three
// executors draw the same random numbers.

/** PCG hash of a u32. */
export function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** A particle's seed: 24 bits (exact in f32) from its slot, the spawn frame and the system seed. */
export function particleSeed(index: number, frame: number, systemSeed: number): number {
  return (pcg((index >>> 0) ^ pcg((frame >>> 0) ^ pcg(systemSeed >>> 0))) >>> 8) / 16777216;
}

/** A stable random in [0, 1) for a particle (`seed` in [0, 1)) and a salt: 24 bits, exact in f32 on every executor. */
export function krand(seed: number, salt: number): number {
  return (pcg((Math.floor(seed * 16777216) >>> 0) ^ pcg(salt >>> 0)) >>> 8) / 16777216;
}

/** The CPU simulation's lattice hash (murmur3 finalizer). */
export function hashInt(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

const lattice = (x: number, y: number, z: number): number => (hashInt(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) / 4294967296) * 2 - 1;
const fade = (t: number): number => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth 3D value noise in [-1, 1] (as the CPU simulation's). */
export function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const fz = fade(z - iz);
  return mix(
    mix(mix(lattice(ix, iy, iz), lattice(ix + 1, iy, iz), fx), mix(lattice(ix, iy + 1, iz), lattice(ix + 1, iy + 1, iz), fx), fy),
    mix(mix(lattice(ix, iy, iz + 1), lattice(ix + 1, iy, iz + 1), fx), mix(lattice(ix, iy + 1, iz + 1), lattice(ix + 1, iy + 1, iz + 1), fx), fy),
    fz,
  );
}

/** The Noise node's hash (`particleNodes.ts`), in -1..1. */
function hash1(n: number, seed: number): number {
  let x = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

/** The Noise node's smooth 1D value noise. */
export function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i, seed);
  return a + (hash1(i + 1, seed) - a) * u;
}

/** HSV (hue wraps) to RGBA. */
export function hsv(h: number, s: number, v: number, a: number): [number, number, number, number] {
  const hh = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const rgb = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return [rgb[0], rgb[1], rgb[2], a];
}

export const srgbToLinear = (x: number): number => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
