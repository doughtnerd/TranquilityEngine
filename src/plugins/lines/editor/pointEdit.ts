// The maths of editing a line's points in the scene view (ADR 0382), on plain numbers so it's tested without an
// editor: where a pointer ray meets the plane a point moves in, which segment a canvas point is nearest, and
// converting between a line's space (world, or its node's) and the world.

export type V3 = [number, number, number];

/** Where the ray (`origin`, `direction`) meets the plane through `point` with normal `normal`, or null when it runs along it. */
export function rayPlane(origin: readonly number[], direction: readonly number[], point: readonly number[], normal: readonly number[]): V3 | null {
  const denom = direction[0]! * normal[0]! + direction[1]! * normal[1]! + direction[2]! * normal[2]!;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((point[0]! - origin[0]!) * normal[0]! + (point[1]! - origin[1]!) * normal[1]! + (point[2]! - origin[2]!) * normal[2]!) / denom;
  if (t < 0) return null;
  return [origin[0]! + direction[0]! * t, origin[1]! + direction[1]! * t, origin[2]! + direction[2]! * t];
}

/**
 * The segment of a polyline on the canvas (`screen`, a point per vertex, null where off screen) nearest the canvas
 * point (x, y), within `reach` pixels: its first vertex's index and how far along it the nearest point is (0..1);
 * null when none is that close. `closed` adds the segment from the last vertex back to the first.
 */
export function nearestSegment(screen: readonly (readonly [number, number] | null)[], x: number, y: number, reach: number, closed: boolean): { index: number; t: number } | null {
  let best: { index: number; t: number; d: number } | null = null;
  const n = screen.length;
  const count = closed && n > 2 ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = screen[i], b = screen[(i + 1) % n];
    if (!a || !b) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
    const d = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
    if (d <= reach && (!best || d < best.d)) best = { index: i, t, d };
  }
  return best ? { index: best.index, t: best.t } : null;
}

/** A point under a column-major 4×4 matrix. */
export function transformPoint(m: ArrayLike<number>, p: readonly number[]): V3 {
  return [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!];
}

/** The inverse of an affine column-major 4×4 matrix, or null when it's singular (a zero scale). */
export function invertAffine(m: ArrayLike<number>): number[] | null {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[4]!, e = m[5]!, f = m[6]!, g = m[8]!, h = m[9]!, i = m[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  const r = [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k, 0,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k, 0,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k, 0,
    0, 0, 0, 1,
  ];
  const t = transformPoint(r, [m[12]!, m[13]!, m[14]!]);
  r[12] = -t[0];
  r[13] = -t[1];
  r[14] = -t[2];
  return r;
}

/** The point halfway along `t` (0..1) from `a` to `b`. */
export const lerp3 = (a: readonly number[], b: readonly number[], t: number): V3 => [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];

/** Points as scene-file JSON (`[[x, y, z], …]`), each number tidied to 4 decimals. */
export const pointsJson = (points: readonly (readonly number[])[]): number[][] => points.map((p) => [tidy(p[0]!), tidy(p[1]!), tidy(p[2]!)]);

const tidy = (n: number): number => Math.round(n * 1e4) / 1e4;
