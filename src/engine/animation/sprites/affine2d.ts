/**
 * 2D affine transforms as `[a, b, c, d, tx, ty]`: a point maps to `(a·x + c·y + tx, b·x + d·y + ty)`. What 2D bones
 * compose, plus the conversion to and from the core's row-major 3×4 bone matrices (D10; z untouched). Pure. Internal:
 * not public API.
 */

/** @internal `[a, b, c, d, tx, ty]`. */
export type Affine2 = readonly [number, number, number, number, number, number];

/** @internal The identity. */
export const AFFINE_IDENTITY: Affine2 = [1, 0, 0, 1, 0, 0];

/** @internal A rotation by `degrees` counter-clockwise, then a move by `(x, y)`. */
export function affineFromPose(x: number, y: number, degrees: number): Affine2 {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, x, y];
}

/** @internal `m` after `n`: a point goes through `n`, then `m`. */
export function affineMultiply(m: Affine2, n: Affine2): Affine2 {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

/** @internal The inverse (the identity for a singular transform). */
export function affineInvert(m: Affine2): Affine2 {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return AFFINE_IDENTITY;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** @internal Where `m` takes `(x, y)`. */
export function affineApply(m: Affine2, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** @internal Writes `m` as a row-major 3×4 matrix (12 floats) at `out[offset]`. */
export function affineToRows(m: Affine2, out: Float32Array, offset = 0): void {
  out.set([m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, 1, 0], offset);
}

/** @internal The xy part of a row-major 3×4 matrix at `rows[offset]`. */
export function affineFromRows(rows: ArrayLike<number>, offset = 0): Affine2 {
  return [rows[offset]!, rows[offset + 4]!, rows[offset + 1]!, rows[offset + 5]!, rows[offset + 3]!, rows[offset + 7]!];
}
