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

/** A small, fast seeded random (mulberry32), in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A scene file's `#rrggbb[aa]` colour as 0xRRGGBB (alpha dropped); white if it isn't one. */
export function colorFromHex(hex: string): number {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  return m ? parseInt(m[1], 16) : 0xffffff;
}
