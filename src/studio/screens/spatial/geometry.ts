// The Spatial screen's plan geometry (ADR 0347; the prototype's rotated boxes, handles and routes, S:906-925, 1024-1028):
// a test scene seen from above, x to the right and z to the north (up the screen), height (y) out of the plan. Boxes
// turn by `yaw` degrees clockwise seen from above, as `AudioZone` and `AudioReverbZone` do (local +z goes to
// (sin yaw, cos yaw)). Positions snap to half a metre; turns snap to 5°.
//
// Pure: no DOM, no signals.
import { routeLength, routePose } from "../../../engine/audio/spatial/testScene";
import type { SceneBox, Vec3 } from "../../../engine/audio/spatial/testSceneTypes";

/** A point on the plan (metres). */
export interface P2 {
  readonly x: number;
  readonly z: number;
}

/** The grid positions snap to, metres. */
export const SNAP_M = 0.5;
/** The step a rotate knob snaps to, degrees. */
export const SNAP_DEG = 5;
/** The smallest a box gets by its handles, metres. */
export const MIN_BOX_SIZE = 0.5;

export const snap = (v: number, step = SNAP_M): number => Math.round(v / step) * step + 0; // + 0: no -0
export const snapPoint = (p: P2, step = SNAP_M): P2 => ({ x: snap(p.x, step), z: snap(p.z, step) });

const rad = (deg: number) => (deg * Math.PI) / 180;

/** An angle in degrees as -180 < a ≤ 180. */
export function normalizeDeg(a: number): number {
  const r = ((((a + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r + 0;
}

/** `p` in the box's own frame (x across its width, z along its depth, from its centre). */
export function toLocal(box: SceneBox, p: P2): P2 {
  const dx = p.x - box.center.x, dz = p.z - box.center.z;
  const c = Math.cos(rad(box.yaw)), s = Math.sin(rad(box.yaw));
  // The inverse of toWorld's turn.
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** A point of the box's own frame on the plan. */
export function toWorld(box: SceneBox, l: P2): P2 {
  const c = Math.cos(rad(box.yaw)), s = Math.sin(rad(box.yaw));
  return { x: box.center.x + l.x * c + l.z * s, z: box.center.z - l.x * s + l.z * c };
}

/** Whether `p` is inside the box seen from above. */
export function boxContains(box: SceneBox, p: P2): boolean {
  const l = toLocal(box, p);
  return Math.abs(l.x) <= box.width / 2 + 1e-9 && Math.abs(l.z) <= box.depth / 2 + 1e-9;
}

/** The four corners on the plan: south-west, south-east, north-east, north-west of the box's own frame. */
export function boxCorners(box: SceneBox): P2[] {
  const w = box.width / 2, d = box.depth / 2;
  return [{ x: -w, z: -d }, { x: w, z: -d }, { x: w, z: d }, { x: -w, z: d }].map((l) => toWorld(box, l));
}

/** Where the rotate knob sits: `offset` metres beyond the box's north edge, on its own axis. */
export const rotateKnob = (box: SceneBox, offset: number): P2 => toWorld(box, { x: 0, z: box.depth / 2 + offset });

/** The point of the box (seen from above) nearest `p`: `p` itself when inside (where an edge audio zone is heard from). */
export function nearestOnBox(box: SceneBox, p: P2): P2 {
  const l = toLocal(box, p);
  return toWorld(box, { x: Math.min(box.width / 2, Math.max(-box.width / 2, l.x)), z: Math.min(box.depth / 2, Math.max(-box.depth / 2, l.z)) });
}

/**
 * How deep `p` is inside the box, 0 at its edge (and outside, or outside bottom..top) to 1 at its middle: the zone's
 * `zoneDepth` (ADR 0347; the prototype's `min(w/2−|x|, d/2−|z|) / (min(w, d)/2)`), for the Inspector's readout.
 */
export function depthIn(box: SceneBox, p: P2 & { readonly y?: number }): number {
  if (p.y !== undefined && (p.y < box.bottom || p.y > box.top)) return 0;
  const l = toLocal(box, p);
  const inner = Math.min(box.width / 2 - Math.abs(l.x), box.depth / 2 - Math.abs(l.z));
  if (inner <= 0) return 0;
  return Math.min(1, inner / (Math.min(box.width, box.depth) / 2));
}

/** The box grown by `by` metres on every side (an audio zone's feather edge). */
export const growBox = (box: SceneBox, by: number): SceneBox => ({ ...box, width: box.width + 2 * by, depth: box.depth + 2 * by });

/** The box's extent along x (the side view's): the min and max x of its corners. */
export function boxSpanX(box: SceneBox): [number, number] {
  const xs = boxCorners(box).map((c) => c.x);
  return [Math.min(...xs), Math.max(...xs)];
}

/** The box resized by dragging a corner to `p`: symmetric about its centre (the opposite corner moves too), snapped. */
export function resizeFromCorner(box: SceneBox, p: P2): SceneBox {
  const l = toLocal(box, p);
  return { ...box, width: Math.max(MIN_BOX_SIZE, snap(2 * Math.abs(l.x))), depth: Math.max(MIN_BOX_SIZE, snap(2 * Math.abs(l.z))) };
}

/** The box turned so its north axis points at `p`, snapped to 5°, -180..180. */
export function rotateToward(box: SceneBox, p: P2): SceneBox {
  const dx = p.x - box.center.x, dz = p.z - box.center.z;
  if (dx === 0 && dz === 0) return box;
  const deg = (Math.atan2(dx, dz) * 180) / Math.PI;
  return { ...box, yaw: normalizeDeg(snap(deg, SNAP_DEG)) };
}

/** The box moved so its centre is at `p` (snapped). */
export const moveBox = (box: SceneBox, p: P2): SceneBox => ({ ...box, center: { x: snap(p.x), y: box.center.y, z: snap(p.z) } });

// --- routes ----------------------------------------------------------------------------------------------------------

const v3 = (p: P2): Vec3 => ({ x: p.x, y: 0, z: p.z });

/** The point at arc-length fraction `u` (0..1) of a route on the plan, and its travel direction. */
export function routeAt(route: readonly Vec3[], u: number): { point: P2; direction: P2 } {
  const out = { position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };
  routePose(route, 0, u, false, out);
  return { point: { x: out.position.x, z: out.position.z }, direction: { x: out.direction.x, z: out.direction.z } };
}

/** The arc-length fraction (0..1) of the route's point nearest `p`: a moving emitter dragged stays on its path. */
export function projectOnRoute(route: readonly Vec3[], p: P2): number {
  const total = routeLength(route);
  if (!(total > 0)) return 0;
  let best = Infinity, bestAt = 0, walked = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const len = Math.sqrt(len2);
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
    const qx = a.x + dx * t, qz = a.z + dz * t;
    const d = (p.x - qx) ** 2 + (p.z - qz) ** 2;
    if (d < best - 1e-12) {
      best = d;
      bestAt = walked + len * t;
    }
    walked += len;
  }
  return Math.min(1, Math.max(0, bestAt / total));
}

/** The middle of each segment (the path editor's "+" buttons), segment i between waypoints i and i + 1. */
export function routeMidpoints(route: readonly Vec3[]): P2[] {
  const out: P2[] = [];
  for (let i = 1; i < route.length; i++) out.push({ x: (route[i - 1]!.x + route[i]!.x) / 2, z: (route[i - 1]!.z + route[i]!.z) / 2 });
  return out;
}

export type RouteEdit = { readonly next: Vec3[] } | { readonly refused: string };

/** A waypoint inserted in the middle of segment `segment` (snapped). */
export function insertWaypoint(route: readonly Vec3[], segment: number, maxPoints: number): RouteEdit {
  if (segment < 0 || segment >= route.length - 1) return { refused: "there's no such segment" };
  if (route.length >= maxPoints) return { refused: `a route has at most ${maxPoints} waypoints` };
  const mid = snapPoint(routeMidpoints(route)[segment]!);
  const next = route.map((p) => ({ ...p }));
  next.splice(segment + 1, 0, v3(mid));
  return { next };
}

/** Waypoint `i` removed; a route keeps at least two. */
export function removeWaypoint(route: readonly Vec3[], i: number): RouteEdit {
  if (route.length <= 2) return { refused: "a route needs at least two waypoints" };
  if (i < 0 || i >= route.length) return { refused: "there's no such waypoint" };
  return { next: route.filter((_, k) => k !== i).map((p) => ({ ...p })) };
}

/** Waypoint `i` moved to `p` (snapped). */
export function moveWaypoint(route: readonly Vec3[], i: number, p: P2): RouteEdit {
  if (i < 0 || i >= route.length) return { refused: "there's no such waypoint" };
  return { next: route.map((q, k) => (k === i ? v3(snapPoint(p)) : { ...q })) };
}

/** The whole route moved by (dx, dz). */
export const shiftRoute = (route: readonly Vec3[], dx: number, dz: number): Vec3[] => route.map((p) => ({ x: p.x + dx, y: 0, z: p.z + dz }));

// --- bounds ----------------------------------------------------------------------------------------------------------

export interface Bounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** The bounds of some points, grown to at least `minSize` metres each way about their middle; null for none. */
export function boundsOf(points: readonly P2[], minSize = 20): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const grow = (lo: number, hi: number): [number, number] => {
    if (hi - lo >= minSize) return [lo, hi];
    const mid = (lo + hi) / 2;
    return [mid - minSize / 2, mid + minSize / 2];
  };
  const [x0, x1] = grow(minX, maxX), [z0, z1] = grow(minZ, maxZ);
  return { minX: x0, minZ: z0, maxX: x1, maxZ: z1 };
}

/** Distance between two points of the plan. */
export const planDistance = (a: P2, b: P2): number => Math.hypot(a.x - b.x, a.z - b.z);
