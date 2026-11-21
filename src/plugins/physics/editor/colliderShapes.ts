// The collider shape table (ADR 0288): one entry per collider type Edit Collider works on, giving the
// fields its shape is made from, its outline (2D) or wireframe (3D), its handles, and what a press or drag
// on a handle writes, as a patch of the collider's fields. The collider gizmo (`colliderGizmo.ts`) is a loop
// over this table; a new collider type is one entry.
//
// Entries work on plain field values in local units, never on the Component, so they're tested without an
// editor. Their sizes come from `engine/physics/shape2d.ts` and `shape3d.ts`, which the physics worlds build
// their shapes with, so an outline is the simulated shape by construction. The centre handle is the loop's:
// it moves `center` the same way for every collider.
import { meshTriangleData } from "../../../engine/editor";
import { shapeSize2D } from "../../../engine/physics/shape2d";
import { AXIS_INDEX, shapeSize3D } from "../../../engine/physics/shape3d";
import type { Component } from "../../../engine/core/Component";
import {
  BoxCollider,
  BoxCollider2D,
  CapsuleCollider,
  CharacterController,
  CharacterController2D,
  CircleCollider2D,
  EdgeCollider2D,
  MeshCollider,
  PolygonCollider2D,
  SphereCollider,
  type Collider,
  type Collider2D,
} from "../runtime";
import { axesOf, rotate, worldCenter, type Pose3D, type V3, type Wire } from "./collider3dMath";
import { MIN_EXTENT, toWorld, type Pose2D, type V2 } from "./colliderMath";

type P3 = [number, number, number];

/** What a handle press or drag writes: collider field name → new value (plain arrays for vectors). */
export type FieldPatch = Readonly<Record<string, unknown>>;

/** A press on a 2D collider's handle (other than the centre). */
export type Press2D =
  /** A drag: `start` is written once as it begins; each pointer move (in the node's local space, the pose at the press) writes what `drag` gives. */
  | { readonly label: string; readonly start?: FieldPatch; drag(p: V2, alt: boolean, snap: (n: number) => number): FieldPatch }
  /** A click: one undo step, no drag (Ctrl+click removing a vertex). */
  | { readonly label: string; readonly edit: FieldPatch }
  /** Nothing to do, and why (shown to the user). */
  | { readonly refused: string };

interface ShapeBase<C extends Component, F> {
  /** The Component type id. */
  readonly type: string;
  readonly cls: new () => C;
  /** The pose ignores the node's rotation (a character controller's capsule stays upright). */
  readonly upright: boolean;
  /** Edit Collider's tooltip, when it isn't the usual one. */
  readonly hint?: string;
  /** The fields the shape is made from (local units), or null while it can't be drawn (a mesh still loading). */
  read(c: C): F | null;
}

/** A 2D collider type's entry. */
export interface ColliderShape2D<C extends Collider2D = Collider2D, F extends { center: V2 } = { center: V2 }> extends ShapeBase<C, F> {
  readonly dimension: "2d";
  /** The outline in world space, on the node's z plane (open for an edge collider). */
  outline(f: F, pose: Pose2D): { points: P3[]; closed: boolean };
  /** The handles by id, in world space; `center` among them. */
  handles(f: F, pose: Pose2D): Record<string, P3>;
  /** A press on `handle` (not `center`), with the fields as they are at the press; null when the handle does nothing. */
  press(f: F, pose: Pose2D, handle: string, mods: { ctrl: boolean }): Press2D | null;
}

/** A 3D collider type's entry. */
export interface ColliderShape3D<C extends Collider = Collider, F extends { center: V3 } = { center: V3 }> extends ShapeBase<C, F> {
  readonly dimension: "3d";
  /** Changes whenever the wireframe for the same pose and centre would (the loop reuses the last one otherwise). */
  signature(f: F): string;
  /** The wireframe in world space. */
  wire(f: F, pose: Pose3D): Wire;
  /** The handles by id, in world space; `center` among them. */
  handles(f: F, pose: Pose3D): Record<string, V3>;
  /** The outward world axis `handle` moves along; without it, from the centre through the handle. */
  handleAxis?(f: F, pose: Pose3D, handle: string): V3;
  /**
   * A press on `handle` (not `center`), with the fields and pose at the press: what to write when the handle
   * is `reach` metres out from the shape's centre along its axis (Alt: `alt`); null when the handle does nothing.
   */
  press(f: F, pose: Pose3D, handle: string): ((reach: number, alt: boolean) => FieldPatch) | null;
}

// The table holds entries over different field shapes; each one's fields only ever come from its own `read`.
export type AnyColliderShape2D = ColliderShape2D<any, any>;
export type AnyColliderShape3D = ColliderShape3D<any, any>;

const DEG = Math.PI / 180;
const v2 = (v: { x: number; y: number }): V2 => [v.x, v.y];
const v3 = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z];
const sign = (n: number) => (n < 0 ? -1 : 1);

// --- 2D -------------------------------------------------------------------------------------------

/** The world point `w` world units along the node's x and `h` along its y from `c` (a negative scale mirrors the axis, as `toWorld` does). */
function along(pose: Pose2D, c: P3, w: number, h: number): P3 {
  const x = w * sign(pose.scale[0]), y = h * sign(pose.scale[1]);
  const cos = Math.cos(pose.rotation * DEG), sin = Math.sin(pose.rotation * DEG);
  return [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos, c[2]];
}

type BoxFields2D = { center: V2; size: V2 };
const BOX_EDGES: Record<string, [axis: 0 | 1, sign: 1 | -1]> = { left: [0, -1], right: [0, 1], bottom: [1, -1], top: [1, 1] };

const box2D = {
  dimension: "2d",
  type: "engine.BoxCollider2D" as const,
  cls: BoxCollider2D,
  upright: false,
  read: (c) => ({ center: v2(c.center), size: v2(c.size) }),
  outline(f, pose) {
    const size = shapeSize2D({ kind: "box", size: f.size }, pose.scale);
    const [hx, hy] = size.kind === "box" ? size.halfExtents : [0, 0];
    const c = toWorld(pose, f.center);
    return { points: [along(pose, c, -hx, -hy), along(pose, c, hx, -hy), along(pose, c, hx, hy), along(pose, c, -hx, hy)], closed: true };
  },
  handles(f, pose) {
    const size = shapeSize2D({ kind: "box", size: f.size }, pose.scale);
    const [hx, hy] = size.kind === "box" ? size.halfExtents : [0, 0];
    const c = toWorld(pose, f.center);
    return { left: along(pose, c, -hx, 0), right: along(pose, c, hx, 0), top: along(pose, c, 0, hy), bottom: along(pose, c, 0, -hy), center: c };
  },
  // The dragged edge follows the pointer and the opposite edge stays put (the centre moves by half), or with
  // Alt both edges move (the centre stays). It never passes the opposite edge.
  press(f, _pose, handle) {
    const edge = BOX_EDGES[handle];
    if (!edge) return null;
    const [axis, s] = edge;
    return {
      label: "Resize collider",
      drag(p, alt) {
        const center: [number, number] = [f.center[0], f.center[1]], size: [number, number] = [f.size[0], f.size[1]];
        if (alt) {
          size[axis] = Math.max(MIN_EXTENT, Math.abs(p[axis] - f.center[axis]) * 2);
          return { size };
        }
        const fixed = f.center[axis] - (s * f.size[axis]) / 2;
        const moving = s > 0 ? Math.max(p[axis], fixed + MIN_EXTENT) : Math.min(p[axis], fixed - MIN_EXTENT);
        size[axis] = Math.abs(moving - fixed);
        center[axis] = (moving + fixed) / 2;
        return { size, center };
      },
    };
  },
} satisfies ColliderShape2D<BoxCollider2D, BoxFields2D>;

type CircleFields2D = { center: V2; radius: number };
const CIRCLE_RIM: Record<string, number> = { "radius-right": 0, "radius-top": 90, "radius-left": 180, "radius-bottom": 270 };

const circle2D = {
  dimension: "2d",
  type: "engine.CircleCollider2D" as const,
  cls: CircleCollider2D,
  upright: false,
  read: (c) => ({ center: v2(c.center), radius: c.radius }),
  outline(f, pose) {
    const c = toWorld(pose, f.center), r = shapeSize2D({ kind: "circle", radius: f.radius }, pose.scale) as { radius: number };
    const segments = 48;
    const points = Array.from({ length: segments }, (_, i): P3 => {
      const a = (i / segments) * Math.PI * 2;
      return [c[0] + Math.cos(a) * r.radius, c[1] + Math.sin(a) * r.radius, c[2]];
    });
    return { points, closed: true };
  },
  // Four rim handles, turning with the node, and the centre.
  handles(f, pose) {
    const c = toWorld(pose, f.center), { radius: r } = shapeSize2D({ kind: "circle", radius: f.radius }, pose.scale) as { radius: number };
    const out: Record<string, P3> = { center: c };
    for (const [id, deg] of Object.entries(CIRCLE_RIM)) out[id] = [c[0] + Math.cos((pose.rotation + deg) * DEG) * r, c[1] + Math.sin((pose.rotation + deg) * DEG) * r, c[2]];
    return out;
  },
  // The radius is the pointer's distance from the centre in the world, with the node's scale undone.
  press(f, pose, handle) {
    if (!(handle in CIRCLE_RIM)) return null;
    const c = toWorld(pose, f.center), scale = Math.max(Math.abs(pose.scale[0]), Math.abs(pose.scale[1])) || 1;
    return {
      label: "Resize collider",
      drag: (p) => {
        const w = toWorld(pose, p);
        return { radius: Math.max(MIN_EXTENT, Math.hypot(w[0] - c[0], w[1] - c[1]) / scale) };
      },
    };
  },
} satisfies ColliderShape2D<CircleCollider2D, CircleFields2D>;

type CapsuleFields2D = { center: V2; radius: number; height: number };

/** An upright capsule's world radius and half straight part. */
const capsule2DSize = (f: CapsuleFields2D, pose: Pose2D) => shapeSize2D({ kind: "capsule", radius: f.radius, height: f.height }, pose.scale) as { radius: number; halfHeight: number };

const character2D = {
  dimension: "2d",
  type: "engine.CharacterController2D" as const,
  cls: CharacterController2D,
  upright: true,
  read: (c) => ({ center: v2(c.center), radius: c.radius, height: c.height }),
  // Counter-clockwise from the right of the top cap, 17 points per cap.
  outline(f, pose) {
    const c = toWorld(pose, f.center), { radius: r, halfHeight: hh } = capsule2DSize(f, pose);
    const segments = 16, points: P3[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI;
      points.push([c[0] + Math.cos(a) * r, c[1] + hh + Math.sin(a) * r, c[2]]);
    }
    for (let i = 0; i <= segments; i++) {
      const a = Math.PI + (i / segments) * Math.PI;
      points.push([c[0] + Math.cos(a) * r, c[1] - hh + Math.sin(a) * r, c[2]]);
    }
    return { points, closed: true };
  },
  handles(f, pose) {
    const c = toWorld(pose, f.center), { radius: r, halfHeight: hh } = capsule2DSize(f, pose);
    return { "radius-right": [c[0] + r, c[1], c[2]], "radius-left": [c[0] - r, c[1], c[2]], "height-top": [c[0], c[1] + hh + r, c[2]], "height-bottom": [c[0], c[1] - hh - r, c[2]], center: c };
  },
  // In local units the scale cancels: the radius is the pointer's distance across, the height twice its distance along (both ends move).
  press(f, _pose, handle) {
    if (handle.startsWith("height-")) return { label: "Resize collider", drag: (p) => ({ height: Math.max(MIN_EXTENT, 2 * Math.abs(p[1] - f.center[1])) }) };
    if (handle.startsWith("radius-")) return { label: "Resize collider", drag: (p) => ({ radius: Math.max(MIN_EXTENT, Math.abs(p[0] - f.center[0])) }) };
    return null;
  },
} satisfies ColliderShape2D<CharacterController2D, CapsuleFields2D>;

// Polygon and edge colliders (ADR 0039): each point offset by `center`, then posed. Handles: `vertex:i` on each
// point, `insert:i` at the middle of the edge from point i to the next (the closing edge too when closed).

type PointsFields2D = { center: V2; points: V2[] };

/** Read a points field (plain `[x, y]` pairs, or anything with x and y), dropping malformed entries. */
function readPoints(value: unknown): V2[] {
  if (!Array.isArray(value)) return [];
  const out: V2[] = [];
  for (const p of value) {
    const x = Array.isArray(p) ? p[0] : (p as { x?: unknown } | null)?.x;
    const y = Array.isArray(p) ? p[1] : (p as { y?: unknown } | null)?.y;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/** `points` with point `index` at `p`. */
const movePoint = (points: readonly V2[], index: number, p: V2): V2[] => points.map((q, i) => (i === index ? [p[0], p[1]] : [q[0], q[1]]));

function pointsShape<C extends PolygonCollider2D | EdgeCollider2D, T extends string>(type: T, cls: new () => C, closed: boolean): ColliderShape2D<C, PointsFields2D> & { readonly type: T } {
  const name = closed ? "A polygon" : "An edge", fewest = closed ? 3 : 2;
  /** A drag moving point `index` of `points` to the pointer (snapped, in the collider's own space). */
  const moving = (f: PointsFields2D, points: V2[], index: number) => (p: V2, _alt: boolean, snap: (n: number) => number) => ({ points: movePoint(points, index, [snap(p[0] - f.center[0]), snap(p[1] - f.center[1])]) });
  return {
    dimension: "2d",
    type,
    cls,
    upright: false,
    hint: "Show handles in the viewport: drag vertices, press an edge's middle handle to add one, Ctrl+click a vertex to remove it",
    read: (c) => ({ center: v2(c.center), points: readPoints(c.points) }),
    outline: (f, pose) => ({ points: f.points.map((p) => toWorld(pose, [f.center[0] + p[0], f.center[1] + p[1]])), closed }),
    handles(f, pose) {
      const out: Record<string, P3> = {}, { points, center } = f;
      const n = points.length, edges = closed ? n : n - 1;
      points.forEach((p, i) => (out[`vertex:${i}`] = toWorld(pose, [center[0] + p[0], center[1] + p[1]])));
      for (let i = 0; i < edges; i++) {
        const a = points[i], b = points[(i + 1) % n];
        out[`insert:${i}`] = toWorld(pose, [center[0] + (a[0] + b[0]) / 2, center[1] + (a[1] + b[1]) / 2]);
      }
      out.center = toWorld(pose, center);
      return out;
    },
    press(f, _pose, handle, mods) {
      const m = /^(vertex|insert):(\d+)$/.exec(handle);
      const index = m ? Number(m[2]) : -1;
      if (!m || index >= f.points.length) return null;
      if (m[1] === "vertex" && mods.ctrl) {
        if (f.points.length <= fewest) return { refused: `${name} collider needs at least ${fewest} points.` };
        return { label: "Remove collider vertex", edit: { points: f.points.filter((_, i) => i !== index) } };
      }
      if (m[1] === "vertex") return { label: "Move collider vertex", drag: moving(f, f.points, index) };
      // A new point in the middle of the edge, then dragged.
      const a = f.points[index], b = f.points[(index + 1) % f.points.length];
      const points = f.points.map((q): V2 => [q[0], q[1]]);
      points.splice(index + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      return { label: "Add collider vertex", start: { points }, drag: moving(f, points, index + 1) };
    },
  };
}

const polygon2D = pointsShape("engine.PolygonCollider2D", PolygonCollider2D, true);
const edge2D = pointsShape("engine.EdgeCollider2D", EdgeCollider2D, false);

// --- 3D -------------------------------------------------------------------------------------------

const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: readonly number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** A point given in the shape's turned (unscaled) frame around world centre `c`. */
const at = (pose: Pose3D, c: V3, local: readonly number[]): V3 => add(c, rotate(pose.rotation, local));

/** A circle of radius `r` around `c` in the plane of world axes `u` and `v`, from angle `from` to `to`. */
function circle(c: V3, u: V3, v: V3, r: number, from = 0, to = Math.PI * 2, n = 32): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    pts.push(add(c, add(scale3(u, Math.cos(a) * r), scale3(v, Math.sin(a) * r))));
  }
  return pts;
}

type BoxFields3D = { center: V3; size: V3 };
const BOX_FACES = ["x+", "x-", "y+", "y-", "z+", "z-"] as const;
const boxHalf3D = (f: BoxFields3D, pose: Pose3D) => (shapeSize3D({ kind: "box", size: f.size }, pose.scale) as { halfExtents: V3 }).halfExtents;

/** A box's twelve edges in world space. */
function boxWire(pose: Pose3D, center: V3, h: V3): Wire {
  const c = worldCenter(pose, center);
  const corner = (i: number) => at(pose, c, [i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]]);
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return edges.map(([a, b]) => [corner(a), corner(b)]);
}

const box3D = {
  dimension: "3d",
  type: "engine.BoxCollider" as const,
  cls: BoxCollider,
  upright: false,
  read: (c) => ({ center: v3(c.center), size: v3(c.size) }),
  signature: (f) => `b${f.size}`,
  wire: (f, pose) => boxWire(pose, f.center, boxHalf3D(f, pose)),
  // A handle on each face's centre, and one on the centre.
  handles(f, pose) {
    const h = boxHalf3D(f, pose), c = worldCenter(pose, f.center);
    const out: Record<string, V3> = { center: c };
    for (const face of BOX_FACES) {
      const i = AXIS_INDEX[face[0] as "x"], local: V3 = [0, 0, 0];
      local[i] = face[1] === "+" ? h[i] : -h[i];
      out[face] = at(pose, c, local);
    }
    return out;
  },
  // The opposite face stays put, or with Alt both faces move (the centre stays).
  press(f, pose, handle) {
    if (!(BOX_FACES as readonly string[]).includes(handle)) return null;
    const i = AXIS_INDEX[handle[0] as "x"], s = handle[1] === "+" ? 1 : -1;
    const k = Math.abs(pose.scale[i]) || 1;
    const half = (Math.abs(f.size[i]) * k) / 2;
    return (reach, alt) => {
      const center: V3 = [...f.center], size: V3 = [...f.size];
      if (alt) {
        size[i] = Math.max(MIN_EXTENT, (2 * reach) / k);
        return { size };
      }
      const world = Math.max(MIN_EXTENT * k, reach + half); // from the fixed face to the dragged one
      size[i] = world / k;
      center[i] = f.center[i] + (s * (world / 2 - half)) / (pose.scale[i] || 1);
      return { size, center };
    };
  },
} satisfies ColliderShape3D<BoxCollider, BoxFields3D>;

type SphereFields3D = { center: V3; radius: number };
const sphereR = (f: SphereFields3D, pose: Pose3D) => (shapeSize3D({ kind: "sphere", radius: f.radius }, pose.scale) as { radius: number }).radius;

const sphere3D = {
  dimension: "3d",
  type: "engine.SphereCollider" as const,
  cls: SphereCollider,
  upright: false,
  read: (c) => ({ center: v3(c.center), radius: c.radius }),
  signature: (f) => `s${f.radius}`,
  wire(f, pose) {
    const r = sphereR(f, pose), c = worldCenter(pose, f.center), [x, y, z] = axesOf(pose);
    return [circle(c, x, y, r), circle(c, x, z, r), circle(c, y, z, r)];
  },
  // A handle at each end of the sphere's three axes, and one on the centre.
  handles(f, pose) {
    const r = sphereR(f, pose), c = worldCenter(pose, f.center), axes = axesOf(pose);
    const out: Record<string, V3> = { center: c };
    ["x", "y", "z"].forEach((name, i) => {
      out[`radius:${name}+`] = add(c, scale3(axes[i], r));
      out[`radius:${name}-`] = add(c, scale3(axes[i], -r));
    });
    return out;
  },
  press(_f, pose, handle) {
    if (!handle.startsWith("radius:")) return null;
    const k = Math.max(...pose.scale.map(Math.abs)) || 1;
    return (reach) => ({ radius: Math.max(MIN_EXTENT, Math.abs(reach) / k) });
  },
} satisfies ColliderShape3D<SphereCollider, SphereFields3D>;

type CapsuleFields3D = { center: V3; radius: number; height: number; direction: "x" | "y" | "z" };

/** The capsule's axis (index) and the two axes across it. */
function capsuleAxes(direction: "x" | "y" | "z"): [0 | 1 | 2, number, number] {
  const a = AXIS_INDEX[direction] ?? 1;
  return [a, (a + 1) % 3, (a + 2) % 3];
}
const capsuleSize3D = (f: CapsuleFields3D, pose: Pose3D) => shapeSize3D({ kind: "capsule", radius: f.radius, height: f.height, axis: capsuleAxes(f.direction)[0] }, pose.scale) as { radius: number; halfHeight: number };

function capsuleShape<C extends CapsuleCollider | CharacterController, T extends string>(type: T, cls: new () => C, upright: boolean, direction: (c: C) => "x" | "y" | "z"): ColliderShape3D<C, CapsuleFields3D> & { readonly type: T } {
  return {
    dimension: "3d",
    type,
    cls,
    upright,
    read: (c) => ({ center: v3(c.center), radius: c.radius, height: c.height, direction: direction(c) }),
    signature: (f) => `c${f.radius},${f.height},${f.direction}`,
    wire(f, pose) {
      const [a, b, d] = capsuleAxes(f.direction), { radius: r, halfHeight: hh } = capsuleSize3D(f, pose);
      const axes = axesOf(pose), c = worldCenter(pose, f.center);
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
    },
    // On the radius (across the capsule both ways), the two ends, and the centre.
    handles(f, pose) {
      const [a, b, d] = capsuleAxes(f.direction), { radius: r, halfHeight: hh } = capsuleSize3D(f, pose);
      const axes = axesOf(pose), c = worldCenter(pose, f.center);
      return {
        center: c,
        "height+": add(c, scale3(axes[a], hh + r)),
        "height-": add(c, scale3(axes[a], -(hh + r))),
        "radius:u+": add(c, scale3(axes[b], r)),
        "radius:u-": add(c, scale3(axes[b], -r)),
        "radius:v+": add(c, scale3(axes[d], r)),
        "radius:v-": add(c, scale3(axes[d], -r)),
      };
    },
    handleAxis(f, pose, handle) {
      const [a, b, d] = capsuleAxes(f.direction);
      const axis = axesOf(pose)[handle.startsWith("height") ? a : handle.startsWith("radius:u") ? b : d];
      return handle.endsWith("-") ? scale3(axis, -1) : axis;
    },
    // The radius from the reach over the larger scale across the capsule; the height (both ends move) over the scale along it.
    press(f, pose, handle) {
      const [a] = capsuleAxes(f.direction);
      if (handle.startsWith("height")) {
        const k = Math.abs(pose.scale[a]) || 1;
        return (reach) => ({ height: Math.max(MIN_EXTENT, (2 * Math.abs(reach)) / k) });
      }
      if (!handle.startsWith("radius:")) return null;
      const across = Math.max(...pose.scale.filter((_, i) => i !== a).map(Math.abs)) || 1;
      return (reach) => ({ radius: Math.max(MIN_EXTENT, Math.abs(reach) / across) });
    },
  };
}

const capsule3D = capsuleShape("engine.CapsuleCollider", CapsuleCollider, false, (c) => c.direction);
const character3D = capsuleShape("engine.CharacterController", CharacterController, true, () => "y");

// Mesh colliders are drawn by their triangle edges (shared edges once), or above this many triangles as the
// box around them; only their centre is edited.

const MESH_WIRE_TRIANGLES = 2000;
type TriangleData = { readonly vertices: readonly number[]; readonly indices: readonly number[] };
type MeshOutline = { edges: number[] } | { boxCenter: V3; boxSize: V3 };
type MeshFields3D = { center: V3; mesh: TriangleData };

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

const mesh3D = {
  dimension: "3d",
  type: "engine.MeshCollider" as const,
  cls: MeshCollider,
  upright: false,
  read(c) {
    const mesh = meshTriangleData(c.mesh, c.node);
    return mesh ? { center: v3(c.center), mesh } : null;
  },
  signature: (f) => `m${meshOutline(f.mesh).id}`,
  wire(f, pose) {
    const { outline } = meshOutline(f.mesh), { vertices } = f.mesh;
    if ("boxSize" in outline) return boxWire(pose, add(f.center, outline.boxCenter), outline.boxSize.map((v, i) => Math.abs(v * pose.scale[i]) / 2) as V3);
    const c = worldCenter(pose, f.center);
    const world = (i: number): V3 => at(pose, c, [vertices[i * 3] * pose.scale[0], vertices[i * 3 + 1] * pose.scale[1], vertices[i * 3 + 2] * pose.scale[2]]);
    const wire: Wire = [];
    for (let i = 0; i + 1 < outline.edges.length; i += 2) wire.push([world(outline.edges[i]), world(outline.edges[i + 1])]);
    return wire;
  },
  handles: (f, pose) => ({ center: worldCenter(pose, f.center) }),
  press: () => null,
} satisfies ColliderShape3D<MeshCollider, MeshFields3D>;

// --- the table ------------------------------------------------------------------------------------

/** Every collider type Edit Collider works on. */
export const COLLIDER_SHAPES = [box2D, circle2D, polygon2D, edge2D, character2D, box3D, sphere3D, capsule3D, mesh3D, character3D] as const satisfies readonly (AnyColliderShape2D | AnyColliderShape3D)[];

/** The Component type ids Edit Collider works on. */
export type EditableColliderType = (typeof COLLIDER_SHAPES)[number]["type"];

const byClass = new Map<unknown, AnyColliderShape2D | AnyColliderShape3D>(COLLIDER_SHAPES.map((e) => [e.cls, e]));
const byType = new Map<string, AnyColliderShape2D | AnyColliderShape3D>(COLLIDER_SHAPES.map((e) => [e.type, e]));

/** The entry for a collider Component, or undefined for one Edit Collider doesn't work on (a tilemap's). */
export function colliderShapeOf(c: Collider2D): AnyColliderShape2D | undefined;
export function colliderShapeOf(c: Collider): AnyColliderShape3D | undefined;
export function colliderShapeOf(c: Collider | Collider2D): AnyColliderShape2D | AnyColliderShape3D | undefined {
  return byClass.get(c.constructor);
}

/**
 * The outward world axis a 3D collider's `handle` moves along: the entry's own, or from the shape's centre
 * through the handle; null when the handle sits on the centre (nothing to drag along).
 */
export function resizeAxis<F extends { center: V3 }>(shape: ColliderShape3D<Collider, F>, f: F, pose: Pose3D, handle: string): V3 | null {
  const own = shape.handleAxis?.(f, pose, handle);
  if (own) return own;
  const at = shape.handles(f, pose)[handle], c = worldCenter(pose, f.center);
  if (!at) return null;
  const d: V3 = [at[0] - c[0], at[1] - c[1], at[2] - c[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  return len < 1e-9 ? null : scale3(d, 1 / len);
}

/** The entry for a Component type id. */
export const colliderShapeFor = (type: string): AnyColliderShape2D | AnyColliderShape3D | undefined => byType.get(type);
