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
  static get forward(): Vector3 { return new Vector3(0, 0, -1); }
  static get back(): Vector3 { return new Vector3(0, 0, 1); }

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

/** Rotation quaternion. Euler angles in the public API are degrees, XYZ order (ADR 0019). */
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

  static fromEuler(x: number, y: number, z: number): Quaternion {
    return new Quaternion().setFromEuler(x, y, z);
  }

  /** Rotation of `degrees` around the Z axis (the 2D rotation axis). */
  static fromAngle2D(degrees: number): Quaternion {
    return new Quaternion().setFromEuler(0, 0, degrees);
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

  copy(q: Quaternion): this { return this.set(q.x, q.y, q.z, q.w); }
  clone(): Quaternion { return new Quaternion(this.x, this.y, this.z, this.w); }

  /** Set from Euler angles in degrees (XYZ order). */
  setFromEuler(xDeg: number, yDeg: number, zDeg: number): this {
    const hx = (xDeg * DEG2RAD) / 2, hy = (yDeg * DEG2RAD) / 2, hz = (zDeg * DEG2RAD) / 2;
    const c1 = Math.cos(hx), c2 = Math.cos(hy), c3 = Math.cos(hz);
    const s1 = Math.sin(hx), s2 = Math.sin(hy), s3 = Math.sin(hz);
    return this.set(
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3,
    );
  }

  /** Euler angles in degrees (XYZ order). Returns a new Vector3. */
  toEuler(): Vector3 {
    const { x, y, z, w } = this;
    const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
    const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
    const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
    const ey = Math.asin(Mathf.clamp(m13, -1, 1));
    let ex: number, ez: number;
    if (Math.abs(m13) < 0.9999999) {
      ex = Math.atan2(-m23, m33);
      ez = Math.atan2(-m12, m11);
    } else {
      ex = Math.atan2(m32, m22);
      ez = 0;
    }
    return new Vector3(ex * RAD2DEG, ey * RAD2DEG, ez * RAD2DEG);
  }

  /** Rotation around Z in degrees, assuming a 2D (Z-only) rotation. */
  get angle2D(): number {
    return 2 * Math.atan2(this.z, this.w) * RAD2DEG;
  }

  multiply(q: Quaternion): this {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    return this.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  }

  normalize(): this {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    return this.set(this.x / l, this.y / l, this.z / l, this.w / l);
  }

  toJSON(): [number, number, number] {
    return this.toEuler().toArray();
  }
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

/**
 * Column-major 4x4 matrix helpers operating on `(array, offset)` pairs, so world matrices
 * can live in one big Float32Array (ADR 0012). Layout matches WebGL/three.js.
 * @internal
 */
export const Mat4 = {
  identity(out: Float32Array, o: number): void {
    out.fill(0, o, o + 16);
    out[o] = out[o + 5] = out[o + 10] = out[o + 15] = 1;
  },

  copy(out: Float32Array, o: number, a: Float32Array, ao: number): void {
    for (let i = 0; i < 16; i++) out[o + i] = a[ao + i];
  },

  /** Compose translation, rotation quaternion and scale. */
  compose(out: Float32Array, o: number, p: Storage, po: number, q: Storage, qo: number, s: Storage, so: number): void {
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
  multiply(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number): void {
    for (let col = 0; col < 4; col++) {
      const b0 = b[bo + col * 4], b1 = b[bo + col * 4 + 1], b2 = b[bo + col * 4 + 2], b3 = b[bo + col * 4 + 3];
      for (let row = 0; row < 4; row++) {
        out[o + col * 4 + row] = a[ao + row] * b0 + a[ao + 4 + row] * b1 + a[ao + 8 + row] * b2 + a[ao + 12 + row] * b3;
      }
    }
  },

  /** out = inverse(a). Returns false if not invertible. */
  invert(out: Float32Array, o: number, a: Float32Array, ao: number): boolean {
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
  decompose(m: Float32Array, mo: number, p: Storage, po: number, q: Storage, qo: number, s: Storage, so: number): void {
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

  transformPoint(m: Float32Array, mo: number, x: number, y: number, z: number): [number, number, number] {
    return [
      m[mo] * x + m[mo + 4] * y + m[mo + 8] * z + m[mo + 12],
      m[mo + 1] * x + m[mo + 5] * y + m[mo + 9] * z + m[mo + 13],
      m[mo + 2] * x + m[mo + 6] * y + m[mo + 10] * z + m[mo + 14],
    ];
  },
};
