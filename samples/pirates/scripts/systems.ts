// The simulation (ADR 0017, 0033). What runs where:
// - client and server: the predicted sailing system (a client runs it only for its own ship,
//   ahead of the server, and again after a correction);
// - the server only: a ship per connection plus bots, broadsides, cannonballs and hits,
//   collisions, the arena edge, sinking and respawning.
import { Connection, ConnectionState, GameObject, Mathf, Quaternion, Replicated, Transform, Water, defineSystem } from "myco";
import { Actors } from "./behaviors/Actors";
import {
  ARENA_RADIUS,
  BALL_DAMAGE,
  BALL_GRAVITY,
  BALL_LIFT,
  BALL_PREFAB,
  BALL_RADIUS,
  BALL_SPEED,
  BROADSIDE,
  Ball,
  Battery,
  Fx,
  FxKind,
  HULL_HALF_LENGTH,
  HULL_HALF_WIDTH,
  Helm,
  OUTSIDE_DAMAGE,
  Obstacle,
  PROTOTYPE_SHIPS,
  RAM_DAMAGE,
  RELOAD,
  RESPAWN_DELAY,
  SHIP_ACCEL,
  SHIP_HP,
  SHIP_PREFAB,
  SHIP_RADIUS,
  SHIP_SPEED,
  SHIP_TURN_RATE,
  SPAWN_INVULNERABLE,
  Ship,
  angleDelta,
  bearing,
  forward,
  ships,
  starboard,
  type BallView,
  type ObstacleView,
  type ShipInfo,
  type ShipView,
} from "./data";

/** Where ships start and respawn: a ring facing the middle. */
function spawnPoint(slot: number, count = 8): { x: number; z: number; heading: number } {
  const a = (slot / count) * Math.PI * 2 + 0.3;
  const r = ARENA_RADIUS * 0.7;
  const x = Math.sin(a) * r, z = Math.cos(a) * r;
  return { x, z, heading: bearing(x, z, 0, 0) + 90 };
}

/** The helm a ship sails by this tick: its owner's input, or a bot's own fields. */
function helmOf(node: GameObject, ship: ShipView): { x: number; z: number; steer: boolean; battery: number; fire: boolean } | null {
  if (ship.bot) return { x: ship.aimX, z: ship.aimZ, steer: true, battery: ship.battery, fire: ship.fire !== 0 };
  const input = Helm.of(node);
  if (!input) return null;
  return { x: input.x, z: input.z, steer: input.steer !== 0, battery: input.battery, fire: input.fire !== 0 };
}

// --- client and server -----------------------------------------------------------------------------

/**
 * Sails ships toward their helm's point: turn toward it at `SHIP_TURN_RATE`, slow down while
 * turning hard, and move along the heading. Deterministic and touches only predicted values
 * (the transform, `heading`, `speed`), so the owner can predict it.
 */
defineSystem({
  name: "pirates.Sail",
  phase: "fixedUpdate",
  predicted: true,
  worlds: ["client", "server"],
  query: [Transform, Ship],
  run(rows, ctx) {
    for (const row of rows) {
      const ship = row.ship as ShipView;
      const p = row.transform.position;
      if (ship.sunk > 0) {
        ship.speed = 0;
        continue;
      }
      const helm = helmOf(row.node, ship);
      let wanted = SHIP_SPEED;
      if (helm?.steer) {
        const dx = helm.x - p.x, dz = helm.z - p.z;
        if (dx * dx + dz * dz > 4) {
          const turn = angleDelta(bearing(p.x, p.z, helm.x, helm.z), ship.heading);
          const step = SHIP_TURN_RATE * ctx.dt;
          ship.heading = angleDelta(ship.heading + Mathf.clamp(turn, -step, step), 0);
          wanted = SHIP_SPEED * (1 - 0.5 * Math.min(1, Math.abs(turn) / 90));
        }
      }
      ship.speed += Mathf.clamp(wanted - ship.speed, -SHIP_ACCEL * ctx.dt, SHIP_ACCEL * ctx.dt);
      const f = forward(ship.heading);
      p.x += f.x * ship.speed * ctx.dt;
      p.z += f.z * ship.speed * ctx.dt;
      row.transform.rotation = Quaternion.fromEuler(0, ship.heading, 0);
    }
  },
});

// --- server ----------------------------------------------------------------------------------------

/** Lowest team slot no ship has. */
function freeTeam(all: readonly ShipInfo[]): number {
  for (let t = 0; t < 8; t++) if (!all.some((s) => s.data.team === t)) return t;
  return 0;
}

function placeAtSpawn(node: GameObject, ship: ShipView): void {
  const s = spawnPoint(ship.team);
  node.transform!.position.set(s.x, 0, s.z);
  node.transform!.rotation = Quaternion.fromEuler(0, s.heading, 0);
  ship.heading = angleDelta(s.heading, 0);
  ship.speed = 0;
  ship.hp = SHIP_HP;
  ship.sunk = 0;
  ship.invulnerable = SPAWN_INVULNERABLE;
  ship.reloadPort = 0;
  ship.reloadStarboard = 0;
}

function spawnShip(parent: GameObject, owner: number, bot: boolean, team: number): void {
  const node = GameObject.instantiate(SHIP_PREFAB, { parent });
  const rep = node.getBehavior(Replicated)!;
  rep.ownerId = owner;
  rep.mode = owner ? "predicted" : "interpolated";
  const ship = node.getData(Ship) as ShipView;
  ship.team = team;
  ship.bot = bot ? 1 : 0;
  ship.battery = Battery.starboard;
  placeAtSpawn(node, ship);
}

/**
 * A ship for each open connection, removed when the connection goes, and bots so there are
 * `PROTOTYPE_SHIPS` in all (a bot leaves when a player needs its place). Ships spawn under the
 * scene's `Actors` node, so they wait for the scene.
 */
defineSystem({
  name: "pirates.SpawnShips",
  phase: "update",
  worlds: ["server"],
  query: [Connection],
  run(rows) {
    const actors = GameObject.findObjectOfType(Actors)?.node;
    if (!actors) return;
    const open = new Set<number>();
    for (const row of rows) {
      const c = row.connection as { id: number; state: number };
      if (c.state === ConnectionState.open) open.add(c.id);
    }
    let all = ships();
    for (const s of all) if (!s.data.bot && !open.has(s.rep.ownerId)) GameObject.destroy(s.node);
    all = all.filter((s) => s.node.isValid && (s.data.bot || open.has(s.rep.ownerId)));
    for (const id of open) {
      if (all.some((s) => !s.data.bot && s.rep.ownerId === id)) continue;
      const bot = all.find((s) => s.data.bot);
      const team = bot ? bot.data.team : freeTeam(all);
      if (bot) {
        GameObject.destroy(bot.node);
        all = all.filter((s) => s !== bot);
      }
      spawnShip(actors, id, false, team);
      all = ships().filter((s) => s.node.isValid);
    }
    // Bots only once someone is playing, so an empty server stays idle.
    if (open.size === 0) return;
    for (let n = all.length; n < PROTOTYPE_SHIPS; n++) {
      spawnShip(actors, 0, true, freeTeam(all));
      all = ships().filter((s) => s.node.isValid);
    }
  },
});

/** Picks the battery and fires a broadside when fire is held and that battery is loaded. */
defineSystem({
  name: "pirates.Fire",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["pirates.Sail"],
  query: [Transform, Ship],
  run(rows, ctx) {
    const shots: { x: number; z: number; vx: number; vz: number; shooter: number; parent: GameObject | null }[] = [];
    for (const row of rows) {
      const ship = row.ship as ShipView;
      ship.reloadPort = Math.max(0, ship.reloadPort - ctx.dt);
      ship.reloadStarboard = Math.max(0, ship.reloadStarboard - ctx.dt);
      ship.invulnerable = Math.max(0, ship.invulnerable - ctx.dt);
      if (ship.sunk > 0) continue;
      const helm = helmOf(row.node, ship);
      if (!helm) continue;
      if (helm.battery === Battery.port || helm.battery === Battery.starboard) ship.battery = helm.battery;
      if (!helm.fire) continue;
      const port = ship.battery === Battery.port;
      if ((port ? ship.reloadPort : ship.reloadStarboard) > 0) continue;
      if (port) ship.reloadPort = RELOAD;
      else ship.reloadStarboard = RELOAD;
      const p = row.transform.position;
      const f = forward(ship.heading), s = starboard(ship.heading);
      const side = port ? -1 : 1;
      for (let i = 0; i < BROADSIDE; i++) {
        const along = (i - (BROADSIDE - 1) / 2) * 1.1;
        shots.push({
          x: p.x + f.x * along + s.x * side * (HULL_HALF_WIDTH + 0.2),
          z: p.z + f.z * along + s.z * side * (HULL_HALF_WIDTH + 0.2),
          vx: s.x * side * BALL_SPEED + f.x * ship.speed,
          vz: s.z * side * BALL_SPEED + f.z * ship.speed,
          shooter: ship.team,
          parent: row.node.parent,
        });
      }
      Fx.send({ kind: FxKind.fire, x: p.x + s.x * side, y: 1, z: p.z + s.z * side });
    }
    for (const s of shots) {
      const node = GameObject.instantiate(BALL_PREFAB, { parent: s.parent, position: [s.x, 0.9, s.z] });
      const ball = node.getData(Ball) as BallView;
      ball.vx = s.vx;
      ball.vy = BALL_LIFT;
      ball.vz = s.vz;
      ball.shooter = s.shooter;
      ball.life = 4;
    }
  },
});

/** Damages a ship (unless it's sunk or just respawned); sinks it at 0. */
function damage(target: ShipInfo, amount: number): void {
  const ship = target.data;
  if (ship.sunk > 0 || ship.invulnerable > 0) return;
  ship.hp = Math.max(0, ship.hp - amount);
  if (ship.hp > 0) return;
  ship.sunk = RESPAWN_DELAY;
  ship.sinks++;
  const p = target.node.transform!.position;
  Fx.send({ kind: FxKind.sink, x: p.x, y: 0, z: p.z });
}

/** Moves cannonballs: a ball that reaches the water splashes, one that meets a hull or a rock breaks. */
defineSystem({
  name: "pirates.Balls",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["pirates.Fire"],
  query: [Transform, Ball],
  run(rows, ctx) {
    const all = ships();
    const obstacles = obstacleList(ctx.world);
    for (const row of rows) {
      const ball = row.ball as BallView;
      const p = row.transform.position;
      ball.vy -= BALL_GRAVITY * ctx.dt;
      p.x += ball.vx * ctx.dt;
      p.y += ball.vy * ctx.dt;
      p.z += ball.vz * ctx.dt;
      ball.life -= ctx.dt;
      let done = ball.life <= 0;
      for (const target of all) {
        if (done) break;
        if (target.data.sunk > 0 || target.data.team === ball.shooter) continue;
        const t = target.node.transform!.position;
        const f = forward(target.data.heading), s = starboard(target.data.heading);
        const dx = p.x - t.x, dz = p.z - t.z;
        const along = dx * f.x + dz * f.z, across = dx * s.x + dz * s.z;
        if (Math.abs(along) > HULL_HALF_LENGTH + BALL_RADIUS || Math.abs(across) > HULL_HALF_WIDTH + BALL_RADIUS || p.y > 2.6) continue;
        done = true;
        damage(target, BALL_DAMAGE);
        Fx.send({ kind: FxKind.hit, x: p.x, y: p.y, z: p.z });
      }
      for (const o of obstacles) {
        if (done) break;
        if ((p.x - o.x) ** 2 + (p.z - o.z) ** 2 > o.r * o.r || p.y > 3) continue;
        done = true;
        Fx.send({ kind: FxKind.crunch, x: p.x, y: p.y, z: p.z });
      }
      if (!done) {
        const sea = Water.sample(p.x, p.z);
        if (p.y < (sea?.height ?? 0)) {
          done = true;
          Fx.send({ kind: FxKind.splash, x: p.x, y: sea?.height ?? 0, z: p.z });
        }
      }
      if (done) GameObject.destroy(row.node);
    }
  },
});

/** The scene's obstacles as circles on the water, gathered each fixed step before anything uses them. */
const obstacleCache = new WeakMap<object, { x: number; z: number; r: number }[]>();

defineSystem({
  name: "pirates.Obstacles",
  phase: "fixedUpdate",
  worlds: ["server"],
  before: ["pirates.Bots", "pirates.Sail"],
  query: [Transform, Obstacle],
  run(rows, ctx) {
    const out: { x: number; z: number; r: number }[] = [];
    for (const row of rows) {
      const o = row.obstacle as ObstacleView;
      const w = row.transform.worldPosition;
      out.push({ x: w.x, z: w.z, r: o.radius * row.transform.worldScale.x });
    }
    obstacleCache.set(ctx.world, out);
  },
});

/** This World's obstacles, as the last `pirates.Obstacles` step found them. */
export function obstacleList(world: object): readonly { x: number; z: number; r: number }[] {
  return obstacleCache.get(world) ?? [];
}

/**
 * Keeps ships out of obstacles and each other, and hurts them for it: ramming an obstacle bow-on
 * costs `RAM_DAMAGE` per metre a second and stops the ship; brushing it costs little. Outside the
 * arena a ship takes `OUTSIDE_DAMAGE` a second.
 */
defineSystem({
  name: "pirates.Collide",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["pirates.Sail"],
  before: ["pirates.Balls"],
  query: [Ship],
  run(_rows, ctx) {
    const all = ships().filter((s) => s.data.sunk <= 0);
    const obstacles = obstacleList(ctx.world);
    for (const s of all) {
      const p = s.node.transform!.position;
      const f = forward(s.data.heading);
      for (const o of obstacles) {
        const dx = p.x - o.x, dz = p.z - o.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const min = o.r + SHIP_RADIUS;
        if (d >= min || d === 0) continue;
        const nx = dx / d, nz = dz / d;
        p.x = o.x + nx * min;
        p.z = o.z + nz * min;
        const into = -(f.x * nx + f.z * nz); // 1 = bow straight at it
        if (into > 0.6 && s.data.speed > 2) {
          damage(s, s.data.speed * RAM_DAMAGE * into);
          Fx.send({ kind: FxKind.crunch, x: p.x - nx * SHIP_RADIUS, y: 0.5, z: p.z - nz * SHIP_RADIUS });
          s.data.speed = 0;
        } else if (into > 0) {
          s.data.speed *= 0.97;
        }
      }
      if (p.x * p.x + p.z * p.z > ARENA_RADIUS * ARENA_RADIUS) damage(s, OUTSIDE_DAMAGE * ctx.dt);
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i].node.transform!.position, b = all[j].node.transform!.position;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const min = SHIP_RADIUS * 2;
        if (d >= min || d === 0) continue;
        const push = (min - d) / 2, nx = dx / d, nz = dz / d;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        const closing = Math.abs(all[i].data.speed - all[j].data.speed) + 1;
        damage(all[i], closing * ctx.dt * 4);
        damage(all[j], closing * ctx.dt * 4);
      }
    }
  },
});

/** Counts down sunk ships and brings them back at their spawn point, briefly invulnerable. */
defineSystem({
  name: "pirates.Respawn",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["pirates.Balls"],
  query: [Transform, Ship],
  run(rows, ctx) {
    for (const row of rows) {
      const ship = row.ship as ShipView;
      if (ship.sunk <= 0) continue;
      ship.sunk -= ctx.dt;
      if (ship.sunk <= 0) placeAtSpawn(row.node, ship);
    }
  },
});
