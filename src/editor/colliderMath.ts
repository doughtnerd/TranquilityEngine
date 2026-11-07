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

// --- Character controller (an upright capsule that never turns with the node) -------------------

/** World size of an upright 2D capsule: radius × |scale.x|, half straight part = max(0, height × |scale.y| / 2 − radius). */
export function capsule2DSize(pose: Pose2D, radius: number, height: number): { radius: number; halfStraight: number } {
  const r = Math.abs(radius) * Math.abs(pose.scale[0]);
  return { radius: r, halfStraight: Math.max(0, (Math.abs(height) * Math.abs(pose.scale[1])) / 2 - r) };
}

/** An upright capsule's outline in world space (counter-clockwise from the right of the top cap), `segments` points per cap. */
export function capsule2DPoints(pose: Pose2D, center: V2, radius: number, height: number, segments = 16): [number, number, number][] {
  const c = toWorld(pose, center), { radius: r, halfStraight: hh } = capsule2DSize(pose, radius, height);
  const out: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI;
    out.push([c[0] + Math.cos(a) * r, c[1] + hh + Math.sin(a) * r, c[2]]);
  }
  for (let i = 0; i <= segments; i++) {
    const a = Math.PI + (i / segments) * Math.PI;
    out.push([c[0] + Math.cos(a) * r, c[1] - hh + Math.sin(a) * r, c[2]]);
  }
  return out;
}

export type CapsuleHandle2D = "radius-right" | "radius-left" | "height-top" | "height-bottom" | "center";

/** Handles for an upright capsule: the radius on both sides, the two ends, and the centre. */
export function capsule2DHandles(pose: Pose2D, center: V2, radius: number, height: number): Record<CapsuleHandle2D, [number, number, number]> {
  const c = toWorld(pose, center), { radius: r, halfStraight: hh } = capsule2DSize(pose, radius, height);
  return {
    "radius-right": [c[0] + r, c[1], c[2]],
    "radius-left": [c[0] - r, c[1], c[2]],
    "height-top": [c[0], c[1] + hh + r, c[2]],
    "height-bottom": [c[0], c[1] - hh - r, c[2]],
    center: c,
  };
}

/** Dragging a capsule's side handle to local point `p`: the radius (local units; the scale cancels). */
export function dragCapsule2DRadius(p: V2, center: V2): number {
  return Math.max(MIN_EXTENT, Math.abs(p[0] - center[0]));
}

/** Dragging a capsule's end handle to local point `p`: the height (both ends move). */
export function dragCapsule2DHeight(p: V2, center: V2): number {
  return Math.max(MIN_EXTENT, 2 * Math.abs(p[1] - center[1]));
}

/** Round away float noise so files stay readable. */
export const tidy = (n: number) => Math.round(n * 1e4) / 1e4;

/** True if world point `p` is inside the polygon `points` (on its plane; only X and Y are compared). */
export function pointInPolygon(p: readonly [number, number, ...number[]], points: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Area of the polygon `points` in the XY plane. */
export function polygonArea(points: readonly (readonly number[])[]): number {
  let twice = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) twice += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return Math.abs(twice) / 2;
}

// --- Polygon and edge colliders (ADR 0039) ------------------------------------------------------

/** Fewest points a polygon (closed) or edge (open) collider keeps when removing vertices. */
export const minPoints = (closed: boolean) => (closed ? 3 : 2);

/** A points collider's outline in world space: each point offset by `center`, then posed. */
export function pointsOutline(pose: Pose2D, center: V2, points: readonly V2[]): [number, number, number][] {
  return points.map((p) => toWorld(pose, [center[0] + p[0], center[1] + p[1]]));
}

/**
 * Handles for a points collider: `vertex:i` on each point, `insert:i` at the middle of the edge
 * from point i to the next (the closing edge too when `closed`), and `center`.
 */
export function pointsHandles(pose: Pose2D, center: V2, points: readonly V2[], closed: boolean): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  const n = points.length, edges = closed ? n : n - 1;
  points.forEach((p, i) => (out[`vertex:${i}`] = toWorld(pose, [center[0] + p[0], center[1] + p[1]])));
  for (let i = 0; i < edges; i++) {
    const a = points[i], b = points[(i + 1) % n];
    out[`insert:${i}`] = toWorld(pose, [center[0] + (a[0] + b[0]) / 2, center[1] + (a[1] + b[1]) / 2]);
  }
  out.center = toWorld(pose, center);
  return out;
}

/** Parse a points-collider handle id. */
export function pointsHandle(id: string): { kind: "vertex" | "insert"; index: number } | { kind: "center" } | null {
  if (id === "center") return { kind: "center" };
  const m = /^(vertex|insert):(\d+)$/.exec(id);
  return m ? { kind: m[1] as "vertex" | "insert", index: Number(m[2]) } : null;
}

/** `points` with point `index` moved to `p`. */
export function movePoint(points: readonly V2[], index: number, p: V2): [number, number][] {
  return points.map((q, i) => (i === index ? [p[0], p[1]] : [q[0], q[1]]));
}

/** `points` with a new point after `index` (on the edge to the next point), at `p` (default: the edge's middle). */
export function insertPoint(points: readonly V2[], index: number, p?: V2): [number, number][] {
  const a = points[index], b = points[(index + 1) % points.length];
  const at: [number, number] = p ? [p[0], p[1]] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const out = points.map((q) => [q[0], q[1]] as [number, number]);
  out.splice(index + 1, 0, at);
  return out;
}

/** `points` without point `index`, or null if that would leave fewer than the minimum. */
export function removePoint(points: readonly V2[], index: number, closed: boolean): [number, number][] | null {
  if (points.length <= minPoints(closed) || index < 0 || index >= points.length) return null;
  return points.filter((_, i) => i !== index).map((q) => [q[0], q[1]]);
}

/** Read a points field (plain `[x, y]` pairs, or anything with x and y), dropping malformed entries. */
export function readPoints(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  const out: [number, number][] = [];
  for (const p of value) {
    const x = Array.isArray(p) ? p[0] : (p as { x?: unknown } | null)?.x;
    const y = Array.isArray(p) ? p[1] : (p as { y?: unknown } | null)?.y;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}
