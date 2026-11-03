/**
 * @internal How 3D colliders size themselves (ADR 0045), shared by the physics backend and the
 * editor's collider gizmos so the two always agree:
 *
 * - box: `size` × the node's world scale, per axis;
 * - sphere: `radius` × the largest world scale axis;
 * - capsule: `radius` × the larger of the two axes across it, and `height` × the scale along it,
 *   never shorter than the capsule's diameter;
 * - every shape sits at `center` × world scale, turned with the node.
 */
export type V3 = [number, number, number];

export const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

const abs3 = (s: readonly number[]): V3 => [Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])];

/** A box's half extents in world units. */
export function boxHalfExtents(size: readonly number[], scale: readonly number[]): V3 {
  const s = abs3(scale);
  return [Math.abs(size[0] * s[0]) / 2, Math.abs(size[1] * s[1]) / 2, Math.abs(size[2] * s[2]) / 2];
}

/** A sphere's radius in world units. */
export function sphereRadius(radius: number, scale: readonly number[]): number {
  const s = abs3(scale);
  return Math.abs(radius) * Math.max(s[0], s[1], s[2]);
}

/** A capsule's radius and the half length of its straight part, in world units, along `axis` (0 x, 1 y, 2 z). */
export function capsuleSize(radius: number, height: number, axis: 0 | 1 | 2, scale: readonly number[]): { radius: number; halfHeight: number } {
  const s = abs3(scale);
  const across = Math.max(...s.filter((_, i) => i !== axis));
  const r = Math.abs(radius) * across;
  const total = Math.abs(height) * s[axis];
  return { radius: r, halfHeight: Math.max(0, total / 2 - r) };
}

/** The shape's offset from the node's origin in the node's (unscaled, turned) frame: `center` × world scale. */
export function scaledCenter(center: readonly number[], scale: readonly number[]): V3 {
  return [center[0] * scale[0], center[1] * scale[1], center[2] * scale[2]];
}
