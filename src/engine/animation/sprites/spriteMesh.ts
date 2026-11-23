/**
 * A slice's skin mesh (ADR 0371 "2D bones"): the slice's opaque outline (`outline.ts`), its long edges split so no
 * triangle is a sliver, plus interior points on a grid, triangulated (`triangulate.ts`). Without pixels (or when the
 * slice has nothing opaque) the slice's rectangle is meshed the same way. What the editor's tools (0373, T56) write
 * into the sidecar's `skin.mesh`, and what the runtime draws when a skin has no mesh.
 *
 * Vertices are in the slice's frame (pixels; x right from the rect's left edge, y up from its bottom edge). Pure; no
 * DOM. Internal: not public API.
 */
import type { PixelRect, Pixels } from "./islands";
import { sliceOutlines, type OutlineOptions } from "./outline";
import type { SpriteMesh } from "./sidecar";
import { interiorPoints, triangulatePolygon, type Point2 } from "./triangulate";

/** @internal How a mesh is made. */
export interface SpriteMeshOptions extends OutlineOptions {
  /** Interior points' grid step and the longest outline edge, in pixels (default: an eighth of the rect's longer side, at least 4). */
  readonly spacing?: number;
}

const defaultSpacing = (w: number, h: number) => Math.max(4, Math.max(w, h) / 8);

/** `poly` with every edge longer than `spacing` split into equal parts. */
function subdivide(poly: readonly Point2[], spacing: number): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const parts = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
    for (let k = 0; k < parts; k++) out.push([a[0] + ((b[0] - a[0]) * k) / parts, a[1] + ((b[1] - a[1]) * k) / parts]);
  }
  return out;
}

/** The polygons meshed into one: each one's points and triangles appended. */
function meshPolygons(polys: readonly Point2[][], spacing: number): SpriteMesh {
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (const poly of polys) {
    const outline = subdivide(poly, spacing);
    const t = triangulatePolygon(outline, interiorPoints(outline, spacing));
    const base = vertices.length / 2;
    for (const [x, y] of t.points) vertices.push(x, y);
    for (const i of t.triangles) triangles.push(base + i);
  }
  return { vertices, triangles };
}

/** @internal The slice `width` × `height` pixels as a mesh: its rectangle, edges split and a grid inside. */
export function rectMesh(width: number, height: number, spacing = defaultSpacing(width, height)): SpriteMesh {
  return meshPolygons([[[0, 0], [width, 0], [width, height], [0, height]]], spacing);
}

/**
 * @internal The mesh of the slice `rect` (image pixels, top-left origin) of `pixels`: each island of opaque pixels'
 * outline with interior points, triangulated; the rectangle when nothing is opaque.
 */
export function outlineMesh(pixels: Pixels, rect: PixelRect, options: SpriteMeshOptions = {}): SpriteMesh {
  const spacing = options.spacing ?? defaultSpacing(rect[2], rect[3]);
  const outlines = sliceOutlines(pixels, rect, options);
  return outlines.length ? meshPolygons(outlines, spacing) : rectMesh(rect[2], rect[3], spacing);
}
