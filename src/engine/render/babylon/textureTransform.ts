/**
 * `KHR_texture_transform` as Babylon texture properties (ADR 0371, 0088; T24). A transform the importer baked into
 * the mesh's UVs (`models.ts`: `uvTransformsOf`) is, for a material whose transform an animation drives, a live
 * value on its textures instead; this is the same transform, so an unchanged live one draws as the baked one did.
 *
 * The baked path takes the file's UVs `(u, v)` (V down) through three's texture matrix, `u' = sx·(cos·u + sin·v) + tx`
 * and `v' = sy·(−sin·u + cos·v) + ty` (rotation first, then scale, then offset), then flips V (`1 − v'`), and the
 * texture uploads flipped (`invertY`). The mesh's UVs hold the flipped file UVs `(u, 1 − v)`, so the live matrix acts
 * on those: `u'' = sx·(cos·u − sin·v) + sx·sin + tx` and `v'' = sy·(sin·u + cos·v) + 1 − sy·cos − ty`. Babylon's
 * texture matrix, with `homogeneousRotationInUVTransform`, rotates about the origin by `wAng`, then scales, then
 * offsets: the same order, so `wAng = rotation` and the offsets below are exact, for any scale (its default order,
 * scale first, is not). Its rotation centre must be the origin (its default is the image's middle).
 *
 * A compressed (KTX2) texture can't flip on upload: it flips in the texture matrix (`v → 1 − v`), which after the
 * transform is `vScale → −vScale` and `vOffset → 1 − vOffset`.
 *
 * Pure. Internal: not public API.
 */

/** @internal A texture transform (`KHR_texture_transform`, in the file's UV space): offset, scale, rotation in radians. */
export interface TextureTransform {
  readonly offset: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
}

/** @internal The Babylon texture properties of a transform. */
export interface BabylonUv {
  uOffset: number;
  vOffset: number;
  uScale: number;
  vScale: number;
  wAng: number;
}

/** @internal The identity transform (what a texture without one has). */
export const IDENTITY_TRANSFORM: TextureTransform = Object.freeze({ offset: [0, 0] as const, scale: [1, 1] as const, rotation: 0 });

/** @internal `t` as Babylon texture properties written into `out`; `flipped` for a texture whose V flip is in its matrix (KTX2). */
export function babylonUv(t: TextureTransform, flipped: boolean, out: BabylonUv): BabylonUv {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const sx = t.scale[0];
  const sy = t.scale[1];
  out.uScale = sx;
  out.vScale = flipped ? -sy : sy;
  out.uOffset = sx * s + t.offset[0];
  const v = 1 - sy * c - t.offset[1];
  out.vOffset = flipped ? 1 - v : v;
  out.wAng = t.rotation;
  return out;
}
