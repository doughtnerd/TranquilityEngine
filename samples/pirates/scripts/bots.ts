// Bots (server only): each fills a ship's helm fields before the ships sail. A bot goes for the
// flag when it's free, hunts whoever holds it, and runs while it holds it itself. It turns to
// bring a target abeam, picks the battery on that side and fires when the target is lined up and
// in range. It grabs power-ups it passes near, steers clear of obstacles and the arena edge, and
// wanders when there's nothing to do. What it can tell follows awareness.ts: it can't see ships
// inside others' fog clouds, spots a ghost ship only close by, and knows where the flag's holder is
// only when a captain's minimap would show it or it spots the holder itself. Route-finding around
// obstacles is `steer` (navigation.ts swaps in navmesh paths when the arena has one).
import { GameObject, Replicated, Transform, defineSystem } from "myco";
import { botSpots, flagChartedBy, type SeaShip } from "./awareness";
import { BALL_GRAVITY, BALL_LIFT, BALL_SPEED, Battery, Pickup, Ship, angleDelta, bearing, cloudSpots, flag, forward, ships, starboard, type ShipView } from "./data";
import { arenaRadius, obstacleList } from "./systems";

/** The range a bot fires from: about where a ball comes down. */
const RANGE = BALL_SPEED * ((2 * BALL_LIFT) / BALL_GRAVITY) * 1.15;
/** Degrees off the beam a bot still fires at. */
const AIM_TOLERANCE = 12;
/** A bot detours for a power-up this close. */
const PICKUP_SIGHT = 22;

/** Each bot's wander point, by team. */
const wander = new Map<number, { x: number; z: number }>();

function wanderPoint(team: number, x: number, z: number): { x: number; z: number } {
  let w = wander.get(team);
  if (!w || (w.x - x) ** 2 + (w.z - z) ** 2 < 100) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * arenaRadius() * 0.6;
    w = { x: Math.sin(a) * r, z: Math.cos(a) * r };
    wander.set(team, w);
  }
  return w;
}

/**
 * The heading a bot takes toward (tx, tz): straight there, unless an obstacle blocks the line, then
 * along the tangent that passes it on the side nearer the goal's bearing (checked again against
 * the next obstacle). Inside an obstacle's margin it backs straight away. Stable from tick to tick,
 * since it depends on where the goal is, not on the current heading. navigation.ts swaps in
 * navmesh paths.
 */
export type Steer = (world: object, team: number, x: number, z: number, tx: number, tz: number, heading: number) => number;
const MARGIN = 3.5;
const LOOKAHEAD = 30;
const avoid: Steer = (world, _team, x, z, tx, tz) => {
  const obstacles = obstacleList(world);
  for (const o of obstacles) {
    const d = Math.hypot(o.x - x, o.z - z);
    if (d < o.r + 1.5) return bearing(o.x, o.z, x, z);
  }
  let want = bearing(x, z, tx, tz);
  const reach = Math.min(LOOKAHEAD, Math.hypot(tx - x, tz - z));
  for (let pass = 0; pass < 3; pass++) {
    const f = forward(want), s = starboard(want);
    let block: { x: number; z: number; r: number; ahead: number } | null = null;
    for (const o of obstacles) {
      const dx = o.x - x, dz = o.z - z;
      const ahead = dx * f.x + dz * f.z, across = dx * s.x + dz * s.z;
      if (ahead <= 0 || ahead > reach + o.r || Math.abs(across) > o.r + MARGIN) continue;
      if (!block || ahead < block.ahead) block = { ...o, ahead };
    }
    if (!block) break;
    const d = Math.hypot(block.x - x, block.z - z);
    const to = bearing(x, z, block.x, block.z);
    const half = (Math.asin(Math.min(1, (block.r + MARGIN) / d)) * 180) / Math.PI + 4;
    const left = to - half, right = to + half;
    want = Math.abs(angleDelta(left, want)) < Math.abs(angleDelta(right, want)) ? left : right;
  }
  return want;
};
let steer: Steer = avoid;
export function setSteer(next: Steer | null): void {
  steer = next ?? avoid;
}
/** The plain obstacle-avoiding steer, for a navmesh steer to fall back on. */
export const avoidObstacles = avoid;

defineSystem({
  name: "pirates.Bots",
  phase: "fixedUpdate",
  worlds: ["server"],
  before: ["pirates.Sail"],
  query: [Transform, Ship],
  run(rows, ctx) {
    const all = ships();
    const theFlag = flag();
    const holder = theFlag ? theFlag.data.carrier : -1;
    const pickups: { x: number; z: number }[] = [];
    for (const rep of GameObject.findObjectsOfType(Replicated)) if (rep.node.isValid && rep.node.hasData(Pickup)) pickups.push(rep.node.transform!.position);
    const clouds = cloudSpots();
    const sea: SeaShip[] = all.map((o) => {
      const q = o.node.transform!.position;
      return { team: o.data.team, x: q.x, z: q.z, sunk: o.data.sunk > 0, mine: false, ghost: o.data.ghost > 0 };
    });
    for (const row of rows) {
      const ship = row.ship as ShipView;
      if (!ship.bot || ship.sunk > 0) continue;
      const p = row.transform.position;
      const s = starboard(ship.heading);

      // Who to shoot: the flag's holder if it spots it, else the nearest ship it spots.
      let target: { x: number; z: number; d: number; holder: boolean } | null = null;
      for (let i = 0; i < all.length; i++) {
        const other = all[i], o = sea[i];
        if (other.data.team === ship.team || other.data.sunk > 0 || other.data.invulnerable > 0) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (!botSpots(ship.team, o, clouds, d)) continue;
        const isHolder = other.data.team === holder;
        if (!target || (isHolder && !target.holder) || (d < target.d && target.holder === isHolder)) target = { x: o.x, z: o.z, d, holder: isHolder };
      }

      // Where to go: the free flag, away while holding it, a nearby power-up, the target, the flag's
      // holder if it knows where that is, or anywhere.
      const f = theFlag?.node.transform!.position;
      const knowsFlag = !!f && (holder < 0 || !!flagChartedBy(ship.team, { x: f.x, z: f.z, carrier: holder }, sea, clouds));
      let goal: { x: number; z: number };
      if (f && holder < 0) goal = { x: f.x, z: f.z };
      else if (holder === ship.team) goal = wanderPoint(ship.team, p.x, p.z);
      else {
        const near = pickups.find((q) => Math.hypot(q.x - p.x, q.z - p.z) < PICKUP_SIGHT);
        goal = near ? { x: near.x, z: near.z } : target ? { x: target.x, z: target.z } : f && knowsFlag ? { x: f.x, z: f.z } : wanderPoint(ship.team, p.x, p.z);
      }

      ship.fire = 0;
      if (target) {
        const toTarget = bearing(p.x, p.z, target.x, target.z);
        const side = (target.x - p.x) * s.x + (target.z - p.z) * s.z >= 0 ? Battery.starboard : Battery.port;
        ship.battery = side;
        const beam = toTarget + (side === Battery.starboard ? 90 : -90); // the heading that puts it abeam
        // Hunting (rather than racing for the free flag or running with it): run parallel once in range,
        // steering for a point ahead on that course like any other goal, so it doesn't run onto a rock.
        if (holder >= 0 && holder !== ship.team && target.d < RANGE) {
          const b = forward(beam);
          goal = { x: p.x + b.x * 20, z: p.z + b.z * 20 };
        }
        const off = Math.abs(angleDelta(ship.heading, beam));
        const reload = side === Battery.port ? ship.reloadPort : ship.reloadStarboard;
        if (off < AIM_TOLERANCE && target.d < RANGE && reload <= 0) ship.fire = 1;
        // A ghost holding the flag drops its cloud when someone's close (a bot's drop is "fire" while it has a cloud).
        if (ship.cloud && holder === ship.team && target.d < 25) ship.fire = 1;
      }
      let heading = steer(ctx.world, ship.team, p.x, p.z, goal.x, goal.z, ship.heading);

      if (Math.hypot(p.x, p.z) > arenaRadius() * 0.85) heading = bearing(p.x, p.z, 0, 0);
      const aim = forward(heading);
      ship.aimX = p.x + aim.x * 20;
      ship.aimZ = p.z + aim.z * 20;
    }
  },
});
