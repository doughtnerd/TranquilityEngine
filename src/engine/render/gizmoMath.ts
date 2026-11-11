/**
 * Editor gizmo math (ADR 0022). Internal: converts the gizmo's world-space pose into the values
 * a node's Transform stores relative to its parent. Kept free of the renderer so it can be
 * tested headless. Works in double precision (`Float64Array`), so poses written to scene files
 * don't pick up float32 noise.
 */
import { Mat4, Quaternion, type QuatLike, type Vec3Like } from "../core/math";

/** @internal A Transform's local values in scene-file form: metres, a quaternion `[x, y, z, w]` (ADR 0163), scale factors. */
export interface LocalPose {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

const world = new Float64Array(16);
const inverse = new Float64Array(16);
const local = new Float64Array(16);
const p = [0, 0, 0];
const q = [0, 0, 0, 1];
const s = [1, 1, 1];

/** Round away float noise so files don't fill with 0.30000000000000004. */
function clean(n: number): number {
  const r = Math.round(n * 1e5) / 1e5;
  return Object.is(r, -0) ? 0 : r;
}

/** Round a quaternion component (finer than `clean`: 1e-5 there is a 0.002-degree step). */
function cleanUnit(n: number): number {
  const r = Math.round(n * 1e7) / 1e7;
  return Object.is(r, -0) ? 0 : r;
}

/** @internal A matrix (16 floats, column-major) from `array` at `offset`, widened to double precision. */
export function matrixFrom(array: ArrayLike<number>, offset = 0): Float64Array {
  const m = new Float64Array(16);
  for (let i = 0; i < 16; i++) m[i] = array[offset + i];
  return m;
}

/** @internal The matrix of position, rotation and scale (a new `Float64Array`). */
export function composeMatrix(position: Vec3Like, quaternion: QuatLike, scale: Vec3Like): Float64Array {
  const m = new Float64Array(16);
  Mat4.compose(m, 0, [position.x, position.y, position.z], 0, [quaternion.x, quaternion.y, quaternion.z, quaternion.w], 0, [scale.x, scale.y, scale.z], 0);
  return m;
}

/**
 * @internal Local pose of a node whose world matrix is `nodeWorld` (16 floats), given its parent's world
 * matrix (null for a node under the World root). The rotation is a quaternion with w ≥ 0.
 */
export function localPoseFromMatrix(parentWorld: ArrayLike<number> | null, nodeWorld: ArrayLike<number>): LocalPose {
  for (let i = 0; i < 16; i++) world[i] = nodeWorld[i];
  if (parentWorld) {
    for (let i = 0; i < 16; i++) inverse[i] = parentWorld[i];
    Mat4.invert(inverse, 0, inverse, 0);
    Mat4.multiply(local, 0, inverse, 0, world, 0);
  } else local.set(world);
  Mat4.decompose(local, 0, p, 0, q, 0, s, 0);
  const sign = q[3] < 0 ? -1 : 1;
  return {
    position: [clean(p[0]), clean(p[1]), clean(p[2])],
    rotation: [cleanUnit(q[0] * sign), cleanUnit(q[1] * sign), cleanUnit(q[2] * sign), cleanUnit(q[3] * sign)],
    scale: [clean(s[0]), clean(s[1]), clean(s[2])],
  };
}

/**
 * @internal Local pose of a node whose world transform is (`position`, `quaternion`, `scale`), given its
 * parent's world matrix (null for a node under the World root).
 */
export function localPoseFromWorld(parentWorld: ArrayLike<number> | null, position: Vec3Like, quaternion: QuatLike, scale: Vec3Like): LocalPose {
  return localPoseFromMatrix(parentWorld, composeMatrix(position, quaternion, scale));
}
