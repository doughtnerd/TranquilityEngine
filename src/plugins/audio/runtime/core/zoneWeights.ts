// Zone weights and sends, the pure maths of the zone manager (ADR 0162; api-and-models §1.5, §3.2, §4.4; architecture
// §3.3; contract S21; C5). The zone manager (`zones.ts`) caches each zone's world volume (`ZoneVolume`, rebuilt from
// the node's world matrix with `zoneVolumeFromMatrix`), measures each voice's distance outside it (`outsideDistance`),
// turns that into a weight over `blendDistance` (`zoneWeight`), normalises overlapping zones (`normalizeWeights`), and
// computes each send: `volume × min(4, reverbSend × sendCurve(d)) × weight × wetFactor(occlusion)` (`zoneSend`).
// Everything here is allocation-free: a frame calls it for every (voice, zone) pair.
import { evalCurve } from "../../../../engine/core/curve";
import type { SendCurve } from "../backend";

/** @internal §1.2, S21: `reverbSend × sendCurve(d)` is clamped to this. */
export const ZONE_SEND_CLAMP = 4;
/** @internal `ZoneVolume.shape`: an oriented box. */
export const ZONE_SHAPE_BOX = 0;
/** @internal `ZoneVolume.shape`: a sphere. */
export const ZONE_SHAPE_SPHERE = 1;

/**
 * @internal A zone's volume in world space (api-and-models §3.2: box: centre, half extents, inverse rotation; sphere:
 * centre, radius). Mutable and reused: the registry rebuilds it in place when the node's world matrix or a shape field
 * changes.
 */
export interface ZoneVolume {
  /** `ZONE_SHAPE_BOX` or `ZONE_SHAPE_SPHERE`. */
  shape: number;
  /** The volume's centre, world units. */
  cx: number;
  cy: number;
  cz: number;
  /**
   * Box: the world-to-zone rotation as three rows (each a unit world-space axis of the box), so a point's coordinate
   * along box axis k is `rk0·dx + rk1·dy + rk2·dz` with `d = p − centre`.
   */
  r00: number;
  r01: number;
  r02: number;
  r10: number;
  r11: number;
  r12: number;
  r20: number;
  r21: number;
  r22: number;
  /** Box: half extents along the three box axes, world units (never negative). */
  hx: number;
  hy: number;
  hz: number;
  /** Sphere: radius, world units (never negative). */
  radius: number;
}

/** @internal A zero-sized box at the origin with the identity rotation (radius 0). */
export function makeZoneVolume(): ZoneVolume {
  throw new Error("not implemented: L-C5a");
}

/**
 * @internal Rebuilds `out` from a node's world matrix and the zone's fields (§1.5). `m` is column-major (the engine's
 * `Mat4`: column k is `m[o + 4k .. o + 4k + 2]`, translation at `m[o + 12 .. o + 14]`). The world centre is the matrix
 * applied to the local `center` point. Box: half extents are `size / 2` times each column's length (the node's world
 * scale per axis); the rotation rows are the normalised columns. Sphere: `radius` times the largest column length.
 * Negative sizes or radius count as 0; a zero-length column gives the matching unit axis and a half extent of 0.
 * Returns `out`.
 */
export function zoneVolumeFromMatrix(
  out: ZoneVolume,
  m: ArrayLike<number>,
  o: number,
  shape: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  radius: number,
): ZoneVolume {
  void out; void m; void o; void shape; void centerX; void centerY; void centerZ; void sizeX; void sizeY; void sizeZ; void radius;
  throw new Error("not implemented: L-C5a");
}

/**
 * @internal How far the world point (x, y, z) lies outside `v`, world units: 0 inside or on the surface. Box: the
 * length of `max(|local| − half, 0)` per axis; sphere: `max(0, |p − centre| − radius)`.
 */
export function outsideDistance(v: ZoneVolume, x: number, y: number, z: number): number {
  void v; void x; void y; void z;
  throw new Error("not implemented: L-C5a");
}

/**
 * @internal A point's weight in a zone from its distance outside the volume (architecture §3.3): 1 inside (`outside`
 * ≤ 0), falling linearly to 0 at `blendDistance`, 0 beyond. `blendDistance` ≤ 0 (or not finite) is a hard edge: 1
 * inside, 0 at any positive distance. A non-finite `outside` is 0.
 */
export function zoneWeight(outside: number, blendDistance: number): number {
  void outside; void blendDistance;
  throw new Error("not implemented: L-C5a");
}

/**
 * @internal Normalises the first `n` weights of `w` in place for overlapping zones (architecture §3.3, equal power):
 * with `norm = √Σ w²`, every weight is divided by `norm` only when `norm > 1`, so a single zone's blend edge keeps its
 * fade. Returns the total weight, `min(1, norm)` (the listener's total gives `sharedReturnGain = 1 − total`). `n` 0
 * returns 0.
 */
export function normalizeWeights(w: Float32Array, n: number): number {
  void w; void n;
  throw new Error("not implemented: L-C5a");
}

/**
 * @internal The send curve's x for a distance (§1.1): `(d − minDistance) / (maxDistance − minDistance)` clamped to
 * 0..1. When `maxDistance ≤ minDistance`: 0 at or below `minDistance`, else 1. A non-finite `d` is 0.
 */
export function sendCurveX(distance: number, minDistance: number, maxDistance: number): number {
  void distance; void minDistance; void maxDistance;
  throw new Error("not implemented: L-C5a");
}

/** @internal The send curve's gain at `distance` (`evalCurve(curve, sendCurveX(…))`). */
export function sendCurveGain(curve: SendCurve, distance: number, minDistance: number, maxDistance: number): number {
  void curve; void distance; void minDistance; void maxDistance; void evalCurve;
  throw new Error("not implemented: L-C5a");
}

/**
 * @internal The wet factor occlusion leaves on a send (architecture §3.2): `1 − (1 − occGain) × wetOcclusion`, with
 * both inputs clamped to 0..1 (non-finite: `occGain` 1, `wetOcclusion` 0).
 */
export function wetFactor(occGain: number, wetOcclusion: number): number {
  void occGain; void wetOcclusion;
  throw new Error("not implemented: L-C5a");
}

/**
 * @internal A voice's send into one zone (§4.4, S21): `volume × min(ZONE_SEND_CLAMP, reverbSend × curveGain) × weight
 * × wet`. Any input that is negative or not finite makes the send 0.
 */
export function zoneSend(volume: number, reverbSend: number, curveGain: number, weight: number, wet: number): number {
  void volume; void reverbSend; void curveGain; void weight; void wet;
  throw new Error("not implemented: L-C5a");
}
