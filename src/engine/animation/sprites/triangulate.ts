/**
 * Constrained Delaunay triangulation of a simple polygon with interior points (ADR 0371, 2D skin meshes): ear clipping
 * gives a first triangulation of the outline, each interior point splits the triangle (or the edge) it falls in, and
 * Lawson flips then make every edge that isn't on the outline locally Delaunay. Outline edges are never flipped, so
 * the result covers the polygon exactly. Plus the helpers a mesh is built with: the polygon's signed area, a
 * point-in-polygon test, simplicity, and evenly spaced interior points.
 *
 * Coordinates are any 2D frame with y up; polygons are lists of `[x, y]` without the closing repeat. Pure; no DOM.
 * Internal: not public API.
 */

/** @internal A 2D point. */
export type Point2 = readonly [number, number];

const orient = (a: Point2, b: Point2, c: Point2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** @internal The polygon's signed area (positive when counter-clockwise). */
export function polygonArea(poly: readonly Point2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** @internal Whether `p` is inside `poly` (even-odd rule; points exactly on an edge may go either way). */
export function insidePolygon(poly: readonly Point2[], p: Point2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** @internal The distance from `p` to the segment `a`–`b`. */
export function segmentDistance(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const segmentsCross = (a: Point2, b: Point2, c: Point2, d: Point2): boolean => {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p: Point2, q: Point2, r: Point2, o: number) => o === 0 && Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return on(a, b, c, o1) || on(a, b, d, o2) || on(c, d, a, o3) || on(c, d, b, o4);
};

/** @internal Whether `poly` is simple: at least 3 points, no two edges meeting except neighbours at their shared point. */
export function isSimplePolygon(poly: readonly Point2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!;
    if (a[0] === b[0] && a[1] === b[1]) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours across the closing edge
      if (segmentsCross(a, b, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

/**
 * @internal Points on a grid `spacing` apart (offset half a cell) strictly inside `poly` and at least `margin`
 * (default 0.35 × spacing) from its outline.
 */
export function interiorPoints(poly: readonly Point2[], spacing: number, margin = spacing * 0.35): Point2[] {
  if (!(spacing > 0) || poly.length < 3) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const out: Point2[] = [];
  for (let y = y0 + spacing / 2; y < y1; y += spacing) {
    for (let x = x0 + spacing / 2; x < x1; x += spacing) {
      const p: Point2 = [x, y];
      if (!insidePolygon(poly, p)) continue;
      let near = false;
      for (let i = 0; i < poly.length && !near; i++) near = segmentDistance(p, poly[i]!, poly[(i + 1) % poly.length]!) < margin;
      if (!near) out.push(p);
    }
  }
  return out;
}

/** @internal A triangulation: the points (outline first, then the interior points kept) and three indices per triangle, counter-clockwise. */
export interface Triangulation {
  readonly points: Point2[];
  readonly triangles: number[];
}

/**
 * @internal The constrained Delaunay triangulation of the simple polygon `outline` (either winding) with `interior`
 * points inside it. Interior points outside the polygon or on an existing vertex are dropped. Triangles of zero area
 * (relative to the polygon's size) never appear.
 */
export function triangulatePolygon(outline: readonly Point2[], interior: readonly Point2[] = []): Triangulation {
  const ccw = polygonArea(outline) >= 0 ? [...outline] : [...outline].reverse();
  const points: Point2[] = [...ccw];
  const n = ccw.length;
  if (n < 3) return { points, triangles: [] };
  let span = 0;
  for (const p of ccw) span = Math.max(span, Math.abs(p[0] - ccw[0]![0]), Math.abs(p[1] - ccw[0]![1]));
  const eps = 1e-9 * span * span;

  // Ear clipping.
  const tris: [number, number, number][] = [];
  const ring = Array.from({ length: n }, (_, i) => i);
  let guard = 0;
  while (ring.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < ring.length; k++) {
      const ia = ring[(k + ring.length - 1) % ring.length]!, ib = ring[k]!, ic = ring[(k + 1) % ring.length]!;
      const a = points[ia]!, b = points[ib]!, c = points[ic]!;
      if (orient(a, b, c) <= eps) continue;
      let blocked = false;
      for (const j of ring) {
        if (j === ia || j === ib || j === ic) continue;
        const p = points[j]!;
        if (orient(a, b, p) >= -eps && orient(b, c, p) >= -eps && orient(c, a, p) >= -eps) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      tris.push([ia, ib, ic]);
      ring.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not simple: what's left isn't covered
  }
  if (ring.length === 3 && orient(points[ring[0]!]!, points[ring[1]!]!, points[ring[2]!]!) > eps) tris.push([ring[0]!, ring[1]!, ring[2]!]);

  const constrained = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let i = 0; i < n; i++) constrained.add(key(i, (i + 1) % n));

  // Interior points: split the triangle they fall in, or the two triangles beside the edge they lie on.
  for (const p of interior) {
    if (!insidePolygon(ccw, p) || points.some((q) => q[0] === p[0] && q[1] === p[1])) continue;
    let placed = false;
    for (let t = 0; t < tris.length && !placed; t++) {
      const [a, b, c] = tris[t]!;
      const o = [orient(points[a]!, points[b]!, p), orient(points[b]!, points[c]!, p), orient(points[c]!, points[a]!, p)];
      if (o.some((v) => v < -eps)) continue;
      const zero = o.findIndex((v) => v <= eps);
      if (o.filter((v) => v <= eps).length > 1) break; // on a vertex: dropped
      const ip = points.length;
      if (zero < 0) {
        points.push(p);
        tris.splice(t, 1, [a, b, ip], [b, c, ip], [c, a, ip]);
        placed = true;
        break;
      }
      // On the edge (e0 → e1) opposite `apex`.
      const tri = [a, b, c];
      const e0 = tri[zero]!, e1 = tri[(zero + 1) % 3]!, apex = tri[(zero + 2) % 3]!;
      if (constrained.has(key(e0, e1))) break; // on the outline: dropped
      const u = tris.findIndex((q, qi) => qi !== t && q.includes(e0) && q.includes(e1));
      if (u < 0) break;
      const other = tris[u]!.find((v) => v !== e0 && v !== e1)!;
      points.push(p);
      const keep = tris.filter((_, qi) => qi !== t && qi !== u);
      keep.push([e0, ip, apex], [ip, e1, apex], [e1, ip, other], [ip, e0, other]);
      tris.length = 0;
      tris.push(...keep);
      placed = true;
    }
  }

  // Lawson flips until every unconstrained edge is locally Delaunay.
  const incircle = (a: Point2, b: Point2, c: Point2, d: Point2): number => {
    const adx = a[0] - d[0], ady = a[1] - d[1], bdx = b[0] - d[0], bdy = b[1] - d[1], cdx = c[0] - d[0], cdy = c[1] - d[1];
    return (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
  };
  const owner = new Map<string, number>(); // directed edge "a>b" → triangle
  const own = (t: number) => {
    const [a, b, c] = tris[t]!;
    owner.set(`${a}>${b}`, t);
    owner.set(`${b}>${c}`, t);
    owner.set(`${c}>${a}`, t);
  };
  const disown = (t: number) => {
    const [a, b, c] = tris[t]!;
    owner.delete(`${a}>${b}`);
    owner.delete(`${b}>${c}`);
    owner.delete(`${c}>${a}`);
  };
  tris.forEach((_, t) => own(t));
  const circleEps = 1e-12 * span * span * span * span;
  for (let pass = 0, flipped = true; flipped && pass < 64; pass++) {
    flipped = false;
    for (let t = 0; t < tris.length; t++) {
      for (let e = 0; e < 3; e++) {
        const tri = tris[t]!;
        const a = tri[e]!, b = tri[(e + 1) % 3]!, c = tri[(e + 2) % 3]!;
        if (constrained.has(key(a, b))) continue;
        const u = owner.get(`${b}>${a}`);
        if (u === undefined) continue;
        const d = tris[u]!.find((v) => v !== a && v !== b)!;
        if (incircle(points[a]!, points[b]!, points[c]!, points[d]!) <= circleEps) continue;
        if (orient(points[a]!, points[d]!, points[c]!) <= eps || orient(points[d]!, points[b]!, points[c]!) <= eps) continue;
        disown(t);
        disown(u);
        tris[t] = [a, d, c];
        tris[u] = [d, b, c];
        own(t);
        own(u);
        flipped = true;
        break;
      }
    }
  }
  return { points, triangles: tris.flat() };
}
