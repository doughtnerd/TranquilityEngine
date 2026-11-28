// Independent quality metrics: BVH nearest-point queries, Hausdorff-style distances, topology checks.
import { rng } from './gen.mjs';
import { weldPositions, bboxOf } from './mesh.mjs';

function closestPointTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  // Ericson, Real-Time Collision Detection 5.1.5; out = [x,y,z,u,v,w]
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const set = (u, v, w) => { out[0] = ax * u + bx * v + cx * w; out[1] = ay * u + by * v + cy * w; out[2] = az * u + bz * v + cz * w; out[3] = u; out[4] = v; out[5] = w; };
  if (d1 <= 0 && d2 <= 0) return set(1, 0, 0);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return set(1 - v, v, 0); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return set(1 - w, 0, w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); return set(0, 1 - w, w); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return set(1 - v - w, v, w);
}

export class Bvh {
  constructor(positions, indices) {
    this.positions = positions; this.indices = indices;
    const nt = indices.length / 3; this.nt = nt;
    const cen = new Float32Array(nt * 3), lo = new Float32Array(nt * 3), hi = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
      const a = positions[indices[t * 3] * 3 + k], b = positions[indices[t * 3 + 1] * 3 + k], c = positions[indices[t * 3 + 2] * 3 + k];
      lo[t * 3 + k] = Math.min(a, b, c); hi[t * 3 + k] = Math.max(a, b, c); cen[t * 3 + k] = (a + b + c) / 3;
    }
    const order = new Uint32Array(nt).map((_, i) => i);
    const maxNodes = Math.max(1, nt) * 2;
    this.nb = new Float32Array(maxNodes * 6); this.left = new Int32Array(maxNodes); this.right = new Int32Array(maxNodes);
    this.start = new Int32Array(maxNodes); this.cnt = new Int32Array(maxNodes);
    this.nodes = 0;
    const build = (s, e) => {
      const id = this.nodes++;
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], cmn = [Infinity, Infinity, Infinity], cmx = [-Infinity, -Infinity, -Infinity];
      for (let i = s; i < e; i++) { const t = order[i]; for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], lo[t * 3 + k]); mx[k] = Math.max(mx[k], hi[t * 3 + k]); cmn[k] = Math.min(cmn[k], cen[t * 3 + k]); cmx[k] = Math.max(cmx[k], cen[t * 3 + k]); } }
      this.nb.set([...mn, ...mx], id * 6);
      if (e - s <= 4) { this.left[id] = -1; this.start[id] = s; this.cnt[id] = e - s; return id; }
      let ax = 0; for (let k = 1; k < 3; k++) if (cmx[k] - cmn[k] > cmx[ax] - cmn[ax]) ax = k;
      const mid = (s + e) >> 1;
      // quickselect on centroid along ax
      let l = s, r = e - 1;
      while (l < r) {
        const pv = cen[order[(l + r) >> 1] * 3 + ax]; let i = l, j = r;
        while (i <= j) { while (cen[order[i] * 3 + ax] < pv) i++; while (cen[order[j] * 3 + ax] > pv) j--; if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; } }
        if (mid <= j) r = j; else if (mid >= i) l = i; else break;
      }
      this.left[id] = build(s, mid); this.right[id] = build(mid, e); return id;
    };
    if (nt) build(0, nt);
    this.order = order; this.stack = new Int32Array(128); this.tmp = new Float64Array(6); this.best = new Float64Array(6);
  }
  /** Closest point on the mesh: returns squared distance; fills this.best = [x,y,z,u,v,w], this.bestTri. */
  query(px, py, pz) {
    if (!this.nt) return Infinity;
    let bd = Infinity; const st = this.stack; let sp = 0; st[sp++] = 0;
    const P = this.positions, I = this.indices, nb = this.nb, tmp = this.tmp;
    while (sp) {
      const id = st[--sp];
      const o = id * 6;
      const dx = Math.max(nb[o] - px, 0, px - nb[o + 3]), dy = Math.max(nb[o + 1] - py, 0, py - nb[o + 4]), dz = Math.max(nb[o + 2] - pz, 0, pz - nb[o + 5]);
      if (dx * dx + dy * dy + dz * dz >= bd) continue;
      if (this.left[id] < 0) {
        for (let i = this.start[id]; i < this.start[id] + this.cnt[id]; i++) {
          const t = this.order[i]; const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
          closestPointTri(px, py, pz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], tmp);
          const ex = tmp[0] - px, ey = tmp[1] - py, ez = tmp[2] - pz; const d = ex * ex + ey * ey + ez * ez;
          if (d < bd) { bd = d; this.best.set(tmp); this.bestTri = t; }
        }
      } else {
        const l = this.left[id], r = this.right[id];
        const dl = boxDist(nb, l * 6, px, py, pz), dr = boxDist(nb, r * 6, px, py, pz);
        if (dl < dr) { st[sp++] = r; st[sp++] = l; } else { st[sp++] = l; st[sp++] = r; }
      }
    }
    return bd;
  }
}
function boxDist(nb, o, px, py, pz) {
  const dx = Math.max(nb[o] - px, 0, px - nb[o + 3]), dy = Math.max(nb[o + 1] - py, 0, py - nb[o + 4]), dz = Math.max(nb[o + 2] - pz, 0, pz - nb[o + 5]);
  return dx * dx + dy * dy + dz * dz;
}

/** Deterministic sample set on a triangle soup: area-weighted surface points + (a capped subset of) vertices. Returns [{p, tri, bary}] flattened. */
export function sampleSurface(positions, indices, nSurf, nVert, seed = 99) {
  const r = rng(seed); const nt = indices.length / 3; const out = [];
  if (!nt) return out;
  const cum = new Float64Array(nt); let acc = 0;
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]], e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    acc += 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]); cum[t] = acc;
  }
  for (let i = 0; i < nSurf; i++) {
    const x = r() * acc; let lo = 0, hi = nt - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
    let u = r(), v = r(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    out.push({ tri: lo, b: [1 - u - v, u, v] });
  }
  // vertices of used triangles
  const seen = new Set(); const vs = [];
  for (let k = 0; k < indices.length; k++) if (!seen.has(indices[k])) { seen.add(indices[k]); vs.push(k); }
  const stepV = Math.max(1, Math.floor(vs.length / nVert));
  for (let i = 0; i < vs.length; i += stepV) { const k = vs[i]; const t = Math.floor(k / 3), c = k % 3; out.push({ tri: t, b: [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0] }); }
  return out;
}

function pointOf(positions, indices, s) {
  const a = indices[s.tri * 3] * 3, b = indices[s.tri * 3 + 1] * 3, c = indices[s.tri * 3 + 2] * 3;
  return [0, 1, 2].map((k) => positions[a + k] * s.b[0] + positions[b + k] * s.b[1] + positions[c + k] * s.b[2]);
}

/** One-sided distances from samples on A to surface B (absolute units). */
export function oneSided(A, bvhB, nSurf = 15000, nVert = 15000) {
  const samples = sampleSurface(A.positions, A.indices, nSurf, nVert);
  let sum = 0, max = 0; const ds = new Float64Array(samples.length);
  samples.forEach((s, i) => { const p = pointOf(A.positions, A.indices, s); const d = Math.sqrt(bvhB.query(p[0], p[1], p[2])); ds[i] = d; sum += d; if (d > max) max = d; });
  ds.sort();
  return { mean: sum / (samples.length || 1), max, p99: ds[Math.floor(ds.length * 0.99)] || 0 };
}

/**
 * Hausdorff-style comparison of a simplified mesh S against the original O, as fractions of O's bounding-box diagonal.
 * forward: S -> O (surface of simplified near the original), reverse: O -> S.
 */
export function hausdorff(O, S, bvhO, bvhS = null) {
  const diag = bboxOf(O.positions, O.indices).diag;
  if (!S.indices.length) return { fwdMean: NaN, fwdMax: NaN, revMean: NaN, revMax: NaN, max: NaN, mean: NaN, empty: true };
  const bs = bvhS || new Bvh(S.positions, S.indices);
  const f = oneSided(S, bvhO), r = oneSided(O, bs);
  return { fwdMean: f.mean / diag, fwdMax: f.max / diag, revMean: r.mean / diag, revMax: r.max / diag, max: Math.max(f.max, r.max) / diag, mean: Math.max(f.mean, r.mean) / diag };
}

/** Normal-angle (deg) and UV deviation of simplified-surface samples vs interpolated original at the nearest point. */
export function attributeDeviation(O, S, bvhO, n = 15000) {
  const samples = sampleSurface(S.positions, S.indices, n, 0, 7);
  const angs = []; const uvd = [];
  const interp = (M, tri, b) => {
    const i = [M.indices[tri * 3], M.indices[tri * 3 + 1], M.indices[tri * 3 + 2]];
    const nn = [0, 1, 2].map((k) => M.normals[i[0] * 3 + k] * b[0] + M.normals[i[1] * 3 + k] * b[1] + M.normals[i[2] * 3 + k] * b[2]);
    const uv = [0, 1].map((k) => M.uvs[i[0] * 2 + k] * b[0] + M.uvs[i[1] * 2 + k] * b[1] + M.uvs[i[2] * 2 + k] * b[2]);
    return { nn, uv };
  };
  for (const s of samples) {
    const p = pointOf(S.positions, S.indices, s); bvhO.query(p[0], p[1], p[2]);
    const tb = [bvhO.best[3], bvhO.best[4], bvhO.best[5]]; const a = interp(S, s.tri, s.b), o = interp(O, bvhO.bestTri, tb);
    const la = Math.hypot(...a.nn) || 1, lo = Math.hypot(...o.nn) || 1;
    const dot = (a.nn[0] * o.nn[0] + a.nn[1] * o.nn[1] + a.nn[2] * o.nn[2]) / (la * lo);
    angs.push(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI);
    uvd.push(Math.hypot(a.uv[0] - o.uv[0], a.uv[1] - o.uv[1]));
  }
  const stat = (a) => { a.sort((x, y) => x - y); return { mean: a.reduce((x, y) => x + y, 0) / (a.length || 1), p95: a[Math.floor(a.length * 0.95)] || 0 }; };
  const A = stat(angs), U = stat(uvd);
  return { nMean: A.mean, nP95: A.p95, uvMean: U.mean, uvP95: U.p95 };
}

/** Edge topology in position-welded space: open (1 face) and non-manifold (>2 faces) edge counts. */
export function edgeTopology(positions, indices) {
  const w = weldPositions(positions, indices);
  const map = new Map();
  for (let t = 0; t < w.indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = w.indices[t + e], b = w.indices[t + (e + 1) % 3]; if (a === b) continue;
    const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    map.set(k, (map.get(k) || 0) + 1);
  }
  let open = 0, nonManifold = 0;
  for (const c of map.values()) { if (c === 1) open++; else if (c > 2) nonManifold++; }
  let degenerate = 0;
  for (let t = 0; t < w.indices.length; t += 3) if (w.indices[t] === w.indices[t + 1] || w.indices[t + 1] === w.indices[t + 2] || w.indices[t] === w.indices[t + 2]) degenerate++;
  return { open, nonManifold, degenerate, edges: map.size };
}

/** Open (border) edges as segments [ax,ay,az,bx,by,bz] using original positions. */
export function borderSegments(positions, indices) {
  const w = weldPositions(positions, indices); const map = new Map();
  for (let t = 0; t < w.indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = w.indices[t + e], b = w.indices[t + (e + 1) % 3]; const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    const rec = map.get(k); if (rec) rec.c++; else map.set(k, { c: 1, a, b });
  }
  const segs = [];
  for (const r of map.values()) if (r.c === 1) segs.push([w.positions[r.a * 3], w.positions[r.a * 3 + 1], w.positions[r.a * 3 + 2], w.positions[r.b * 3], w.positions[r.b * 3 + 1], w.positions[r.b * 3 + 2]]);
  return segs;
}

/** Max/mean distance from points along border segments of S to the border polyline of O (brute force). */
export function borderDeviation(segO, segS, samplesPerSeg = 3) {
  let sum = 0, max = 0, n = 0; const tmp = new Float64Array(6);
  for (const s of segS) for (let i = 0; i < samplesPerSeg; i++) {
    const t = (i + 0.5) / samplesPerSeg; const p = [s[0] + (s[3] - s[0]) * t, s[1] + (s[4] - s[1]) * t, s[2] + (s[5] - s[2]) * t];
    let best = Infinity;
    for (const o of segO) {
      const dx = o[3] - o[0], dy = o[4] - o[1], dz = o[5] - o[2]; const l2 = dx * dx + dy * dy + dz * dz || 1;
      let u = ((p[0] - o[0]) * dx + (p[1] - o[1]) * dy + (p[2] - o[2]) * dz) / l2; u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(p[0] - o[0] - dx * u, p[1] - o[1] - dy * u, p[2] - o[2] - dz * u); if (d < best) best = d;
    }
    sum += best; n++; if (best > max) max = best;
  }
  void tmp;
  return { mean: sum / (n || 1), max };
}

/** FIFO post-transform cache ACMR (cache size 16). */
export function acmr(indices, cacheSize = 16) {
  const cache = new Int32Array(cacheSize).fill(-1); let misses = 0, head = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]; let hit = false;
    for (let k = 0; k < cacheSize; k++) if (cache[k] === v) { hit = true; break; }
    if (!hit) { misses++; cache[head] = v; head = (head + 1) % cacheSize; }
  }
  return misses / (indices.length / 3);
}

/** Distinct 64-byte cache lines touched when fetching vertices of `stride` bytes (in index order of first use). */
export function fetchLines(indices, stride, line = 64) {
  const lines = new Set();
  for (let i = 0; i < indices.length; i++) { const a = indices[i] * stride, b = a + stride - 1; for (let l = Math.floor(a / line); l <= Math.floor(b / line); l++) lines.add(l); }
  return lines.size;
}

export function percentile(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** Cache-line misses with a small LRU (default 128 lines of 64 B = 8 KiB) while fetching vertices in index order. */
export function fetchMisses(indices, stride, lruLines = 128, line = 64) {
  const lru = []; let misses = 0;
  for (let i = 0; i < indices.length; i++) {
    const a = indices[i] * stride, b = a + stride - 1;
    for (let l = Math.floor(a / line); l <= Math.floor(b / line); l++) {
      const at = lru.indexOf(l);
      if (at >= 0) { lru.splice(at, 1); lru.unshift(l); } else { misses++; lru.unshift(l); if (lru.length > lruLines) lru.pop(); }
    }
  }
  return misses;
}
