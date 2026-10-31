/**
 * Ray tests for editor picking (ADR 0022). Internal: three.js types stay inside the render layer.
 */
import { Matrix4, Ray, Vector3 } from "three";

const inverse = new Matrix4();
const local = new Ray();
const hit = new Vector3();

/**
 * @internal Distance along `ray` (world space) to where it crosses the unit quad (-0.5..0.5 on X and Y,
 * at local z = 0) transformed by `matrix`, or null if it misses. Both faces count, so flipped
 * or back-facing sprites are still pickable. Degenerate (zero-scale) quads never hit.
 */
export function rayQuadDistance(ray: Ray, matrix: Matrix4): number | null {
  if (Math.abs(matrix.determinant()) < 1e-12) return null;
  inverse.copy(matrix).invert();
  local.copy(ray).applyMatrix4(inverse);
  const dz = local.direction.z;
  if (Math.abs(dz) < 1e-12) return null; // parallel to the quad
  const t = -local.origin.z / dz;
  if (t < 0) return null; // behind the ray origin
  local.at(t, hit);
  if (Math.abs(hit.x) > 0.5 || Math.abs(hit.y) > 0.5) return null;
  // Measure the distance in world space (the local ray's length is scaled by the matrix).
  hit.applyMatrix4(matrix);
  return hit.distanceTo(ray.origin);
}
