// A blend space's geometry, the core's rule (ADR 0372; `anim-graph/src/sources/triangulate.rs`, leaf L31a, and
// `sources.rs`'s `space_weights`), for the graph editor's blend-space preview: the same triangles and the same weights the
// runtime blends by, so the preview point shows what the game will play.
//
// - **2D:** exact duplicates dropped (the first copy represents the point); the rest inserted in lexicographic order
//   (x, then y, then index), each joined to every hull edge it sees; a run of collinear leading points fanned to the
//   first point off their line; then Lawson flips while a vertex lies strictly inside the neighbour's circumcircle
//   (relative tolerance 1e-12), so co-circular points (a square grid) keep the sweep's diagonal. Triangles are
//   counter-clockwise, rotated to start at their lowest index, and sorted. Weights: the first triangle whose barycentric
//   coordinates are all ≥ −1e-6 (clamped at 0, renormalised), else the projection onto the nearest hull edge (the first
//   on a tie), else one point takes it all. Weights are computed in f32, as the core does (`Math.fround`).
// - **1D:** the samples sorted by coordinate (ties by index); below the first or at/after the last, that one alone;
//   between two neighbours, linear.
//
// A port, not a second design: a change to the Rust rule changes this file too. Pure; no DOM.

/** A point of the space. */
export type Point2 = readonly [number, number];

/** Triangles and hull edges, as indices into the caller's point list. */
export interface Triangulation {
  readonly triangles: readonly (readonly [number, number, number])[];
  readonly hull: readonly (readonly [number, number])[];
}

const INCIRCLE_EPS = 1e-12;

const orient = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function incircle(a: Point2, b: Point2, c: Point2, d: Point2): number {
  const adx = a[0] - d[0], ady = a[1] - d[1];
  const bdx = b[0] - d[0], bdy = b[1] - d[1];
  const cdx = c[0] - d[0], cdy = c[1] - d[1];
  const ad = adx * adx + ady * ady, bd = bdx * bdx + bdy * bdy, cd = cdx * cdx + cdy * cdy;
  return adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx);
}

/** The edges that belong to exactly one triangle, in triangle order. */
function boundary(tris: readonly (readonly [number, number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const a = t[e]!, b = t[(e + 1) % 3]!;
      const shared = tris.some((s) => [0, 1, 2].some((f) => s[f] === b && s[(f + 1) % 3] === a));
      if (!shared) out.push([a, b]);
    }
  }
  return out;
}

/** Stable insertion sort (the Rust `sort_small`), so equal keys keep their order exactly as the core's. */
function sortSmall<T>(v: T[], less: (a: T, b: T) => boolean): void {
  for (let i = 1; i < v.length; i++) {
    const x = v[i]!;
    let j = i;
    while (j > 0 && less(x, v[j - 1]!)) {
      v[j] = v[j - 1]!;
      j--;
    }
    v[j] = x;
  }
}

/** The core's triangulation of `points` (see the file comment). Coordinates are read as f32 first, as the core stores them. */
export function triangulate(points: readonly Point2[]): Triangulation {
  const p: Point2[] = points.map((q) => [Math.fround(q[0]), Math.fround(q[1])]);
  const unique: number[] = [];
  p.forEach((q, i) => {
    if (Number.isFinite(q[0]) && Number.isFinite(q[1]) && !unique.some((u) => p[u]![0] === q[0] && p[u]![1] === q[1])) unique.push(i);
  });
  sortSmall(unique, (a, b) => {
    const pa = p[a]!, pb = p[b]!;
    return pa[0] !== pb[0] ? pa[0] < pb[0] : pa[1] !== pb[1] ? pa[1] < pb[1] : a < b;
  });
  const at = (i: number) => p[i]!;
  let extent = 0;
  for (const u of unique) for (const v of unique) extent = Math.max(extent, Math.abs(at(u)[0] - at(v)[0]), Math.abs(at(u)[1] - at(v)[1]));
  const scale2 = Math.max(extent * extent, Number.MIN_VALUE);
  const collinearEps = 1e-12 * scale2;
  let k = -1;
  for (let i = 2; i < unique.length; i++) {
    if (Math.abs(orient(at(unique[0]!), at(unique[1]!), at(unique[i]!))) > collinearEps) { k = i; break; }
  }
  if (k < 0) {
    const hull: [number, number][] = [];
    for (let i = 0; i + 1 < unique.length; i++) hull.push([unique[i]!, unique[i + 1]!]);
    return { triangles: [], hull };
  }
  const tris: [number, number, number][] = [];
  const push = (a: number, b: number, c: number) => tris.push(orient(at(a), at(b), at(c)) > 0 ? [a, b, c] : [a, c, b]);
  const apex = unique[k]!;
  for (let i = 0; i + 1 < k; i++) push(unique[i]!, unique[i + 1]!, apex);
  for (const q of unique.slice(k + 1)) {
    for (const [a, b] of boundary(tris)) if (orient(at(a), at(b), at(q)) < -collinearEps) push(a, b, q);
  }
  const eps = INCIRCLE_EPS * scale2 * scale2;
  let guard = 0;
  outer: for (;;) {
    guard++;
    if (guard > 64 * (tris.length + 1) * (tris.length + 1)) break;
    for (let t = 0; t < tris.length; t++) {
      for (let e = 0; e < 3; e++) {
        const a = tris[t]![e]!, b = tris[t]![(e + 1) % 3]!, c = tris[t]![(e + 2) % 3]!;
        let u = -1, d = -1;
        for (let s = 0; s < tris.length && u < 0; s++) {
          for (let f = 0; f < 3; f++) {
            if (tris[s]![f] === b && tris[s]![(f + 1) % 3] === a) { u = s; d = tris[s]![(f + 2) % 3]!; break; }
          }
        }
        if (u < 0) continue;
        if (incircle(at(a), at(b), at(c), at(d)) > eps && orient(at(c), at(a), at(d)) > 0 && orient(at(d), at(b), at(c)) > 0) {
          tris[t] = [c, a, d];
          tris[u] = [d, b, c];
          continue outer;
        }
      }
    }
    break;
  }
  const rotated = tris.map((t): [number, number, number] => {
    const m = t.indexOf(Math.min(...t));
    return [t[m]!, t[(m + 1) % 3]!, t[(m + 2) % 3]!];
  });
  sortSmall(rotated, (a, b) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]));
  return { triangles: rotated, hull: boundary(rotated) };
}

const f = Math.fround;

/** The weight of each point (in the caller's order) at `q`, by the core's rule over `tri` (from `triangulate(points)`). */
export function weights2D(points: readonly Point2[], tri: Triangulation, q: Point2): number[] {
  const out = points.map(() => 0);
  const get = (i: number): Point2 => { const v = points[i]; return v ? [f(v[0]), f(v[1])] : [0, 0]; };
  const p: Point2 = [f(q[0]), f(q[1])];
  for (const t of tri.triangles) {
    const a = get(t[0]), b = get(t[1]), c = get(t[2]);
    const d = f(f(f(b[1] - c[1]) * f(a[0] - c[0])) + f(f(c[0] - b[0]) * f(a[1] - c[1])));
    if (d === 0) continue;
    const wa = f(f(f(f(b[1] - c[1]) * f(p[0] - c[0])) + f(f(c[0] - b[0]) * f(p[1] - c[1]))) / d);
    const wb = f(f(f(f(c[1] - a[1]) * f(p[0] - c[0])) + f(f(a[0] - c[0]) * f(p[1] - c[1]))) / d);
    const wc = f(f(1 - wa) - wb);
    const TOL = -1e-6;
    if (wa >= TOL && wb >= TOL && wc >= TOL) {
      const xa = Math.max(wa, 0), xb = Math.max(wb, 0), xc = Math.max(wc, 0);
      const s = f(f(xa + xb) + xc);
      if (s > 0) { out[t[0]] += f(xa / s); out[t[1]] += f(xb / s); out[t[2]] += f(xc / s); }
      else out[t[0]] += 1;
      return out;
    }
  }
  let best: { d2: number; e: readonly [number, number]; t: number } | null = null;
  for (const e of tri.hull) {
    const a = get(e[0]), b = get(e[1]);
    const ex = f(b[0] - a[0]), ey = f(b[1] - a[1]);
    const len2 = f(f(ex * ex) + f(ey * ey));
    const t = len2 > 0 ? Math.min(1, Math.max(0, f(f(f(f(p[0] - a[0]) * ex) + f(f(p[1] - a[1]) * ey)) / len2))) : 0;
    const qx = f(f(a[0] + f(ex * t)) - p[0]), qy = f(f(a[1] + f(ey * t)) - p[1]);
    const d2 = f(f(qx * qx) + f(qy * qy));
    if (!best || d2 < best.d2) best = { d2, e, t };
  }
  if (best) {
    out[best.e[0]] += f(1 - best.t);
    out[best.e[1]] += best.t;
    return out;
  }
  const first = points.findIndex((v) => Number.isFinite(v[0]) && Number.isFinite(v[1]));
  if (out.length) out[first < 0 ? 0 : first] = 1;
  return out;
}

/** The weight of each sample (in the caller's order) at `x`, by the core's 1D rule. */
export function weights1D(coords: readonly number[], x: number): number[] {
  const n = coords.length;
  const out = coords.map(() => 0);
  if (n === 0) return out;
  const order = coords.map((_, i) => i);
  sortSmall(order, (a, b) => (f(coords[a]!) !== f(coords[b]!) ? f(coords[a]!) < f(coords[b]!) : a < b));
  const pos = (k: number) => f(coords[order[k]!]!);
  const xf = f(x);
  if (Number.isNaN(xf) || xf <= pos(0)) { out[order[0]!] = 1; return out; }
  if (xf >= pos(n - 1)) { out[order[n - 1]!] = 1; return out; }
  for (let k = 0; k + 1 < n; k++) {
    const a = pos(k), b = pos(k + 1);
    if (xf >= a && xf < b) {
      const t = b > a ? f(f(xf - a) / f(b - a)) : 0;
      out[order[k]!] += f(1 - t);
      out[order[k + 1]!] += t;
      return out;
    }
  }
  out[order[n - 1]!] = 1;
  return out;
}
