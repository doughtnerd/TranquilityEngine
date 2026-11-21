// 3D pose maths for the physics gizmos (ADR 0045): turning by quaternions, a shape's world centre, and
// turning a pointer ray back into a handle's reach or a centre move. Each collider type's wireframe,
// handles and drags are its entry in the collider shape table (`colliderShapes.ts`, ADR 0288), sized as
// `engine/physics/shape3d.ts` says. Pure functions over plain arrays, so they're tested without a renderer.
import { scaledCenter, type V3 } from "../../../engine/physics/shape3d";

export type { V3 };
export type Quat = [number, number, number, number];

/** A node's world pose: position, rotation and (positive) scale. */
export interface Pose3D {
  position: V3;
  rotation: Quat;
  scale: V3;
}

/** A wireframe: open polylines in world space. */
export type Wire = V3[][];

/** `v` turned by the unit quaternion `q`. */
export function rotate(q: Quat, v: readonly number[]): V3 {
  const [x, y, z, w] = q;
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The node's local X, Y and Z axes in world space (unit length). */
export function axesOf(pose: Pose3D): [V3, V3, V3] {
  return [rotate(pose.rotation, [1, 0, 0]), rotate(pose.rotation, [0, 1, 0]), rotate(pose.rotation, [0, 0, 1])];
}

/** Where a shape with this `center` sits in the world. */
export function worldCenter(pose: Pose3D, center: readonly number[]): V3 {
  return add(pose.position, rotate(pose.rotation, scaledCenter(center, pose.scale)));
}

// --- dragging ----------------------------------------------------------------------------------

/**
 * Where along a line (through `point`, along the unit `axis`) a ray passes closest: the signed
 * distance from `point`; null when the ray runs along the line.
 */
export function closestOnAxis(origin: readonly number[], direction: readonly number[], point: readonly number[], axis: readonly number[]): number | null {
  const w = sub(point, origin);
  const b = dot(axis, direction), c = dot(direction, direction), d = dot(axis, w), e = dot(direction, w);
  const denom = c - b * b; // |axis| = 1
  if (Math.abs(denom) < 1e-9) return null;
  return (b * e - c * d) / denom;
}

/** A world-space move as a change of a shape's `center` (local units): turned back and unscaled. */
export function centerDelta(pose: Pose3D, worldDelta: readonly number[]): V3 {
  const local = rotate(conj(pose.rotation), worldDelta);
  return [local[0] / (pose.scale[0] || 1), local[1] / (pose.scale[1] || 1), local[2] / (pose.scale[2] || 1)];
}
