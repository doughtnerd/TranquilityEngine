// The ragdoll builder's viewport geometry (ADR 0373 "edit shapes and limits with gizmos"; T55): for one body, the wires of its
// collider shape (capsule, box, sphere) and of its joint's limits (the swing cone and the twist arc, drawn by the physics
// plugin's joint maths, `jointWire`), the handles that resize the shape and set the limits, and the drag of a handle
// as a patch of the body's values (`ragdollLogic.ts`'s `BonePatch`). Pure functions over plain arrays, so they are tested
// without a renderer.
//
// Frames: a body's shape lives in the **body frame**: the bone's frame turned by the body's `frame` (identity by default).
// Its joint sits at the frame's origin, with the twist axis along the frame's x and the swing axes along its y and z
// (ADR 0375). `bodyMatrix` puts that frame in the world; everything here takes it as a column-major 4×4.
import type { shapeKit3d } from "../../../../editor/sdk";
import { ARC_RADIUS, jointWire, rotateAround } from "../../../physics/editor/jointMath";
import type { RagdollBone } from "../../runtime/Ragdoll";
import { RAGDOLL_LIMITS, type BonePatch } from "./ragdollLogic";

type V3 = shapeKit3d.V3;
/** A column-major 4×4. */
export type Mat4 = ArrayLike<number>;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const SEGMENTS = 24;
/** The twist arc's radius in joint-wire units (jointMath's TWIST_RADIUS is 0.6 of the cone's). */
const TWIST_UNITS = ARC_RADIUS * 0.6;

// --- matrices ----------------------------------------------------------------------------------------------------------

/** `m` applied to the point `p`. */
export const transformPoint = (m: Mat4, p: readonly number[]): V3 => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
];

/** `m`'s rotation applied to the direction `d`, scale removed (a unit vector). */
export function transformDirection(m: Mat4, d: readonly number[]): V3 {
  const x = m[0]! * d[0]! + m[4]! * d[1]! + m[8]! * d[2]!, y = m[1]! * d[0]! + m[5]! * d[1]! + m[9]! * d[2]!, z = m[2]! * d[0]! + m[6]! * d[1]! + m[10]! * d[2]!;
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n];
}

/** The inverse of an affine matrix (rotation, scale and translation; no projection). Null when singular. */
export function invertAffine(m: Mat4): number[] | null {
  const a = m[0]!, b = m[4]!, c = m[8]!, d = m[1]!, e = m[5]!, f = m[9]!, g = m[2]!, h = m[6]!, i = m[10]!;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-18) return null;
  const k = 1 / det;
  const r = [(e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k, (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k, (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k];
  // r is the inverse 3×3 row-major; write column-major with the translation -R⁻¹ t.
  const out = [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, 0, 0, 0, 1];
  const t = [m[12]!, m[13]!, m[14]!];
  for (let row = 0; row < 3; row++) out[12 + row] = -(r[row * 3]! * t[0]! + r[row * 3 + 1]! * t[1]! + r[row * 3 + 2]! * t[2]!);
  return out;
}

/** The body frame's matrix: the bone's world matrix times the rotation of the body's `frame` (identity when absent). */
export function bodyMatrix(boneWorld: Mat4, frame?: RagdollBone["frame"]): number[] {
  const out = Array.from({ length: 16 }, (_, i) => boneWorld[i]!);
  if (!frame) return out;
  const { x, y, z, w } = frame;
  const n = Math.hypot(x, y, z, w) || 1;
  const qx = x / n, qy = y / n, qz = z / n, qw = w / n;
  // The rotation's columns (the frame's x, y, z axes in the bone frame).
  const r = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw),
    2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw),
    2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += boneWorld[k * 4 + row]! * r[col * 3 + k]!;
      out[col * 4 + row] = s;
    }
  }
  return out;
}

// --- shape wires -------------------------------------------------------------------------------------------------------

const AXES: Record<RagdollBone["axis"], V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** The two body axes perpendicular to a capsule's. */
function perpendicularsOf(axis: RagdollBone["axis"]): [V3, V3] {
  return axis === "x" ? [AXES.y, AXES.z] : axis === "y" ? [AXES.z, AXES.x] : [AXES.x, AXES.y];
}

const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const mul = (a: readonly number[], k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];

/** A circle of `radius` around `center` in the plane spanned by the unit vectors `u` and `v`; `from`..`to` degrees (default all round). */
function circle(center: readonly number[], u: readonly number[], v: readonly number[], radius: number, from = 0, to = 360): V3[] {
  const n = Math.max(2, Math.ceil((Math.abs(to - from) / 360) * SEGMENTS));
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = (from + ((to - from) * i) / n) * DEG;
    return add(center, add(mul(u, Math.cos(t) * radius), mul(v, Math.sin(t) * radius)));
  });
}

/** A body's collider outline in the body frame: polylines. */
export function shapeWire(b: Pick<RagdollBone, "shape" | "size" | "center" | "axis">): V3[][] {
  const c: V3 = [b.center.x, b.center.y, b.center.z];
  if (b.shape === "box") {
    const h = [b.size.x / 2, b.size.y / 2, b.size.z / 2];
    const corner = (sx: number, sy: number, sz: number): V3 => [c[0] + sx * h[0]!, c[1] + sy * h[1]!, c[2] + sz * h[2]!];
    const lines: V3[][] = [];
    for (const a of [-1, 1]) {
      for (const bb of [-1, 1]) {
        lines.push([corner(-1, a, bb), corner(1, a, bb)], [corner(a, -1, bb), corner(a, 1, bb)], [corner(a, bb, -1), corner(a, bb, 1)]);
      }
    }
    return lines;
  }
  if (b.shape === "sphere") {
    const r = b.size.x;
    return [circle(c, AXES.x, AXES.y, r), circle(c, AXES.y, AXES.z, r), circle(c, AXES.z, AXES.x, r)];
  }
  // Capsule: two end circles, four side lines and the two caps' arcs in both planes.
  const a = AXES[b.axis], [u, v] = perpendicularsOf(b.axis);
  const r = b.size.x, half = Math.max(0, (b.size.y - 2 * r) / 2);
  const top = add(c, mul(a, half)), bottom = add(c, mul(a, -half));
  const lines: V3[][] = [circle(top, u, v, r), circle(bottom, u, v, r)];
  for (const [su, sv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const side = add(mul(u, su * r), mul(v, sv * r));
    lines.push([add(top, side), add(bottom, side)]);
  }
  for (const w of [u, v]) {
    lines.push(circle(top, w, a, r, 0, 180), circle(bottom, w, a, r, 180, 360));
  }
  return lines;
}

/** The longest extent of a body (m): what the joint wire is sized by. */
export const extentOf = (b: Pick<RagdollBone, "shape" | "size">): number => (b.shape === "box" ? Math.max(b.size.x, b.size.y, b.size.z) : b.shape === "capsule" ? b.size.y : b.size.x * 2);

/** The factor the joint wire (a cone of radius `ARC_RADIUS` world units) is scaled by so it fits the body: its extent, at least 5 cm. */
export const jointScaleOf = (b: Pick<RagdollBone, "shape" | "size">): number => Math.max(0.05, extentOf(b) * 0.8) / ARC_RADIUS;

// --- joint wires --------------------------------------------------------------------------------------------------------

/** A body's joint limits in the body frame (the joint at its origin): the swing cone and the twist arc, sized to the body. */
export function jointLimitWire(b: Pick<RagdollBone, "swing" | "twist" | "shape" | "size">): V3[][] {
  const scale = jointScaleOf(b);
  const origin: V3 = [0, 0, 0];
  const wire = jointWire({ kind: "ball", anchor: origin, connected: null, axis: [1, 0, 0], ball: { twist: b.twist, swing: b.swing, frameY: [0, 1, 0], frameZ: [0, 0, 1] } });
  // `jointWire` also draws the anchor's cross at a fixed size; scaled like the rest, it stays proportionate.
  return wire.map((line) => line.map((p) => mul(p, scale)));
}

/** `wire` (body-frame polylines) in the world. */
export const wireToWorld = (m: Mat4, wire: readonly (readonly V3[])[]): V3[][] => wire.map((line) => line.map((p) => transformPoint(m, p)));

// --- handles -----------------------------------------------------------------------------------------------------------

/** The handles of a body, by id, in the body frame: the shape's size handles and the joint's limit handles. */
export function bodyHandles(b: Pick<RagdollBone, "shape" | "size" | "center" | "axis" | "swing" | "twist">): Record<string, V3> {
  const c: V3 = [b.center.x, b.center.y, b.center.z];
  const handles: Record<string, V3> = {};
  if (b.shape === "box") {
    handles["size:x"] = add(c, [b.size.x / 2, 0, 0]);
    handles["size:y"] = add(c, [0, b.size.y / 2, 0]);
    handles["size:z"] = add(c, [0, 0, b.size.z / 2]);
  } else if (b.shape === "sphere") {
    handles["size:radius"] = add(c, [b.size.x, 0, 0]);
  } else {
    const [u] = perpendicularsOf(b.axis);
    handles["size:radius"] = add(c, mul(u, b.size.x));
    handles["size:height"] = add(c, mul(AXES[b.axis], b.size.y / 2));
  }
  const scale = jointScaleOf(b) * ARC_RADIUS;
  // The cone's rim at its two axes' ends (jointMath's swing rim: y tilts toward z, z toward y), and the twist arc's ends.
  handles["swing:z"] = mul([1, Math.tan(Math.min(b.swing.z, 89) * DEG), 0], scale / Math.hypot(1, Math.tan(Math.min(b.swing.z, 89) * DEG)));
  handles["swing:y"] = mul([1, 0, Math.tan(Math.min(b.swing.y, 89) * DEG)], scale / Math.hypot(1, Math.tan(Math.min(b.swing.y, 89) * DEG)));
  const twistRadius = jointScaleOf(b) * TWIST_UNITS;
  for (const key of ["min", "max"] as const) handles[`twist:${key}`] = mul(rotateAround([0, 1, 0], [1, 0, 0], b.twist[key]), twistRadius);
  return handles;
}

/** The body-frame position of every handle, mapped to the world. */
export const handlesToWorld = (m: Mat4, handles: Record<string, V3>): Record<string, V3> => Object.fromEntries(Object.entries(handles).map(([id, p]) => [id, transformPoint(m, p)]));

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const tidy = (n: number) => Math.round(n * 1e4) / 1e4;
const tidyDeg = (n: number) => Math.round(n * 10) / 10;

/**
 * What dragging handle `id` to `local` (the pointer's point in the body frame) sets, as a patch of the body's values, kept inside
 * the rules (`ragdollLogic.ts`): sizes at least the minimum, a capsule at least two radii tall, swing 0 to 180, twist in
 * range with min not above max. Null for an unknown handle.
 */
export function dragPatch(b: Pick<RagdollBone, "shape" | "size" | "center" | "axis" | "swing" | "twist">, id: string, local: readonly number[]): BonePatch | null {
  const L = RAGDOLL_LIMITS;
  const d = [local[0]! - b.center.x, local[1]! - b.center.y, local[2]! - b.center.z];
  switch (id) {
    case "size:x": return { size: { x: tidy(clamp(Math.abs(d[0]!) * 2, L.minSize, L.maxSize)) } };
    case "size:y": return { size: { y: tidy(clamp(Math.abs(d[1]!) * 2, L.minSize, L.maxSize)) } };
    case "size:z": return { size: { z: tidy(clamp(Math.abs(d[2]!) * 2, L.minSize, L.maxSize)) } };
    case "size:radius": {
      if (b.shape === "sphere") return { size: { x: tidy(clamp(Math.hypot(d[0]!, d[1]!, d[2]!), L.minSize, L.maxSize)) } };
      const along = AXES[b.axis];
      const t = d[0]! * along[0] + d[1]! * along[1] + d[2]! * along[2];
      const across = Math.hypot(d[0]! - along[0] * t, d[1]! - along[1] * t, d[2]! - along[2] * t);
      return { size: { x: tidy(clamp(across, L.minSize, Math.min(L.maxSize, b.size.y / 2))) } };
    }
    case "size:height": {
      const along = AXES[b.axis];
      const t = Math.abs(d[0]! * along[0] + d[1]! * along[1] + d[2]! * along[2]);
      return { size: { y: tidy(clamp(t * 2, Math.max(L.minSize, 2 * b.size.x), L.maxSize)) } };
    }
    case "swing:z": return { swing: { z: tidyDeg(clamp(Math.atan2(Math.abs(local[1]!), local[0]!) * RAD, 0, L.swingMax)) } };
    case "swing:y": return { swing: { y: tidyDeg(clamp(Math.atan2(Math.abs(local[2]!), local[0]!) * RAD, 0, L.swingMax)) } };
    case "twist:min": return { twist: { min: tidyDeg(clamp(Math.atan2(local[2]!, local[1]!) * RAD, L.twistMin, b.twist.max)) } };
    case "twist:max": return { twist: { max: tidyDeg(clamp(Math.atan2(local[2]!, local[1]!) * RAD, b.twist.min, L.twistMax)) } };
    default: return null;
  }
}
