// A character's model-to-world frame (ADR 0370, 0372; T40t, D41): position, rotation and scale, with the conversions
// the rig's host side needs (grounder rays out to world space, hits back to model space). Model to world is
// `p_w = P + R (S ∘ p_m)`. Normals go back with the inverse transpose (`n_m ∝ S ∘ (R⁻¹ n_w)`). A pure library.
import type { GameObject } from "../../../../../engine/scene/GameObject";

/** @internal A model-to-world frame: position xyz, rotation xyzw (unit), scale xyz. */
export class CharacterFrame {
  readonly position = new Float64Array(3);
  readonly rotation = new Float64Array([0, 0, 0, 1]);
  readonly scale = new Float64Array([1, 1, 1]);

  /** Reads `node`'s world transform. Returns this. */
  readNode(node: GameObject): this {
    const t = node.transform;
    if (!t) return this.set([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const p = t.worldPosition, q = t.worldRotation, s = t.worldScale;
    return this.set([p.x, p.y, p.z], [q.x, q.y, q.z, q.w], [s.x, s.y, s.z]);
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

  copy(other: CharacterFrame): this {
    return this.set(other.position, other.rotation, other.scale);
  }

  /** `v` rotated by the frame's rotation (`inverse`: by its inverse), into `out` at `at`. */
  rotate(v: ArrayLike<number>, out: Float64Array, at = 0, inverse = false): void {
    const [x, y, z, w0] = this.rotation as unknown as [number, number, number, number];
    const w = inverse ? -w0 : w0;
    // v' = v + 2w (q × v) + 2 q × (q × v), with q's vector part negated for the inverse (same as negating w here).
    const vx = v[0]!, vy = v[1]!, vz = v[2]!;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    out[at] = vx + w * tx + (y * tz - z * ty);
    out[at + 1] = vy + w * ty + (z * tx - x * tz);
    out[at + 2] = vz + w * tz + (x * ty - y * tx);
  }

  /** A model-space point in world space. */
  pointToWorld(p: ArrayLike<number>, out: Float64Array, at = 0): void {
    const s = this.scale;
    this.rotate([p[0]! * s[0]!, p[1]! * s[1]!, p[2]! * s[2]!], out, at);
    for (let k = 0; k < 3; k++) out[at + k] += this.position[k]!;
  }

  /** A model-space direction in world space (scaled, not normalised: its length is the model length's world length). */
  vectorToWorld(d: ArrayLike<number>, out: Float64Array, at = 0): void {
    const s = this.scale;
    this.rotate([d[0]! * s[0]!, d[1]! * s[1]!, d[2]! * s[2]!], out, at);
  }

  /** A world-space point in model space (a zero scale axis maps to 0). */
  pointToModel(p: ArrayLike<number>, out: Float64Array, at = 0): void {
    const d = [p[0]! - this.position[0]!, p[1]! - this.position[1]!, p[2]! - this.position[2]!];
    this.rotate(d, out, at, true);
    for (let k = 0; k < 3; k++) {
      const s = this.scale[k]!;
      out[at + k] = s !== 0 ? out[at + k]! / s : 0;
    }
  }

  /** A world-space unit normal in model space, unit length. */
  normalToModel(n: ArrayLike<number>, out: Float64Array, at = 0): void {
    this.rotate(n, out, at, true);
    for (let k = 0; k < 3; k++) out[at + k] *= this.scale[k]!;
    const l = Math.hypot(out[at]!, out[at + 1]!, out[at + 2]!);
    if (l > 0) for (let k = 0; k < 3; k++) out[at + k] /= l;
  }
}
