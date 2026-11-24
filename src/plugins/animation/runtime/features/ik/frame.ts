// A character's model-to-world frame (ADR 0370, 0372; T40t, D41): position, rotation and scale, with the conversions
// the rig's host side needs (grounder rays out to world space, hits back to model space). Model to world is
// `p_w = P + R (S ∘ p_m)`. Normals go back with the inverse transpose (`n_m ∝ S ∘ (R⁻¹ n_w)`). A pure library; it
// allocates nothing per call (the grounder converts every ray of every character each frame).
import { Mat4 } from "../../../../../engine/core/math";
import type { GameObject } from "../../../../../engine/scene/GameObject";

/** `Transform.worldRotation`'s decomposition target: f32, so the rotation read here has that getter's bits. */
const decomposed = { p: new Float32Array(3), q: new Float32Array(4), s: new Float32Array(3) };
const ZERO3 = [0, 0, 0] as const, IDENTITY = [0, 0, 0, 1] as const, ONE3 = [1, 1, 1] as const;

/** @internal A model-to-world frame: position xyz, rotation xyzw (unit), scale xyz. */
export class CharacterFrame {
  readonly position = new Float64Array(3);
  readonly rotation = new Float64Array([0, 0, 0, 1]);
  readonly scale = new Float64Array([1, 1, 1]);

  /**
   * Reads `node`'s world transform. Returns this. The numbers `worldPosition`, `worldRotation` and `worldScale` give,
   * from one read of the world matrix instead of three getters and their objects.
   */
  readNode(node: GameObject): this {
    if (!node.transform) return this.set(ZERO3, IDENTITY, ONE3);
    const e = node.entity;
    const m = node.world.worldMatrix(e), o = e * 16;
    Mat4.decompose(m, o, decomposed.p, 0, decomposed.q, 0, decomposed.s, 0);
    const p = this.position, s = this.scale;
    p[0] = m[o + 12]!;
    p[1] = m[o + 13]!;
    p[2] = m[o + 14]!;
    s[0] = Math.hypot(m[o]!, m[o + 1]!, m[o + 2]!);
    s[1] = Math.hypot(m[o + 4]!, m[o + 5]!, m[o + 6]!);
    s[2] = Math.hypot(m[o + 8]!, m[o + 9]!, m[o + 10]!);
    this.setRotation(decomposed.q);
    return this;
  }

  /** Sets the frame (the rotation is normalised; a zero one becomes the identity). Returns this. */
  set(p: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): this {
    const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
    for (let k = 0; k < 3; k++) {
      this.position[k] = p[k]!;
      this.scale[k] = s[k]!;
    }
    for (let k = 0; k < 4; k++) this.rotation[k] = l > 0 ? q[k]! / l : k === 3 ? 1 : 0;
    return this;
  }

  private setRotation(q: ArrayLike<number>): void {
    const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
    for (let k = 0; k < 4; k++) this.rotation[k] = l > 0 ? q[k]! / l : k === 3 ? 1 : 0;
  }

  copy(other: CharacterFrame): this {
    return this.set(other.position, other.rotation, other.scale);
  }

  /** `v` rotated by the frame's rotation (`inverse`: by its inverse), into `out` at `at`. */
  rotate(v: ArrayLike<number>, out: Float64Array, at = 0, inverse = false): void {
    this.rotate3(v[0]!, v[1]!, v[2]!, out, at, inverse);
  }

  /** `rotate` of (vx, vy, vz). */
  private rotate3(vx: number, vy: number, vz: number, out: Float64Array, at: number, inverse: boolean): void {
    const r = this.rotation;
    const x = r[0]!, y = r[1]!, z = r[2]!;
    const w = inverse ? -r[3]! : r[3]!;
    // v' = v + 2w (q × v) + 2 q × (q × v), with q's vector part negated for the inverse (same as negating w here).
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    out[at] = vx + w * tx + (y * tz - z * ty);
    out[at + 1] = vy + w * ty + (z * tx - x * tz);
    out[at + 2] = vz + w * tz + (x * ty - y * tx);
  }

  /** A model-space point in world space. */
  pointToWorld(p: ArrayLike<number>, out: Float64Array, at = 0): void {
    this.pointToWorld3(p[0]!, p[1]!, p[2]!, out, at);
  }

  /** `pointToWorld` of (x, y, z). */
  pointToWorld3(x: number, y: number, z: number, out: Float64Array, at = 0): void {
    const s = this.scale;
    this.rotate3(x * s[0]!, y * s[1]!, z * s[2]!, out, at, false);
    for (let k = 0; k < 3; k++) out[at + k] += this.position[k]!;
  }

  /** A model-space direction in world space (scaled, not normalised: its length is the model length's world length). */
  vectorToWorld(d: ArrayLike<number>, out: Float64Array, at = 0): void {
    this.vectorToWorld3(d[0]!, d[1]!, d[2]!, out, at);
  }

  /** `vectorToWorld` of (x, y, z). */
  vectorToWorld3(x: number, y: number, z: number, out: Float64Array, at = 0): void {
    const s = this.scale;
    this.rotate3(x * s[0]!, y * s[1]!, z * s[2]!, out, at, false);
  }

  /** A world-space point in model space (a zero scale axis maps to 0). */
  pointToModel(p: ArrayLike<number>, out: Float64Array, at = 0): void {
    this.pointToModel3(p[0]!, p[1]!, p[2]!, out, at);
  }

  /** `pointToModel` of (x, y, z). */
  pointToModel3(x: number, y: number, z: number, out: Float64Array, at = 0): void {
    this.rotate3(x - this.position[0]!, y - this.position[1]!, z - this.position[2]!, out, at, true);
    for (let k = 0; k < 3; k++) {
      const s = this.scale[k]!;
      out[at + k] = s !== 0 ? out[at + k]! / s : 0;
    }
  }

  /** A world-space unit normal in model space, unit length. */
  normalToModel(n: ArrayLike<number>, out: Float64Array, at = 0): void {
    this.normalToModel3(n[0]!, n[1]!, n[2]!, out, at);
  }

  /** `normalToModel` of (x, y, z). */
  normalToModel3(x: number, y: number, z: number, out: Float64Array, at = 0): void {
    this.rotate3(x, y, z, out, at, true);
    for (let k = 0; k < 3; k++) out[at + k] *= this.scale[k]!;
    const l = Math.hypot(out[at]!, out[at + 1]!, out[at + 2]!);
    if (l > 0) for (let k = 0; k < 3; k++) out[at + k] /= l;
  }
}
