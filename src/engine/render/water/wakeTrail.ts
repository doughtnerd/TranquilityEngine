/**
 * Wake trails (ADR 0459): the path a wake's stern has passed and how strongly a moving node churns
 * the water. Plain maths, no World or renderer: `wakes.ts` drives it, its tests drive it directly.
 */

/** Below this speed (m/s) a node is at rest and leaves no wake. */
export const WAKE_REST_SPEED = 0.5;

/**
 * How strongly a node moving at `speed` m/s churns the water, 0 to 1: nothing at or below `rest`,
 * rising quickly above it (a boat barely under way still leaves a faint mark) and levelling off at 1
 * from `full` m/s.
 */
export function wakeStrength(speed: number, full: number, rest = WAKE_REST_SPEED): number {
  if (!(speed > rest) || !(full > rest)) return 0;
  const t = Math.min(1, (speed - rest) / (full - rest));
  return t * (2 - t);
}

/** A point of a trail on the water: where, its age in seconds and the strength it was laid at. */
export interface WakePoint {
  x: number;
  z: number;
  age: number;
  strength: number;
}

/**
 * A trail: the points a stern has passed, newest first, at least `spacing` metres apart, each dropped
 * once it is `life` seconds old (and the oldest past `maxPoints`). The water stays where it is, so a
 * faster boat's trail reaches further behind it, and a turning boat's trail bends.
 */
export class WakePath {
  /** Newest first. */
  readonly points: WakePoint[] = [];

  constructor(
    public spacing: number,
    public life: number,
    readonly maxPoints: number,
  ) {}

  /**
   * `dt` seconds later, with the stern at (x, z): the points age (the old ones go), and while
   * `strength` > 0 a new point is laid once the stern is `spacing` from the last.
   */
  step(x: number, z: number, dt: number, strength: number): void {
    const pts = this.points;
    for (const p of pts) p.age += dt;
    while (pts.length && pts[pts.length - 1]!.age >= this.life) pts.pop();
    if (!(strength > 0)) return;
    const last = pts[0];
    if (last && Math.hypot(x - last.x, z - last.z) < this.spacing) {
      last.strength = Math.max(last.strength, strength);
      return;
    }
    pts.unshift({ x, z, age: 0, strength });
    if (pts.length > this.maxPoints) pts.length = this.maxPoints;
  }

  /** Forget the path (the node jumped: it respawned somewhere else). */
  clear(): void {
    this.points.length = 0;
  }
}
