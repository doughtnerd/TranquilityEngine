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
  return {
    shape: ZONE_SHAPE_BOX,
    cx: 0, cy: 0, cz: 0,
    r00: 1, r01: 0, r02: 0,
    r10: 0, r11: 1, r12: 0,
    r20: 0, r21: 0, r22: 1,
    hx: 0, hy: 0, hz: 0,
    radius: 0,
  };
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
  // Column k of the matrix: (m[o+4k], m[o+4k+1], m[o+4k+2]). Its length is the node's world scale along axis k.
  const c0x = m[o], c0y = m[o + 1], c0z = m[o + 2];
  const c1x = m[o + 4], c1y = m[o + 5], c1z = m[o + 6];
  const c2x = m[o + 8], c2y = m[o + 9], c2z = m[o + 10];
  const l0 = Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z);
  const l1 = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  const l2 = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z);

  // World centre: the matrix applied to the local centre point.
  out.cx = c0x * centerX + c1x * centerY + c2x * centerZ + m[o + 12];
  out.cy = c0y * centerX + c1y * centerY + c2y * centerZ + m[o + 13];
  out.cz = c0z * centerX + c1z * centerY + c2z * centerZ + m[o + 14];

  if (shape === ZONE_SHAPE_SPHERE) {
    out.shape = ZONE_SHAPE_SPHERE;
    out.r00 = 1; out.r01 = 0; out.r02 = 0;
    out.r10 = 0; out.r11 = 1; out.r12 = 0;
    out.r20 = 0; out.r21 = 0; out.r22 = 1;
    out.hx = 0; out.hy = 0; out.hz = 0;
    out.radius = Math.max(0, radius) * Math.max(l0, l1, l2);
    return out;
  }

  out.shape = ZONE_SHAPE_BOX;
  // Rotation rows: the normalised columns. A zero-length column gives the matching unit axis.
  if (l0 > 0) { out.r00 = c0x / l0; out.r01 = c0y / l0; out.r02 = c0z / l0; }
  else { out.r00 = 1; out.r01 = 0; out.r02 = 0; }
  if (l1 > 0) { out.r10 = c1x / l1; out.r11 = c1y / l1; out.r12 = c1z / l1; }
  else { out.r10 = 0; out.r11 = 1; out.r12 = 0; }
  if (l2 > 0) { out.r20 = c2x / l2; out.r21 = c2y / l2; out.r22 = c2z / l2; }
  else { out.r20 = 0; out.r21 = 0; out.r22 = 1; }
  // Half extents: size / 2 scaled by each axis's world length. Negative sizes count as 0.
  out.hx = (Math.max(0, sizeX) / 2) * l0;
  out.hy = (Math.max(0, sizeY) / 2) * l1;
  out.hz = (Math.max(0, sizeZ) / 2) * l2;
  out.radius = 0;
  return out;
}

/**
 * @internal How far the world point (x, y, z) lies outside `v`, world units: 0 inside or on the surface. Box: the
 * length of `max(|local| − half, 0)` per axis; sphere: `max(0, |p − centre| − radius)`.
 */
export function outsideDistance(v: ZoneVolume, x: number, y: number, z: number): number {
  const dx = x - v.cx, dy = y - v.cy, dz = z - v.cz;
  if (v.shape === ZONE_SHAPE_SPHERE) {
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - v.radius;
    return d > 0 ? d : 0;
  }
  // Coordinate along each box axis, then the excess beyond that axis's half extent.
  const a0 = v.r00 * dx + v.r01 * dy + v.r02 * dz;
  const a1 = v.r10 * dx + v.r11 * dy + v.r12 * dz;
  const a2 = v.r20 * dx + v.r21 * dy + v.r22 * dz;
  const q0 = Math.max(Math.abs(a0) - v.hx, 0);
  const q1 = Math.max(Math.abs(a1) - v.hy, 0);
  const q2 = Math.max(Math.abs(a2) - v.hz, 0);
  return Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2);
}

/**
 * @internal A point's weight in a zone from its distance outside the volume (architecture §3.3): 1 inside (`outside`
 * ≤ 0), falling linearly to 0 at `blendDistance`, 0 beyond. `blendDistance` ≤ 0 (or not finite) is a hard edge: 1
 * inside, 0 at any positive distance. A non-finite `outside` is 0.
 */
export function zoneWeight(outside: number, blendDistance: number): number {
  if (!Number.isFinite(outside)) return 0;
  if (outside <= 0) return 1;
  // Hard edge: blend 0, negative, NaN or infinite.
  if (!(blendDistance > 0) || !Number.isFinite(blendDistance)) return 0;
  const w = 1 - outside / blendDistance;
  return w > 0 ? w : 0;
}

/**
 * @internal Normalises the first `n` weights of `w` in place for overlapping zones (architecture §3.3, equal power):
 * with `norm = √Σ w²`, every weight is divided by `norm` only when `norm > 1`, so a single zone's blend edge keeps its
 * fade. Returns the total weight, `min(1, norm)` (the listener's total gives `sharedReturnGain = 1 − total`). `n` 0
 * returns 0.
 */
export function normalizeWeights(w: Float32Array, n: number): number {
  const count = Math.min(n, w.length);
  if (!(count > 0)) return 0;
  let sumSq = 0;
  for (let i = 0; i < count; i++) sumSq += w[i] * w[i];
  const norm = Math.sqrt(sumSq);
  if (norm > 1) {
    for (let i = 0; i < count; i++) w[i] /= norm;
  }
  return norm < 1 ? norm : 1;
}

/**
 * @internal The send curve's x for a distance (§1.1): `(d − minDistance) / (maxDistance − minDistance)` clamped to
 * 0..1. When `maxDistance ≤ minDistance`: 0 at or below `minDistance`, else 1. A non-finite `d` is 0.
 */
export function sendCurveX(distance: number, minDistance: number, maxDistance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (maxDistance <= minDistance) return distance <= minDistance ? 0 : 1;
  const x = (distance - minDistance) / (maxDistance - minDistance);
  if (!(x > 0)) return 0;
  return x < 1 ? x : 1;
}

/** @internal The send curve's gain at `distance` (`evalCurve(curve, sendCurveX(…))`). */
export function sendCurveGain(curve: SendCurve, distance: number, minDistance: number, maxDistance: number): number {
  return evalCurve(curve, sendCurveX(distance, minDistance, maxDistance));
}

/**
 * @internal The wet factor occlusion leaves on a send (architecture §3.2): `1 − (1 − occGain) × wetOcclusion`, with
 * both inputs clamped to 0..1 (non-finite: `occGain` 1, `wetOcclusion` 0).
 */
export function wetFactor(occGain: number, wetOcclusion: number): number {
  const occ = Number.isFinite(occGain) ? clamp01(occGain) : 1;
  const wet = Number.isFinite(wetOcclusion) ? clamp01(wetOcclusion) : 0;
  return 1 - (1 - occ) * wet;
}

/**
 * @internal A voice's send into one zone (§4.4, S21): `volume × min(ZONE_SEND_CLAMP, reverbSend × curveGain) × weight
 * × wet`. Any input that is negative or not finite makes the send 0.
 */
export function zoneSend(volume: number, reverbSend: number, curveGain: number, weight: number, wet: number): number {
  if (!(isNonNegFinite(volume) && isNonNegFinite(reverbSend) && isNonNegFinite(curveGain)
    && isNonNegFinite(weight) && isNonNegFinite(wet))) return 0;
  const curved = reverbSend * curveGain;
  const clamped = curved < ZONE_SEND_CLAMP ? curved : ZONE_SEND_CLAMP;
  return volume * clamped * weight * wet;
}

/** Clamps to 0..1 (the caller has ensured `v` is finite). */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isNonNegFinite(v: number): boolean {
  return v >= 0 && Number.isFinite(v);
}
