// A look-at rotation in Babylon's types: what the previews' cameras aim with (`previews/common.ts`). Pure.
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";

/**
 * The rotation that puts a camera at `eye` looking at `target`, +Y up, as the engine's cameras look
 * (along +Z): the quaternion of the basis the engine's world matrices decompose to.
 */
export function lookAtRotation(eye: readonly number[], target: readonly number[]): Quaternion {
  const z = new Vector3(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
  if (z.lengthSquared() < 1e-12) z.set(0, 0, 1);
  z.normalize();
  let x = Vector3.Cross(Vector3.Up(), z);
  if (x.lengthSquared() < 1e-12) x = new Vector3(1, 0, 0); // looking straight up or down
  x.normalize();
  const y = Vector3.Cross(z, x);
  const m = Matrix.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);
  const q = new Quaternion();
  m.decompose(undefined, q);
  return q;
}
