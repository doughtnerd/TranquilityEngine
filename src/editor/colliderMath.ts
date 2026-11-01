// Collider gizmo geometry (ADR 0022): where a 2D collider's outline and handles are in the world,
// and how dragging a handle changes the collider. Pure math in the node's local XY plane; the
// physics backend sizes shapes the same way (box: size × world scale; circle: radius × the
// larger world scale axis; the centre offset is scaled and rotated with the node).

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

export type BoxHandle = "left" | "right" | "top" | "bottom" | "center";
export type CircleHandle = "radius-right" | "radius-top" | "radius-left" | "radius-bottom" | "center";

/** A box collider's four corners in world space, counter-clockwise from bottom-left. */
export function boxCorners(pose: Pose2D, center: V2, size: V2): [number, number, number][] {
  const hx = size[0] / 2, hy = size[1] / 2;
  return [
    [center[0] - hx, center[1] - hy],
    [center[0] + hx, center[1] - hy],
    [center[0] + hx, center[1] + hy],
    [center[0] - hx, center[1] + hy],
  ].map((p) => toWorld(pose, p as unknown as V2));
}

/** Handle positions for a box collider: the middle of each edge, and its centre. */
export function boxHandles(pose: Pose2D, center: V2, size: V2): Record<BoxHandle, [number, number, number]> {
  const hx = size[0] / 2, hy = size[1] / 2, [cx, cy] = center;
  return {
    left: toWorld(pose, [cx - hx, cy]),
    right: toWorld(pose, [cx + hx, cy]),
    top: toWorld(pose, [cx, cy + hy]),
    bottom: toWorld(pose, [cx, cy - hy]),
    center: toWorld(pose, center),
  };
}

/** World radius of a circle collider (radius × the larger scale axis, like the physics backend). */
export const worldRadius = (pose: Pose2D, radius: number) => Math.abs(radius) * Math.max(Math.abs(pose.scale[0]), Math.abs(pose.scale[1]));

/** A circle collider's outline in world space, as `segments` points. */
export function circlePoints(pose: Pose2D, center: V2, radius: number, segments = 48): [number, number, number][] {
  const c = toWorld(pose, center), r = worldRadius(pose, radius);
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2]] as [number, number, number];
  });
}

/** Handle positions for a circle collider: four points on the rim (following the node's rotation), and its centre. */
export function circleHandles(pose: Pose2D, center: V2, radius: number): Record<CircleHandle, [number, number, number]> {
  const c = toWorld(pose, center), r = worldRadius(pose, radius);
  const at = (deg: number): [number, number, number] => [c[0] + Math.cos((pose.rotation + deg) * DEG) * r, c[1] + Math.sin((pose.rotation + deg) * DEG) * r, c[2]];
  return { "radius-right": at(0), "radius-top": at(90), "radius-left": at(180), "radius-bottom": at(270), center: c };
}

/**
 * Dragging a box edge to local point `p`: the edge follows the pointer and the opposite edge stays
 * put (the centre moves by half), or with `symmetric` both edges move (the centre stays).
 */
export function dragBoxEdge(handle: Exclude<BoxHandle, "center">, p: V2, center: V2, size: V2, symmetric = false): { center: [number, number]; size: [number, number] } {
  const axis = handle === "left" || handle === "right" ? 0 : 1;
  const sign = handle === "right" || handle === "top" ? 1 : -1;
  const c: [number, number] = [center[0], center[1]], s: [number, number] = [size[0], size[1]];
  if (symmetric) {
    s[axis] = Math.max(MIN_EXTENT, Math.abs(p[axis] - center[axis]) * 2);
  } else {
    const fixed = center[axis] - (sign * size[axis]) / 2; // the opposite edge
    const moving = sign > 0 ? Math.max(p[axis], fixed + MIN_EXTENT) : Math.min(p[axis], fixed - MIN_EXTENT);
    s[axis] = Math.abs(moving - fixed);
    c[axis] = (moving + fixed) / 2;
  }
  return { center: c, size: s };
}

/** Dragging a circle's rim handle to local point `p` (in the node's local space). */
export function dragCircleRadius(pose: Pose2D, p: V2, center: V2): number {
  // Measure in world space, then undo the scale the physics backend applies.
  const w = toWorld(pose, p), c = toWorld(pose, center);
  const scale = Math.max(Math.abs(pose.scale[0]), Math.abs(pose.scale[1])) || 1;
  return Math.max(MIN_EXTENT, Math.hypot(w[0] - c[0], w[1] - c[1]) / scale);
}

/** Round away float noise so files stay readable. */
export const tidy = (n: number) => Math.round(n * 1e4) / 1e4;
