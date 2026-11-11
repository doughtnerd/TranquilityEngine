/**
 * Engine-owned math types (ADR 0010: three.js types never appear in the public API).
 *
 * Vectors and quaternions can be plain values or *live views* over engine storage
 * (ADR 0019): a view reads and writes the backing array directly and notifies its owner
 * on change, so `transform.position.x += 1` moves the node.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export const Mathf = {
  /** Multiply degrees by this for radians (Unity's `Mathf.Deg2Rad`). */
  Deg2Rad: DEG2RAD,
  /** Multiply radians by this for degrees (Unity's `Mathf.Rad2Deg`). */
  Rad2Deg: RAD2DEG,
  PI: Math.PI,
  clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
  },
  lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  },
  inverseLerp(a: number, b: number, value: number): number {
    return a === b ? 0 : (value - a) / (b - a);
  },
  randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  },
  repeat(t: number, length: number): number {
    return t - Math.floor(t / length) * length;
  },
  approximately(a: number, b: number, epsilon = 1e-6): boolean {
    return Math.abs(a - b) <= epsilon;
  },
};

type Storage = Float32Array | number[];
type ChangeHook = (() => void) | null;

export interface Vec2Like {
  x: number;
  y: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Accepts `[x, y]`, `{x, y}` or a Vector2. */
export type Vec2Input = Vec2Like | readonly [number, number] | readonly number[];
/** Accepts `[x, y, z]`, `{x, y, z}` or a Vector3. */
export type Vec3Input = Vec3Like | readonly [number, number, number] | readonly number[];

function readVec2(v: Vec2Input): [number, number] {
  if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0];
  const o = v as Vec2Like;
  return [o.x, o.y];
}

function readVec3(v: Vec3Input): [number, number, number] {
  if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  const o = v as Partial<Vec3Like> & Vec2Like;
  return [o.x, o.y, o.z ?? 0];
}

export class Vector2 implements Vec2Like {
  /** @internal */ _a!: Storage;
  /** @internal */ _o!: number;
  /** @internal */ _onChange!: ChangeHook;

  constructor(x = 0, y = 0) {
    this._a = [x, y];
    this._o = 0;
    this._onChange = null;
  }

  /** @internal Create a live view over `array[offset..offset+1]`. */
  static view(array: Storage, offset: number, onChange: ChangeHook): Vector2 {
    const v = Object.create(Vector2.prototype) as Vector2;
    v._a = array;
    v._o = offset;
    v._onChange = onChange;
    return v;
  }

  static from(v: Vec2Input): Vector2 {
    const [x, y] = readVec2(v);
    return new Vector2(x, y);
  }

  static get zero(): Vector2 { return new Vector2(0, 0); }
  static get one(): Vector2 { return new Vector2(1, 1); }
  static get up(): Vector2 { return new Vector2(0, 1); }
  static get down(): Vector2 { return new Vector2(0, -1); }
  static get left(): Vector2 { return new Vector2(-1, 0); }
  static get right(): Vector2 { return new Vector2(1, 0); }

  get x(): number { return this._a[this._o]; }
  set x(value: number) { this._a[this._o] = value; this._onChange?.(); }
  get y(): number { return this._a[this._o + 1]; }
  set y(value: number) { this._a[this._o + 1] = value; this._onChange?.(); }

  set(x: number, y: number): this {
    this._a[this._o] = x;
    this._a[this._o + 1] = y;
    this._onChange?.();
    return this;
  }

  copy(v: Vec2Input): this {
    const [x, y] = readVec2(v);
    return this.set(x, y);
  }

  clone(): Vector2 { return new Vector2(this.x, this.y); }
  add(v: Vec2Like): this { return this.set(this.x + v.x, this.y + v.y); }
  sub(v: Vec2Like): this { return this.set(this.x - v.x, this.y - v.y); }
  scale(s: number): this { return this.set(this.x * s, this.y * s); }
  addScaled(v: Vec2Like, s: number): this { return this.set(this.x + v.x * s, this.y + v.y * s); }
  get length(): number { return Math.hypot(this.x, this.y); }
  normalize(): this { const l = this.length; return l > 0 ? this.scale(1 / l) : this; }
  equals(v: Vec2Like, epsilon = 1e-6): boolean {
    return Math.abs(this.x - v.x) <= epsilon && Math.abs(this.y - v.y) <= epsilon;
  }
  toArray(): [number, number] { return [this.x, this.y]; }
  toJSON(): [number, number] { return this.toArray(); }
  toString(): string { return `Vector2(${this.x}, ${this.y})`; }

  static add(a: Vec2Like, b: Vec2Like): Vector2 { return new Vector2(a.x + b.x, a.y + b.y); }
  static sub(a: Vec2Like, b: Vec2Like): Vector2 { return new Vector2(a.x - b.x, a.y - b.y); }
  static scale(a: Vec2Like, s: number): Vector2 { return new Vector2(a.x * s, a.y * s); }
  static dot(a: Vec2Like, b: Vec2Like): number { return a.x * b.x + a.y * b.y; }
  static distance(a: Vec2Like, b: Vec2Like): number { return Math.hypot(a.x - b.x, a.y - b.y); }
  static lerp(a: Vec2Like, b: Vec2Like, t: number): Vector2 {
    return new Vector2(Mathf.lerp(a.x, b.x, t), Mathf.lerp(a.y, b.y, t));
  }
}

export class Vector3 implements Vec3Like {
  /** @internal */ _a!: Storage;
  /** @internal */ _o!: number;
  /** @internal */ _onChange!: ChangeHook;

  constructor(x = 0, y = 0, z = 0) {
    this._a = [x, y, z];
    this._o = 0;
    this._onChange = null;
  }

  /** @internal Create a live view over `array[offset..offset+2]`. */
  static view(array: Storage, offset: number, onChange: ChangeHook): Vector3 {
    const v = Object.create(Vector3.prototype) as Vector3;
    v._a = array;
    v._o = offset;
    v._onChange = onChange;
    return v;
  }

  static from(v: Vec3Input): Vector3 {
    const [x, y, z] = readVec3(v);
    return new Vector3(x, y, z);
  }

  static get zero(): Vector3 { return new Vector3(0, 0, 0); }
  static get one(): Vector3 { return new Vector3(1, 1, 1); }
  static get up(): Vector3 { return new Vector3(0, 1, 0); }
  static get down(): Vector3 { return new Vector3(0, -1, 0); }
  static get left(): Vector3 { return new Vector3(-1, 0, 0); }
  static get right(): Vector3 { return new Vector3(1, 0, 0); }
  /** +Z: where an unrotated node, and a camera, faces (Unity's coordinates, ADR 0164). */
  static get forward(): Vector3 { return new Vector3(0, 0, 1); }
  static get back(): Vector3 { return new Vector3(0, 0, -1); }

  get x(): number { return this._a[this._o]; }
  set x(value: number) { this._a[this._o] = value; this._onChange?.(); }
  get y(): number { return this._a[this._o + 1]; }
  set y(value: number) { this._a[this._o + 1] = value; this._onChange?.(); }
  get z(): number { return this._a[this._o + 2]; }
  set z(value: number) { this._a[this._o + 2] = value; this._onChange?.(); }

  set(x: number, y: number, z: number): this {
    this._a[this._o] = x;
    this._a[this._o + 1] = y;
    this._a[this._o + 2] = z;
    this._onChange?.();
    return this;
  }

  copy(v: Vec3Input): this {
    const [x, y, z] = readVec3(v);
    return this.set(x, y, z);
  }

  clone(): Vector3 { return new Vector3(this.x, this.y, this.z); }
  add(v: Vec3Like): this { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v: Vec3Like): this { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  scale(s: number): this { return this.set(this.x * s, this.y * s, this.z * s); }
  /** Adds `v * s`. `v` may be any object with numeric x/y/z (a data component view, for example). */
  addScaled(v: Partial<Vec3Like>, s: number): this {
    return this.set(this.x + (v.x ?? 0) * s, this.y + (v.y ?? 0) * s, this.z + (v.z ?? 0) * s);
  }
  get length(): number { return Math.hypot(this.x, this.y, this.z); }
  normalize(): this { const l = this.length; return l > 0 ? this.scale(1 / l) : this; }
  equals(v: Vec3Like, epsilon = 1e-6): boolean {
    return Math.abs(this.x - v.x) <= epsilon && Math.abs(this.y - v.y) <= epsilon && Math.abs(this.z - v.z) <= epsilon;
  }
  toArray(): [number, number, number] { return [this.x, this.y, this.z]; }
  toJSON(): [number, number, number] { return this.toArray(); }
  toString(): string { return `Vector3(${this.x}, ${this.y}, ${this.z})`; }

  static add(a: Vec3Like, b: Vec3Like): Vector3 { return new Vector3(a.x + b.x, a.y + b.y, a.z + b.z); }
  static sub(a: Vec3Like, b: Vec3Like): Vector3 { return new Vector3(a.x - b.x, a.y - b.y, a.z - b.z); }
  static scale(a: Vec3Like, s: number): Vector3 { return new Vector3(a.x * s, a.y * s, a.z * s); }
  static dot(a: Vec3Like, b: Vec3Like): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static cross(a: Vec3Like, b: Vec3Like): Vector3 {
    return new Vector3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  static distance(a: Vec3Like, b: Vec3Like): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  static lerp(a: Vec3Like, b: Vec3Like, t: number): Vector3 {
    return new Vector3(Mathf.lerp(a.x, b.x, t), Mathf.lerp(a.y, b.y, t), Mathf.lerp(a.z, b.z, t));
  }
}

/** A half-line: `origin` plus `direction` (always normalized) times a distance (ADR 0073). */
export class Ray {
  readonly origin: Vector3;
  readonly direction: Vector3;

  constructor(origin: Vec3Input = [0, 0, 0], direction: Vec3Input = [0, 0, 1]) {
    this.origin = Vector3.from(origin);
    this.direction = Vector3.from(direction).normalize();
  }

  /** The point `t` units along the ray. */
  at(t: number): Vector3 {
    return new Vector3(
      this.origin.x + this.direction.x * t,
      this.origin.y + this.direction.y * t,
      this.origin.z + this.direction.z * t,
    );
  }

  toString(): string { return `Ray(${this.origin}, ${this.direction})`; }
}

/**
 * An infinite plane (ADR 0073): the points `p` where `normal . p + distance = 0`, like Unity's
 * `Plane`. `normal` is kept normalized; `distance` is the signed distance from the origin to the
 * plane, measured against the normal (`Plane.fromNormalAndPoint(up, [0, 2, 0])` has distance -2).
 */
export class Plane {
  readonly normal: Vector3;
  distance: number;

  constructor(normal: Vec3Input = [0, 1, 0], distance = 0) {
    this.normal = Vector3.from(normal).normalize();
    this.distance = distance;
  }

  static fromNormalAndPoint(normal: Vec3Input, point: Vec3Input): Plane {
    const n = Vector3.from(normal).normalize();
    return new Plane(n, -Vector3.dot(n, Vector3.from(point)));
  }

  /** Signed distance from the plane to `point`: positive on the side the normal faces. */
  distanceToPoint(point: Vec3Like): number {
    return Vector3.dot(this.normal, point) + this.distance;
  }

  /** The distance along `ray` to the plane, or null if the ray is parallel to it or points away. */
  raycast(ray: Ray): number | null {
    const denom = Vector3.dot(this.normal, ray.direction);
    if (Math.abs(denom) < 1e-12) return null;
    const t = -this.distanceToPoint(ray.origin) / denom;
    return t >= 0 ? t : null;
  }
}

/** Rotation quaternion. Euler angles in the public API are degrees, XYZ order (ADR 0019). */
/**
 * The order Euler angles are applied in, as in Unity.Mathematics' `RotationOrder`: `"ZXY"` turns about Z,
 * then X, then Y, each about the parent's (fixed) axes, so `q = qY · qX · qZ`. `"ZXY"` (yaw outermost) is
 * the default everywhere (ADR 0163). Angles are radians (ADR 0164).
 */
export type RotationOrder = "XYZ" | "XZY" | "YXZ" | "YZX" | "ZXY" | "ZYX";

const AXIS_INDEX = { X: 0, Y: 1, Z: 2 } as const;

const TAU = Math.PI * 2;

/** Wrap radians into [0, 2π), as Unity's `eulerAngles` reads back (float32 noise next to 0 or 2π reads as 0). */
const wrapTau = (rad: number): number => {
  const r = rad - Math.floor(rad / TAU) * TAU;
  return r > TAU - 2e-6 || r < 2e-6 ? 0 : r;
};

/**
 * A rotation, stored as a unit quaternion `(x, y, z, w)`: the data a Transform holds, as Unity ECS's
 * `LocalTransform.Rotation` (ADR 0163). Euler angles (radians, as Unity.Mathematics, ADR 0164) only build or
 * describe one. Coordinates are Unity's: left-handed, +Y up, +Z forward; positive turns follow the left hand
 * (yaw turns right, pitch looks down).
 * Static builders return new quaternions; instance methods named as verbs change this one.
 */
export class Quaternion {
  /** @internal */ _a!: Storage;
  /** @internal */ _o!: number;
  /** @internal */ _onChange!: ChangeHook;

  constructor(x = 0, y = 0, z = 0, w = 1) {
    this._a = [x, y, z, w];
    this._o = 0;
    this._onChange = null;
  }

  /** @internal */
  static view(array: Storage, offset: number, onChange: ChangeHook): Quaternion {
    const q = Object.create(Quaternion.prototype) as Quaternion;
    q._a = array;
    q._o = offset;
    q._onChange = onChange;
    return q;
  }

  static get identity(): Quaternion { return new Quaternion(0, 0, 0, 1); }

  /**
   * A quaternion from `[x, y, z, w]` (a raw quaternion, as scene files store rotations), Euler radians
   * `[x, y, z]` (in `order`), or another Quaternion (copied).
   */
  static from(value: Quaternion | QuatLike | readonly number[], order: RotationOrder = "ZXY"): Quaternion {
    if (value instanceof Quaternion) return value.clone();
    if (Array.isArray(value)) {
      const a = value as readonly number[];
      return a.length >= 4 ? new Quaternion(a[0], a[1], a[2], a[3]) : Quaternion.euler(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, order);
    }
    const q = value as QuatLike;
    return new Quaternion(q.x, q.y, q.z, q.w);
  }

  /**
   * From Euler angles in radians, applied in `order` (default `"ZXY"`: roll about Z, then pitch about X,
   * then yaw about Y, as Unity's `quaternion.Euler` and `Quaternion.Euler`). Takes three numbers or a vector.
   */
  static euler(x: number, y: number, z: number, order?: RotationOrder): Quaternion;
  static euler(angles: Vec3Input, order?: RotationOrder): Quaternion;
  static euler(a: number | Vec3Input, b?: number | RotationOrder, c?: number, order: RotationOrder = "ZXY"): Quaternion {
    if (typeof a === "number") return new Quaternion().setFromEuler(a, b as number, c as number, order);
    const [x, y, z] = readVec3(a);
    return new Quaternion().setFromEuler(x, y, z, (b as RotationOrder | undefined) ?? "ZXY");
  }

  /** Same as {@link Quaternion.euler} with three numbers (default order `"ZXY"`). */
  static fromEuler(x: number, y: number, z: number, order: RotationOrder = "ZXY"): Quaternion {
    return new Quaternion().setFromEuler(x, y, z, order);
  }

  /** A turn of `angle` radians about the X axis (positive pitches forward down). */
  static rotateX(angle: number): Quaternion { return Quaternion.axisAngle([1, 0, 0], angle); }
  /** A turn of `angle` radians about the Y axis (positive yaws right). */
  static rotateY(angle: number): Quaternion { return Quaternion.axisAngle([0, 1, 0], angle); }
  /** A turn of `angle` radians about the Z axis (positive is counter-clockwise on screen). */
  static rotateZ(angle: number): Quaternion { return Quaternion.axisAngle([0, 0, 1], angle); }

  /** Rotation of `angle` radians around the Z axis (the 2D rotation axis). */
  static fromAngle2D(angle: number): Quaternion {
    return Quaternion.rotateZ(angle);
  }

  /** A turn of `angle` radians about `axis` (normalized here; a zero axis gives the identity). */
  static axisAngle(axis: Vec3Input, angle: number): Quaternion {
    const [ax, ay, az] = readVec3(axis);
    const l = Math.hypot(ax, ay, az);
    if (l === 0) return Quaternion.identity;
    const h = angle / 2, s = Math.sin(h) / l;
    return new Quaternion(ax * s, ay * s, az * s, Math.cos(h));
  }

  /**
   * The rotation that points a node's forward (+Z, where cameras look) along `forward`, with its up (+Y)
   * as close to `up` as it can be. Both need not be unit length; they must not be parallel or zero
   * (see {@link Quaternion.lookRotationSafe}).
   */
  static lookRotation(forward: Vec3Input, up: Vec3Input = [0, 1, 0]): Quaternion {
    const [fx, fy, fz] = readVec3(forward);
    const [ux, uy, uz] = readVec3(up);
    // Basis columns: right (X = up × forward), up (Y = forward × right), forward (Z), as Unity's LookRotation.
    let zx = fx, zy = fy, zz = fz;
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return quaternionFromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz);
  }

  /**
   * As {@link Quaternion.lookRotation}, but safe for any input: a zero `forward` gives the identity, and
   * a `forward` parallel to `up` picks another up.
   */
  static lookRotationSafe(forward: Vec3Input, up: Vec3Input = [0, 1, 0]): Quaternion {
    const f = readVec3(forward), u = readVec3(up);
    const fl = Math.hypot(f[0], f[1], f[2]);
    if (fl < 1e-12) return Quaternion.identity;
    const ul = Math.hypot(u[0], u[1], u[2]);
    const cross = Math.hypot(f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]);
    if (ul < 1e-12 || cross < 1e-6 * fl * ul) {
      // Parallel: any up perpendicular to forward will do; use the world axis least aligned with it.
      const ax = Math.abs(f[0]), ay = Math.abs(f[1]), az = Math.abs(f[2]);
      const alt: [number, number, number] = ay <= ax && ay <= az ? [0, 1, 0] : az <= ax ? [0, 0, 1] : [1, 0, 0];
      return Quaternion.lookRotation(f, alt);
    }
    return Quaternion.lookRotation(f, u);
  }

  /** `a · b`: the rotation `b` followed by `a` (a new Quaternion). */
  static mul(a: QuatLike, b: QuatLike): Quaternion {
    return new Quaternion(a.x, a.y, a.z, a.w).multiply(b);
  }

  /** The inverse rotation of a unit quaternion (a new Quaternion). */
  static inverse(q: QuatLike): Quaternion {
    return new Quaternion(-q.x, -q.y, -q.z, q.w);
  }

  /** Dot product of two quaternions (1 or -1: the same rotation). */
  static dot(a: QuatLike, b: QuatLike): number {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  }

  /** The angle in radians between two rotations (0..π). */
  static angle(a: QuatLike, b: QuatLike): number {
    const d = Math.min(Math.abs(Quaternion.dot(a, b)), 1);
    return 2 * Math.acos(d);
  }

  /** `v` turned by `q` (a new Vector3). */
  static rotate(q: QuatLike, v: Vec3Input): Vector3 {
    const [x, y, z] = readVec3(v);
    return Quat.rotate(q, new Vector3(x, y, z));
  }

  /** Normalized linear interpolation (the shorter way round), cheaper than `slerp`. */
  static nlerp(a: QuatLike, b: QuatLike, t: number): Quaternion {
    const s = Quaternion.dot(a, b) < 0 ? -1 : 1;
    return new Quaternion(
      a.x + (b.x * s - a.x) * t,
      a.y + (b.y * s - a.y) * t,
      a.z + (b.z * s - a.z) * t,
      a.w + (b.w * s - a.w) * t,
    ).normalize();
  }

  /** Spherical interpolation (the shorter way round) from `a` (t = 0) to `b` (t = 1). */
  static slerp(a: QuatLike, b: QuatLike, t: number): Quaternion {
    let d = Quaternion.dot(a, b);
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (d > 0.9995) return Quaternion.nlerp(a, { x: bx, y: by, z: bz, w: bw }, t);
    const th = Math.acos(d), sn = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / sn, wb = Math.sin(t * th) / sn;
    return new Quaternion(a.x * wa + bx * wb, a.y * wa + by * wb, a.z * wa + bz * wb, a.w * wa + bw * wb);
  }

  get x(): number { return this._a[this._o]; }
  set x(v: number) { this._a[this._o] = v; this._onChange?.(); }
  get y(): number { return this._a[this._o + 1]; }
  set y(v: number) { this._a[this._o + 1] = v; this._onChange?.(); }
  get z(): number { return this._a[this._o + 2]; }
  set z(v: number) { this._a[this._o + 2] = v; this._onChange?.(); }
  get w(): number { return this._a[this._o + 3]; }
  set w(v: number) { this._a[this._o + 3] = v; this._onChange?.(); }

  set(x: number, y: number, z: number, w: number): this {
    const a = this._a, o = this._o;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = w;
    this._onChange?.();
    return this;
  }

  copy(q: QuatLike): this { return this.set(q.x, q.y, q.z, q.w); }
  clone(): Quaternion { return new Quaternion(this.x, this.y, this.z, this.w); }

  /** Set from Euler angles in radians, applied in `order` (default `"ZXY"`, see {@link Quaternion.euler}). */
  setFromEuler(x: number, y: number, z: number, order: RotationOrder = "ZXY"): this {
    const angles = [x, y, z];
    let rx = 0, ry = 0, rz = 0, rw = 1;
    // Each turn about a fixed axis goes on the left: q = q3 · q2 · q1.
    for (const axis of order) {
      const i = AXIS_INDEX[axis as "X" | "Y" | "Z"];
      const h = angles[i] / 2, s = Math.sin(h), c = Math.cos(h);
      const ax = i === 0 ? s : 0, ay = i === 1 ? s : 0, az = i === 2 ? s : 0;
      const nx = c * rx + ax * rw + ay * rz - az * ry;
      const ny = c * ry + ay * rw + az * rx - ax * rz;
      const nz = c * rz + az * rw + ax * ry - ay * rx;
      const nw = c * rw - ax * rx - ay * ry - az * rz;
      rx = nx; ry = ny; rz = nz; rw = nw;
    }
    return this.set(rx, ry, rz, rw);
  }

  /**
   * Euler angles in radians that rebuild this rotation in `order` (default `"ZXY"`). The middle axis of the
   * order (X for `"ZXY"`) is in -π/2..π/2, the others in -π..π. Returns a new Vector3.
   */
  toEuler(order: RotationOrder = "ZXY"): Vector3 {
    const { x, y, z, w } = this;
    const R = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
    // R = R_k · R_j · R_i for order "ijk" (i applied first).
    const i = AXIS_INDEX[order[0] as "X"], j = AXIS_INDEX[order[1] as "X"], k = AXIS_INDEX[order[2] as "X"];
    const e = (j - i + 3) % 3 === 1 ? 1 : -1; // +1 when i, j, k run cyclically (X→Y→Z)
    const sj = Mathf.clamp(-e * R[k][i], -1, 1);
    const out = [0, 0, 0];
    out[j] = Math.asin(sj);
    if (Math.abs(sj) < 0.9999999) {
      out[i] = Math.atan2(e * R[k][j], R[k][k]);
      out[k] = Math.atan2(e * R[j][i], R[i][i]);
    } else {
      // Gimbal lock: the first and last turns share an axis; put it all in the last.
      out[i] = 0;
      out[k] = Math.atan2(-e * R[i][j], R[j][j]);
    }
    return new Vector3(out[0] + 0, out[1] + 0, out[2] + 0);
  }

  /**
   * Euler angles in radians, order `"ZXY"`, each in [0, 2π). Returns a new Vector3; assigning sets the
   * rotation from them.
   */
  get eulerAngles(): Vector3 {
    const e = this.toEuler("ZXY");
    return new Vector3(wrapTau(e.x), wrapTau(e.y), wrapTau(e.z));
  }
  set eulerAngles(v: Vec3Input) {
    const [x, y, z] = readVec3(v);
    this.setFromEuler(x, y, z, "ZXY");
  }

  /** Rotation around Z in radians (-π..π), assuming a 2D (Z-only) rotation. */
  get angle2D(): number {
    const a = 2 * Math.atan2(this.z, this.w);
    return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a;
  }

  /** `this = this · q`: turn by `q` about this rotation's own axes. */
  multiply(q: QuatLike): this {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    return this.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  }

  /** `this = q · this`: turn by `q` about the parent's (fixed) axes. */
  premultiply(q: QuatLike): this {
    const ax = q.x, ay = q.y, az = q.z, aw = q.w;
    const bx = this.x, by = this.y, bz = this.z, bw = this.w;
    return this.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  }

  /** Invert this unit quaternion in place. */
  invert(): this {
    return this.set(-this.x, -this.y, -this.z, this.w);
  }

  normalize(): this {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    return this.set(this.x / l, this.y / l, this.z / l, this.w / l);
  }

  /** True when both describe the same rotation within `epsilon` (q and -q are the same rotation). */
  equals(q: QuatLike, epsilon = 1e-6): boolean {
    return Math.abs(Quaternion.dot(this, q)) >= 1 - epsilon;
  }

  toArray(): [number, number, number, number] { return [this.x, this.y, this.z, this.w]; }

  /** `[x, y, z, w]`: scene files store rotations as quaternions (ADR 0163). */
  toJSON(): [number, number, number, number] {
    return this.toArray();
  }

  toString(): string { return `Quaternion(${this.x}, ${this.y}, ${this.z}, ${this.w})`; }
}

/** A unit quaternion from an orthonormal basis given as its three columns (right, up, back). */
function quaternionFromBasis(m11: number, m21: number, m31: number, m12: number, m22: number, m32: number, m13: number, m23: number, m33: number): Quaternion {
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const t = 0.5 / Math.sqrt(trace + 1);
    return new Quaternion((m32 - m23) * t, (m13 - m31) * t, (m21 - m12) * t, 0.25 / t);
  }
  if (m11 > m22 && m11 > m33) {
    const t = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return new Quaternion(0.25 * t, (m12 + m21) / t, (m13 + m31) / t, (m32 - m23) / t);
  }
  if (m22 > m33) {
    const t = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return new Quaternion((m12 + m21) / t, 0.25 * t, (m23 + m32) / t, (m13 - m31) / t);
  }
  const t = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return new Quaternion((m13 + m31) / t, (m23 + m32) / t, 0.25 * t, (m21 - m12) / t);
}

/** RGBA color with components in 0..1. */
export class Color {
  constructor(public r = 1, public g = 1, public b = 1, public a = 1) {}

  static get white(): Color { return new Color(1, 1, 1, 1); }
  static get black(): Color { return new Color(0, 0, 0, 1); }

  /** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `[r, g, b, a?]` (0..1) or a Color. */
  static from(value: string | readonly number[] | Color): Color {
    if (value instanceof Color) return value.clone();
    if (Array.isArray(value)) return new Color(value[0] ?? 1, value[1] ?? 1, value[2] ?? 1, value[3] ?? 1);
    let hex = (value as string).replace("#", "");
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const n = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a);
  }

  clone(): Color { return new Color(this.r, this.g, this.b, this.a); }

  toHex(): string {
    const h = (v: number) => Math.round(Mathf.clamp(v, 0, 1) * 255).toString(16).padStart(2, "0");
    return `#${h(this.r)}${h(this.g)}${h(this.b)}`;
  }

  toCss(): string {
    return `rgba(${Math.round(this.r * 255)}, ${Math.round(this.g * 255)}, ${Math.round(this.b * 255)}, ${this.a})`;
  }

  toJSON(): number[] { return [this.r, this.g, this.b, this.a]; }
}

/** @internal A 4x4 matrix's storage for `Mat4`. */
type MatArray = Float32Array | Float64Array;

/**
 * Column-major 4x4 matrix helpers operating on `(array, offset)` pairs, so world matrices
 * can live in one big Float32Array (ADR 0012). Layout matches WebGL/three.js. A Float64Array works too,
 * for maths that must not lose precision (the editor's gizmo poses).
 * @internal
 */
export const Mat4 = {
  identity(out: MatArray, o: number): void {
    out.fill(0, o, o + 16);
    out[o] = out[o + 5] = out[o + 10] = out[o + 15] = 1;
  },

  copy(out: MatArray, o: number, a: MatArray, ao: number): void {
    for (let i = 0; i < 16; i++) out[o + i] = a[ao + i];
  },

  /** Compose translation, rotation quaternion and scale. */
  compose(out: MatArray, o: number, p: Storage, po: number, q: Storage, qo: number, s: Storage, so: number): void {
    const x = q[qo], y = q[qo + 1], z = q[qo + 2], w = q[qo + 3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s[so], sy = s[so + 1], sz = s[so + 2];
    out[o] = (1 - (yy + zz)) * sx;
    out[o + 1] = (xy + wz) * sx;
    out[o + 2] = (xz - wy) * sx;
    out[o + 3] = 0;
    out[o + 4] = (xy - wz) * sy;
    out[o + 5] = (1 - (xx + zz)) * sy;
    out[o + 6] = (yz + wx) * sy;
    out[o + 7] = 0;
    out[o + 8] = (xz + wy) * sz;
    out[o + 9] = (yz - wx) * sz;
    out[o + 10] = (1 - (xx + yy)) * sz;
    out[o + 11] = 0;
    out[o + 12] = p[po];
    out[o + 13] = p[po + 1];
    out[o + 14] = p[po + 2];
    out[o + 15] = 1;
  },

  /** out = a * b. `out` may alias neither input. */
  multiply(out: MatArray, o: number, a: MatArray, ao: number, b: MatArray, bo: number): void {
    for (let col = 0; col < 4; col++) {
      const b0 = b[bo + col * 4], b1 = b[bo + col * 4 + 1], b2 = b[bo + col * 4 + 2], b3 = b[bo + col * 4 + 3];
      for (let row = 0; row < 4; row++) {
        out[o + col * 4 + row] = a[ao + row] * b0 + a[ao + 4 + row] * b1 + a[ao + 8 + row] * b2 + a[ao + 12 + row] * b3;
      }
    }
  },

  /**
   * out = a × b for affine matrices (bottom row 0, 0, 0, 1), like every world matrix built from
   * position, rotation and scale: about half the work of `multiply`. `out` may be `a` or `b` at the same offset.
   */
  multiplyAffine(out: MatArray, o: number, a: MatArray, ao: number, b: MatArray, bo: number): void {
    const a00 = a[ao], a01 = a[ao + 1], a02 = a[ao + 2];
    const a10 = a[ao + 4], a11 = a[ao + 5], a12 = a[ao + 6];
    const a20 = a[ao + 8], a21 = a[ao + 9], a22 = a[ao + 10];
    const a30 = a[ao + 12], a31 = a[ao + 13], a32 = a[ao + 14];
    const b00 = b[bo], b01 = b[bo + 1], b02 = b[bo + 2];
    const b10 = b[bo + 4], b11 = b[bo + 5], b12 = b[bo + 6];
    const b20 = b[bo + 8], b21 = b[bo + 9], b22 = b[bo + 10];
    const b30 = b[bo + 12], b31 = b[bo + 13], b32 = b[bo + 14];
    out[o] = a00 * b00 + a10 * b01 + a20 * b02;
    out[o + 1] = a01 * b00 + a11 * b01 + a21 * b02;
    out[o + 2] = a02 * b00 + a12 * b01 + a22 * b02;
    out[o + 3] = 0;
    out[o + 4] = a00 * b10 + a10 * b11 + a20 * b12;
    out[o + 5] = a01 * b10 + a11 * b11 + a21 * b12;
    out[o + 6] = a02 * b10 + a12 * b11 + a22 * b12;
    out[o + 7] = 0;
    out[o + 8] = a00 * b20 + a10 * b21 + a20 * b22;
    out[o + 9] = a01 * b20 + a11 * b21 + a21 * b22;
    out[o + 10] = a02 * b20 + a12 * b21 + a22 * b22;
    out[o + 11] = 0;
    out[o + 12] = a00 * b30 + a10 * b31 + a20 * b32 + a30;
    out[o + 13] = a01 * b30 + a11 * b31 + a21 * b32 + a31;
    out[o + 14] = a02 * b30 + a12 * b31 + a22 * b32 + a32;
    out[o + 15] = 1;
  },

  /** out = inverse(a). Returns false if not invertible. */
  invert(out: MatArray, o: number, a: MatArray, ao: number): boolean {
    const a00 = a[ao], a01 = a[ao + 1], a02 = a[ao + 2], a03 = a[ao + 3];
    const a10 = a[ao + 4], a11 = a[ao + 5], a12 = a[ao + 6], a13 = a[ao + 7];
    const a20 = a[ao + 8], a21 = a[ao + 9], a22 = a[ao + 10], a23 = a[ao + 11];
    const a30 = a[ao + 12], a31 = a[ao + 13], a32 = a[ao + 14], a33 = a[ao + 15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return false;
    det = 1 / det;
    out[o] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[o + 1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[o + 2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[o + 3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[o + 4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[o + 5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[o + 6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[o + 7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[o + 8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[o + 9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[o + 10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[o + 11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[o + 12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[o + 13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[o + 14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[o + 15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return true;
  },

  /** Decompose into translation, rotation and scale written to the given storages. */
  decompose(m: MatArray, mo: number, p: Storage, po: number, q: Storage, qo: number, s: Storage, so: number): void {
    let sx = Math.hypot(m[mo], m[mo + 1], m[mo + 2]);
    const sy = Math.hypot(m[mo + 4], m[mo + 5], m[mo + 6]);
    const sz = Math.hypot(m[mo + 8], m[mo + 9], m[mo + 10]);
    const det =
      m[mo] * (m[mo + 5] * m[mo + 10] - m[mo + 9] * m[mo + 6]) -
      m[mo + 4] * (m[mo + 1] * m[mo + 10] - m[mo + 9] * m[mo + 2]) +
      m[mo + 8] * (m[mo + 1] * m[mo + 6] - m[mo + 5] * m[mo + 2]);
    if (det < 0) sx = -sx;
    p[po] = m[mo + 12];
    p[po + 1] = m[mo + 13];
    p[po + 2] = m[mo + 14];
    s[so] = sx;
    s[so + 1] = sy;
    s[so + 2] = sz;
    const isx = sx ? 1 / sx : 0, isy = sy ? 1 / sy : 0, isz = sz ? 1 / sz : 0;
    const m11 = m[mo] * isx, m12 = m[mo + 4] * isy, m13 = m[mo + 8] * isz;
    const m21 = m[mo + 1] * isx, m22 = m[mo + 5] * isy, m23 = m[mo + 9] * isz;
    const m31 = m[mo + 2] * isx, m32 = m[mo + 6] * isy, m33 = m[mo + 10] * isz;
    const trace = m11 + m22 + m33;
    let x: number, y: number, z: number, w: number;
    if (trace > 0) {
      const t = 0.5 / Math.sqrt(trace + 1);
      w = 0.25 / t; x = (m32 - m23) * t; y = (m13 - m31) * t; z = (m21 - m12) * t;
    } else if (m11 > m22 && m11 > m33) {
      const t = 2 * Math.sqrt(1 + m11 - m22 - m33);
      w = (m32 - m23) / t; x = 0.25 * t; y = (m12 + m21) / t; z = (m13 + m31) / t;
    } else if (m22 > m33) {
      const t = 2 * Math.sqrt(1 + m22 - m11 - m33);
      w = (m13 - m31) / t; x = (m12 + m21) / t; y = 0.25 * t; z = (m23 + m32) / t;
    } else {
      const t = 2 * Math.sqrt(1 + m33 - m11 - m22);
      w = (m21 - m12) / t; x = (m13 + m31) / t; y = (m23 + m32) / t; z = 0.25 * t;
    }
    q[qo] = x; q[qo + 1] = y; q[qo + 2] = z; q[qo + 3] = w;
  },

  transformPoint(m: MatArray, mo: number, x: number, y: number, z: number): [number, number, number] {
    return [
      m[mo] * x + m[mo + 4] * y + m[mo + 8] * z + m[mo + 12],
      m[mo + 1] * x + m[mo + 5] * y + m[mo + 9] * z + m[mo + 13],
      m[mo + 2] * x + m[mo + 6] * y + m[mo + 10] * z + m[mo + 14],
    ];
  },
};

/** @internal A quaternion's components, read only. */
export interface QuatLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * Quaternion helpers the engine uses internally (physics, the editor's gizmo), kept off the public
 * `Quaternion` class.
 * @internal
 */
export const Quat = {
  /** Turn `v` by `q` in place (a unit quaternion), and return it. */
  rotate<V extends Vec3Like>(q: QuatLike, v: V): V {
    const { x: qx, y: qy, z: qz, w: qw } = q;
    const vx = v.x, vy = v.y, vz = v.z;
    // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
    const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
    v.x = vx + qw * tx + qy * tz - qz * ty;
    v.y = vy + qw * ty + qz * tx - qx * tz;
    v.z = vz + qw * tz + qx * ty - qy * tx;
    return v;
  },

  /** The inverse of a unit quaternion: a new Quaternion. */
  conjugate(q: QuatLike): Quaternion {
    return new Quaternion(-q.x, -q.y, -q.z, q.w);
  },

  /** A turn of `radians` about the unit axis (x, y, z): a new Quaternion. */
  fromAxisAngle(x: number, y: number, z: number, radians: number): Quaternion {
    const h = radians / 2, s = Math.sin(h);
    return new Quaternion(x * s, y * s, z * s, Math.cos(h));
  },
};
