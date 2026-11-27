// The shapes of the marks ships leave on the sea (seaMarks.ts draws them on the waves): how strongly
// a ship's speed churns the water, a bow wave's V and a stern wake's path. Plain maths: no engine state, no World.

/** Below this speed (m/s) a ship is at rest and leaves no wake or bow wave. */
export const REST_SPEED = 0.5;

/**
 * How strongly a ship sailing at `speed` m/s churns the water, 0 to 1: nothing at rest (at or below
 * `rest`), rising quickly above it (a ship barely under way still leaves a faint mark) and levelling
 * off to 1 at `full` m/s (and staying there beyond it).
 */
export function wakeStrength(speed: number, full: number, rest = REST_SPEED): number {
  if (!(speed > rest) || !(full > rest)) return 0;
  const t = Math.min(1, (speed - rest) / (full - rest));
  return t * (2 - t);
}

/** A point of a stern wake on the water and its age in seconds. */
export interface WakePoint {
  x: number;
  z: number;
  age: number;
}

/**
 * A stern wake's path: the points a ship's stern has passed, newest first, at least `spacing` metres
 * apart, each dropped once it is `life` seconds old (and the oldest past `maxPoints`). The water
 * stays where it is, so a faster ship's wake reaches further behind it.
 */
export class WakePath {
  /** Newest first. */
  readonly points: WakePoint[] = [];

  constructor(
    readonly spacing: number,
    readonly life: number,
    readonly maxPoints: number,
  ) {}

  /**
   * `dt` seconds later, with the stern at (x, z): the points age (the old ones go), and while
   * `laying` (the ship is under way) a new point is laid once the stern is `spacing` from the last.
   */
  step(x: number, z: number, dt: number, laying: boolean): void {
    const pts = this.points;
    for (const p of pts) p.age += dt;
    while (pts.length && pts[pts.length - 1]!.age >= this.life) pts.pop();
    if (!laying) return;
    const last = pts[0];
    if (last && Math.hypot(x - last.x, z - last.z) < this.spacing) return;
    pts.unshift({ x, z, age: 0 });
    if (pts.length > this.maxPoints) pts.length = this.maxPoints;
  }

  /** Forget the path (the ship jumped: it respawned somewhere else). */
  clear(): void {
    this.points.length = 0;
  }
}

/** The bow wave's size and shape. */
export interface BowWaveShape {
  /** Where the stem meets the water, ahead of the ship's middle (m). */
  stem: number;
  /** Each arm's length (m). */
  length: number;
  /** Degrees between each arm and the keel line. */
  spread: number;
  /** Points along each arm after the stem. */
  perArm: number;
}

/**
 * A bow wave's V in the ship's own frame (the bow toward +Z, starboard +X): from the end of the port
 * arm, through the stem, to the end of the starboard arm (`2 * perArm + 1` points). The arms waver a
 * little with `time` (seconds), so the wave seems to curl.
 */
export function bowWave(shape: BowWaveShape, time: number): { x: number; z: number }[] {
  const n = Math.max(1, Math.floor(shape.perArm));
  const a = (shape.spread * Math.PI) / 180;
  const back = Math.cos(a), out = Math.sin(a);
  const arm = (i: number) => {
    const d = (shape.length * i) / n;
    const waver = 1 + 0.06 * Math.sin(time * 2.3 + i * 1.7);
    return { along: shape.stem - d * back, across: d * out * waver };
  };
  const points: { x: number; z: number }[] = [];
  for (let i = n; i >= 1; i--) {
    const p = arm(i);
    points.push({ x: -p.across, z: p.along });
  }
  points.push({ x: 0, z: shape.stem });
  for (let i = 1; i <= n; i++) {
    const p = arm(i);
    points.push({ x: p.across, z: p.along });
  }
  return points;
}
