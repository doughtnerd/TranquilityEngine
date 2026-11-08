// Geometry for the 3D collider gizmos (ADR 0045): wireframes in world space and the handles that
// resize them, sized exactly as the physics backend sizes the shapes (engine/physics/shape3d.ts).
// Pure functions over plain arrays, so they're tested without a renderer.
import { AXIS_INDEX, boxHalfExtents, capsuleSize, scaledCenter, sphereRadius, type V3 } from "../../../engine/physics/shape3d";
import { MIN_EXTENT } from "./colliderMath";

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
const scale3 = (a: readonly number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The node's local X, Y and Z axes in world space (unit length). */
export function axesOf(pose: Pose3D): [V3, V3, V3] {
  return [rotate(pose.rotation, [1, 0, 0]), rotate(pose.rotation, [0, 1, 0]), rotate(pose.rotation, [0, 0, 1])];
}

/** Where a shape with this `center` sits in the world. */
export function worldCenter(pose: Pose3D, center: readonly number[]): V3 {
  return add(pose.position, rotate(pose.rotation, scaledCenter(center, pose.scale)));
}

/** A point given in the shape's turned (unscaled) frame, in world space. */
const at = (pose: Pose3D, c: V3, local: readonly number[]): V3 => add(c, rotate(pose.rotation, local));

/** A circle of radius `r` around `c` in the plane of axes `u` and `v` (world). */
function circle(c: V3, u: V3, v: V3, r: number, from = 0, to = Math.PI * 2, n = 32): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    pts.push(add(c, add(scale3(u, Math.cos(a) * r), scale3(v, Math.sin(a) * r))));
  }
  return pts;
}

// --- box ---------------------------------------------------------------------------------------

export type BoxFace3D = "x+" | "x-" | "y+" | "y-" | "z+" | "z-";
export const BOX_FACES: readonly BoxFace3D[] = ["x+", "x-", "y+", "y-", "z+", "z-"];

export function boxWire(pose: Pose3D, center: readonly number[], size: readonly number[]): Wire {
  const h = boxHalfExtents(size, pose.scale), c = worldCenter(pose, center);
  const corner = (i: number) => at(pose, c, [i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]]);
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return edges.map(([a, b]) => [corner(a), corner(b)]);
}

/** A handle on each face's centre, and one on the centre. */
export function boxHandles3D(pose: Pose3D, center: readonly number[], size: readonly number[]): Record<BoxFace3D | "center", V3> {
  const h = boxHalfExtents(size, pose.scale), c = worldCenter(pose, center);
  const out = { center: c } as Record<BoxFace3D | "center", V3>;
  for (const face of BOX_FACES) {
    const i = AXIS_INDEX[face[0] as "x"], local: V3 = [0, 0, 0];
    local[i] = face[1] === "+" ? h[i] : -h[i];
    out[face] = at(pose, c, local);
  }
  return out;
}

/**
 * A box after dragging `face` to `t` metres from the box's centre (at the drag's start) along
 * that face's axis: the opposite face stays put, or (`symmetric`, Alt) both move. In local units.
 */
export function dragBoxFace3D(face: BoxFace3D, t: number, pose: Pose3D, startCenter: readonly number[], startSize: readonly number[], symmetric = false): { center: V3; size: V3 } {
  const i = AXIS_INDEX[face[0] as "x"], sign = face[1] === "+" ? 1 : -1;
  const s = Math.abs(pose.scale[i]) || 1;
  const half = (Math.abs(startSize[i]) * s) / 2;
  const reach = sign * t; // how far the face is from the centre, outwards positive
  const center: V3 = [startCenter[0], startCenter[1], startCenter[2]];
  const size: V3 = [startSize[0], startSize[1], startSize[2]];
  if (symmetric) {
    size[i] = Math.max(MIN_EXTENT, (2 * reach) / s);
  } else {
    const world = Math.max(MIN_EXTENT * s, reach + half); // from the fixed face to the dragged one
    size[i] = world / s;
    center[i] = startCenter[i] + (sign * (world / 2 - half)) / (pose.scale[i] || 1);
  }
  return { center, size };
}

// --- sphere ------------------------------------------------------------------------------------

export function sphereWire(pose: Pose3D, center: readonly number[], radius: number): Wire {
  const r = sphereRadius(radius, pose.scale), c = worldCenter(pose, center), [x, y, z] = axesOf(pose);
  return [circle(c, x, y, r), circle(c, x, z, r), circle(c, y, z, r)];
}

/** A handle at each end of the sphere's three axes, and one on the centre. */
export function sphereHandles3D(pose: Pose3D, center: readonly number[], radius: number): Record<string, V3> {
  const r = sphereRadius(radius, pose.scale), c = worldCenter(pose, center), axes = axesOf(pose);
  const out: Record<string, V3> = { center: c };
  ["x", "y", "z"].forEach((name, i) => {
    out[`radius:${name}+`] = add(c, scale3(axes[i], r));
    out[`radius:${name}-`] = add(c, scale3(axes[i], -r));
  });
  return out;
}

/** A sphere's radius (local units) for a handle dragged `t` metres from its centre. */
export function dragSphereRadius(t: number, pose: Pose3D): number {
  return Math.max(MIN_EXTENT, Math.abs(t) / (Math.max(...pose.scale.map(Math.abs)) || 1));
}

// --- capsule -----------------------------------------------------------------------------------

/** The capsule's axis (index) and the two axes across it. */
function capsuleAxes(direction: "x" | "y" | "z"): [number, number, number] {
  const a = AXIS_INDEX[direction] ?? 1;
  return [a, (a + 1) % 3, (a + 2) % 3];
}

export function capsuleWire(pose: Pose3D, center: readonly number[], radius: number, height: number, direction: "x" | "y" | "z"): Wire {
  const [a, b, d] = capsuleAxes(direction);
  const { radius: r, halfHeight: hh } = capsuleSize(radius, height, a as 0 | 1 | 2, pose.scale);
  const axes = axesOf(pose), c = worldCenter(pose, center);
  const up = axes[a], u = axes[b], v = axes[d];
  const top = add(c, scale3(up, hh)), bottom = add(c, scale3(up, -hh));
  const wire: Wire = [circle(top, u, v, r), circle(bottom, u, v, r)];
  for (const side of [u, v]) {
    for (const k of [1, -1]) wire.push([add(top, scale3(side, k * r)), add(bottom, scale3(side, k * r))]);
    // The end caps' half circles over the top and under the bottom.
    wire.push(circle(top, side, up, r, 0, Math.PI, 16));
    wire.push(circle(bottom, side, up, r, Math.PI, Math.PI * 2, 16));
  }
  return wire;
}

/** Handles on the radius (across the capsule both ways), the two ends, and the centre. */
export function capsuleHandles3D(pose: Pose3D, center: readonly number[], radius: number, height: number, direction: "x" | "y" | "z"): Record<string, V3> {
  const [a, b, d] = capsuleAxes(direction);
  const { radius: r, halfHeight: hh } = capsuleSize(radius, height, a as 0 | 1 | 2, pose.scale);
  const axes = axesOf(pose), c = worldCenter(pose, center);
  return {
    center: c,
    "height+": add(c, scale3(axes[a], hh + r)),
    "height-": add(c, scale3(axes[a], -(hh + r))),
    "radius:u+": add(c, scale3(axes[b], r)),
    "radius:u-": add(c, scale3(axes[b], -r)),
    "radius:v+": add(c, scale3(axes[d], r)),
    "radius:v-": add(c, scale3(axes[d], -r)),
  };
}

/** The world axis a capsule handle moves along. */
export function capsuleHandleAxis(handle: string, pose: Pose3D, direction: "x" | "y" | "z"): V3 {
  const [a, b, d] = capsuleAxes(direction), axes = axesOf(pose);
  return axes[handle.startsWith("height") ? a : handle.startsWith("radius:u") ? b : d];
}

/** A capsule's radius (local units) for a radius handle dragged `t` metres from its centre. */
export function dragCapsuleRadius(t: number, pose: Pose3D, direction: "x" | "y" | "z"): number {
  const [a] = capsuleAxes(direction);
  const across = Math.max(...pose.scale.filter((_, i) => i !== a).map(Math.abs)) || 1;
  return Math.max(MIN_EXTENT, Math.abs(t) / across);
}

/** A capsule's height (local units, both ends move) for an end handle dragged `t` metres from its centre. */
export function dragCapsuleHeight(t: number, pose: Pose3D, direction: "x" | "y" | "z"): number {
  const [a] = capsuleAxes(direction);
  return Math.max(MIN_EXTENT, (2 * Math.abs(t)) / (Math.abs(pose.scale[a]) || 1));
}

// --- mesh --------------------------------------------------------------------------------------

/** Above this many triangles a mesh collider is drawn as the box around it. */
export const MESH_WIRE_TRIANGLES = 2000;

/** What a mesh collider is drawn as, in mesh space: its triangle edges (vertex index pairs, shared edges once), or for a big mesh its bounds. */
export type MeshOutline = { edges: number[] } | { boxCenter: V3; boxSize: V3 };

/** A mesh's outline (see `MeshOutline`). Costly for big meshes: work it out once per mesh. */
export function meshOutline(vertices: readonly number[], indices: readonly number[]): MeshOutline {
  if (indices.length / 3 > MESH_WIRE_TRIANGLES) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], vertices[i + k])), (max[k] = Math.max(max[k], vertices[i + k]));
    return { boxCenter: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], boxSize: sub(max, min) };
  }
  const edges: number[] = [];
  const seen = new Set<number>();
  const n = vertices.length / 3;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (const [p, q] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]) {
      const key = p < q ? p * n + q : q * n + p;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(p, q);
    }
  }
  return { edges };
}

/** A mesh collider's triangle edges in world space (or its bounding box, for big meshes). */
export function meshWire(pose: Pose3D, center: readonly number[], vertices: readonly number[], indices: readonly number[], outline: MeshOutline = meshOutline(vertices, indices)): Wire {
  if ("boxSize" in outline) return boxWire(pose, add(center, outline.boxCenter), outline.boxSize);
  const c = worldCenter(pose, center);
  const world = (i: number): V3 => at(pose, c, [vertices[i * 3] * pose.scale[0], vertices[i * 3 + 1] * pose.scale[1], vertices[i * 3 + 2] * pose.scale[2]]);
  const wire: Wire = [];
  for (let i = 0; i + 1 < outline.edges.length; i += 2) wire.push([world(outline.edges[i]), world(outline.edges[i + 1])]);
  return wire;
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
