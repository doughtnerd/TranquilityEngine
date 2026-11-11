// Geometry for the reverb zone gizmo (ADR 0162 E1, api-and-models §1.5 and §7): the volume and its `blendDistance`
// shell as wireframes in world space, the handles that resize them, and the drags that turn a handle position into
// field values. Sized exactly as the zone manager sizes the volume (`runtime/core/zoneWeights.ts`,
// `zoneVolumeFromMatrix`): the world centre is the node's matrix applied to the local `center`; a box's half extents are
// `size / 2` times the node's world scale per axis; a sphere's radius is `radius` times the largest scale axis; the
// box axes are the node's turned axes; `blendDistance` is in world units. Pure functions over plain arrays, so they
// are tested without a renderer.

/** A point or vector in world space. */
export type V3 = [number, number, number];
/** A unit quaternion `[x, y, z, w]`. */
export type Quat = [number, number, number, number];

/** A node's world pose: position, rotation and scale (the node's world matrix is T·R·S). */
export interface Pose3D {
  position: V3;
  rotation: Quat;
  scale: V3;
}

/** A wireframe: open polylines in world space. */
export type Wire = V3[][];

/** The shortest a zone edge or radius is dragged to, local units. */
export const MIN_EXTENT = 0.01;
/** Segments per quarter arc of a box shell's rounded corners. */
export const SHELL_ARC_SEGMENTS = 8;
/** Segments of a sphere's circle. */
export const CIRCLE_SEGMENTS = 32;

/** The faces of a box zone, as handle ids: axis then sign. */
export type ZoneFace = "x+" | "x-" | "y+" | "y-" | "z+" | "z-";
/** The six face ids in handle order. */
export const ZONE_FACES: readonly ZoneFace[] = ["x+", "x-", "y+", "y-", "z+", "z-"];
/** The six radius handle ids of a sphere zone: one at each end of each axis. */
export const RADIUS_HANDLES = ["radius:x+", "radius:x-", "radius:y+", "radius:y-", "radius:z+", "radius:z-"] as const;
/** The blend-shell handle's id. */
export const BLEND_HANDLE = "blend";

const AXIS: Record<string, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const scale3 = (a: readonly number[], k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];

/** `v` turned by the unit quaternion `q`. */
export function rotate(q: Quat, v: readonly number[]): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2]! - z * v[1]!), ty = 2 * (z * v[0]! - x * v[2]!), tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}

/** The node's local X, Y and Z axes in world space (unit length). */
export function axesOf(pose: Pose3D): [V3, V3, V3] {
  return [rotate(pose.rotation, [1, 0, 0]), rotate(pose.rotation, [0, 1, 0]), rotate(pose.rotation, [0, 0, 1])];
}

/** A zone's volume in world space. */
export interface ZoneGeometry {
  shape: "box" | "sphere";
  /** The volume's centre. */
  center: V3;
  /** The box's three axes (unit, world). */
  axes: [V3, V3, V3];
  /** Box: half extents along the axes, world units (never negative). Sphere: zeros. */
  half: V3;
  /** Sphere: the radius, world units. Box: 0. */
  radius: number;
}

/** The zone's volume in world space, sized as `zoneVolumeFromMatrix` sizes it. Negative sizes and radius count as 0. */
export function zoneGeometry(pose: Pose3D, shape: string, center: readonly number[], size: readonly number[], radius: number): ZoneGeometry {
  const s: V3 = [Math.abs(pose.scale[0]), Math.abs(pose.scale[1]), Math.abs(pose.scale[2])];
  const c = add(pose.position, rotate(pose.rotation, [center[0]! * pose.scale[0], center[1]! * pose.scale[1], center[2]! * pose.scale[2]]));
  const axes = axesOf(pose);
  if (shape === "sphere") return { shape: "sphere", center: c, axes, half: [0, 0, 0], radius: Math.max(0, radius) * Math.max(s[0], s[1], s[2]) };
  return { shape: "box", center: c, axes, half: [(Math.max(0, size[0]!) / 2) * s[0], (Math.max(0, size[1]!) / 2) * s[1], (Math.max(0, size[2]!) / 2) * s[2]], radius: 0 };
}

/** A circle of radius `r` around `c` in the plane of `u` and `v`, `n` segments (`n + 1` points, the last equal to the first). */
function circle(c: V3, u: V3, v: V3, r: number, n = CIRCLE_SEGMENTS): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * 2 * i) / n;
    pts.push(add(c, add(scale3(u, Math.cos(a) * r), scale3(v, Math.sin(a) * r))));
  }
  return pts;
}

/** A rectangle of half sizes `hu`, `hv` in the plane of `u` and `v`, grown by `d` with rounded corners: the points `d` from the rectangle. One closed polyline (first point repeated). */
function roundedRect(c: V3, u: V3, v: V3, hu: number, hv: number, d: number, arc = SHELL_ARC_SEGMENTS): V3[] {
  const pts: V3[] = [];
  const quadrants: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  quadrants.forEach(([su, sv], q) => {
    const corner = add(c, add(scale3(u, su * hu), scale3(v, sv * hv)));
    for (let i = 0; i <= arc; i++) {
      const a = (Math.PI / 2) * (q + i / arc);
      pts.push(add(corner, add(scale3(u, Math.cos(a) * d), scale3(v, Math.sin(a) * d))));
    }
  });
  pts.push(pts[0]!);
  return pts;
}

/**
 * The volume as a wireframe: a box's twelve edges (one segment each), a sphere's three great circles
 * (`CIRCLE_SEGMENTS` segments each).
 */
export function zoneVolumeWire(g: ZoneGeometry): Wire {
  const [x, y, z] = g.axes;
  if (g.shape === "sphere") return [circle(g.center, x, y, g.radius), circle(g.center, x, z, g.radius), circle(g.center, y, z, g.radius)];
  const corner = (i: number): V3 => add(g.center, add(scale3(x, i & 1 ? g.half[0] : -g.half[0]), add(scale3(y, i & 2 ? g.half[1] : -g.half[1]), scale3(z, i & 4 ? g.half[2] : -g.half[2]))));
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return edges.map(([a, b]) => [corner(a!), corner(b!)]);
}

/**
 * The blend shell: the surface where a point is `blendDistance` outside the volume (weight 0), drawn in the three
 * planes through the centre. A box's shell has rounded corners (the distance outside a box is measured to the box, as
 * `outsideDistance` does); a sphere's is a sphere of `radius + blendDistance`. Nothing when `blendDistance` is not
 * above 0 (a hard edge: the shell is the volume).
 */
export function zoneShellWire(g: ZoneGeometry, blendDistance: number): Wire {
  if (!(blendDistance > 0)) return [];
  const [x, y, z] = g.axes;
  if (g.shape === "sphere") {
    const r = g.radius + blendDistance;
    return [circle(g.center, x, y, r), circle(g.center, x, z, r), circle(g.center, y, z, r)];
  }
  return [
    roundedRect(g.center, x, y, g.half[0], g.half[1], blendDistance),
    roundedRect(g.center, x, z, g.half[0], g.half[2], blendDistance),
    roundedRect(g.center, y, z, g.half[1], g.half[2], blendDistance),
  ];
}

/** A box's handles: a face centre each (ids `x+` … `z-`). */
export function zoneFaceHandles(g: ZoneGeometry): Record<ZoneFace, V3> {
  const out = {} as Record<ZoneFace, V3>;
  for (const face of ZONE_FACES) {
    const i = AXIS[face[0]!]!;
    out[face] = add(g.center, scale3(g.axes[i], face[1] === "+" ? g.half[i] : -g.half[i]));
  }
  return out;
}

/** A sphere's radius handles: the rim at each end of each axis (ids `radius:x+` … `radius:z-`). */
export function zoneRadiusHandles(g: ZoneGeometry): Record<string, V3> {
  const out: Record<string, V3> = {};
  for (const id of RADIUS_HANDLES) {
    const i = AXIS[id[7]!]!;
    out[id] = add(g.center, scale3(g.axes[i], id[8] === "+" ? g.radius : -g.radius));
  }
  return out;
}

/**
 * The direction the blend handle moves along, and where its distance counts from. Box: the outside of the vertical
 * edge where the +x and +y faces meet, along the diagonal of the x and y axes; sphere: the rim in that same diagonal.
 * The handle sits at `origin + direction × blendDistance`, so on a hard edge it sits on the volume without hiding
 * a face handle (those are at face centres).
 */
export function blendAxis(g: ZoneGeometry): { origin: V3; direction: V3 } {
  const [x, y] = g.axes;
  const dir = add(x, y);
  const direction = scale3(dir, 1 / Math.hypot(dir[0], dir[1], dir[2]));
  if (g.shape === "sphere") return { origin: add(g.center, scale3(direction, g.radius)), direction };
  return { origin: add(g.center, add(scale3(x, g.half[0]), scale3(y, g.half[1]))), direction };
}

/** The blend handle's position. */
export function blendHandle(g: ZoneGeometry, blendDistance: number): V3 {
  const { origin, direction } = blendAxis(g);
  return add(origin, scale3(direction, Math.max(0, blendDistance)));
}

/** `blendDistance` (world units) for a blend handle dragged to `t` along `blendAxis`'s direction from its origin: not below 0. */
export function dragBlend(t: number): number {
  return Math.max(0, t);
}

/**
 * A box after dragging `face` so it lies `reach` world units from the box's centre at the drag's start, outward
 * positive: the opposite face stays put, or (`symmetric`, Alt) both move. `center` and `size` are local units, as the
 * fields hold them; the scale is the node's world scale.
 */
export function dragZoneFace(face: ZoneFace, reach: number, pose: Pose3D, startCenter: readonly number[], startSize: readonly number[], symmetric = false): { center: V3; size: V3 } {
  const i = AXIS[face[0]!]!, sign = face[1] === "+" ? 1 : -1;
  const s = Math.abs(pose.scale[i]) || 1;
  const half = (Math.abs(startSize[i]!) * s) / 2;
  const center: V3 = [startCenter[0]!, startCenter[1]!, startCenter[2]!];
  const size: V3 = [startSize[0]!, startSize[1]!, startSize[2]!];
  if (symmetric) {
    size[i] = Math.max(MIN_EXTENT, (2 * reach) / s);
  } else {
    const world = Math.max(MIN_EXTENT * s, reach + half); // from the fixed face to the dragged one
    size[i] = world / s;
    center[i] = startCenter[i]! + (sign * (world / 2 - half)) / (pose.scale[i] || 1);
  }
  return { center, size };
}

/** A sphere zone's `radius` (local units) for a radius handle dragged to `reach` world units from the centre. */
export function dragZoneRadius(reach: number, pose: Pose3D): number {
  return Math.max(MIN_EXTENT, Math.abs(reach) / (Math.max(...pose.scale.map(Math.abs)) || 1));
}

/**
 * Where along the line `point + t × axis` (unit `axis`) the line comes nearest the ray `origin + s × direction`;
 * null when they are parallel. Dragging a handle along its axis follows the pointer ray with this.
 */
export function closestOnAxis(origin: readonly number[], direction: readonly number[], point: readonly number[], axis: readonly number[]): number | null {
  const w = sub(point, origin);
  const b = dot(axis, direction), c = dot(direction, direction), d = dot(axis, w), e = dot(direction, w);
  const denom = c - b * b;
  if (Math.abs(denom) < 1e-9) return null;
  return (b * e - c * d) / denom;
}

/** Round to 4 decimals, as the other gizmos write fields. */
export const tidy = (n: number): number => Math.round(n * 1e4) / 1e4;
