/**
 * Moving imported transforms between spaces (ADR 0371 "Model import", 0164 handedness): a model file's local TRS
 * values become the engine's through two fixed matrices, `engine = A · local · B`.
 *
 * - A **bone** of an imported skeleton: `A = M · P`, `B = M⁻¹`, where `M` is the model's import matrix (handedness
 *   mirror, `scale`, `upAxis`) and `P` folds in the static nodes between the bone and its parent bone. So bone rests
 *   and bone tracks are the file's, conjugated into the engine's left-handed model space, with `scale` in their
 *   translations (never in their scales).
 * - A **node** of the model's tree (what the editor's drop makes, ADR 0118): `A = E_parent⁻¹ · M · W_parent`,
 *   `B = mirror`, which is the local pose the drop gives that node, so node tracks key the same values.
 *
 * `trsSpace(A, B)` splits that product into maps of each channel alone, which is exact whenever `B` has no
 * translation and `A`'s and `B`'s linear parts are a uniform scale times a signed permutation or rotation (every import
 * matrix is): translation `t' = L·t + o`, rotation `q' = qA ⊗ q ⊗ qB`, scale `s'[i] = k · s[perm[i]]`. Each map is
 * linear in the channel's values (the translation's offset aside), so a cubic spline's tangents map through the same
 * linear part.
 *
 * Matrices are column-major 4×4 (`Mat4`, three.js's layout). Pure; no three.js. Internal: not public API.
 */
import { Mat4 } from "../../core/math";

/** @internal A column-major 4×4 matrix. */
export type Matrix = Float64Array;
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/** @internal Each channel's map from file values to engine values. */
export interface TrsSpace {
  /** Translation: linear part, column-major 3×3. */
  readonly linear: readonly number[];
  /** Translation: offset. */
  readonly offset: Vec3;
  /** Rotation: `qPre ⊗ q ⊗ qPost`. */
  readonly qPre: Quat;
  readonly qPost: Quat;
  /** Scale: `s'[i] = scaleBy · s[perm[i]]`. */
  readonly scaleBy: number;
  readonly perm: readonly [number, number, number];
}

/** @internal The identity map. */
export const IDENTITY_SPACE: TrsSpace = Object.freeze({ linear: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] as Vec3, qPre: [0, 0, 0, 1] as Quat, qPost: [0, 0, 0, 1] as Quat, scaleBy: 1, perm: [0, 1, 2] as const });

/** @internal A new identity matrix. */
export function identity(): Matrix {
  const m = new Float64Array(16);
  Mat4.identity(m, 0);
  return m;
}

/** @internal `a · b` (new). */
export function mul(a: Matrix, b: Matrix): Matrix {
  const out = new Float64Array(16);
  Mat4.multiply(out, 0, a, 0, b, 0);
  return out;
}

/** @internal `a⁻¹` (new); the identity for a singular matrix. */
export function inverse(a: Matrix): Matrix {
  const out = new Float64Array(16);
  if (!Mat4.invert(out, 0, a, 0)) Mat4.identity(out, 0);
  return out;
}

/** @internal A matrix from translation, rotation (x, y, z, w) and scale. */
export function compose(t: Vec3, q: Quat, s: Vec3): Matrix {
  const out = new Float64Array(16);
  Mat4.compose(out, 0, [...t], 0, [...q], 0, [...s], 0);
  return out;
}

/** @internal A matrix's translation, rotation and scale. */
export function decompose(m: Matrix): { t: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] } {
  const t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1];
  Mat4.decompose(m, 0, t, 0, q, 0, s, 0);
  return { t: t as [number, number, number], q: q as [number, number, number, number], s: s as [number, number, number] };
}

/** @internal `a ⊗ b` (Hamilton product, x, y, z, w). */
export function quatMul(a: Quat, b: Quat): [number, number, number, number] {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** The rotation quaternion of an orthonormal 3×3 (column-major `r`), Shepperd's method. */
function quatOf(r: readonly number[]): [number, number, number, number] {
  const m = new Float64Array(16);
  Mat4.identity(m, 0);
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) m[c * 4 + row] = r[c * 3 + row];
  return decompose(m).q;
}

/** A matrix's linear part as a uniform scale and an orthonormal 3×3 (column-major), and whether that is improper. */
function split(m: Matrix): { k: number; r: number[]; improper: boolean } {
  const cols = [0, 1, 2].map((c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]);
  const lengths = cols.map((c) => Math.hypot(c[0], c[1], c[2]));
  const k = (lengths[0] + lengths[1] + lengths[2]) / 3 || 1;
  const r = cols.flatMap((c, i) => c.map((v) => v / (lengths[i] || 1)));
  const det = r[0] * (r[4] * r[8] - r[7] * r[5]) - r[3] * (r[1] * r[8] - r[7] * r[2]) + r[6] * (r[1] * r[5] - r[4] * r[2]);
  return { k, r, improper: det < 0 };
}

/**
 * @internal The per-channel maps of `engine = A · local · B` (see the module comment). `A`'s and `B`'s linear parts
 * must together be proper (an even number of mirrors), as every import matrix pair is.
 */
export function trsSpace(a: Matrix, b: Matrix): TrsSpace {
  const sa = split(a), sb = split(b);
  // An improper orthonormal matrix Q is -R for a proper R; the two signs cancel in Q_A · R · Q_B.
  const proper = (s: { r: number[]; improper: boolean }) => (s.improper ? s.r.map((v) => -v) : s.r);
  const perm = [0, 1, 2].map((i) => {
    // s'_i = Σ_j Q_B[j][i]² s_j: the row j whose entry in column i is largest.
    let best = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(sb.r[i * 3 + j]) > Math.abs(sb.r[i * 3 + best])) best = j;
    return best;
  }) as [number, number, number];
  const qPre = quatOf(proper(sa));
  let qPost = quatOf(proper(sb));
  // q and -q are one rotation: pick the sign that maps the identity to a positive w, so mapped rests stay canonical.
  if (quatMul(qPre, qPost)[3] < 0) qPost = qPost.map((v) => -v) as [number, number, number, number];
  return {
    linear: [a[0], a[1], a[2], a[4], a[5], a[6], a[8], a[9], a[10]],
    offset: [a[12], a[13], a[14]],
    qPre,
    qPost,
    scaleBy: sa.k * sb.k,
    perm,
  };
}

/** @internal A translation (or, with `offset` false, a translation's tangent) through `space`. */
export function mapTranslation(space: TrsSpace, v: readonly number[], offset = true): [number, number, number] {
  const l = space.linear, o = offset ? space.offset : [0, 0, 0];
  return [l[0] * v[0] + l[3] * v[1] + l[6] * v[2] + o[0], l[1] * v[0] + l[4] * v[1] + l[7] * v[2] + o[1], l[2] * v[0] + l[5] * v[1] + l[8] * v[2] + o[2]];
}

/** @internal A rotation (or its tangent: the map is linear) through `space`. */
export function mapRotation(space: TrsSpace, q: readonly number[]): [number, number, number, number] {
  return quatMul(quatMul(space.qPre, q as unknown as Quat), space.qPost);
}

/** @internal A scale (or its tangent) through `space`. */
export function mapScale(space: TrsSpace, s: readonly number[]): [number, number, number] {
  const k = space.scaleBy, p = space.perm;
  return [k * s[p[0]], k * s[p[1]], k * s[p[2]]];
}

/** @internal A column-major 4×4 as the core's 3×4 row-major bone matrix (D10): rows `[r0 r1 r2 t]`, 12 floats. */
export function toRowMajor3x4(m: Matrix, out: Float32Array, at: number): void {
  for (let row = 0; row < 3; row++) {
    out[at + row * 4] = m[row];
    out[at + row * 4 + 1] = m[4 + row];
    out[at + row * 4 + 2] = m[8 + row];
    out[at + row * 4 + 3] = m[12 + row];
  }
}

/** @internal A 3×4 row-major bone matrix back as a column-major 4×4. */
export function fromRowMajor3x4(src: ArrayLike<number>, at: number): Matrix {
  const m = identity();
  for (let row = 0; row < 3; row++) {
    m[row] = src[at + row * 4];
    m[4 + row] = src[at + row * 4 + 1];
    m[8 + row] = src[at + row * 4 + 2];
    m[12 + row] = src[at + row * 4 + 3];
  }
  return m;
}
