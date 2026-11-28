// A shake impulse source's reach as wire rings (ADR 0436 "Editor"): full strength inside `radius`, fading to nothing at
// `radius + dissipationDistance`. Rings are world-space distances (the runtime measures from the node's world position,
// unscaled): circles in the XY plane for a 2D view, spheres as three great circles otherwise.
import { shapeKit3d } from "../../../editor/sdk";

type V3 = shapeKit3d.V3;

export interface ReachRadii {
  /** Full strength within this distance. */
  readonly radius: number;
  /** Strength reaches zero at this distance (`radius + dissipationDistance`). */
  readonly outer: number;
}

/** The two radii a source's fields give, each at least 0. */
export function reachRadii(radius: number, dissipationDistance: number): ReachRadii {
  const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  const d = Number.isFinite(dissipationDistance) ? Math.max(0, dissipationDistance) : 0;
  return { radius: r, outer: r + d };
}

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1];

/** The wire of a ring (2D: an XY circle; 3D: three great circles) of radius `r` around `c`; none when `r` is 0. */
export function ringWire(c: V3, r: number, flat: boolean): V3[][] {
  if (!(r > 0)) return [];
  const n = 64;
  return flat ? [shapeKit3d.circle(c, X, Y, r, 0, Math.PI * 2, n)] : [shapeKit3d.circle(c, X, Y, r, 0, Math.PI * 2, n), shapeKit3d.circle(c, X, Z, r, 0, Math.PI * 2, n), shapeKit3d.circle(c, Y, Z, r, 0, Math.PI * 2, n)];
}
