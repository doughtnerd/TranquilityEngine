// 2D pose maths for the physics gizmos (ADR 0022): a node's local XY plane to the world and back. Each
// collider type's outline, handles and drags are its entry in the collider shape table (`colliderShapes.ts`,
// ADR 0288); the physics backend sizes shapes as `engine/physics/shape2d.ts` says.

export type V2 = readonly [number, number];

/** A node's 2D world pose: position (with z), rotation in degrees, scale. */
export interface Pose2D {
  position: readonly [number, number, number];
  rotation: number;
  scale: V2;
}

const DEG = Math.PI / 180;
/** Smallest size or radius a drag can make. */
export const MIN_EXTENT = 0.01;

/** A point in the node's local space → world space (on the node's z plane). */
export function toWorld(pose: Pose2D, p: V2): [number, number, number] {
  const x = p[0] * pose.scale[0], y = p[1] * pose.scale[1];
  const c = Math.cos(pose.rotation * DEG), s = Math.sin(pose.rotation * DEG);
  return [pose.position[0] + x * c - y * s, pose.position[1] + x * s + y * c, pose.position[2]];
}

/** A world point → the node's local space (the inverse of `toWorld`). */
export function toLocal(pose: Pose2D, p: readonly [number, number, ...number[]]): [number, number] {
  const dx = p[0] - pose.position[0], dy = p[1] - pose.position[1];
  const c = Math.cos(-pose.rotation * DEG), s = Math.sin(-pose.rotation * DEG);
  const x = dx * c - dy * s, y = dx * s + dy * c;
  return [pose.scale[0] ? x / pose.scale[0] : 0, pose.scale[1] ? y / pose.scale[1] : 0];
}

/** Round away float noise so files stay readable. */
export const tidy = (n: number) => Math.round(n * 1e4) / 1e4;
