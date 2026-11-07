// Internal (ADR 0061): the pure parts of asset thumbnails, unit-tested without WebGL: framing a
// camera on some bounds, a seeded random for repeatable particle frames, and sprite colours.

export interface Bounds {
  min: number[];
  max: number[];
}

/**
 * A camera position looking at `bounds` from `direction` (normalized for you), far enough that
 * the bounds' sphere fills about 85% of a square view with a vertical field of view of `fov`
 * degrees, with near and far planes around it.
 */
export function frameView(bounds: Bounds, fov: number, direction: readonly number[]): { position: [number, number, number]; target: [number, number, number]; near: number; far: number } {
  const center = [0, 1, 2].map((i) => (bounds.min[i] + bounds.max[i]) / 2) as [number, number, number];
  const radius = Math.max(1e-3, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2);
  const len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const dir = [direction[0] / len, direction[1] / len, direction[2] / len];
  const distance = radius / Math.sin(((fov * Math.PI) / 180 / 2) * 0.85);
  return {
    position: [center[0] + dir[0] * distance, center[1] + dir[1] * distance, center[2] + dir[2] * distance],
    target: center,
    near: Math.max(1e-3, distance - radius * 2),
    far: distance + radius * 2,
  };
}

export { seededRandom } from "./particles/random";

/** A scene file's `#rrggbb[aa]` colour as 0xRRGGBB (alpha dropped); white if it isn't one. */
export function colorFromHex(hex: string): number {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  return m ? parseInt(m[1], 16) : 0xffffff;
}

/** An orbit around a point: yaw about +Y, pitch up from the horizon (radians), and a distance. */
export interface Orbit {
  yaw: number;
  pitch: number;
  distance: number;
}

/** How far up or down an orbit may look: just short of straight overhead, so "up" stays defined. */
export const MAX_PITCH = Math.PI / 2 - 0.05;

/** The orbit that puts a camera at `position` looking at `target`. */
export function orbitOf(position: readonly number[], target: readonly number[]): Orbit {
  const x = position[0] - target[0], y = position[1] - target[1], z = position[2] - target[2];
  const distance = Math.max(1e-3, Math.hypot(x, y, z));
  return { yaw: Math.atan2(x, z), pitch: Math.asin(Math.max(-1, Math.min(1, y / distance))), distance };
}

/** The camera position for an orbit around `target`. */
export function orbitPosition(target: readonly number[], o: Orbit): [number, number, number] {
  const c = Math.cos(o.pitch);
  return [target[0] + Math.sin(o.yaw) * c * o.distance, target[1] + Math.sin(o.pitch) * o.distance, target[2] + Math.cos(o.yaw) * c * o.distance];
}

/**
 * `o` turned by `dyaw` and `dpitch` and zoomed by `zoom` (below 1 moves closer), with the pitch
 * kept off the poles and the distance within `minDistance`..`maxDistance`.
 */
export function moveOrbit(o: Orbit, dyaw: number, dpitch: number, zoom: number, minDistance: number, maxDistance: number): Orbit {
  return {
    yaw: o.yaw + dyaw,
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, o.pitch + dpitch)),
    distance: Math.max(minDistance, Math.min(maxDistance, o.distance * (zoom > 0 ? zoom : 1))),
  };
}

/**
 * The pixels a preview draws at for a canvas of `width` x `height`: the same shape, scaled down
 * (both sides by one factor) so neither side exceeds `max`. At least 1 x 1.
 */
export function previewPixels(width: number, height: number, max: number): [number, number] {
  const k = Math.min(1, max / Math.max(width, height, 1));
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}
