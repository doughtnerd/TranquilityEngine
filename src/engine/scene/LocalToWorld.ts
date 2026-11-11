import { Mat4, Quaternion, Vector3, type Vec3Input } from "../core/math";

const tmpP = [0, 0, 0];
const tmpQ = [0, 0, 0, 1];
const tmpS = [1, 1, 1];

/**
 * A node's local-to-world matrix and what it tells you (ADR 0163), after Unity ECS's `LocalToWorld`:
 * `value` (the matrix), `position`, `rotation`, and the world directions `right` (+X), `up` (+Y) and
 * `forward` (-Z, where cameras look). Read from `transform.localToWorld`, which takes a snapshot: it
 * doesn't follow later moves.
 */
export class LocalToWorld {
  /** The matrix, column-major (16 numbers; translation in 12..14). */
  readonly value: Float64Array;

  /** @internal Copies 16 numbers from `matrix` at `offset`. */
  constructor(matrix: ArrayLike<number>, offset = 0) {
    this.value = new Float64Array(16);
    for (let i = 0; i < 16; i++) this.value[i] = matrix[offset + i];
  }

  /** World-space position (a new Vector3). */
  get position(): Vector3 {
    const m = this.value;
    return new Vector3(m[12], m[13], m[14]);
  }

  /** World-space rotation, with scale taken out (a new Quaternion). */
  get rotation(): Quaternion {
    Mat4.decompose(this.value, 0, tmpP, 0, tmpQ, 0, tmpS, 0);
    return new Quaternion(tmpQ[0], tmpQ[1], tmpQ[2], tmpQ[3]);
  }

  /** The node's +X axis in world space, unit length. */
  get right(): Vector3 { return this.axis(0, 1); }
  /** The node's +Y axis in world space, unit length. */
  get up(): Vector3 { return this.axis(4, 1); }
  /** The node's forward (-Z) in world space, unit length. */
  get forward(): Vector3 { return this.axis(8, -1); }

  /** A point in the node's local space, in world space. */
  transformPoint(point: Vec3Input): Vector3 {
    const p = Vector3.from(point);
    return new Vector3(...Mat4.transformPoint(this.value, 0, p.x, p.y, p.z));
  }

  /** A direction in the node's local space, in world space (rotation and scale, no translation). */
  transformDirection(direction: Vec3Input): Vector3 {
    const d = Vector3.from(direction), m = this.value;
    return new Vector3(m[0] * d.x + m[4] * d.y + m[8] * d.z, m[1] * d.x + m[5] * d.y + m[9] * d.z, m[2] * d.x + m[6] * d.y + m[10] * d.z);
  }

  /** A world-space point, in the node's local space. */
  inverseTransformPoint(point: Vec3Input): Vector3 {
    const p = Vector3.from(point), inv = new Float64Array(16);
    Mat4.invert(inv, 0, this.value, 0);
    return new Vector3(...Mat4.transformPoint(inv, 0, p.x, p.y, p.z));
  }

  /** A world-space direction, in the node's local space. */
  inverseTransformDirection(direction: Vec3Input): Vector3 {
    const d = Vector3.from(direction), m = new Float64Array(16);
    Mat4.invert(m, 0, this.value, 0);
    return new Vector3(m[0] * d.x + m[4] * d.y + m[8] * d.z, m[1] * d.x + m[5] * d.y + m[9] * d.z, m[2] * d.x + m[6] * d.y + m[10] * d.z);
  }

  private axis(o: number, sign: number): Vector3 {
    const m = this.value;
    return new Vector3(m[o] * sign, m[o + 1] * sign, m[o + 2] * sign).normalize();
  }
}
