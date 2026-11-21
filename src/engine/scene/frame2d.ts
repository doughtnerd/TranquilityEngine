/**
 * @internal A node's 2D frame (ADR 0301): its world matrix read as position, angle, signed per-axis scale and
 * whether it is mirrored, such that `T(position) · R(angle) · diag(scale)` is the matrix's XY part (shear aside).
 * The one reading of a 2D world pose: `Transform.worldRotation2D`, the 2D physics world, its tilemap colliders
 * and the 2D collider and joint gizmos all go through it, and physics writes a pose back through its inverse
 * (`localAngle2D`), which keeps the node's mirroring.
 *
 * **The mirror rule.** A matrix with a negative determinant is mirrored, and the mirror is carried on x: the
 * scale's x is negative and its y positive, and the angle is that of the frame's (unmirrored) x axis. A node
 * scaled (-1, 1) and turned θ reads angle θ and scale (-1, 1) (not "turned θ + π, unmirrored", which puts every
 * offset, point and anchor upside down). A node scaled (1, -1) reads angle π and scale (-1, 1): the same matrix.
 */
import type { GameObject } from "./GameObject";

export type V2 = readonly [number, number];

/** A 2D frame: `T(position) · R(angle) · diag(scale)`. */
export interface Frame2D {
  /** World position (with z: 2D shapes lie on the node's z plane). */
  readonly position: readonly [number, number, number];
  /** Radians, counter-clockwise. */
  readonly angle: number;
  /** Signed scale along the frame's own axes; a mirrored frame's x is negative. */
  readonly scale: V2;
  /** The determinant is negative: the frame flips handedness (winding). */
  readonly mirrored: boolean;
}

/** A frame from its parts; `mirrored` follows the scale's signs. */
export function frame2D(position: readonly [number, number, number], angle: number, scale: V2): Frame2D {
  return { position, angle, scale, mirrored: scale[0] * scale[1] < 0 };
}

/** The identity frame at the origin. */
export const IDENTITY_FRAME2D: Frame2D = frame2D([0, 0, 0], 0, [1, 1]);

/** The 2D frame of a column-major 4×4 matrix at `m[o]` (an engine world matrix). */
export function frame2DFromMatrix(m: ArrayLike<number>, o = 0): Frame2D {
  const a = m[o], b = m[o + 1], c = m[o + 4], d = m[o + 5];
  const det = a * d - b * c, len = Math.hypot(a, b);
  const mirrored = det < 0;
  const position: [number, number, number] = [m[o + 12], m[o + 13], m[o + 14]];
  if (len < 1e-12) {
    // No x axis: take the angle from the y axis.
    return { position, angle: Math.atan2(-c, d), scale: [0, Math.hypot(c, d)], mirrored: false };
  }
  const sx = mirrored ? -len : len;
  return { position, angle: mirrored ? Math.atan2(-b, -a) : Math.atan2(b, a), scale: [sx, det / sx], mirrored };
}

/** A node's 2D world frame; the identity for a node without a transform. */
export function frame2DOf(node: GameObject): Frame2D {
  if (!node.transform) return IDENTITY_FRAME2D;
  return frame2DFromMatrix(node.world.worldMatrix(node.entity), node.entity * 16);
}

/** The frame without its turn (a character controller's upright capsule): the same position and signed scale. */
export const upright2D = (f: Frame2D): Frame2D => (f.angle === 0 ? f : { ...f, angle: 0 });

/** A vector in the frame's local space, in world space (scaled and turned, not moved). */
export function frameDirection(f: Frame2D, v: V2): [number, number] {
  const x = v[0] * f.scale[0], y = v[1] * f.scale[1];
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  return [x * c - y * s, x * s + y * c];
}

/** A point in the frame's local space, in world space (on the frame's z plane). */
export function frameToWorld(f: Frame2D, p: V2): [number, number, number] {
  const [x, y] = frameDirection(f, p);
  return [f.position[0] + x, f.position[1] + y, f.position[2]];
}

/** A world point in the frame's local space (the inverse of `frameToWorld`; 0 along an axis scaled to nothing). */
export function frameToLocal(f: Frame2D, p: readonly [number, number, ...number[]]): [number, number] {
  const dx = p[0] - f.position[0], dy = p[1] - f.position[1];
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  const x = dx * c + dy * s, y = -dx * s + dy * c;
  return [f.scale[0] ? x / f.scale[0] : 0, f.scale[1] ? y / f.scale[1] : 0];
}

/**
 * The inverse, for writing a pose back: the local Z rotation (radians) that gives a node the world angle `angle`
 * while keeping its world `scale` (its frame's, so its mirroring), under a parent whose world matrix is at
 * `parent[po]` (null: no parent), for a node of local scale `localScale`.
 */
export function localAngle2D(angle: number, scale: V2, parent: ArrayLike<number> | null, po: number, localScale: V2): number {
  const c = Math.cos(angle), s = Math.sin(angle);
  // The wanted world XY part: R(angle) · diag(scale), column-major [w00, w10, w01, w11].
  let w00 = c * scale[0], w10 = s * scale[0], w01 = -s * scale[1], w11 = c * scale[1];
  if (parent) {
    // Local = parent⁻¹ · world (the parent's XY part).
    const p00 = parent[po], p10 = parent[po + 1], p01 = parent[po + 4], p11 = parent[po + 5];
    const det = p00 * p11 - p01 * p10;
    if (Math.abs(det) > 1e-12) {
      const i00 = p11 / det, i01 = -p01 / det, i10 = -p10 / det, i11 = p00 / det;
      [w00, w10, w01, w11] = [i00 * w00 + i01 * w10, i10 * w00 + i11 * w10, i00 * w01 + i01 * w11, i10 * w01 + i11 * w11];
    }
  }
  // Local = R(φ) · diag(localScale): undo the local scale on one column and read φ off it.
  if (localScale[0]) return Math.atan2(w10 / localScale[0], w00 / localScale[0]);
  if (localScale[1]) return Math.atan2(-w01 / localScale[1], w11 / localScale[1]);
  return angle;
}
