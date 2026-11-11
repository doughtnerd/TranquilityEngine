import { Mat4, Quaternion, RAD2DEG, Vector2, Vector3, type Vec3Input, type Vec3Like } from "../core/math";
import type { World } from "../core/World";
import type { GameObject } from "./GameObject";
import { LocalToWorld } from "./LocalToWorld";

const tmpA = new Float32Array(16);
const tmpP = new Float32Array(3);
const tmpQ = new Float32Array(4);
const tmpS = new Float32Array(3);

/**
 * A node's position, rotation and scale (ADR 0008, 0010, 0163).
 *
 * `position`, `rotation` (a quaternion) and `scale` are **local** (relative to the parent), as the fields
 * of Unity ECS's `LocalTransform`, and are live views (ADR 0019): `transform.position.x += 1` moves the
 * node. Use `.clone()` to keep a snapshot. Turn with `rotate`, `rotateX/Y/Z` rather than by editing
 * Euler angles. World space: `localToWorld` (as Unity ECS's `LocalToWorld`), `worldPosition`,
 * `worldRotation`, `worldRotation2D` and `worldScale`.
 *
 * Transform data lives in the World's typed arrays; this class is a facade over it.
 */
export class Transform {
  private readonly _position: Vector3;
  private readonly _position2D: Vector2;
  private readonly _rotation: Quaternion;
  private readonly _scale: Vector3;

  /** @internal */
  constructor(private readonly world: World, private readonly e: number) {
    const dirty = () => world.markTransformDirty(e);
    this._position = Vector3.view(world.tPos, e * 3, dirty);
    this._position2D = Vector2.view(world.tPos, e * 3, dirty);
    this._rotation = Quaternion.view(world.tRot, e * 4, dirty);
    this._scale = Vector3.view(world.tScl, e * 3, dirty);
  }

  /** @internal Re-point views after the World grows its storage. */
  _rebind(): void {
    this._position._a = this.world.tPos;
    this._position2D._a = this.world.tPos;
    this._rotation._a = this.world.tRot;
    this._scale._a = this.world.tScl;
  }

  get node(): GameObject {
    return this.world.handle(this.e);
  }

  /** Local position (live view). */
  get position(): Vector3 { return this._position; }
  set position(v: Vec3Input) { this._position.copy(v); }

  /** Local x/y position (live view over the same storage as `position`). */
  get position2D(): Vector2 { return this._position2D; }
  set position2D(v: Vector2 | readonly [number, number]) { this._position2D.copy(v); }

  /** Local rotation (live view). */
  get rotation(): Quaternion { return this._rotation; }
  set rotation(q: Quaternion) { this._rotation.copy(q); }

  /** Local scale (live view). */
  get scale(): Vector3 { return this._scale; }
  set scale(v: Vec3Input) { this._scale.copy(v); }

  /**
   * Local rotation as Euler angles in degrees, as Unity's `localEulerAngles`: order ZXY (roll, then pitch,
   * then yaw), each read back in [0, 360). Returns a copy. Reading, changing and writing back works for
   * yaw (y) all the way round but not for pitch (x) past ±90, which reads back flipped; turn with
   * `rotate`, `rotateX/Y/Z` instead.
   */
  get eulerAngles(): Vector3 { return this._rotation.eulerAngles; }
  set eulerAngles(v: Vec3Input) {
    const e = Vector3.from(v);
    this._rotation.setFromEuler(e.x, e.y, e.z, "ZXY");
  }

  /**
   * Turn by `rotation`, about the parent's axes (`rotation = q · rotation`, default) or the node's own
   * (`"self"`: `rotation = rotation · q`). Named after Unity ECS's `LocalTransform.Rotate`.
   */
  rotate(rotation: Quaternion, space: "parent" | "self" = "parent"): void {
    if (space === "self") this._rotation.multiply(rotation).normalize();
    else this._rotation.premultiply(rotation).normalize();
  }

  /** Turn `degrees` about the X axis (the parent's, or the node's own with `"self"`). */
  rotateX(degrees: number, space: "parent" | "self" = "parent"): void { this.rotate(Quaternion.rotateX(degrees), space); }
  /** Turn `degrees` about the Y axis (the parent's, or the node's own with `"self"`). */
  rotateY(degrees: number, space: "parent" | "self" = "parent"): void { this.rotate(Quaternion.rotateY(degrees), space); }
  /** Turn `degrees` about the Z axis (the parent's, or the node's own with `"self"`). */
  rotateZ(degrees: number, space: "parent" | "self" = "parent"): void { this.rotate(Quaternion.rotateZ(degrees), space); }

  /** Local rotation around Z in degrees. */
  get rotation2D(): number { return this._rotation.angle2D; }
  set rotation2D(degrees: number) { this._rotation.setFromEuler(0, 0, degrees); }

  /** World-space position. Returns a copy; assigning moves the node. */
  get worldPosition(): Vector3 {
    const m = this.world.worldMatrix(this.e), o = this.e * 16;
    return new Vector3(m[o + 12], m[o + 13], m[o + 14]);
  }
  set worldPosition(v: Vec3Input) {
    const p = Vector3.from(v);
    const parent = this.world.parentEntity(this.e);
    if (parent < 0) {
      this._position.copy(p);
      return;
    }
    Mat4.invert(tmpA, 0, this.world.worldMatrix(parent), parent * 16);
    this._position.set(...Mat4.transformPoint(tmpA, 0, p.x, p.y, p.z));
  }

  /** World-space rotation around Z in degrees (2D). */
  get worldRotation2D(): number {
    const m = this.world.worldMatrix(this.e), o = this.e * 16;
    return Math.atan2(m[o + 1], m[o]) * RAD2DEG;
  }
  set worldRotation2D(degrees: number) {
    const parent = this.world.parentEntity(this.e);
    const parentRot = parent < 0 ? 0 : Math.atan2(this.world.worldMatrix(parent)[parent * 16 + 1], this.world.tWorld[parent * 16]) * RAD2DEG;
    this.rotation2D = degrees - parentRot;
  }

  /** World-space rotation. Returns a copy; assigning turns the node. */
  get worldRotation(): Quaternion {
    Mat4.decompose(this.world.worldMatrix(this.e), this.e * 16, tmpP, 0, tmpQ, 0, tmpS, 0);
    return new Quaternion(tmpQ[0], tmpQ[1], tmpQ[2], tmpQ[3]);
  }
  set worldRotation(q: Quaternion) {
    const parent = this.world.parentEntity(this.e);
    if (parent < 0 || !this.world.hasTransform[parent]) {
      this._rotation.copy(q);
      return;
    }
    Mat4.decompose(this.world.worldMatrix(parent), parent * 16, tmpP, 0, tmpQ, 0, tmpS, 0);
    // local = inverse(parent) * world
    this._rotation.copy(new Quaternion(-tmpQ[0], -tmpQ[1], -tmpQ[2], tmpQ[3]).multiply(q).normalize());
  }

  /** World-space scale (lossy, from matrix column lengths). */
  get worldScale(): Vector3 {
    const m = this.world.worldMatrix(this.e), o = this.e * 16;
    return new Vector3(Math.hypot(m[o], m[o + 1], m[o + 2]), Math.hypot(m[o + 4], m[o + 5], m[o + 6]), Math.hypot(m[o + 8], m[o + 9], m[o + 10]));
  }

  /** Move by `delta`, in local (parent) space by default or world space. */
  translate(delta: Vec3Like, space: "local" | "world" = "local"): void {
    if (space === "local") this._position.add(delta);
    else this.worldPosition = Vector3.add(this.worldPosition, delta);
  }

  /** Rotate around Z by `degrees`. */
  rotate2D(degrees: number): void {
    this.rotation2D = this.rotation2D + degrees;
  }

  /**
   * A snapshot of the node's local-to-world matrix (as Unity ECS's `LocalToWorld`): `value`, `position`,
   * `rotation`, `right`, `up`, `forward`, and `transformPoint` / `inverseTransformPoint` to convert
   * points between this node's space and world space.
   */
  get localToWorld(): LocalToWorld {
    return new LocalToWorld(this.world.worldMatrix(this.e), this.e * 16);
  }

  /** @internal Set world x/y and Z rotation in one go (used by physics write-back). */
  _setWorldPose2D(x: number, y: number, degrees: number): void {
    const parent = this.world.parentEntity(this.e);
    const a = this.world.tPos, o = this.e * 3;
    if (parent <= 0 || !this.world.hasTransform[parent]) {
      // Fast path: parent has no transform, so local == world (apart from inherited identity).
      if (parent > 0) {
        Mat4.invert(tmpA, 0, this.world.worldMatrix(parent), parent * 16);
        [a[o], a[o + 1]] = Mat4.transformPoint(tmpA, 0, x, y, a[o + 2]);
      } else {
        a[o] = x;
        a[o + 1] = y;
      }
      this._rotation.setFromEuler(0, 0, degrees); // marks dirty
      return;
    }
    this.worldPosition = [x, y, this.worldPosition.z];
    this.worldRotation2D = degrees;
  }

  /** @internal Set world position and rotation in one go (used by 3D physics write-back). */
  _setWorldPose3D(x: number, y: number, z: number, q: Quaternion): void {
    this.worldPosition = [x, y, z];
    this.worldRotation = q;
  }

  /** @internal */
  get entity(): number {
    return this.e;
  }
}
