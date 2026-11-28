/**
 * The engine's one triangle winding (ADR 0450). Every engine mesh, and every native core that reads engine triangles,
 * uses it as it is; nothing flips triangles at a boundary.
 *
 * **A front face's right-hand normal `(b - a) × (c - a)` points inward**, so its outward normal is `(c - a) × (b - a)`
 * (`frontNormal`). Seen from the front on screen (x right, y up), a front face runs counter-clockwise. This is
 * Babylon's default front face in the engine's left-handed space (ADR 0164; Babylon names it
 * `Material.ClockWiseSideOrientation`, counting in its own projected space). The rule is stated by the normal, not by
 * "clockwise", because the word flips with the space it is counted in.
 *
 * Who follows it:
 * - **Model import** (`models.ts`) flips files into it, and **built-in meshes** (`builtinMeshes.ts`) are built in it.
 *   `MeshData.indices` is always in it.
 * - **The occlusion core** (`native/visibility`, `vis_raster::geom::front_normal`) takes engine triangles as they are.
 * - **Navigation** (`native/nav`, `nav_math::winding::front_normal`) takes bake triangles in it: the walkable side faces
 *   along the front normal. `src/engine/nav/geometry.ts` rewinds only under a mirroring transform, which reverses it.
 */

/** The engine's winding, by its normal rule: a front face's right-hand normal points inward. */
export const FRONT_FACE_WINDING = "rightHandNormalInward" as const;

/**
 * The outward normal of triangle (a, b, c) in the engine's winding: `(c - a) × (b - a)`, unnormalised. Written into
 * `out` (3 numbers) and returned.
 */
export function frontNormal(a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>, out: number[] | Float32Array = [0, 0, 0]): number[] | Float32Array {
  const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2];
  const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
  out[0] = uy * vz - uz * vy;
  out[1] = uz * vx - ux * vz;
  out[2] = ux * vy - uy * vx;
  return out;
}
