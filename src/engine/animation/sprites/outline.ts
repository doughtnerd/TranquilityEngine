/**
 * The opaque outline of a slice (ADR 0371, 2D skin meshes): each island of opaque pixels (`islands.ts`) as one simple
 * polygon, its outer boundary along pixel edges, simplified (Ramer–Douglas–Peucker) within a tolerance in pixels.
 * Holes are filled (the mesh covers them; their pixels are transparent anyway).
 *
 * - Pixels touching only at a corner are joined first (the background pixel beside them becomes part of the island),
 *   so every boundary is a simple curve.
 * - A simplification that would make the polygon cross itself is retried with half the tolerance, down to none.
 *
 * Polygons are in the slice's frame (pixels; x right from the rect's left edge, y up from its bottom edge),
 * counter-clockwise. Pure; no DOM. Internal: not public API.
 */
import { alphaIslands, type PixelRect, type Pixels } from "./islands";
import { isSimplePolygon, polygonArea, segmentDistance, type Point2 } from "./triangulate";

/** @internal How outlines are found. */
export interface OutlineOptions {
  /** A pixel is opaque when its alpha is above this (0–255; default 0). */
  readonly threshold?: number;
  /** The most a simplified outline may stray from the pixel boundary, in pixels (default 1). */
  readonly tolerance?: number;
  /** Islands with fewer opaque pixels are left out (default 1). */
  readonly minArea?: number;
}

/** @internal The outline of each island of opaque pixels inside `rect` (an image rect, top-left origin), largest first. */
export function sliceOutlines(pixels: Pixels, rect: PixelRect, options: OutlineOptions = {}): Point2[][] {
  const islands = alphaIslands(pixels, options.threshold ?? 0, rect);
  const [rx, ry, W, H] = islands.region;
  // The region's offset inside the slice (an image that cuts the rect off), in the slice's y-up frame.
  const ox = rx - rect[0], oy = rect[1] + rect[3] - (ry + H);
  const out: { poly: Point2[]; area: number }[] = [];
  islands.areas.forEach((area, i) => {
    if (area < (options.minArea ?? 1)) return;
    const mask = new Uint8Array(W * H);
    for (let k = 0; k < mask.length; k++) mask[k] = islands.labels[k] === i + 1 ? 1 : 0;
    joinCorners(mask, W, H);
    const loop = outerLoop(mask, W, H);
    if (!loop) return;
    const poly = simplify(dropCollinear(loop), options.tolerance ?? 1).map(([x, y]): Point2 => [x + ox, y + oy]);
    out.push({ poly, area: polygonArea(poly) });
  });
  return out.sort((a, b) => b.area - a.area).map((o) => o.poly);
}

/** Fills one background pixel of every 2 × 2 block whose opaque pixels touch only diagonally, until none is left. */
function joinCorners(mask: Uint8Array, W: number, H: number): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (let y = 0; y + 1 < H; y++) {
      for (let x = 0; x + 1 < W; x++) {
        const a = mask[y * W + x], b = mask[y * W + x + 1], c = mask[(y + 1) * W + x], d = mask[(y + 1) * W + x + 1];
        if (a && d && !b && !c) {
          mask[y * W + x + 1] = 1;
          changed = true;
        } else if (b && c && !a && !d) {
          mask[y * W + x] = 1;
          changed = true;
        }
      }
    }
  }
}

/** The counter-clockwise loop of pixel corners around the mask's opaque pixels with the largest area (rows from the top). */
function outerLoop(mask: Uint8Array, W: number, H: number): Point2[] | null {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const next = new Map<number, number>(); // corner → the corner its boundary edge leads to (opaque on the left)
  const id = (x: number, y: number) => y * (W + 1) + x;
  for (let row = 0; row < H; row++) {
    for (let x = 0; x < W; x++) {
      if (!at(x, row)) continue;
      const y = H - 1 - row; // y up: the pixel spans [x, x + 1] × [y, y + 1]
      if (!at(x, row + 1)) next.set(id(x, y), id(x + 1, y)); // bottom
      if (!at(x + 1, row)) next.set(id(x + 1, y), id(x + 1, y + 1)); // right
      if (!at(x, row - 1)) next.set(id(x + 1, y + 1), id(x, y + 1)); // top
      if (!at(x - 1, row)) next.set(id(x, y + 1), id(x, y)); // left
    }
  }
  let best: Point2[] | null = null, bestArea = 0;
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Point2[] = [];
    for (let v: number | undefined = start; v !== undefined && !seen.has(v); v = next.get(v)) {
      seen.add(v);
      loop.push([v % (W + 1), Math.floor(v / (W + 1))]);
    }
    const area = polygonArea(loop);
    if (area > bestArea) {
      best = loop;
      bestArea = area;
    }
  }
  return best;
}

/** The loop without points on the straight line between their neighbours. */
function dropCollinear(loop: readonly Point2[]): Point2[] {
  const out = loop.filter((p, i) => {
    const a = loop[(i + loop.length - 1) % loop.length]!, b = loop[(i + 1) % loop.length]!;
    return (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]) !== 0;
  });
  return out.length >= 3 ? out : [...loop];
}

/** Ramer–Douglas–Peucker over a closed loop, halving the tolerance while the result isn't simple. */
function simplify(loop: readonly Point2[], tolerance: number): Point2[] {
  for (let tol = tolerance; tol >= 0.05; tol /= 2) {
    const s = rdpClosed(loop, tol);
    if (s.length >= 3 && isSimplePolygon(s) && polygonArea(s) > 0) return s;
  }
  return [...loop];
}

function rdpClosed(loop: readonly Point2[], tol: number): Point2[] {
  if (loop.length <= 3 || tol <= 0) return [...loop];
  // Split at point 0 and the point farthest from it.
  let far = 0, fd = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i]![0] - loop[0]![0], loop[i]![1] - loop[0]![1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const first = rdp(loop.slice(0, far + 1), tol);
  const second = rdp([...loop.slice(far), loop[0]!], tol);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function rdp(points: readonly Point2[], tol: number): Point2[] {
  if (points.length <= 2) return [...points];
  const a = points[0]!, b = points[points.length - 1]!;
  let worst = 0, wi = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistance(points[i]!, a, b);
    if (d > worst) {
      worst = d;
      wi = i;
    }
  }
  if (worst <= tol) return [a, b];
  return [...rdp(points.slice(0, wi + 1), tol).slice(0, -1), ...rdp(points.slice(wi), tol)];
}
