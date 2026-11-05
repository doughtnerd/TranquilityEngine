// Bots (server only): each fills a ship's helm fields before the ships sail. A bot hunts the
// nearest ship it can see, turns to bring it abeam, picks the battery on that side and fires when
// the target is lined up and in range. It steers clear of obstacles and the arena edge, and
// wanders when nobody is near.
import { Transform, defineSystem } from "myco";
import { obstacleList } from "./systems";
import { ARENA_RADIUS, BALL_LIFT, BALL_GRAVITY, BALL_SPEED, Battery, Ship, angleDelta, bearing, forward, ships, starboard, type ShipView } from "./data";

/** How far a bot sees, and the range it fires from: about where a ball comes down. */
const SIGHT = 50;
const RANGE = BALL_SPEED * ((2 * BALL_LIFT) / BALL_GRAVITY) * 1.15;
/** Degrees off the beam a bot still fires at. */
const AIM_TOLERANCE = 12;

/** Each bot's wander point, by team. */
const wander = new Map<number, { x: number; z: number }>();

function wanderPoint(team: number, x: number, z: number): { x: number; z: number } {
  let w = wander.get(team);
  if (!w || (w.x - x) ** 2 + (w.z - z) ** 2 < 100) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * ARENA_RADIUS * 0.6;
    w = { x: Math.sin(a) * r, z: Math.cos(a) * r };
    wander.set(team, w);
  }
  return w;
}

defineSystem({
  name: "pirates.Bots",
  phase: "fixedUpdate",
  worlds: ["server"],
  before: ["pirates.Sail"],
  query: [Transform, Ship],
  run(rows, ctx) {
    const all = ships();
    const obstacles = obstacleList(ctx.world);
    for (const row of rows) {
      const ship = row.ship as ShipView;
      if (!ship.bot || ship.sunk > 0) continue;
      const p = row.transform.position;
      const f = forward(ship.heading), s = starboard(ship.heading);

      // The nearest ship that isn't sunk or this one.
      let target: { x: number; z: number; d: number } | null = null;
      for (const other of all) {
        if (other.data.team === ship.team || other.data.sunk > 0 || other.data.invulnerable > 0) continue;
        const o = other.node.transform!.position;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (d < SIGHT && (!target || d < target.d)) target = { x: o.x, z: o.z, d };
      }

      let heading: number;
      ship.fire = 0;
      if (target) {
        const toTarget = bearing(p.x, p.z, target.x, target.z);
        // Which side is the target on? Positive: starboard.
        const side = (target.x - p.x) * s.x + (target.z - p.z) * s.z >= 0 ? Battery.starboard : Battery.port;
        ship.battery = side;
        const beam = toTarget + (side === Battery.starboard ? 90 : -90); // the heading that puts it abeam
        // Close in when far, run parallel when in range.
        heading = target.d > RANGE ? toTarget + (side === Battery.starboard ? 35 : -35) : beam;
        const off = Math.abs(angleDelta(ship.heading, beam));
        const reload = side === Battery.port ? ship.reloadPort : ship.reloadStarboard;
        if (off < AIM_TOLERANCE && target.d < RANGE && reload <= 0) ship.fire = 1;
      } else {
        const w = wanderPoint(ship.team, p.x, p.z);
        heading = bearing(p.x, p.z, w.x, w.z);
      }

      // Turn away from an obstacle ahead, and back toward the middle near the edge.
      for (const o of obstacles) {
        const dx = o.x - p.x, dz = o.z - p.z;
        const ahead = dx * f.x + dz * f.z, across = dx * s.x + dz * s.z;
        if (ahead > 0 && ahead < o.r + 14 && Math.abs(across) < o.r + 3) heading = ship.heading + (across > 0 ? -70 : 70);
      }
      if (Math.hypot(p.x, p.z) > ARENA_RADIUS * 0.85) heading = bearing(p.x, p.z, 0, 0);

      const aim = forward(heading);
      ship.aimX = p.x + aim.x * 20;
      ship.aimZ = p.z + aim.z * 20;
    }
  },
});
