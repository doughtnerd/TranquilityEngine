/**
 * Editor gizmo math (ADR 0022). Internal: converts the gizmo's world-space pose into the values
 * a node's Transform stores relative to its parent. Kept free of the renderer so it can be
 * tested headless.
 */
import { Euler, Matrix4, Quaternion, Vector3 } from "three";

const RAD2DEG = 180 / Math.PI;

/** @internal A Transform's local values in scene-file form: metres, Euler XYZ degrees, scale factors. */
export interface LocalPose {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

const world = new Matrix4();
const inverse = new Matrix4();
const local = new Matrix4();
const p = new Vector3();
const q = new Quaternion();
const s = new Vector3();
const euler = new Euler();

/** Round away float noise so files don't fill with 0.30000000000000004. */
function clean(n: number): number {
  const r = Math.round(n * 1e5) / 1e5;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * @internal Local pose of a node whose world transform is (`position`, `quaternion`, `scale`), given its
 * parent's world matrix (null for a node under the World root). Euler order XYZ matches the
 * engine's `Quaternion.setFromEuler`.
 */
export function localPoseFromWorld(parentWorld: Matrix4 | null, position: Vector3, quaternion: Quaternion, scale: Vector3): LocalPose {
  world.compose(position, quaternion, scale);
  if (parentWorld) local.multiplyMatrices(inverse.copy(parentWorld).invert(), world);
  else local.copy(world);
  local.decompose(p, q, s);
  euler.setFromQuaternion(q, "XYZ");
  return {
    position: [clean(p.x), clean(p.y), clean(p.z)],
    rotation: [clean(euler.x * RAD2DEG), clean(euler.y * RAD2DEG), clean(euler.z * RAD2DEG)],
    scale: [clean(s.x), clean(s.y), clean(s.z)],
  };
}
