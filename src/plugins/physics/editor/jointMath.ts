// Geometry for the joint gizmos: the lines that show a joint's anchors, axis, limits and spring in
// world space. Pure functions over plain arrays, so they're tested without a renderer.
import type { shapeKit3d } from "../../../editor/sdk";
import type { JointKind } from "../../../engine/physics/types";

type V3 = shapeKit3d.V3;

export type { V3 };

/** Size of the cross drawn at an anchor, in world units. */
const CROSS_SIZE = 0.15;
/** Length of a hinge's axis line, and the radius of its limits arc. */
const AXIS_LENGTH = 1;
export const ARC_RADIUS = 0.5;

const DEG = Math.PI / 180;
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: readonly number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);

/** `a` scaled to unit length (the +X axis for a zero vector). */
export function normalize(a: readonly number[]): V3 {
  const l = length(a);
  return l < 1e-9 ? [1, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

/** A unit vector perpendicular to `axis`: the reference direction angles are measured from. */
export function perpendicular(axis: readonly number[]): V3 {
  const a = normalize(axis);
  const helper: V3 = Math.abs(a[0]) <= Math.abs(a[1]) && Math.abs(a[0]) <= Math.abs(a[2]) ? [1, 0, 0] : Math.abs(a[1]) <= Math.abs(a[2]) ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(a, helper));
}

/** Three short lines along the world axes through `c`. */
export function crossLines(c: readonly number[], size = CROSS_SIZE): V3[][] {
  return [0, 1, 2].map((i) => {
    const d: V3 = [0, 0, 0];
    d[i] = size;
    return [sub(c, d), add(c, d)];
  });
}

/** `v` turned by `deg` degrees around the unit `axis` (Rodrigues' formula, counterclockwise looking down the axis). */
export function rotateAround(v: readonly number[], axis: readonly number[], deg: number): V3 {
  const k = normalize(axis), c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  const kxv = cross(k, v), kdv = dot(k, v);
  return [v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c), v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c), v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c)];
}

/** An arc around `center` in the plane perpendicular to `axis`, from `fromDeg` to `toDeg` measured from the direction `ref`. */
export function arcPoints(center: readonly number[], axis: readonly number[], ref: readonly number[], fromDeg: number, toDeg: number, radius = ARC_RADIUS, segments?: number): V3[] {
  const n = segments ?? Math.max(2, Math.min(64, Math.ceil(Math.abs(toDeg - fromDeg) / 10)));
  const r = normalize(ref);
  return Array.from({ length: n + 1 }, (_, i) => add(center, mul(rotateAround(r, axis, fromDeg + ((toDeg - fromDeg) * i) / n), radius)));
}

/** A zig-zag from `a` to `b`: `coils` teeth of height `amplitude` sideways, straight ends. */
export function zigzag(a: readonly number[], b: readonly number[], coils = 8, amplitude = 0.08): V3[] {
  const d = sub(b, a), len = length(d);
  if (len < 1e-9) return [add(a, [0, 0, 0]), add(b, [0, 0, 0])];
  const dir = mul(d, 1 / len), side = perpendicular(dir);
  const pts: V3[] = [add(a, [0, 0, 0])];
  const n = coils * 2;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    pts.push(add(add(a, mul(d, t)), mul(side, i % 2 ? -amplitude : amplitude)));
  }
  pts.push(add(b, [0, 0, 0]));
  return pts;
}

export type { JointKind };

/** What a joint gizmo needs, all in world space. */
export interface JointShape {
  kind: JointKind;
  anchor: V3;
  /** The other body's anchor, or null when it's the same point as `anchor`. */
  connected: V3 | null;
  /** Hinge and slider axis (any length). */
  axis?: V3;
  /** Direction hinge angles are measured from (default: any perpendicular to the axis). */
  ref?: V3;
  /** Degrees for hinges, units for sliders; null or missing when limits are off. */
  limits?: { min: number; max: number } | null;
  /**
   * A ball joint's ranges while limits are on (`axis` is its twist axis): twist degrees about `axis`, swing degrees
   * about the joint frame's y and z axes (`frameY`, `frameZ`: unit vectors in world space, perpendicular to `axis`).
   */
  ball?: { twist: { min: number; max: number }; swing: { y: number; z: number }; frameY: V3; frameZ: V3 } | null;
}

/** The segments an elliptical swing cone's rim is drawn with. */
const CONE_SEGMENTS = 32;
/** Swing angles are drawn up to this many degrees: a cone is open at 90°. */
const MAX_SWING_DRAWN = 89;
/** The twist arc's radius, inside the cone's. */
const TWIST_RADIUS = ARC_RADIUS * 0.6;

/**
 * The unit direction on the swing cone's rim at parameter `t` (radians). The cone is elliptical: `swing.y` degrees
 * about the frame's y axis tip the twist axis towards the frame's z direction, `swing.z` about z tip it towards y.
 * The rim is exact on both axes and the ellipse of the tangent plane between them.
 */
export function swingRimDirection(axis: readonly number[], frameY: readonly number[], frameZ: readonly number[], swing: { y: number; z: number }, t: number): V3 {
  const ty = Math.tan(Math.min(Math.abs(swing.z), MAX_SWING_DRAWN) * DEG), tz = Math.tan(Math.min(Math.abs(swing.y), MAX_SWING_DRAWN) * DEG);
  return normalize(add(add(normalize(axis), mul(frameY, ty * Math.cos(t))), mul(frameZ, tz * Math.sin(t))));
}

/** A ball joint's limits: the swing cone's rim with a spoke to each end of its two axes, and the twist arc with a radius to each end. */
function ballWire(anchor: V3, axis: V3, ball: NonNullable<JointShape["ball"]>): V3[][] {
  const wire: V3[][] = [];
  const rim = Array.from({ length: CONE_SEGMENTS + 1 }, (_, i) => add(anchor, mul(swingRimDirection(axis, ball.frameY, ball.frameZ, ball.swing, (i / CONE_SEGMENTS) * 2 * Math.PI), ARC_RADIUS)));
  wire.push(rim);
  for (let k = 0; k < 4; k++) wire.push([anchor, rim[(k * CONE_SEGMENTS) / 4]!]);
  const { min, max } = ball.twist;
  if (Number.isFinite(min) && Number.isFinite(max) && max !== min) {
    wire.push(arcPoints(anchor, axis, ball.frameY, min, max, TWIST_RADIUS));
    for (const deg of [min, max]) wire.push([anchor, add(anchor, mul(rotateAround(ball.frameY, axis, deg), TWIST_RADIUS))]);
  }
  return wire;
}

/** Whether two points are apart enough to draw a line between them. */
export const apart = (a: readonly number[], b: readonly number[]) => length(sub(a, b)) > 1e-6;

/** The polylines that draw a joint: the anchor cross, the link to the connected anchor, and the axis, limits or spring. */
export function jointWire(shape: JointShape): V3[][] {
  const { anchor, connected } = shape;
  const wire = crossLines(anchor);
  const linked = connected !== null && apart(anchor, connected);
  if (shape.kind === "spring") {
    if (linked) wire.push(zigzag(anchor, connected!));
  } else if (linked) {
    wire.push([anchor, connected!]);
  }
  const axis = shape.axis ? normalize(shape.axis) : null;
  if (shape.kind === "hinge" && axis) {
    wire.push([sub(anchor, mul(axis, AXIS_LENGTH / 2)), add(anchor, mul(axis, AXIS_LENGTH / 2))]);
    const l = shape.limits;
    if (l && Number.isFinite(l.min) && Number.isFinite(l.max) && l.max !== l.min) {
      const ref = shape.ref ?? perpendicular(axis);
      wire.push(arcPoints(anchor, axis, ref, Math.min(l.min, l.max), Math.max(l.min, l.max)));
      // Radii to the two ends make the swept range readable.
      const ends = [l.min, l.max].map((deg) => add(anchor, mul(rotateAround(normalize(ref), axis, deg), ARC_RADIUS)));
      for (const end of ends) wire.push([anchor, end]);
    }
  } else if (shape.kind === "ball" && axis && shape.ball) {
    wire.push(...ballWire(anchor, axis, shape.ball));
  } else if (shape.kind === "slider" && axis) {
    const l = shape.limits;
    const lo = l ? Math.min(l.min, l.max) : -AXIS_LENGTH / 2, hi = l ? Math.max(l.min, l.max) : AXIS_LENGTH / 2;
    wire.push([add(anchor, mul(axis, lo)), add(anchor, mul(axis, hi))]);
  }
  return wire;
}
