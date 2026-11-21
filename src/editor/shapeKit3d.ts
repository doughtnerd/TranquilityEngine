// The 3D shape kit (ADR 0295): what every 3D handle gizmo shares, whichever plugin draws it. A gizmo describes each
// shape it edits as a table entry (`HandleShape3D`: wireframe, handles, what a handle press writes as a field patch)
// built from the rules here, and loops over its table with `axisDrag`. The Physics plugin's collider shape table
// (ADR 0288) and the Audio plugin's zone shape table use it; plugins reach it as `shapeKit3d` from `myco/editor`.
//
// - pose maths: quaternion turns, a node's axes and pose, a shape's world centre, its pose as a matrix, centre moves;
// - wireframes: an oriented box or sphere (`Volume3D`), a shape as `engine/physics/shape3d.ts` sizes it, a mesh by its
//   triangle edges, and the blend shell around a volume;
// - handle rules: a box's face handles (the opposite face stays, Alt moves both), a sphere's radius handles, and the
//   blend-shell handle (a distance outside the volume);
// - the axis drag: a pointer ray turned into how far out along its axis a handle is ("reach"), which an entry turns
//   into a patch.
//
// Pure functions over plain arrays (only `pose3DOf` reads a node), so entries are tested without a renderer.
import type { GameObject } from "../engine/scene/GameObject";
import { scaledCenter, type ShapeSize3D, type V3 } from "../engine/physics/shape3d";

export type { V3 };
/** A unit quaternion `[x, y, z, w]`. */
export type Quat = [number, number, number, number];

/** A node's world pose: position, rotation and scale (its world matrix is T·R·S; a negative scale mirrors an axis). */
export interface Pose3D {
  position: V3;
  rotation: Quat;
  scale: V3;
}

/** A wireframe: open polylines in world space. */
export type Wire = V3[][];

/** What a handle press writes: field name → new value (plain arrays for vectors). */
export type FieldPatch = Readonly<Record<string, unknown>>;

/** The shortest a handle drags an edge or radius to, local units (2D gizmos too). */
export const MIN_EXTENT = 0.01;

/** A number rounded to 4 decimals, as gizmos write fields, so files stay free of float noise. */
export const tidy = (n: number): number => Math.round(n * 1e4) / 1e4;

const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: readonly number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const AXIS: Record<string, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

// --- pose maths --------------------------------------------------------------------------------------

/** `v` turned by the unit quaternion `q`. */
export function rotate(q: Quat, v: readonly number[]): V3 {
  const [x, y, z, w] = q;
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/**
 * A node's world pose, whose T·R·S is the node's world matrix. A mirrored node (a negative determinant) gets a negative
 * x scale: `worldRotation` is decomposed that way, while `worldScale` gives column lengths only.
 */
export function pose3DOf(node: GameObject): Pose3D {
  const t = node.transform!;
  const p = t.worldPosition, q = t.worldRotation, s = t.worldScale, m = t.localToWorld.value;
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], scale: [det < 0 ? -s.x : s.x, s.y, s.z] };
}

/** The node's local X, Y and Z axes in world space (unit length, turned but not mirrored). */
export function axesOf(pose: Pose3D): [V3, V3, V3] {
  return [rotate(pose.rotation, [1, 0, 0]), rotate(pose.rotation, [0, 1, 0]), rotate(pose.rotation, [0, 0, 1])];
}

/** Where a shape with this `center` (local units) sits in the world. */
export function worldCenter(pose: Pose3D, center: readonly number[]): V3 {
  return add(pose.position, rotate(pose.rotation, scaledCenter(center, pose.scale)));
}

/** The pose as the engine's world matrix: column-major T·R·S (column k is axis k times scale k, then the position). */
export function poseMatrix(pose: Pose3D): number[] {
  const [x, y, z] = axesOf(pose), [sx, sy, sz] = pose.scale;
  return [x[0] * sx, x[1] * sx, x[2] * sx, 0, y[0] * sy, y[1] * sy, y[2] * sy, 0, z[0] * sz, z[1] * sz, z[2] * sz, 0, ...pose.position, 1];
}

/** A world-space move as a change of a shape's `center` (local units): turned back and unscaled. */
export function centerDelta(pose: Pose3D, worldDelta: readonly number[]): V3 {
  const local = rotate(conj(pose.rotation), worldDelta);
  return [local[0] / (pose.scale[0] || 1), local[1] / (pose.scale[1] || 1), local[2] / (pose.scale[2] || 1)];
}

/**
 * Where along a line (through `point`, along the unit `axis`) a ray passes closest: the signed distance from
 * `point`; null when the ray runs along the line.
 */
export function closestOnAxis(origin: readonly number[], direction: readonly number[], point: readonly number[], axis: readonly number[]): number | null {
  const w = sub(point, origin);
  const b = dot(axis, direction), c = dot(direction, direction), d = dot(axis, w), e = dot(direction, w);
  const denom = c - b * b; // |axis| = 1
  if (Math.abs(denom) < 1e-9) return null;
  return (b * e - c * d) / denom;
}

// --- wireframes ----------------------------------------------------------------------------------------

/** An oriented box or a sphere in world space. */
export interface Volume3D {
  readonly shape: "box" | "sphere";
  readonly center: V3;
  /** The three axes (unit, world): the box's, and the sphere's handles'. */
  readonly axes: readonly [V3, V3, V3];
  /** Box: half extents along the axes (never negative). Sphere: zeros. */
  readonly half: V3;
  /** Sphere: the radius. Box: 0. */
  readonly radius: number;
}

/** A circle of radius `r` around `c` in the plane of world axes `u` and `v`, from angle `from` to `to`, `n` segments (`n + 1` points). */
export function circle(c: V3, u: V3, v: V3, r: number, from = 0, to = Math.PI * 2, n = 32): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    pts.push(add(c, add(scale3(u, Math.cos(a) * r), scale3(v, Math.sin(a) * r))));
  }
  return pts;
}

/** A volume's wireframe: a box's twelve edges (one segment each), a sphere's three great circles (32 segments each). */
export function volumeWire(g: Volume3D): Wire {
  const [x, y, z] = g.axes;
  if (g.shape === "sphere") return [circle(g.center, x, y, g.radius), circle(g.center, x, z, g.radius), circle(g.center, y, z, g.radius)];
  const h = g.half;
  const corner = (i: number): V3 => add(g.center, add(scale3(x, i & 1 ? h[0] : -h[0]), add(scale3(y, i & 2 ? h[1] : -h[1]), scale3(z, i & 4 ? h[2] : -h[2]))));
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return edges.map(([a, b]) => [corner(a), corner(b)]);
}

/** Segments per quarter arc of a box shell's rounded corners. */
const SHELL_ARC_SEGMENTS = 8;

/** A rectangle of half sizes `hu`, `hv` in the plane of `u` and `v`, grown by `d` with rounded corners. One closed polyline (first point repeated). */
function roundedRect(c: V3, u: V3, v: V3, hu: number, hv: number, d: number): V3[] {
  const pts: V3[] = [];
  const quadrants: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  quadrants.forEach(([su, sv], q) => {
    const corner = add(c, add(scale3(u, su * hu), scale3(v, sv * hv)));
    for (let i = 0; i <= SHELL_ARC_SEGMENTS; i++) {
      const a = (Math.PI / 2) * (q + i / SHELL_ARC_SEGMENTS);
      pts.push(add(corner, add(scale3(u, Math.cos(a) * d), scale3(v, Math.sin(a) * d))));
    }
  });
  pts.push(pts[0]);
  return pts;
}

/**
 * The blend shell: the surface `d` outside the volume, drawn in the three planes through its centre. A box's shell has
 * rounded corners (the distance outside a box is measured to the box); a sphere's is a sphere of `radius + d`. Nothing
 * when `d` is not above 0 (a hard edge: the shell is the volume).
 */
export function shellWire(g: Volume3D, d: number): Wire {
  if (!(d > 0)) return [];
  const [x, y, z] = g.axes;
  if (g.shape === "sphere") {
    const r = g.radius + d;
    return [circle(g.center, x, y, r), circle(g.center, x, z, r), circle(g.center, y, z, r)];
  }
  return [roundedRect(g.center, x, y, g.half[0], g.half[1], d), roundedRect(g.center, x, z, g.half[0], g.half[2], d), roundedRect(g.center, y, z, g.half[1], g.half[2], d)];
}

/**
 * A shape as `shapeSize3D` sizes it (world units), at local `center` on a node of `pose`: a box's twelve edges, a
 * sphere's three circles, a capsule's two rings, four sides and four half-circle caps.
 */
export function sizedShapeWire(size: ShapeSize3D, pose: Pose3D, center: readonly number[]): Wire {
  const c = worldCenter(pose, center), axes = axesOf(pose);
  if (size.kind === "box") return volumeWire({ shape: "box", center: c, axes, half: size.halfExtents, radius: 0 });
  if (size.kind === "sphere") return volumeWire({ shape: "sphere", center: c, axes, half: [0, 0, 0], radius: size.radius });
  const a = size.axis, r = size.radius, hh = size.halfHeight;
  const up = axes[a], u = axes[(a + 1) % 3], v = axes[(a + 2) % 3];
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

/** A mesh's triangles in local units, as the editor reads a model. */
export type TriangleData = { readonly vertices: readonly number[]; readonly indices: readonly number[] };

// Meshes are drawn by their triangle edges (shared edges once), or above this many triangles as the box around them.
const MESH_WIRE_TRIANGLES = 2000;
type MeshOutline = { edges: number[] } | { boxCenter: V3; boxSize: V3 };

/** Each mesh's outline (costly for big meshes), and a number per mesh for signatures; the same object while a mesh is unchanged. */
const meshOutlines = new WeakMap<TriangleData, { id: number; outline: MeshOutline }>();
let meshIds = 0;

function meshOutline(mesh: TriangleData): { id: number; outline: MeshOutline } {
  let known = meshOutlines.get(mesh);
  if (known) return known;
  const { vertices, indices } = mesh;
  let outline: MeshOutline;
  if (indices.length / 3 > MESH_WIRE_TRIANGLES) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], vertices[i + k])), (max[k] = Math.max(max[k], vertices[i + k]));
    outline = { boxCenter: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], boxSize: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  } else {
    const edges: number[] = [], seen = new Set<number>(), n = vertices.length / 3;
    for (let t = 0; t + 2 < indices.length; t += 3) {
      for (const [p, q] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]) {
        const key = p < q ? p * n + q : q * n + p;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(p, q);
      }
    }
    outline = { edges };
  }
  meshOutlines.set(mesh, (known = { id: ++meshIds, outline }));
  return known;
}

/** A string that changes whenever `meshWire` for the same pose and centre would. */
export const meshSignature = (mesh: TriangleData): string => `m${meshOutline(mesh).id}`;

/** A mesh at local `center` on a node of `pose`, by its triangle edges (shared ones once), or above 2000 triangles as the box around it. */
export function meshWire(mesh: TriangleData, pose: Pose3D, center: readonly number[]): Wire {
  const { outline } = meshOutline(mesh), { vertices } = mesh;
  if ("boxSize" in outline) {
    const half = outline.boxSize.map((v, i) => Math.abs(v * pose.scale[i]) / 2) as V3;
    return volumeWire({ shape: "box", center: worldCenter(pose, add(center, outline.boxCenter)), axes: axesOf(pose), half, radius: 0 });
  }
  const c = worldCenter(pose, center);
  const world = (i: number): V3 => add(c, rotate(pose.rotation, [vertices[i * 3] * pose.scale[0], vertices[i * 3 + 1] * pose.scale[1], vertices[i * 3 + 2] * pose.scale[2]]));
  const wire: Wire = [];
  for (let i = 0; i + 1 < outline.edges.length; i += 2) wire.push([world(outline.edges[i]), world(outline.edges[i + 1])]);
  return wire;
}

// --- handle rules ----------------------------------------------------------------------------------------

/** A box's face handle ids: axis then sign. */
export const BOX_FACES = ["x+", "x-", "y+", "y-", "z+", "z-"] as const;
/** A sphere's radius handle ids: one at each end of each axis. */
export const RADIUS_HANDLES = ["radius:x+", "radius:x-", "radius:y+", "radius:y-", "radius:z+", "radius:z-"] as const;
/** The blend-shell handle's id. */
export const BLEND_HANDLE = "blend";

/** A box's face handles: each face's centre. */
export function faceHandles(g: Volume3D): Record<string, V3> {
  const out: Record<string, V3> = {};
  for (const face of BOX_FACES) {
    const i = AXIS[face[0]];
    out[face] = add(g.center, scale3(g.axes[i], face[1] === "+" ? g.half[i] : -g.half[i]));
  }
  return out;
}

/**
 * A press on a box's face handle, the box's local `center` and `size` as they are at the press: what to write when the
 * face is `reach` world units out from the centre along its axis. The opposite face stays put (the centre moves by
 * half), or with Alt both faces move (the centre stays); a face never passes `MIN_EXTENT` from the other. Null for a
 * handle that isn't a face.
 */
export function facePress(f: { readonly center: readonly number[]; readonly size: readonly number[] }, pose: Pose3D, handle: string): ((reach: number, alt: boolean) => FieldPatch) | null {
  if (!(BOX_FACES as readonly string[]).includes(handle)) return null;
  const i = AXIS[handle[0]], s = handle[1] === "+" ? 1 : -1;
  const k = Math.abs(pose.scale[i]) || 1;
  const half = (Math.abs(f.size[i]) * k) / 2;
  return (reach, alt) => {
    const center = [...f.center] as V3, size = [...f.size] as V3;
    if (alt) {
      size[i] = Math.max(MIN_EXTENT, (2 * reach) / k);
      return { size };
    }
    const world = Math.max(MIN_EXTENT * k, reach + half); // from the fixed face to the dragged one
    size[i] = world / k;
    center[i] = f.center[i] + (s * (world / 2 - half)) / (pose.scale[i] || 1);
    return { size, center };
  };
}

/** A sphere's radius handles: the rim at each end of each axis. */
export function radiusHandles(g: Volume3D): Record<string, V3> {
  const out: Record<string, V3> = {};
  for (const id of RADIUS_HANDLES) out[id] = add(g.center, scale3(g.axes[AXIS[id[7]]], id[8] === "+" ? g.radius : -g.radius));
  return out;
}

/** A press on a sphere's radius handle: `radius` (local units, over the largest scale axis) for a handle `reach` world units from the centre. Null for any other handle. */
export function radiusPress(pose: Pose3D, handle: string): ((reach: number) => FieldPatch) | null {
  if (!(RADIUS_HANDLES as readonly string[]).includes(handle)) return null;
  const k = Math.max(...pose.scale.map(Math.abs)) || 1;
  return (reach) => ({ radius: Math.max(MIN_EXTENT, Math.abs(reach) / k) });
}

/**
 * The line the blend handle moves along: from `origin` along the unit `direction`. Box: the outside of the edge where
 * the +x and +y faces meet, along the diagonal of the x and y axes; sphere: the rim in that same diagonal. The handle
 * sits at `origin + direction × d`, so on a hard edge it sits on the volume without hiding a face handle.
 */
export function blendAxis(g: Volume3D): { origin: V3; direction: V3 } {
  const [x, y] = g.axes;
  const dir = add(x, y);
  const direction = scale3(dir, 1 / Math.hypot(dir[0], dir[1], dir[2]));
  if (g.shape === "sphere") return { origin: add(g.center, scale3(direction, g.radius)), direction };
  return { origin: add(g.center, add(scale3(x, g.half[0]), scale3(y, g.half[1]))), direction };
}

/** The blend handle, for a shell `d` outside the volume. */
export function blendHandle(g: Volume3D, d: number): V3 {
  const { origin, direction } = blendAxis(g);
  return add(origin, scale3(direction, Math.max(0, d)));
}

/** A press on the blend handle: `blendDistance` (world units, not below 0) for the handle `reach` world units from the volume's centre along `blendAxis`. */
export function blendPress(g: Volume3D): (reach: number) => FieldPatch {
  const { origin, direction } = blendAxis(g);
  const start = dot(sub(origin, g.center), direction); // where along the line the volume's surface is
  return (reach) => ({ blendDistance: Math.max(0, reach - start) });
}

// --- entries and the axis drag ----------------------------------------------------------------------------

/**
 * A shape a 3D gizmo edits, as its table entry: over plain field values in local units (`center` among them), never the
 * Component, so entries are tested without an editor.
 */
export interface HandleShape3D<F extends { readonly center: readonly number[] }> {
  /** The wireframe in world space. */
  wire(f: F, pose: Pose3D): Wire;
  /** The handles by id, in world space. */
  handles(f: F, pose: Pose3D): Record<string, V3>;
  /** The outward world axis `handle` moves along; without it (or undefined), from the shape's centre through the handle. */
  handleAxis?(f: F, pose: Pose3D, handle: string): V3 | undefined;
  /**
   * A press on `handle`, with the fields and pose at the press: what to write when the handle is `reach` world units out
   * from the shape's centre along its axis (Alt: `alt`); null when the handle does nothing.
   */
  press(f: F, pose: Pose3D, handle: string): ((reach: number, alt: boolean) => FieldPatch) | null;
}

/**
 * The outward world axis an entry's `handle` moves along: the entry's own, or from the shape's world centre through
 * the handle; null when the handle sits on the centre (nothing to drag along) or isn't there.
 */
export function resizeAxis<F extends { readonly center: readonly number[] }>(shape: HandleShape3D<F>, f: F, pose: Pose3D, handle: string): V3 | null {
  const own = shape.handleAxis?.(f, pose, handle);
  if (own) return own;
  const at = shape.handles(f, pose)[handle];
  if (!at) return null;
  const d = sub(at, worldCenter(pose, f.center));
  const len = Math.hypot(d[0], d[1], d[2]);
  return len < 1e-9 ? null : scale3(d, 1 / len);
}

/** A pointer ray in world space, as the viewport gives it. */
export interface Ray3D {
  readonly origin: readonly number[];
  readonly direction: readonly number[];
}

/**
 * A press on an entry's `handle` with the pointer's ray `press`, the fields and pose at the press: the drag along the
 * handle's axis, as a function from a later pointer ray (and Alt) to the patch to write, or null when nothing comes of
 * that pointer (its ray runs along the axis). The handle follows the point on its axis nearest the pointer's ray,
 * offset by where the press was, so it doesn't jump. Null when the handle does nothing, has no axis, or the press ray
 * runs along it.
 */
export function axisDrag<F extends { readonly center: readonly number[] }>(shape: HandleShape3D<F>, f: F, pose: Pose3D, handle: string, press: Ray3D): ((ray: Ray3D | null, alt: boolean) => FieldPatch | null) | null {
  const grabbed = shape.handles(f, pose)[handle];
  const resize = grabbed ? shape.press(f, pose, handle) : null;
  const along = resize ? resizeAxis(shape, f, pose, handle) : null;
  if (!grabbed || !resize || !along) return null;
  const t0 = closestOnAxis(press.origin, press.direction, grabbed, along);
  if (t0 === null) return null;
  const handleReach = dot(sub(grabbed, worldCenter(pose, f.center)), along); // how far out the handle is at the press
  return (ray, alt) => {
    const t = ray ? closestOnAxis(ray.origin, ray.direction, grabbed, along) : null;
    return t === null ? null : resize(handleReach + (t - t0), alt);
  };
}
