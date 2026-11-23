// Affine 3×4 matrices in the animation core's bone-matrix layout (ADR 0370, D10): row-major, three rows
// `[r00 r01 r02 tx] [r10 r11 r12 ty] [r20 r21 r22 tz]`, 12 floats at an offset into a flat array. A pure library: the
// Skeleton's rest and bind matrices, BoneAttachments (model = skinning × bind) and the engine's column-major `Mat4`
// meet here.
type Floats = Float32Array | Float64Array | number[];

/** @internal out = a × b (3×4 affine). `out` may alias neither input at the same offset. */
export function multiply34(out: Floats, o: number, a: Floats, ao: number, b: Floats, bo: number): void {
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4]!, a1 = a[ao + r * 4 + 1]!, a2 = a[ao + r * 4 + 2]!, a3 = a[ao + r * 4 + 3]!;
    for (let c = 0; c < 4; c++) {
      out[o + r * 4 + c] = a0 * b[bo + c]! + a1 * b[bo + 4 + c]! + a2 * b[bo + 8 + c]! + (c === 3 ? a3 : 0);
    }
  }
}

/** @internal out = inverse(a) (3×4 affine). Returns false (out untouched) when `a` is singular. */
export function invert34(out: Floats, o: number, a: Floats, ao: number): boolean {
  const m00 = a[ao]!, m01 = a[ao + 1]!, m02 = a[ao + 2]!, tx = a[ao + 3]!;
  const m10 = a[ao + 4]!, m11 = a[ao + 5]!, m12 = a[ao + 6]!, ty = a[ao + 7]!;
  const m20 = a[ao + 8]!, m21 = a[ao + 9]!, m22 = a[ao + 10]!, tz = a[ao + 11]!;
  const c00 = m11 * m22 - m12 * m21, c01 = m02 * m21 - m01 * m22, c02 = m01 * m12 - m02 * m11;
  const det = m00 * c00 + m10 * c01 + m20 * c02;
  if (!det || !Number.isFinite(det)) return false;
  const d = 1 / det;
  const i00 = c00 * d, i01 = c01 * d, i02 = c02 * d;
  const i10 = (m12 * m20 - m10 * m22) * d, i11 = (m00 * m22 - m02 * m20) * d, i12 = (m02 * m10 - m00 * m12) * d;
  const i20 = (m10 * m21 - m11 * m20) * d, i21 = (m01 * m20 - m00 * m21) * d, i22 = (m00 * m11 - m01 * m10) * d;
  out[o] = i00;
  out[o + 1] = i01;
  out[o + 2] = i02;
  out[o + 3] = -(i00 * tx + i01 * ty + i02 * tz);
  out[o + 4] = i10;
  out[o + 5] = i11;
  out[o + 6] = i12;
  out[o + 7] = -(i10 * tx + i11 * ty + i12 * tz);
  out[o + 8] = i20;
  out[o + 9] = i21;
  out[o + 10] = i22;
  out[o + 11] = -(i20 * tx + i21 * ty + i22 * tz);
  return true;
}

/** @internal out = translation `t` × rotation `q` (x, y, z, w) × scale `s`, read at `to`, `qo`, `so` of `trs`. */
export function compose34(out: Floats, o: number, trs: Floats, to: number, qo: number, so: number): void {
  const x = trs[qo]!, y = trs[qo + 1]!, z = trs[qo + 2]!, w = trs[qo + 3]!;
  const sx = trs[so]!, sy = trs[so + 1]!, sz = trs[so + 2]!;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  out[o] = (1 - 2 * (yy + zz)) * sx;
  out[o + 1] = 2 * (xy - wz) * sy;
  out[o + 2] = 2 * (xz + wy) * sz;
  out[o + 3] = trs[to]!;
  out[o + 4] = 2 * (xy + wz) * sx;
  out[o + 5] = (1 - 2 * (xx + zz)) * sy;
  out[o + 6] = 2 * (yz - wx) * sz;
  out[o + 7] = trs[to + 1]!;
  out[o + 8] = 2 * (xz - wy) * sx;
  out[o + 9] = 2 * (yz + wx) * sy;
  out[o + 10] = (1 - 2 * (xx + yy)) * sz;
  out[o + 11] = trs[to + 2]!;
}

/** @internal Writes the 3×4 at `ao` of `a` as a column-major 4×4 (the engine's `Mat4` layout) at `o` of `out`. */
export function toMat4(out: Float32Array | Float64Array, o: number, a: Floats, ao: number): void {
  for (let r = 0; r < 3; r++) {
    out[o + r] = a[ao + r * 4]!;
    out[o + 4 + r] = a[ao + r * 4 + 1]!;
    out[o + 8 + r] = a[ao + r * 4 + 2]!;
    out[o + 12 + r] = a[ao + r * 4 + 3]!;
  }
  out[o + 3] = out[o + 7] = out[o + 11] = 0;
  out[o + 15] = 1;
}
