// Internal (ADR 0094, 0250): the integer hashes and noise every kernel executor shares, in TypeScript
// (the JavaScript executor) and in KSL (`KERNEL_MATH_KSL`, the shaders' prelude, with u32 arithmetic),
// so the three executors draw the same random numbers.
import { shaderSource } from "../../shaderSource/shaderSource";

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

/** The noise's lattice hash (murmur3 finalizer). */
export function hashInt(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

const lattice = (x: number, y: number, z: number): number => (hashInt(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) / 4294967296) * 2 - 1;
const fade = (t: number): number => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth 3D value noise in [-1, 1]. */
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

/**
 * The functions above in KSL (`render/shaderSource`), as the kernel shaders include them: `k_pcg`,
 * `k_rand` (krand), `k_seed` (particleSeed), `k_hashInt`, `k_noise3`, `k_vnoise` (valueNoise), `k_hsv`,
 * `k_lin` and `k_toLinear` (srgbToLinear).
 */
export const KERNEL_MATH_SHADER = shaderSource(/* KSL */ `
FN(KU, k_pcg, KU v) {
  VAR(KU, state) = (v * 747796405u) + 2891336453u;
  VAR(KU, word) = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
FN(KF, k_rand, KF seed, KU salt) {
  return KF(k_pcg(KU(floor(seed * 16777216.0)) ^ k_pcg(salt)) >> 8u) / 16777216.0;
}
FN(KF, k_seed, KF index, KF frame, KF sys) {
  return KF(k_pcg(KU(index) ^ k_pcg(KU(frame) ^ k_pcg(KU(sys)))) >> 8u) / 16777216.0;
}
FN(KU, k_hashInt, KU x0) {
  VAR(KU, x) = x0;
  x = (x ^ (x >> 16u)) * 0x85ebca6bu;
  x = (x ^ (x >> 13u)) * 0xc2b2ae35u;
  return x ^ (x >> 16u);
}
FN(KF, k_lattice, KI x, KI y, KI z) {
  return KF(k_hashInt((KBITU(x) * 73856093u) ^ (KBITU(y) * 19349663u) ^ (KBITU(z) * 83492791u))) / 4294967296.0 * 2.0 - 1.0;
}
FN(KF, k_fade, KF t) {
  return t * t * (3.0 - 2.0 * t);
}
FN(KF, k_noise3, KF x, KF y, KF z) {
  VAR(KF, fx0) = floor(x);
  VAR(KF, fy0) = floor(y);
  VAR(KF, fz0) = floor(z);
  VAR(KI, ix) = KI(fx0);
  VAR(KI, iy) = KI(fy0);
  VAR(KI, iz) = KI(fz0);
  VAR(KF, fx) = k_fade(x - fx0);
  VAR(KF, fy) = k_fade(y - fy0);
  VAR(KF, fz) = k_fade(z - fz0);
  VAR(KF, a) = mix(mix(k_lattice(ix, iy, iz), k_lattice(ix + 1, iy, iz), fx), mix(k_lattice(ix, iy + 1, iz), k_lattice(ix + 1, iy + 1, iz), fx), fy);
  VAR(KF, b) = mix(mix(k_lattice(ix, iy, iz + 1), k_lattice(ix + 1, iy, iz + 1), fx), mix(k_lattice(ix, iy + 1, iz + 1), k_lattice(ix + 1, iy + 1, iz + 1), fx), fy);
  return mix(a, b, fz);
}
FN(KF, k_hash1, KI n, KI seed) {
  VAR(KU, x) = (KBITU(n) * 374761393u) + (KBITU(seed) * 668265263u);
  x = (x ^ (x >> 13u)) * 1274126177u;
  x = x ^ (x >> 16u);
  return KF(x) / 4294967295.0 * 2.0 - 1.0;
}
FN(KF, k_vnoise, KF x, KI seed) {
  VAR(KF, fi) = floor(x);
  VAR(KI, i) = KI(fi);
  VAR(KF, f) = x - fi;
  VAR(KF, u) = f * f * (3.0 - 2.0 * f);
  VAR(KF, a) = k_hash1(i, seed);
  return a + (k_hash1(i + 1, seed) - a) * u;
}
FN(KV4, k_hsv, KF h, KF s, KF v, KF a) {
  VAR(KF, hh) = (h - floor(h)) * 6.0;
  VAR(KF, fi) = floor(hh);
  VAR(KF, f) = hh - fi;
  VAR(KF, p) = v * (1.0 - s);
  VAR(KF, q) = v * (1.0 - s * f);
  VAR(KF, t) = v * (1.0 - s * (1.0 - f));
  VAR(KI, i) = KI(fi) % 6;
  if (i == 0) { return KV4(v, t, p, a); }
  if (i == 1) { return KV4(q, v, p, a); }
  if (i == 2) { return KV4(p, v, t, a); }
  if (i == 3) { return KV4(p, q, v, a); }
  if (i == 4) { return KV4(t, p, v, a); }
  return KV4(v, p, q, a);
}
FN(KF, k_lin, KF c) {
  return mix(pow((max(c, 0.0) + 0.055) / 1.055, 2.4), c / 12.92, step(c, 0.04045));
}
FN(KV4, k_toLinear, KV4 c) {
  return KV4(k_lin(c.x), k_lin(c.y), k_lin(c.z), c.w);
}
`);
