/**
 * Polygon geometry for 2D colliders (ADR 0005, 0039). Internal and renderer-free so it can be
 * tested headless: a simple polygon (either winding) is split into convex parts, which the
 * physics backend turns into one compound shape.
 */

/** @internal A point in a collider's local XY plane. */
export type Point2 = readonly [number, number];

const EPS = 1e-9;

/** @internal Twice the signed area: positive for counter-clockwise points. */
export function signedArea2(points: readonly Point2[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return a;
}

const cross = (o: Point2, a: Point2, b: Point2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** @internal Drop non-finite points and repeated neighbours (including last = first). */
export function cleanPoints(points: readonly (readonly number[])[]): Point2[] {
  const out: Point2[] = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < EPS && Math.abs(prev[1] - p[1]) < EPS) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < EPS && Math.abs(out[0][1] - out[out.length - 1][1]) < EPS) out.pop();
  return out;
}

/** @internal True if the polygon is convex (collinear points allowed), in either winding. */
export function isConvex(points: readonly Point2[]): boolean {
  if (points.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const c = cross(points[i], points[(i + 1) % points.length], points[(i + 2) % points.length]);
    if (Math.abs(c) < EPS) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

function inTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  return cross(a, b, p) >= -EPS && cross(b, c, p) >= -EPS && cross(c, a, p) >= -EPS;
}

/**
 * @internal Ear-clipping triangulation of a simple polygon given counter-clockwise. Returns index
 * triples, or null if the polygon isn't simple (no ear could be found).
 */
export function triangulate(points: readonly Point2[]): [number, number, number][] | null {
  const idx = points.map((_, i) => i);
  const out: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3) {
    if (guard++ > points.length * points.length) return null;
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = points[ia], b = points[ib], c = points[ic];
      const turn = cross(a, b, c);
      if (turn < -EPS) continue; // reflex
      if (Math.abs(turn) <= EPS) {
        // Collinear: drop the middle point without making a triangle.
        idx.splice(i, 1);
        clipped = true;
        break;
      }
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTriangle(points[j], a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (idx.length === 3 && Math.abs(cross(points[idx[0]], points[idx[1]], points[idx[2]])) > EPS) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/** True if the index polygon is convex (counter-clockwise, collinear allowed). */
function convexIndices(points: readonly Point2[], poly: readonly number[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (cross(points[poly[i]], points[poly[(i + 1) % poly.length]], points[poly[(i + 2) % poly.length]]) < -EPS) return false;
  }
  return true;
}

/** Merge P (has edge a→b) and Q (has edge b→a) along that edge. */
function mergeAlong(p: readonly number[], q: readonly number[], a: number, b: number): number[] {
  const pi = p.indexOf(b), qi = q.indexOf(a);
  const pr = [...p.slice(pi), ...p.slice(0, pi)]; // b … a
  const qr = [...q.slice(qi), ...q.slice(0, qi)]; // a … b
  return [...pr, ...qr.slice(1, -1)];
}

/**
 * @internal Split a simple polygon (either winding) into convex parts, counter-clockwise: the
 * polygon itself if it's convex, else ear-clipped triangles merged back into convex pieces
 * (Hertel-Mehlhorn). Null if there are fewer than 3 usable points or the polygon crosses itself.
 */
export function convexParts(input: readonly (readonly number[])[]): Point2[][] | null {
  let points = cleanPoints(input);
  if (points.length < 3 || Math.abs(signedArea2(points)) < EPS) return null;
  if (signedArea2(points) < 0) points = [...points].reverse();
  if (isConvex(points)) return [points];
  const tris = triangulate(points);
  if (!tris || tris.length === 0) return null;
  const pieces: number[][] = tris.map((t) => [...t]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length];
        for (let j = 0; j < pieces.length; j++) {
          if (j === i) continue;
          const q = pieces[j];
          const qa = q.indexOf(a);
          if (qa < 0 || q[(qa + q.length - 1) % q.length] !== b) continue; // Q needs edge b→a
          const m = mergeAlong(p, q, a, b);
          if (!convexIndices(points, m)) continue;
          pieces[i] = m;
          pieces.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return pieces.map((poly) => poly.map((i) => points[i]));
}
