/**
 * How a moving emitter of a spatial test scene travels its route over time (ADR 0347): by arc length at its speed, at
 * its height. A route that doesn't loop stops at its last point. A looping route starts over from its first point, and
 * how it gets there decides what Doppler hears:
 *
 * - **A near-closed route** (its last point within `closeWithin` metres of its first, the distance `closeDistance`
 *   gives) travels the gap back to its first point at its speed, so its velocity carries across the wrap. Jumped, a
 *   gap that short reads as one frame of very fast motion to the runtime's velocity estimate (a pitch spike), because
 *   the Doppler pass's teleport guard only sees steps faster than `audio.doppler.maxSpeed`.
 * - **Any other route** jumps back to its first point: a step the teleport guard catches, so its velocity is zero for
 *   the guard's frames and then estimated again (no spike).
 *
 * The place along the route stays the arc-length fraction `u` the scene's `start` and the Spatial view's handles use;
 * while it travels the closing gap, `gap` holds the metres travelled along it.
 *
 * Pure: no engine, no audio.
 */
import { routeLength, routePose } from "./testScene";
import type { Vec3 } from "./testSceneTypes";

/** Where a moving emitter is along its route. */
export interface RouteTravel {
  /** Arc-length fraction of the route, 0..1. */
  u: number;
  /** Metres travelled along a looping route's closing gap (last point back to the first), or null while on the route. */
  gap: number | null;
}

/** The smallest gap that's always travelled rather than jumped when a route loops, m. */
export const ROUTE_CLOSE_METRES = 5;

/**
 * The longest closing gap travelled rather than jumped, for a frame of `dt` seconds and the Doppler pass's teleport
 * speed `maxSpeed` (`audio.doppler.maxSpeed`): at least `ROUTE_CLOSE_METRES`, and twice what the guard would miss.
 */
export function closeDistance(maxSpeed: number, dt: number): number {
  const missed = Number.isFinite(maxSpeed) && maxSpeed > 0 && dt > 0 ? 2 * maxSpeed * dt : 0;
  return Math.max(ROUTE_CLOSE_METRES, missed);
}

/** A route's closing gap on the ground plane: from its last point back to its first, m. */
export function routeGap(route: readonly Vec3[]): number {
  if (route.length < 2) return 0;
  const a = route[route.length - 1]!, b = route[0]!;
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** A travel state at fraction `u` of the route (clamped 0..1). */
export const travelAt = (u: number): RouteTravel => ({ u: Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0, gap: null });

/**
 * Advance `t` by `dt` seconds at `speed` m/s along `route`. A looping route whose gap is at most `closeWithin` metres
 * travels it; one with a longer gap jumps to its first point. A route of zero length, a speed of 0 or a `dt` of 0 stays.
 */
export function advanceRoute(route: readonly Vec3[], speed: number, loop: boolean, t: RouteTravel, dt: number, closeWithin: number): void {
  const length = routeLength(route);
  if (!(length > 0) || !(speed > 0) || !(dt > 0)) return;
  const gap = routeGap(route);
  const travelsGap = loop && gap > 0 && gap <= closeWithin;
  let d = speed * dt;
  if (loop) {
    // Whole laps change nothing: keep the remainder.
    const lap = length + (travelsGap ? gap : 0);
    if (d > lap) d %= lap;
  }
  for (let guard = 0; d > 0 && guard < 4; guard++) {
    if (t.gap !== null) {
      const left = gap - t.gap;
      if (travelsGap && d < left) {
        t.gap += d;
        return;
      }
      d = travelsGap ? d - left : d;
      t.gap = null;
      t.u = 0;
      continue;
    }
    const left = (1 - t.u) * length;
    if (d < left) {
      t.u += d / length;
      return;
    }
    d -= left;
    if (!loop) {
      t.u = 1;
      return;
    }
    if (travelsGap) t.gap = 0;
    else t.u = 0;
  }
}

/** Where `t` puts the emitter (at `height`) and the unit direction it travels. */
export function travelPose(route: readonly Vec3[], height: number, loop: boolean, t: RouteTravel, out: { position: Vec3; direction: Vec3 }): void {
  const gap = routeGap(route);
  if (t.gap === null || !(gap > 0)) {
    routePose(route, height, t.u, loop, out);
    return;
  }
  const a = route[route.length - 1]!, b = route[0]!;
  const f = Math.min(1, Math.max(0, t.gap / gap));
  out.position.x = a.x + (b.x - a.x) * f;
  out.position.y = height;
  out.position.z = a.z + (b.z - a.z) * f;
  out.direction.x = (b.x - a.x) / gap;
  out.direction.y = 0;
  out.direction.z = (b.z - a.z) / gap;
}

/** The speed `t` travels at now, m/s: `speed`, or 0 once a route that doesn't loop has arrived (or it can't move). */
export function travelSpeed(route: readonly Vec3[], speed: number, loop: boolean, t: RouteTravel): number {
  if (!(routeLength(route) > 0) || !(speed > 0)) return 0;
  return !loop && t.gap === null && t.u >= 1 ? 0 : speed;
}
