// Deterministic procedural test meshes: rock, tree, building.
import { computeNormals, weld, mergeMeshes, regroup } from './mesh.mjs';

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function makeNoise(seed) {
  const r = rng(seed);
  const perm = new Uint8Array(512), grad = new Float32Array(256);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) grad[i] = r() * 2 - 1;
  const lat = (x, y, z) => grad[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  const sm = (t) => t * t * (3 - 2 * t);
  const value = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(lat(xi, yi, zi), lat(xi + 1, yi, zi), xf), l(lat(xi, yi + 1, zi), lat(xi + 1, yi + 1, zi), xf), yf),
      l(l(lat(xi, yi, zi + 1), lat(xi + 1, yi, zi + 1), xf), l(lat(xi, yi + 1, zi + 1), lat(xi + 1, yi + 1, zi + 1), xf), yf), zf);
  };
  return (x, y, z, oct = 5) => { let s = 0, a = 1, f = 1; for (let o = 0; o < oct; o++) { s += a * value(x * f, y * f, z * f); a *= 0.5; f *= 2; } return s; };
}

/** Icosphere with shared vertices; returns {pos:number[][], tris:number[][]} on the unit sphere. */
function icosphere(level) {
  const t = (1 + Math.sqrt(5)) / 2;
  let pos = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
  let tris = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const cache = new Map(); const next = [];
    const mid = (a, b) => {
      const k = a < b ? a * 1e6 + b : b * 1e6 + a;
      let m = cache.get(k);
      if (m === undefined) {
        const x = pos[a][0] + pos[b][0], y = pos[a][1] + pos[b][1], z = pos[a][2] + pos[b][2]; const len = Math.hypot(x, y, z);
        m = pos.length; pos.push([x / len, y / len, z / len]); cache.set(k, m);
      }
      return m;
    };
    for (const [a, b, c] of tris) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    tris = next;
  }
  return { pos, tris };
}

/** Spherical-UV an icosphere-derived shape (positions already displaced). Splits the u seam. Returns raw mesh (shared normals across seam). */
function sphericalMesh(basePos, tris, name) {
  const n = basePos.length;
  const flat = new Float32Array(n * 3); basePos.forEach((p, i) => flat.set(p, i * 3));
  const idx0 = new Uint32Array(tris.flat());
  const baseNormals = computeNormals(flat, idx0);
  const uv0 = basePos.map((p) => { const d = Math.hypot(p[0], p[1], p[2]); return [Math.atan2(p[2], p[0]) / (2 * Math.PI) + 0.5, Math.acos(Math.max(-1, Math.min(1, p[1] / d))) / Math.PI]; });
  const pos = [...basePos], nrm = Array.from({ length: n }, (_, i) => [baseNormals[i * 3], baseNormals[i * 3 + 1], baseNormals[i * 3 + 2]]), uvs = [...uv0];
  const dup = new Map(); const indices = [];
  for (const tri of tris) {
    const us = tri.map((v) => uv0[v][0]); const wrap = Math.max(...us) - Math.min(...us) > 0.5;
    for (const v of tri) {
      if (wrap && uv0[v][0] < 0.5) {
        let d = dup.get(v);
        if (d === undefined) { d = pos.length; pos.push(basePos[v]); nrm.push(nrm[v]); uvs.push([uv0[v][0] + 1, uv0[v][1]]); dup.set(v, d); }
        indices.push(d);
      } else indices.push(v);
    }
  }
  return {
    name, positions: new Float32Array(pos.flat()), normals: new Float32Array(nrm.flat()), uvs: new Float32Array(uvs.flat()),
    indices: new Uint32Array(indices), groups: [{ start: 0, count: indices.length, name: 'main' }],
  };
}

export function makeRock() {
  const noise = makeNoise(1234);
  const ico = icosphere(5); // 20480 triangles
  const pos = ico.pos.map(([x, y, z]) => {
    const n = noise(x * 1.7 + 5, y * 1.7 + 5, z * 1.7 + 5, 6);
    const ridge = 1 - Math.abs(noise(x * 3 + 9, y * 3 + 9, z * 3 + 9, 3));
    const r = 1 + 0.35 * n + 0.08 * ridge;
    return [x * r * 1.2, y * r * 0.85, z * r];
  });
  return sphericalMesh(pos, ico.tris, 'rock');
}

function cylinder(radial, rings, r0, r1, h, bend, noise) {
  const positions = [], uvs = [], indices = [];
  for (let j = 0; j <= rings; j++) {
    const v = j / rings; const y = v * h; const r = r0 + (r1 - r0) * v;
    const cx = Math.sin(v * 2.3) * bend, cz = Math.cos(v * 1.7) * bend * 0.5;
    for (let i = 0; i <= radial; i++) { // i == radial duplicates column 0 for the UV seam
      const a = (i % radial) / radial * Math.PI * 2;
      const wob = 1 + 0.12 * noise(Math.cos(a) * 2 + 3, y * 1.5, Math.sin(a) * 2 + 3, 3);
      positions.push([cx + Math.cos(a) * r * wob, y, cz + Math.sin(a) * r * wob]);
      uvs.push([i / radial, v * 2]);
    }
  }
  const W = radial + 1;
  for (let j = 0; j < rings; j++) for (let i = 0; i < radial; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  // caps (fan, own vertices so the cap has a hard edge)
  for (const [j, up] of [[0, false], [rings, true]]) {
    const center = positions.length; const cy = j / rings * h;
    positions.push([positions[j * W][0] * 0 + (cyl_center(positions, j, W, radial)[0]), cy, cyl_center(positions, j, W, radial)[1]]); uvs.push([0.5, 0.5]);
    const ring0 = positions.length;
    for (let i = 0; i < radial; i++) { const p = positions[j * W + i]; positions.push([...p]); uvs.push([0.5 + (p[0] - positions[center][0]) * 0.5, 0.5 + (p[2] - positions[center][2]) * 0.5]); }
    for (let i = 0; i < radial; i++) { const a = ring0 + i, b = ring0 + (i + 1) % radial; if (up) indices.push(center, b, a); else indices.push(center, a, b); }
  }
  return { positions, uvs, indices };
}
function cyl_center(positions, j, W, radial) {
  let x = 0, z = 0; for (let i = 0; i < radial; i++) { x += positions[j * W + i][0]; z += positions[j * W + i][2]; }
  return [x / radial, z / radial];
}

export function makeTree() {
  const noise = makeNoise(777);
  const cyl = cylinder(24, 60, 0.28, 0.14, 3.2, 0.25, noise); // 24*60*2 + 48 = 2928 tris
  const flat = new Float32Array(cyl.positions.flat());
  const idx = new Uint32Array(cyl.indices);
  const trunk = {
    name: 'trunk', positions: flat, normals: computeNormals(flat, idx), uvs: new Float32Array(cyl.uvs.flat()), indices: idx,
    groups: [{ start: 0, count: idx.length, name: 'bark' }],
  };
  const blobs = [[0, 3.9, 0, 1.3, 4, 1], [0.8, 3.2, 0.5, 0.95, 4, 2], [-0.7, 4.6, -0.3, 0.8, 3, 3], [0.2, 5.0, 0.7, 0.7, 3, 4]];
  const parts = [trunk];
  for (const [cx, cy, cz, rad, lvl, seed] of blobs) {
    const nz = makeNoise(seed * 31);
    const ico = icosphere(lvl);
    const pos = ico.pos.map(([x, y, z]) => { const r = rad * (1 + 0.3 * nz(x * 2.5 + seed, y * 2.5, z * 2.5, 4)); return [cx + x * r, cy + y * r * 0.9, cz + z * r]; });
    const m = sphericalMesh(pos, ico.tris, 'blob' + seed);
    m.groups = [{ start: 0, count: m.indices.length, name: 'leaves' }];
    parts.push(m);
  }
  const merged = mergeMeshes('tree', parts);
  // two material groups: bark = trunk, leaves = all blobs
  const trunkTris = trunk.indices.length / 3;
  return regroup(merged, (t) => (t < trunkTris ? 0 : 1), ['bark', 'leaves']);
}

export function makeBuilding({ conforming = true } = {}) {
  const W = 12, D = 8, floors = 20, FH = 1.0, depth = 0.12;
  const H = floors * FH;
  const positions = [], normals = [], uvs = [], indices = [];
  const quad = (p, n, uv) => { // p: 4 corners; auto-orient CCW to n
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const flip = c[0] * n[0] + c[1] * n[1] + c[2] * n[2] < 0;
    const o = positions.length;
    for (let i = 0; i < 4; i++) { positions.push(p[i]); normals.push(n); uvs.push(uv[i]); }
    if (!flip) indices.push(o, o + 1, o + 2, o, o + 2, o + 3); else indices.push(o, o + 2, o + 1, o, o + 3, o + 2);
  };
  // walls: origin, along, normal, length, columns
  const walls = [
    { o: [-W / 2, 0, D / 2], u: [1, 0, 0], n: [0, 0, 1], L: W, cols: 6 },
    { o: [W / 2, 0, -D / 2], u: [-1, 0, 0], n: [0, 0, -1], L: W, cols: 6 },
    { o: [W / 2, 0, D / 2], u: [0, 0, -1], n: [1, 0, 0], L: D, cols: 4 },
    { o: [-W / 2, 0, -D / 2], u: [0, 0, 1], n: [-1, 0, 0], L: D, cols: 4 },
  ];
  for (const w of walls) {
    const P = (x, y, dz = 0) => [w.o[0] + w.u[0] * x - w.n[0] * dz, w.o[1] + y, w.o[2] + w.u[2] * x - w.n[2] * dz];
    const cw = w.L / w.cols;
    for (let f = 0; f < floors; f++) for (let c = 0; c < w.cols; c++) {
      const x0 = c * cw, x1 = x0 + cw, y0 = f * FH, y1 = y0 + FH;
      const mx = cw * 0.18, my = FH * 0.15;
      const wx0 = x0 + mx, wx1 = x1 - mx, wy0 = y0 + my, wy1 = y1 - my;
      const wallUV = (x, y) => [x / w.L, y / H];
      const strip = (xa, ya, xb, yb) => quad([P(xa, ya), P(xb, ya), P(xb, yb), P(xa, yb)], w.n, [wallUV(xa, ya), wallUV(xb, ya), wallUV(xb, yb), wallUV(xa, yb)]);
      if (conforming) { // split the full-width strips at the window edges so every edge is shared (no T-junctions)
        strip(x0, y0, wx0, wy0); strip(wx0, y0, wx1, wy0); strip(wx1, y0, x1, wy0);
        strip(x0, wy1, wx0, y1); strip(wx0, wy1, wx1, y1); strip(wx1, wy1, x1, y1);
      } else { strip(x0, y0, x1, wy0); strip(x0, wy1, x1, y1); }
      strip(x0, wy0, wx0, wy1); strip(wx1, wy0, x1, wy1);
      // recess: back (own UV island [0,1]) + 4 sides (inward normals)
      quad([P(wx0, wy0, depth), P(wx1, wy0, depth), P(wx1, wy1, depth), P(wx0, wy1, depth)], w.n, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      const tx = w.u, up = [0, 1, 0];
      quad([P(wx0, wy0), P(wx1, wy0), P(wx1, wy0, depth), P(wx0, wy0, depth)], up, [[0, 0], [1, 0], [1, 0.1], [0, 0.1]]);
      quad([P(wx0, wy1), P(wx1, wy1), P(wx1, wy1, depth), P(wx0, wy1, depth)], [0, -1, 0], [[0, 0], [1, 0], [1, 0.1], [0, 0.1]]);
      quad([P(wx0, wy0), P(wx0, wy1), P(wx0, wy1, depth), P(wx0, wy0, depth)], tx, [[0, 0], [1, 0], [1, 0.1], [0, 0.1]]);
      quad([P(wx1, wy0), P(wx1, wy1), P(wx1, wy1, depth), P(wx1, wy0, depth)], [-tx[0], 0, -tx[2]], [[0, 0], [1, 0], [1, 0.1], [0, 0.1]]);
    }
  }
  quad([[-W / 2, H, -D / 2], [W / 2, H, -D / 2], [W / 2, H, D / 2], [-W / 2, H, D / 2]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  quad([[-W / 2, 0, -D / 2], [-W / 2, 0, D / 2], [W / 2, 0, D / 2], [W / 2, 0, -D / 2]], [0, -1, 0], [[0, 0], [0, 1], [1, 1], [1, 0]]);
  return {
    name: 'building', positions: new Float32Array(positions.flat()), normals: new Float32Array(normals.flat()), uvs: new Float32Array(uvs.flat()),
    indices: new Uint32Array(indices), groups: [{ start: 0, count: indices.length, name: 'main' }],
  };
}

/** Rock split in two materials along a plane: shared boundary ring (same vertex indices). */
export function makeRock2Mat(rock) {
  const cy = (t) => (rock.positions[rock.indices[t * 3] * 3 + 1] + rock.positions[rock.indices[t * 3 + 1] * 3 + 1] + rock.positions[rock.indices[t * 3 + 2] * 3 + 1]) / 3;
  const m = regroup(rock, (t) => (cy(t) > 0.05 ? 1 : 0), ['lower', 'upper']);
  m.name = 'rock2mat';
  return m;
}

export function makeProcedural() {
  const raw = [makeRock(), makeTree(), makeBuilding()];
  return raw;
}
export { weld };
