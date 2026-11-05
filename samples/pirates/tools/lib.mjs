// Shared helpers for the King of Pirates asset generator: seeded RNG, PNG and WAV encoders, an OBJ mesh builder.
import { deflateSync } from "node:zlib";

/** mulberry32: a small seeded RNG returning [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- PNG ----------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Encodes RGBA pixels (Uint8Array, w*h*4) as a PNG. */
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** A square RGBA canvas with a few drawing helpers. */
export class Canvas {
  constructor(size) {
    this.w = this.h = size;
    this.px = new Uint8Array(size * size * 4);
  }
  set(x, y, r, g, b, a = 255) {
    x = ((x % this.w) + this.w) % this.w;
    y = ((y % this.h) + this.h) % this.h;
    const i = (y * this.w + x) * 4;
    this.px[i] = clamp255(r);
    this.px[i + 1] = clamp255(g);
    this.px[i + 2] = clamp255(b);
    this.px[i + 3] = clamp255(a);
  }
  /** Blends a colour over a pixel (no wrap outside the canvas). */
  blend(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const t = a / 255;
    const oa = this.px[i + 3] / 255;
    const na = t + oa * (1 - t);
    const c = [r, g, b];
    for (let k = 0; k < 3; k++) this.px[i + k] = clamp255(na ? (c[k] * t + this.px[i + k] * oa * (1 - t)) / na : 0);
    this.px[i + 3] = clamp255(na * 255);
  }
  fill(fn) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, ...fn(x, y));
  }
  disc(cx, cy, r, col, soft = 1) {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.max(0, Math.min(1, (r - d) / soft + 0.5));
        if (a > 0) this.blend(x, y, col[0], col[1], col[2], (col[3] ?? 255) * a);
      }
  }
  rect(x0, y0, x1, y1, col) {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, Math.ceil(x1)); x++) this.blend(x, y, col[0], col[1], col[2], col[3] ?? 255);
  }
  /** A line with round caps, thickness in pixels. */
  line(x0, y0, x1, y1, t, col) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
    for (let i = 0; i < n; i++) this.disc(x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1), t / 2, col);
  }
  poly(points, col) {
    const ys = points.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++)
      for (let x = 0; x < this.w; x++) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[j];
          if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) this.blend(x, y, col[0], col[1], col[2], col[3] ?? 255);
      }
  }
  png() {
    return encodePng(this.w, this.h, this.px);
  }
}

/** Tileable value noise with the given lattice period; f(x, y) in [0,1] for x, y in [0, 1). */
export function tileNoise(seed, period) {
  const r = rng(seed);
  const g = Array.from({ length: period * period }, r);
  const at = (i, j) => g[(((j % period) + period) % period) * period + (((i % period) + period) % period)];
  return (x, y) => {
    const fx = x * period;
    const fy = y * period;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const su = u * u * (3 - 2 * u);
    const sv = v * v * (3 - 2 * v);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * su;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * su;
    return a + (b - a) * sv;
  };
}
/** Fractal tileable noise: octaves of tileNoise. */
export function fbm(seed, basePeriod, octaves) {
  const ns = Array.from({ length: octaves }, (_, o) => tileNoise(seed + o * 101, basePeriod << o));
  return (x, y) => {
    let s = 0;
    let a = 1;
    let t = 0;
    for (const n of ns) {
      s += n(x, y) * a;
      t += a;
      a *= 0.5;
    }
    return s / t;
  };
}

// ---------- WAV ----------
export const SAMPLE_RATE = 22050;
/** Encodes mono float samples (-1..1) as 16-bit PCM WAV. */
export function encodeWav(samples, rate = SAMPLE_RATE) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ---------- OBJ meshes ----------
/** Builds a triangle mesh grouped by object and material, with flat normals; transforms apply to everything added inside them. */
export class Mesh {
  constructor(name) {
    this.name = name;
    this.parts = new Map();
    this.object = name;
    this.xf = (p) => p;
  }
  /** Adds into a named OBJ object (a separate mesh in the engine). */
  into(object, fn) {
    const old = this.object;
    this.object = object;
    fn();
    this.object = old;
    return this;
  }
  with(xf, fn) {
    const old = this.xf;
    this.xf = (p) => old(xf(p));
    fn();
    this.xf = old;
    return this;
  }
  translate(x, y, z, fn) {
    return this.with((p) => [p[0] + x, p[1] + y, p[2] + z], fn);
  }
  scale(x, y, z, fn) {
    return this.with((p) => [p[0] * x, p[1] * y, p[2] * z], fn);
  }
  rotY(a, fn) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return this.with((p) => [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c], fn);
  }
  rotX(a, fn) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return this.with((p) => [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c], fn);
  }
  rotZ(a, fn) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return this.with((p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]], fn);
  }
  tri(mat, a, b, c, ua = [0, 0], ub = [1, 0], uc = [0, 1]) {
    const key = `${this.object}\u0000${mat}`;
    if (!this.parts.has(key)) this.parts.set(key, { object: this.object, material: mat, tris: [] });
    this.parts.get(key).tris.push([[this.xf(a), ua], [this.xf(b), ub], [this.xf(c), uc]]);
  }
  /** A counter-clockwise quad (seen from the front). */
  quad(mat, a, b, c, d, uvs = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    this.tri(mat, a, b, c, uvs[0], uvs[1], uvs[2]);
    this.tri(mat, a, c, d, uvs[0], uvs[2], uvs[3]);
  }
  /** A quad visible from both sides. */
  quad2(mat, a, b, c, d, uvs = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    this.quad(mat, a, b, c, d, uvs);
    this.quad(mat, d, c, b, a, [uvs[3], uvs[2], uvs[1], uvs[0]]);
  }
  box(mat, cx, cy, cz, sx, sy, sz) {
    const [x0, x1, y0, y1, z0, z1] = [cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, cz - sz / 2, cz + sz / 2];
    this.quad(mat, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    this.quad(mat, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
    this.quad(mat, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    this.quad(mat, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    this.quad(mat, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    this.quad(mat, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  }
  /** A vertical frustum from y0 (radius r0) to y1 (radius r1), n sides; r1 = 0 makes a cone. */
  frustum(mat, cx, y0, y1, cz, r0, r1, n, caps = true, capMat = mat) {
    const ring = (y, r, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, y, cz + Math.sin((i / n) * Math.PI * 2) * r];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const u0 = i / n;
      const u1 = (i + 1) / n;
      if (r1 > 0.0001) this.quad(mat, ring(y0, r0, j), ring(y0, r0, i), ring(y1, r1, i), ring(y1, r1, j), [[u1, 0], [u0, 0], [u0, 1], [u1, 1]]);
      else this.tri(mat, ring(y0, r0, j), ring(y0, r0, i), [cx, y1, cz], [u1, 0], [u0, 0], [(u0 + u1) / 2, 1]);
    }
    if (!caps) return;
    const uv = (k) => [0.5 + Math.cos((k / n) * Math.PI * 2) * 0.5, 0.5 - Math.sin((k / n) * Math.PI * 2) * 0.5];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (r1 > 0.0001) this.tri(capMat, [cx, y1, cz], ring(y1, r1, j), ring(y1, r1, i), [0.5, 0.5], uv(j), uv(i));
      if (r0 > 0.0001) this.tri(capMat, [cx, y0, cz], ring(y0, r0, i), ring(y0, r0, j), [0.5, 0.5], uv(i), uv(j));
    }
  }
  sphere(mat, cx, cy, cz, r, seg, rings) {
    const pt = (i, k) => {
      const th = (i / seg) * Math.PI * 2;
      const ph = (k / rings) * Math.PI;
      return [cx + Math.cos(th) * Math.sin(ph) * r, cy + Math.cos(ph) * r, cz + Math.sin(th) * Math.sin(ph) * r];
    };
    const uv = (i, k) => [i / seg, 1 - k / rings];
    for (let k = 0; k < rings; k++)
      for (let i = 0; i < seg; i++) {
        const [a, b, c, d] = [pt(i + 1, k), pt(i, k), pt(i, k + 1), pt(i + 1, k + 1)];
        const [ua, ub, uc, ud] = [uv(i + 1, k), uv(i, k), uv(i, k + 1), uv(i + 1, k + 1)];
        if (k === 0) this.tri(mat, a, d, c, ua, ud, uc);
        else if (k === rings - 1) this.tri(mat, a, c, b, ua, uc, ub);
        else this.quad(mat, d, c, b, a, [ud, uc, ub, ua]);
      }
  }
  triangleCount() {
    let n = 0;
    for (const p of this.parts.values()) n += p.tris.length;
    return n;
  }
  /** OBJ text: one `o` per object, `usemtl` per material, flat normals, 5-decimal coordinates. */
  toObj(mtllib, comment) {
    const f = (n) => (Math.abs(n) < 5e-6 ? 0 : +n.toFixed(5));
    const v = new Map();
    const vt = new Map();
    const vn = new Map();
    const vl = [];
    const vtl = [];
    const vnl = [];
    const idx = (map, list, prefix, vals) => {
      const key = vals.join(" ");
      if (!map.has(key)) {
        map.set(key, list.length + 1);
        list.push(`${prefix} ${key}`);
      }
      return map.get(key);
    };
    const faces = [];
    let current = "";
    for (const part of this.parts.values()) {
      if (part.object !== current) {
        faces.push(`o ${part.object}`);
        current = part.object;
      }
      faces.push(`usemtl ${part.material}`);
      for (const t of part.tris) {
        const [a, b, c] = t.map(([p]) => p);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(...n);
        if (len < 1e-12) continue;
        const ni = idx(vn, vnl, "vn", n.map((x) => f(x / len)));
        const refs = t.map(([p, uv]) => `${idx(v, vl, "v", p.map(f))}/${idx(vt, vtl, "vt", uv.map(f))}/${ni}`);
        faces.push(`f ${refs.join(" ")}`);
      }
    }
    return [`# ${comment}`, `mtllib ${mtllib}`, ...vl, ...vtl, ...vnl, ...faces].join("\n") + "\n";
  }
}
