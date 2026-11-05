// Bots' route-finding on the arena's navmesh (ADR 0065, 0070). Each arena scene has a NavChunk baked
// (`npm run nav:bake -- samples/pirates`) from an invisible disc of sailable water (a MeshCollider marked
// NavSurface) with the rocks, islands and wreck carved out (each obstacle prefab has a "Nav Footprint":
// a flat cylinder MeshCollider the size of its `pirates.Obstacle` circle, marked NavObstacle, low
// enough that the water inside it has no headroom and isn't walkable), for the project's
// "Ship" agent type: radius 2, a ship's collision circle plus a voxel of slack. Navigation runs on the
// server World only, which is where bots run.
//
// Ships aren't NavAgents: the predicted `pirates.Sail` system moves them from their helm. So a bot
// plans with `Navigation.findPath` and steers its helm along the path: toward the farthest point a
// short way ahead on it (about a turning circle) that it can sail to in a straight line, and whose arc,
// sailed the way `pirates.Sail` turns a ship, stays off the rocks. It plans again every so often, when
// its goal moves, or when it's pushed off the path. Fog clouds carry a NavCostVolume, so the paths,
// and with them the bots, go round a cloud when there's a reasonable way round.
//
// With no navmesh (a scene without a bake) or no path, it falls back to `avoidObstacles`.
import { Navigation } from "myco";
import { SHIP_RADIUS, SHIP_SPEED, SHIP_TURN_RATE, angleDelta, bearing } from "./data";
import { avoidObstacles, setSteer, type Steer } from "./bots";
import { obstacleList } from "./systems";

/** The agent type the arenas are baked for (project.json → navigation). */
export const SHIP_AGENT = "Ship";
/** Steps (fixed updates) between timed replans: about 0.75 s, so a new fog cloud is seen soon. */
const REPLAN_STEPS = 45;
/** Steps before trying again after finding no path. */
const RETRY_STEPS = 30;
/** Replan when the goal has moved this far (or this fraction of the way to it, if more) from where the path ends. */
const GOAL_MOVED = 4;
const GOAL_MOVED_FRACTION = 0.15;
/** Replan when the ship is this far off its path (pushed by a collision, or just respawned). */
const OFF_PATH = 7;
/**
 * How far ahead along the path a bot aims. A ship turns at 65°/s at up to 9 m/s, a circle of about
 * 8 m radius (half that while turning hard, as it slows), so it aims about a turning radius ahead.
 */
const LOOKAHEAD = 10;
/** Spacing of the points tried along the path for the aim. */
const SAMPLE = 1.5;
/** Clearance a straight run to the aim point keeps from obstacles, past touching. */
const LINE_MARGIN = 0.4;
/** Corners are pushed out to this clearance from the obstacle they round, past touching, where there's room. */
const CORNER_MARGIN = 1.0;

interface Plan {
  /** The path, flat on the water (x, z). */
  points: { x: number; z: number }[];
  /** The segment the ship was last on: points[seg] to points[seg + 1]. */
  seg: number;
  /** Where the bot was heading when it planned. */
  goalX: number;
  goalZ: number;
  /** Steps until the next timed replan (or retry, when `points` is empty). */
  timer: number;
  ok: boolean;
}

const plans = new WeakMap<object, Map<number, Plan>>();

/** Planning counters, per World, for tests and debugging. */
export const navStats = new WeakMap<object, { plans: number; fallbacks: number }>();

function statsOf(world: object) {
  let s = navStats.get(world);
  if (!s) navStats.set(world, (s = { plans: 0, fallbacks: 0 }));
  return s;
}

type Circle = { x: number; z: number; r: number };

/** True if the segment a-b passes within `pad` of an obstacle's circle (plus a ship's radius). */
function blocked(ax: number, az: number, bx: number, bz: number, obstacles: readonly Circle[], pad: number): boolean {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  for (const o of obstacles) {
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((o.x - ax) * dx + (o.z - az) * dz) / len2)) : 0;
    const px = ax + dx * t - o.x, pz = az + dz * t - o.z;
    const r = o.r + SHIP_RADIUS + pad;
    if (px * px + pz * pz < r * r) return true;
  }
  return false;
}

/**
 * The navmesh path's corners hug the carved edge, a ship's width from the rock. Push each inner corner
 * out from the nearest obstacle to a little more clearance, unless that would bring it near another.
 */
function easeCorners(points: { x: number; z: number }[], obstacles: readonly Circle[]): void {
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    let near: Circle | null = null, nearGap = Infinity;
    for (const o of obstacles) {
      const gap = Math.hypot(p.x - o.x, p.z - o.z) - o.r;
      if (gap < nearGap) (nearGap = gap), (near = o);
    }
    const want = SHIP_RADIUS + CORNER_MARGIN;
    if (!near || nearGap >= want) continue;
    const d = Math.hypot(p.x - near.x, p.z - near.z) || 1;
    const q = { x: near.x + ((p.x - near.x) / d) * (near.r + want), z: near.z + ((p.z - near.z) / d) * (near.r + want) };
    const clear = obstacles.every((o) => o === near || Math.hypot(q.x - o.x, q.z - o.z) >= o.r + want);
    if (clear) points[i] = q;
  }
}

function plan(world: object, x: number, z: number, tx: number, tz: number, p: Plan): void {
  const stats = statsOf(world);
  stats.plans++;
  p.goalX = tx;
  p.goalZ = tz;
  p.seg = 0;
  const path = Navigation.findPath([x, 0, z], [tx, 0, tz], SHIP_AGENT);
  if (path.status === "none") {
    p.points = [];
    p.ok = false;
    p.timer = RETRY_STEPS;
    return;
  }
  p.points = path.waypoints.map((w) => ({ x: w.position.x, z: w.position.z }));
  if (p.points.length < 2) p.points = [{ x, z }, { x: tx, z: tz }]; // already there
  p.points[0] = { x, z };
  easeCorners(p.points, obstacleList(world));
  p.ok = true;
  p.timer = REPLAN_STEPS;
}

/** The nearest point to (x, z) on segment i of the path, and its distance. */
function onSegment(points: { x: number; z: number }[], i: number, x: number, z: number): { t: number; d: number } {
  const a = points[i], b = points[i + 1];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
  return { t, d: Math.hypot(a.x + dx * t - x, a.z + dz * t - z) };
}

/** The navmesh steer: follows a planned path, or falls back to `avoidObstacles`. */
export const navSteer: Steer = (world, team, x, z, tx, tz, heading) => {
  if (!Navigation.isReady || Navigation.loadedChunks.length === 0) return avoidObstacles(world, team, x, z, tx, tz, heading);
  let byTeam = plans.get(world);
  if (!byTeam) plans.set(world, (byTeam = new Map()));
  let p = byTeam.get(team);
  if (!p) byTeam.set(team, (p = { points: [], seg: 0, goalX: tx, goalZ: tz, timer: 0, ok: false }));

  const toGoal = Math.hypot(tx - x, tz - z);
  const moved = Math.hypot(tx - p.goalX, tz - p.goalZ);
  p.timer--;
  if (p.timer <= 0 || (p.ok && moved > Math.max(GOAL_MOVED, toGoal * GOAL_MOVED_FRACTION))) plan(world, x, z, tx, tz, p);

  // Where the ship is along the path: the nearest of this segment and the next two.
  if (p.ok) {
    let best = { i: p.seg, t: 0, d: Infinity };
    for (let i = p.seg; i < Math.min(p.points.length - 1, p.seg + 3); i++) {
      const s = onSegment(p.points, i, x, z);
      if (s.d < best.d) best = { i, t: s.t, d: s.d };
    }
    p.seg = best.i;
    if (best.d > OFF_PATH) plan(world, x, z, tx, tz, p);
  }
  if (!p.ok) {
    statsOf(world).fallbacks++;
    return avoidObstacles(world, team, x, z, tx, tz, heading);
  }

  // The points a short way ahead on the path the ship could sail to in a straight line, nearest first.
  const obstacles = obstacleList(world);
  const pts = p.points;
  const s = onSegment(pts, p.seg, x, z);
  let ax = pts[p.seg].x + (pts[p.seg + 1].x - pts[p.seg].x) * s.t;
  let az = pts[p.seg].z + (pts[p.seg + 1].z - pts[p.seg].z) * s.t;
  const candidates: { x: number; z: number }[] = [];
  let travelled = 0;
  for (let i = p.seg; i < pts.length - 1 && travelled < LOOKAHEAD; i++) {
    const bx = pts[i + 1].x, bz = pts[i + 1].z;
    const len = Math.hypot(bx - ax, bz - az);
    let stop = false;
    for (let d = Math.min(SAMPLE, len); ; d = Math.min(d + SAMPLE, len)) {
      const qx = ax + ((bx - ax) * d) / (len || 1), qz = az + ((bz - az) * d) / (len || 1);
      if (travelled + d > LOOKAHEAD || blocked(x, z, qx, qz, obstacles, LINE_MARGIN)) {
        stop = true;
        break;
      }
      candidates.push({ x: qx, z: qz });
      if (d >= len) break;
    }
    if (stop) break;
    travelled += len;
    ax = bx;
    az = bz;
  }
  // At the end of the path, head for the goal itself if it's in the clear (it may be past where the path stops).
  const end = pts[pts.length - 1];
  if (Math.hypot(end.x - x, end.z - z) < LOOKAHEAD && !blocked(x, z, tx, tz, obstacles, LINE_MARGIN)) candidates.push({ x: tx, z: tz });
  if (candidates.length === 0) candidates.push(pts[p.seg + 1]);

  // A ship can't turn on the spot: aim at the farthest of them it can turn toward and reach without its
  // arc running onto a rock, or failing that, the one whose arc keeps farthest from them.
  let aim = candidates[0], best = -Infinity;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const gap = arcClearance(x, z, heading, candidates[i], obstacles);
    if (gap > SWEEP_MARGIN) {
      aim = candidates[i];
      break;
    }
    if (gap > best) (best = gap), (aim = candidates[i]);
  }
  return angleDelta(bearing(x, z, aim.x, aim.z), 0);
};

/** Seconds of sailing `arcClearance` looks ahead, and its time step. */
const SWEEP_SECONDS = 2;
const SWEEP_STEP = 0.1;
/** The clearance (past touching) a ship's predicted arc must keep. */
const SWEEP_MARGIN = 0.3;

/**
 * Sails a ship from (x, z) on `heading` toward `aim` the way `pirates.Sail` does (turning at its rate, at
 * full sail, the widest arc) for a couple of seconds, and returns the least clearance between its circle
 * and an obstacle's on the way.
 */
function arcClearance(x: number, z: number, heading: number, aim: { x: number; z: number }, obstacles: readonly Circle[]): number {
  let px = x, pz = z, h = heading, gap = Infinity;
  const turnStep = SHIP_TURN_RATE * SWEEP_STEP;
  for (let t = 0; t < SWEEP_SECONDS; t += SWEEP_STEP) {
    const dx = aim.x - px, dz = aim.z - pz;
    if (dx * dx + dz * dz < 4) break;
    const turn = angleDelta(bearing(px, pz, aim.x, aim.z), h);
    h += Math.max(-turnStep, Math.min(turnStep, turn));
    const v = SHIP_SPEED * (1 - 0.5 * Math.min(1, Math.abs(turn) / 90));
    const r = (h * Math.PI) / 180;
    px += Math.sin(r) * v * SWEEP_STEP;
    pz += Math.cos(r) * v * SWEEP_STEP;
    for (const o of obstacles) gap = Math.min(gap, Math.hypot(px - o.x, pz - o.z) - o.r - SHIP_RADIUS);
  }
  return gap;
}

/** The current path of a bot (by team) in a World, for tests and debug drawing. */
export function botPath(world: object, team: number): readonly { x: number; z: number }[] {
  const p = plans.get(world)?.get(team);
  return p?.ok ? p.points : [];
}

setSteer(navSteer);
