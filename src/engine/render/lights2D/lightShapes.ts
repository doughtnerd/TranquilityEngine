/**
 * 2D light shapes (ADR 0399), renderer-neutral: how bright each light type is at a point in its node's local XY (the
 * rule the light shaders draw by, and `Light2D.sampleAt` reads on the CPU), the freeform light's mesh, and each light's
 * local bounds for culling. Pure functions over plain numbers; no Babylon (ADR 0010).
 */
import { triangulate, type Point2 } from "../../physics/polygon";

/** A point light's shape fields (Unity's Spot light: a full circle at 360°). Radii in local units, angles in degrees. */
export interface PointShape {
  innerRadius: number;
  outerRadius: number;
  innerAngle: number;
  outerAngle: number;
  falloff: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number) => t * t * (3 - 2 * t);

/** The falloff curve's exponent for `falloff` 0 (linear) … 1 (sharp): `t^exponent` of the linear ramp. */
export const falloffExponent = (falloff: number): number => 1 + clamp01(falloff) * 3;

/**
 * A point light's brightness (0..1) at local (x, y): 1 inside the inner radius and inner cone, 0 past the outer radius
 * or cone, between them the radial ramp to the power of `falloffExponent` times a smoothstep across the cone's edge.
 * The cone points along local +Y.
 */
export function pointAttenuation(s: PointShape, x: number, y: number): number {
  const outer = Math.max(s.outerRadius, 1e-6);
  const inner = Math.min(Math.max(s.innerRadius, 0), outer);
  const d = Math.hypot(x, y);
  if (d >= outer) return 0;
  const radial = d <= inner ? 1 : Math.pow(1 - (d - inner) / (outer - inner), falloffExponent(s.falloff));
  const outerA = Math.min(Math.max(s.outerAngle, 0), 360);
  if (outerA >= 360) return radial;
  const innerA = Math.min(Math.max(s.innerAngle, 0), outerA);
  // The angle from +Y, 0..180 degrees.
  const a = d < 1e-9 ? 0 : (Math.acos(Math.max(-1, Math.min(1, y / d))) * 180) / Math.PI;
  const halfOuter = outerA / 2, halfInner = innerA / 2;
  if (a >= halfOuter) return 0;
  const cone = a <= halfInner ? 1 : smooth(1 - (a - halfInner) / Math.max(halfOuter - halfInner, 1e-6));
  return radial * cone;
}

/** Whether local (x, y) is inside the polygon (even-odd). */
export function insidePolygon(poly: readonly Point2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The distance from (x, y) to the polygon's outline. */
export function distanceToOutline(poly: readonly Point2[], x: number, y: number, closed = true): number {
  let best = Infinity;
  const n = poly.length;
  for (let i = closed ? 0 : 1; i < n; i++) {
    const a = poly[(i + n - 1) % n]!, b = poly[i]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp01(((x - a[0]) * dx + (y - a[1]) * dy) / len2) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)));
  }
  return best;
}

/** A freeform light's brightness at local (x, y): 1 inside its polygon, fading linearly to 0 at `falloffSize` outside. */
export function freeformAttenuation(poly: readonly Point2[], falloffSize: number, x: number, y: number): number {
  if (poly.length < 3) return 0;
  if (insidePolygon(poly, x, y)) return 1;
  if (falloffSize <= 0) return 0;
  return clamp01(1 - distanceToOutline(poly, x, y) / falloffSize);
}

/** A light mesh in local XY: `positions` xy per vertex, `alpha` per vertex (the brightness there), triangle `indices`. */
export interface LightMesh {
  positions: Float32Array;
  alpha: Float32Array;
  indices: Uint32Array;
}

/**
 * The freeform light's mesh: its polygon triangulated at alpha 1, and a band outside it, `falloffSize` wide, from
 * alpha 1 at the outline to 0 (each vertex pushed out along its corner's mitred normal, capped at 4× for sharp corners).
 * Null when the polygon has fewer than three distinct points or can't be triangulated.
 */
export function freeformMesh(shape: readonly Point2[], falloffSize: number): LightMesh | null {
  const poly = dedupe(shape);
  if (poly.length < 3) return null;
  const ccw = signedArea(poly) > 0 ? poly : [...poly].reverse();
  const tris = triangulate(ccw);
  if (!tris) return null;
  const n = ccw.length;
  const band = falloffSize > 0;
  const positions = new Float32Array((band ? 2 * n : n) * 2);
  const alpha = new Float32Array(band ? 2 * n : n);
  ccw.forEach(([x, y], i) => {
    positions[i * 2] = x;
    positions[i * 2 + 1] = y;
    alpha[i] = 1;
  });
  const indices: number[] = [];
  for (const [a, b, c] of tris) indices.push(a, b, c);
  if (band) {
    for (let i = 0; i < n; i++) {
      const p = ccw[(i + n - 1) % n]!, c = ccw[i]!, q = ccw[(i + 1) % n]!;
      // Outward normals of the two edges (counter-clockwise: outward is to the right of the direction).
      const n1 = outward(p, c), n2 = outward(c, q);
      let mx = n1[0] + n2[0], my = n1[1] + n2[1];
      const ml = Math.hypot(mx, my) || 1;
      mx /= ml;
      my /= ml;
      const cos = mx * n1[0] + my * n1[1];
      const scale = Math.min(cos > 1e-3 ? 1 / cos : 4, 4) * falloffSize;
      positions[(n + i) * 2] = c[0] + mx * scale;
      positions[(n + i) * 2 + 1] = c[1] + my * scale;
      alpha[n + i] = 0;
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(i, n + i, n + j, i, n + j, j);
    }
  }
  return { positions, alpha, indices: Uint32Array.from(indices) };
}

/** A local-space box: [minX, minY, maxX, maxY]. */
export type Box2 = [number, number, number, number];

/** A point light's local bounds (its outer circle). */
export const pointBounds = (s: PointShape): Box2 => {
  const r = Math.max(s.outerRadius, 0);
  return [-r, -r, r, r];
};

/** A freeform light's local bounds (its polygon grown by the falloff, with the mitre cap). */
export function freeformBounds(shape: readonly Point2[], falloffSize: number): Box2 {
  let b: Box2 = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of shape) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  if (!Number.isFinite(b[0])) return [0, 0, 0, 0];
  const g = Math.max(falloffSize, 0) * 4;
  return [b[0] - g, b[1] - g, b[2] + g, b[3] + g];
}

function outward(a: Point2, b: Point2): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l];
}

function signedArea(p: readonly Point2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1];
  return a / 2;
}

function dedupe(points: readonly Point2[]): Point2[] {
  const out: Point2[] = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1 && Math.abs(out[0]![0] - out[out.length - 1]![0]) < 1e-9 && Math.abs(out[0]![1] - out[out.length - 1]![1]) < 1e-9) out.pop();
  return out;
}
