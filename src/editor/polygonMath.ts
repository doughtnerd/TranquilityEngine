// Polygon tests in the XY plane, for viewport picking (ADR 0022): a click inside an outline a viewport
// tool marks selectable (`ViewportToolContext.selectable`, ADR 0142) picks its node, smallest first.

/** Whether `p` is inside the polygon `points` (XY; z ignored). */
export function pointInPolygon(p: readonly [number, number, ...number[]], points: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Area of the polygon `points` in the XY plane. */
export function polygonArea(points: readonly (readonly number[])[]): number {
  let twice = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) twice += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return Math.abs(twice) / 2;
}
