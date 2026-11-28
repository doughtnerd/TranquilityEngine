/**
 * A sampled two-way Hausdorff distance between two triangle meshes (ADR 0459 §1, 0460 §3): the error the LOD pipeline
 * measures for every level and occluder stand-in, since meshoptimizer's own estimate isn't a bound. Ported from the
 * spike's BVH metric (`spikes/lod-simplify/lib/metrics.mjs`). Internal: not public API.
 *
 * Each direction samples area-weighted points on one surface plus (a capped subset of) its vertices, and finds each
 * one's nearest point on the other surface through a BVH. The samples come from a seeded generator, so the result is
 * deterministic.
 */

/** Samples per direction: surface points and (at most) vertices. 15k + 15k agreed with 100k samples to 3 % (`spikes/occlusion-safety/`). */
export const DEFAULT_SAMPLES = { surface: 15000, vertices: 15000 } as const;

/** A seeded generator of numbers in [0, 1) (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Squared distance from p to its closest point on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestSq(px: number, py: number, pz: number, P: Float32Array, a: number, b: number, c: number): number {
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
  const acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u: number, v: number, w: number; // weights of a, b, c
  if (d1 <= 0 && d2 <= 0) (u = 1), (v = 0), (w = 0);
  else {
    const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) (u = 0), (v = 1), (w = 0);
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const t = d1 / (d1 - d3);
      (u = 1 - t), (v = t), (w = 0);
    } else if (d6 >= 0 && d5 <= d6) (u = 0), (v = 0), (w = 1);
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const t = d2 / (d2 - d6);
      (u = 1 - t), (v = 0), (w = t);
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const t = (d4 - d3) / (d4 - d3 + d5 - d6);
      (u = 0), (v = 1 - t), (w = t);
    } else {
      const den = 1 / (va + vb + vc);
      v = vb * den;
      w = vc * den;
      u = 1 - v - w;
    }
  }
  const qx = ax + abx * v + acx * w - px, qy = ay + aby * v + acy * w - py, qz = az + abz * v + acz * w - pz;
  void u;
  return qx * qx + qy * qy + qz * qz;
}

/** A bounding-volume hierarchy over a triangle mesh's triangles, for nearest-point queries. */
export class TriangleBvh {
  private readonly bounds: Float32Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly first: Int32Array;
  private readonly count: Int32Array;
  private readonly order: Uint32Array;
  private readonly stack = new Int32Array(256);
  private readonly triangles: number;

  constructor(
    private readonly positions: Float32Array,
    private readonly indices: Uint32Array,
  ) {
    const nt = (this.triangles = Math.floor(indices.length / 3));
    const lo = new Float32Array(nt * 3), hi = new Float32Array(nt * 3), centre = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        const a = positions[indices[t * 3] * 3 + k], b = positions[indices[t * 3 + 1] * 3 + k], c = positions[indices[t * 3 + 2] * 3 + k];
        lo[t * 3 + k] = Math.min(a, b, c);
        hi[t * 3 + k] = Math.max(a, b, c);
        centre[t * 3 + k] = (a + b + c) / 3;
      }
    }
    const order = (this.order = new Uint32Array(nt));
    for (let i = 0; i < nt; i++) order[i] = i;
    const max = Math.max(1, nt) * 2;
    this.bounds = new Float32Array(max * 6);
    this.left = new Int32Array(max);
    this.right = new Int32Array(max);
    this.first = new Int32Array(max);
    this.count = new Int32Array(max);
    let nodes = 0;
    const build = (s: number, e: number): number => {
      const id = nodes++;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
      for (let i = s; i < e; i++) {
        const t = order[i] * 3;
        x0 = Math.min(x0, lo[t]), y0 = Math.min(y0, lo[t + 1]), z0 = Math.min(z0, lo[t + 2]);
        x1 = Math.max(x1, hi[t]), y1 = Math.max(y1, hi[t + 1]), z1 = Math.max(z1, hi[t + 2]);
        for (let k = 0; k < 3; k++) (cmin[k] = Math.min(cmin[k], centre[t + k])), (cmax[k] = Math.max(cmax[k], centre[t + k]));
      }
      this.bounds.set([x0, y0, z0, x1, y1, z1], id * 6);
      if (e - s <= 4) {
        this.left[id] = -1;
        this.first[id] = s;
        this.count[id] = e - s;
        return id;
      }
      let axis = 0;
      for (let k = 1; k < 3; k++) if (cmax[k] - cmin[k] > cmax[axis] - cmin[axis]) axis = k;
      const mid = (s + e) >> 1;
      // Quickselect on the centroids along the axis.
      let l = s, r = e - 1;
      while (l < r) {
        const pivot = centre[order[(l + r) >> 1] * 3 + axis];
        let i = l, j = r;
        while (i <= j) {
          while (centre[order[i] * 3 + axis] < pivot) i++;
          while (centre[order[j] * 3 + axis] > pivot) j--;
          if (i <= j) {
            const t = order[i];
            order[i] = order[j];
            order[j] = t;
            i++;
            j--;
          }
        }
        if (mid <= j) r = j;
        else if (mid >= i) l = i;
        else break;
      }
      this.left[id] = build(s, mid);
      this.right[id] = build(mid, e);
      return id;
    };
    if (nt) build(0, nt);
  }

  private boxSq(node: number, px: number, py: number, pz: number): number {
    const b = this.bounds, o = node * 6;
    const dx = Math.max(b[o] - px, 0, px - b[o + 3]), dy = Math.max(b[o + 1] - py, 0, py - b[o + 4]), dz = Math.max(b[o + 2] - pz, 0, pz - b[o + 5]);
    return dx * dx + dy * dy + dz * dz;
  }

  /** The squared distance from a point to the mesh (Infinity for a mesh with no triangles). */
  distanceSq(px: number, py: number, pz: number): number {
    if (!this.triangles) return Infinity;
    const P = this.positions, I = this.indices, st = this.stack;
    let best = Infinity;
    let sp = 0;
    st[sp++] = 0;
    while (sp) {
      const id = st[--sp];
      if (this.boxSq(id, px, py, pz) >= best) continue;
      if (this.left[id] < 0) {
        for (let i = this.first[id], end = i + this.count[id]; i < end; i++) {
          const t = this.order[i] * 3;
          const d = closestSq(px, py, pz, P, I[t] * 3, I[t + 1] * 3, I[t + 2] * 3);
          if (d < best) best = d;
        }
      } else {
        const l = this.left[id], r = this.right[id];
        if (this.boxSq(l, px, py, pz) < this.boxSq(r, px, py, pz)) (st[sp++] = r), (st[sp++] = l);
        else (st[sp++] = l), (st[sp++] = r);
      }
    }
    return best;
  }
}

/**
 * The largest distance from samples on mesh A (area-weighted surface points from a seeded generator, then at most
 * `vertices` of its vertices, evenly strided) to mesh B, in model units.
 */
export function oneSidedMax(positionsA: Float32Array, indicesA: Uint32Array, toB: TriangleBvh, samples: { surface: number; vertices: number } = DEFAULT_SAMPLES, seed = 99): number {
  const nt = Math.floor(indicesA.length / 3);
  if (!nt) return 0;
  const P = positionsA, I = indicesA;
  const cumulative = new Float64Array(nt);
  let area = 0;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    area += 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    cumulative[t] = area;
  }
  let max = 0;
  const r = random(seed);
  if (area > 0) {
    for (let i = 0; i < samples.surface; i++) {
      const x = r() * area;
      let lo = 0, hi = nt - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      let u = r(), v = r();
      if (u + v > 1) (u = 1 - u), (v = 1 - v);
      const w = 1 - u - v;
      const a = I[lo * 3] * 3, b = I[lo * 3 + 1] * 3, c = I[lo * 3 + 2] * 3;
      const d = toB.distanceSq(P[a] * w + P[b] * u + P[c] * v, P[a + 1] * w + P[b + 1] * u + P[c + 1] * v, P[a + 2] * w + P[b + 2] * u + P[c + 2] * v);
      if (d > max) max = d;
    }
  }
  // The vertices the triangles use, in order of first use, strided down to at most `vertices`.
  const seen = new Set<number>();
  const used: number[] = [];
  for (let k = 0; k < nt * 3; k++) {
    if (!seen.has(I[k])) {
      seen.add(I[k]);
      used.push(I[k]);
    }
  }
  const step = Math.max(1, Math.floor(used.length / Math.max(1, samples.vertices)));
  for (let i = 0; i < used.length; i += step) {
    const v = used[i] * 3;
    const d = toB.distanceSq(P[v], P[v + 1], P[v + 2]);
    if (d > max) max = d;
  }
  return Math.sqrt(max);
}

/**
 * The sampled two-way Hausdorff distance between an original mesh and a simplified one, in model units. `original` may
 * be passed in prebuilt, since every level of a mesh measures against the same LOD0. A simplified mesh with no
 * triangles is infinitely far.
 */
export function hausdorffDistance(
  original: { positions: Float32Array; indices: Uint32Array; bvh?: TriangleBvh },
  simplified: { positions: Float32Array; indices: Uint32Array },
  samples: { surface: number; vertices: number } = DEFAULT_SAMPLES,
): number {
  if (simplified.indices.length < 3) return Infinity;
  const originalBvh = original.bvh ?? new TriangleBvh(original.positions, original.indices);
  const forward = oneSidedMax(simplified.positions, simplified.indices, originalBvh, samples);
  const reverse = oneSidedMax(original.positions, original.indices, new TriangleBvh(simplified.positions, simplified.indices), samples);
  return Math.max(forward, reverse);
}
