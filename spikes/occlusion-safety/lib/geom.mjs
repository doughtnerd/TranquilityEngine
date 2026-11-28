// Procedural, deterministic occluder geometry: welded triangle meshes (positions + indices, CCW from outside) and the
// solid boxes they fill (used only to keep occludees from poking into walls).
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class MeshBuilder {
  constructor() { this.pos = []; this.idx = []; this.map = new Map(); this.solids = []; }
  v(p) {
    const k = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
    let i = this.map.get(k);
    if (i === undefined) { i = this.pos.length / 3; this.pos.push(p[0], p[1], p[2]); this.map.set(k, i); }
    return i;
  }
  tri(a, b, c) { const ia = this.v(a), ib = this.v(b), ic = this.v(c); if (ia !== ib && ib !== ic && ia !== ic) this.idx.push(ia, ib, ic); }
  /** Quad p0..p3 (cyclic), wound so its normal points along n. */
  quad(p0, p1, p2, p3, n) {
    if (dot(cross(sub(p1, p0), sub(p2, p0)), n) < 0) { this.tri(p0, p2, p1); this.tri(p0, p3, p2); } else { this.tri(p0, p1, p2); this.tri(p0, p2, p3); }
  }
  box(mn, mx, solid = true) {
    const P = (x, y, z) => [x ? mx[0] : mn[0], y ? mx[1] : mn[1], z ? mx[2] : mn[2]];
    this.quad(P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1), [-1, 0, 0]); this.quad(P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1), [1, 0, 0]);
    this.quad(P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1), [0, -1, 0]); this.quad(P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1), [0, 1, 0]);
    this.quad(P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0), [0, 0, -1]); this.quad(P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1), [0, 0, 1]);
    if (solid) this.solids.push([...mn, ...mx]);
  }
  finish() { return { positions: new Float32Array(this.pos), indices: new Uint32Array(this.idx), solids: this.solids }; }
}

const uniq = (a) => { a.sort((x, y) => x - y); const o = []; for (const x of a) if (!o.length || x - o[o.length - 1] > 1e-4) o.push(x); return o; };
const grid = (a, b, step, extra) => { const s = [a, b, ...extra.filter((x) => x > a + 1e-4 && x < b - 1e-4)]; if (step) for (let x = a + step; x < b - 1e-4; x += step) s.push(x); return uniq(s); };

/**
 * A wall slab as a closed, welded, tessellated mesh. Local frame: origin o (bottom corner of the front face), u along the
 * wall, n the outward (front) normal, thickness T extends along -n. openings: {x0,x1,y0,y1, through:boolean, depth?}.
 * Through openings are holes in both faces with reveals; recess openings are blind (front hole, reveals, a back panel).
 */
export function wallSlab(mb, { o, u, n, L, H, T, openings = [], sub = 1 }) {
  const up = [0, 1, 0];
  const P = (x, y, d) => add(add(add(o, mul(u, x)), mul(up, y)), mul(n, -d));
  const xs = grid(0, L, sub, openings.flatMap((q) => [q.x0, q.x1]));
  const ys = grid(0, H, sub, openings.flatMap((q) => [q.y0, q.y1]));
  const openAt = (cx, cy) => openings.find((q) => cx > q.x0 && cx < q.x1 && cy > q.y0 && cy < q.y1);
  const nu = mul(u, -1), nn = mul(n, -1);
  const aabb = (pts) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); } return [...mn, ...mx]; };
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    const xa = xs[i], xb = xs[i + 1], ya = ys[j], yb = ys[j + 1];
    const q = openAt((xa + xb) / 2, (ya + yb) / 2);
    if (!q) {
      mb.quad(P(xa, ya, 0), P(xb, ya, 0), P(xb, yb, 0), P(xa, yb, 0), n);
      mb.quad(P(xa, ya, T), P(xb, ya, T), P(xb, yb, T), P(xa, yb, T), nn);
      mb.solids.push(aabb([P(xa, ya, 0), P(xb, yb, T)]));
    } else if (!q.through) {
      mb.quad(P(xa, ya, T), P(xb, ya, T), P(xb, yb, T), P(xa, yb, T), nn);
      mb.quad(P(xa, ya, q.depth), P(xb, ya, q.depth), P(xb, yb, q.depth), P(xa, yb, q.depth), n);
      mb.solids.push(aabb([P(xa, ya, q.depth), P(xb, yb, T)]));
    }
  }
  for (const q of openings) {
    const dep = q.through ? T : q.depth;
    for (let i = 0; i + 1 < xs.length; i++) {
      const xa = xs[i], xb = xs[i + 1]; if (xa < q.x0 - 1e-4 || xb > q.x1 + 1e-4) continue;
      mb.quad(P(xa, q.y0, 0), P(xb, q.y0, 0), P(xb, q.y0, dep), P(xa, q.y0, dep), up);
      mb.quad(P(xa, q.y1, 0), P(xb, q.y1, 0), P(xb, q.y1, dep), P(xa, q.y1, dep), [0, -1, 0]);
    }
    for (let j = 0; j + 1 < ys.length; j++) {
      const ya = ys[j], yb = ys[j + 1]; if (ya < q.y0 - 1e-4 || yb > q.y1 + 1e-4) continue;
      mb.quad(P(q.x0, ya, 0), P(q.x0, yb, 0), P(q.x0, yb, dep), P(q.x0, ya, dep), u);
      mb.quad(P(q.x1, ya, 0), P(q.x1, yb, 0), P(q.x1, yb, dep), P(q.x1, ya, dep), nu);
    }
  }
  for (let i = 0; i + 1 < xs.length; i++) {
    mb.quad(P(xs[i], H, 0), P(xs[i + 1], H, 0), P(xs[i + 1], H, T), P(xs[i], H, T), up);
    mb.quad(P(xs[i], 0, 0), P(xs[i + 1], 0, 0), P(xs[i + 1], 0, T), P(xs[i], 0, T), [0, -1, 0]);
  }
  for (let j = 0; j + 1 < ys.length; j++) {
    mb.quad(P(0, ys[j], 0), P(0, ys[j + 1], 0), P(0, ys[j + 1], T), P(0, ys[j], T), nu);
    mb.quad(P(L, ys[j], 0), P(L, ys[j + 1], 0), P(L, ys[j + 1], T), P(L, ys[j], T), u);
  }
}

/** Hollow building (4 walls, floor, roof). doors: [{face:'front'|'back'|'left'|'right', u (centre along that wall), w, h}]. */
export function building(mb, { cx, cz, W, D, H, T = 0.4, doors = [], sub = 1 }) {
  const xmin = cx - W / 2, xmax = cx + W / 2, zmin = cz - D / 2, zmax = cz + D / 2;
  const walls = {
    front: { o: [xmin, 0, zmin], u: [1, 0, 0], n: [0, 0, -1], L: W },
    back: { o: [xmax, 0, zmax], u: [-1, 0, 0], n: [0, 0, 1], L: W },
    left: { o: [xmin, 0, zmax - T], u: [0, 0, -1], n: [-1, 0, 0], L: D - 2 * T },
    right: { o: [xmax, 0, zmin + T], u: [0, 0, 1], n: [1, 0, 0], L: D - 2 * T },
  };
  for (const [name, w] of Object.entries(walls)) {
    const openings = [];
    const door = doors.find((d) => d.face === name);
    if (door) openings.push({ x0: door.u - door.w / 2, x1: door.u + door.w / 2, y0: 0, y1: door.h, through: true });
    const cols = Math.max(1, Math.floor(w.L / 3.5));
    const pitch = w.L / cols;
    for (let c = 0; c < cols; c++) {
      const uc = pitch * (c + 0.5);
      const clash = door && Math.abs(uc - door.u) < door.w / 2 + 0.9;
      if (!clash) openings.push({ x0: uc - 0.6, x1: uc + 0.6, y0: 0.9, y1: 2.2, through: true });
      for (const [y0, y1] of [[3.6, 5.0], [6.6, 8.0]]) if (y1 < H - 0.5) openings.push({ x0: uc - 0.7, x1: uc + 0.7, y0, y1, through: false, depth: 0.18 });
    }
    wallSlab(mb, { ...w, H, T, openings, sub });
  }
  mb.box([xmin, -0.3, zmin], [xmax, 0, zmax]);
  mb.box([xmin, H, zmin], [xmax, H + 0.4, zmax]);
  return { xmin, xmax, zmin, zmax, T, H };
}

/** Heightfield patch, one-sided (normals up). */
export function terrain(mb, { x0, z0, nx, nz, cell, height }) {
  const p = (i, j) => [x0 + i * cell, height(x0 + i * cell, z0 + j * cell), z0 + j * cell];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) mb.quad(p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1), [0, 1, 0]);
}
