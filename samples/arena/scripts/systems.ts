// The arena's gameplay as systems (ADR 0017, 0033). What runs where:
// - every client World: reading the keyboard into the `Move` input stream, and tinting players;
// - client and server: the predicted movement system (on a client it moves only the player it
//   owns, ahead of the server, and re-runs when a snapshot corrects it);
// - the server only: a player per connection, firing, shots and hits, scores.
import { Color, Connection, ConnectionState, GameObject, Input, Mathf, Replicated, SpriteRenderer, Transform, defineSystem, type DataView } from "tranquility";
import { Actors } from "./behaviors/Actors";
import {
  FIRE_COOLDOWN,
  HALF_HEIGHT,
  HALF_WIDTH,
  Move,
  PLAYER_COLORS,
  PLAYER_PREFAB,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  Player,
  SHOT_LIFE,
  SHOT_PREFAB,
  SHOT_RADIUS,
  SHOT_SPEED,
  SPAWN_POINTS,
  Shot,
  connectionStates,
  players,
  type ClientConnection,
  type PlayerView,
} from "./data";

type ShotView = DataView<typeof Shot.schema>;

const key = (...names: string[]) => names.some((n) => Input.getKey(n));

// --- clients -------------------------------------------------------------------------------------

/**
 * This tick's input from the keyboard: WASD or the arrows to move, Space to fire. Only the World
 * with local input sees keys (click a tile to give it input); the others send zeros.
 */
defineSystem({
  name: "arena.ReadInput",
  phase: "fixedUpdate",
  worlds: ["client"],
  // The predicted move reads this step's input: write it first, so client and server agree on each tick's input.
  before: ["arena.MovePlayers"],
  run() {
    const x = (key("d", "arrowright") ? 1 : 0) - (key("a", "arrowleft") ? 1 : 0);
    const y = (key("w", "arrowup") ? 1 : 0) - (key("s", "arrowdown") ? 1 : 0);
    Move.write({ x, y, fire: key("space") ? 1 : 0 });
  },
});

/**
 * Notes this client World's connection state for the HUD, which as a behavior can't query data
 * components: connecting, open, or (once a connection it had is gone) lost.
 */
defineSystem({
  name: "arena.WatchConnection",
  phase: "update",
  worlds: ["client"],
  query: [Connection],
  run(rows, ctx) {
    let state: ClientConnection = "none";
    for (const row of rows) state = (row.connection as { state: number }).state === ConnectionState.open ? "open" : "connecting";
    const before = connectionStates.get(ctx.world) ?? "none";
    connectionStates.set(ctx.world, state === "none" && before !== "none" ? "lost" : state);
  },
});

/** Colors each player by its owner and points its aim marker (a child sprite) where it last moved. */
defineSystem({
  name: "arena.ShowPlayers",
  phase: "lateUpdate",
  worlds: ["client"],
  query: [Transform, Player],
  run(rows) {
    for (const row of rows) {
      const rep = row.node.getBehavior(Replicated);
      const sprite = row.node.getBehavior(SpriteRenderer);
      const color = PLAYER_COLORS[((rep?.ownerId ?? 1) - 1 + PLAYER_COLORS.length) % PLAYER_COLORS.length];
      if (sprite && sprite.color.toHex() !== color) sprite.color = Color.from(color);
      const aim = row.node.find("Aim")?.transform;
      const data = row.player as PlayerView;
      if (aim) aim.position.set(data.aimX * 0.42, data.aimY * 0.42, 0);
    }
  },
});

// --- client and server -----------------------------------------------------------------------------

/**
 * Moves players by their owner's input, inside the walls (Unity's `PredictedSimulationSystemGroup`).
 * On the server it moves every player with its connection's input; on a client it moves only the
 * player that client owns, once per predicted tick, and runs again for the ticks since a snapshot
 * that disagrees. So it's deterministic and touches only predicted values: the transform and
 * `Player.aimX`/`aimY`.
 */
defineSystem({
  name: "arena.MovePlayers",
  phase: "fixedUpdate",
  predicted: true,
  worlds: ["client", "server"],
  query: [Transform, Player],
  run(rows, ctx) {
    for (const row of rows) {
      const input = Move.of(row.node);
      if (!input) continue;
      let x = input.x, y = input.y;
      const length = Math.sqrt(x * x + y * y);
      if (length > 1) {
        x /= length;
        y /= length;
      }
      const p = row.transform.position;
      p.x = Mathf.clamp(p.x + x * PLAYER_SPEED * ctx.dt, -HALF_WIDTH + PLAYER_RADIUS, HALF_WIDTH - PLAYER_RADIUS);
      p.y = Mathf.clamp(p.y + y * PLAYER_SPEED * ctx.dt, -HALF_HEIGHT + PLAYER_RADIUS, HALF_HEIGHT - PLAYER_RADIUS);
      if (length > 0) {
        const data = row.player as PlayerView;
        data.aimX = input.x / length;
        data.aimY = input.y / length;
      }
    }
  },
});

// --- server ----------------------------------------------------------------------------------------

/** A player's spawn point: by connection id at first, else the one farthest from `away`. */
function spawnPoint(id: number, away?: { x: number; y: number }): readonly [number, number] {
  if (!away) return SPAWN_POINTS[(id - 1) % SPAWN_POINTS.length];
  let best = SPAWN_POINTS[0];
  for (const s of SPAWN_POINTS) if ((s[0] - away.x) ** 2 + (s[1] - away.y) ** 2 > (best[0] - away.x) ** 2 + (best[1] - away.y) ** 2) best = s;
  return best;
}

/**
 * A player for each open connection, removed when the connection goes (Netcode's "a player
 * joined" is a query over connection nodes, not an event). Players spawn under the arena's
 * `Actors` node, so they wait for the arena scene, and on clients they spawn under the same node.
 */
defineSystem({
  name: "arena.SpawnPlayers",
  phase: "update",
  worlds: ["server"],
  query: [Connection],
  run(rows) {
    const actors = GameObject.findObjectOfType(Actors)?.node;
    if (!actors) return; // the arena scene isn't loaded yet
    const open = new Set<number>();
    for (const row of rows) {
      const c = row.connection as { id: number; state: number };
      if (c.state === ConnectionState.open) open.add(c.id);
    }
    const existing = players();
    for (const p of existing) if (!open.has(p.rep.ownerId)) GameObject.destroy(p.node);
    for (const id of open) {
      if (existing.some((p) => p.rep.ownerId === id)) continue;
      const [x, y] = spawnPoint(id);
      const node = GameObject.instantiate(PLAYER_PREFAB, { parent: actors, position: [x, y, 0] });
      const rep = node.getBehavior(Replicated)!;
      rep.ownerId = id;
      rep.mode = "predicted";
      const data = node.getData(Player) as PlayerView;
      data.aimX = x < 0 ? 1 : -1; // face the middle
    }
  },
});

/** Fires a shot while a player's fire input is held, at most every `FIRE_COOLDOWN` seconds. */
defineSystem({
  name: "arena.Fire",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["arena.MovePlayers"],
  query: [Transform, Player],
  run(rows, ctx) {
    const shots: { parent: GameObject | null; x: number; y: number; dx: number; dy: number; shooter: number }[] = [];
    for (const row of rows) {
      const data = row.player as PlayerView;
      data.cooldown = Math.max(0, data.cooldown - ctx.dt);
      const input = Move.of(row.node);
      if (!input?.fire || data.cooldown > 0) continue;
      data.cooldown = FIRE_COOLDOWN;
      const p = row.transform.position;
      const rep = row.node.getBehavior(Replicated)!;
      shots.push({ parent: row.node.parent, x: p.x + data.aimX * (PLAYER_RADIUS + SHOT_RADIUS), y: p.y + data.aimY * (PLAYER_RADIUS + SHOT_RADIUS), dx: data.aimX, dy: data.aimY, shooter: rep.ownerId });
    }
    // Instantiated after the loop, so the query isn't changed while it's iterated.
    for (const s of shots) {
      const node = GameObject.instantiate(SHOT_PREFAB, { parent: s.parent, position: [s.x, s.y, 0] });
      const shot = node.getData(Shot) as ShotView;
      shot.vx = s.dx * SHOT_SPEED;
      shot.vy = s.dy * SHOT_SPEED;
      shot.shooter = s.shooter;
      shot.life = SHOT_LIFE;
    }
  },
});

/**
 * Moves shots; one that hits another player scores a point for its shooter and sends the player
 * hit to the spawn point farthest from the shooter. Shots expire or stop at the walls.
 */
defineSystem({
  name: "arena.Shots",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["arena.Fire"],
  query: [Transform, Shot],
  run(rows, ctx) {
    const all = players();
    const reach = (PLAYER_RADIUS + SHOT_RADIUS) ** 2;
    for (const row of rows) {
      const shot = row.shot as ShotView;
      const p = row.transform.position;
      p.x += shot.vx * ctx.dt;
      p.y += shot.vy * ctx.dt;
      shot.life -= ctx.dt;
      let done = shot.life <= 0 || Math.abs(p.x) > HALF_WIDTH - SHOT_RADIUS || Math.abs(p.y) > HALF_HEIGHT - SHOT_RADIUS;
      for (const target of all) {
        if (done) break;
        if (target.rep.ownerId === shot.shooter) continue;
        const t = target.node.transform!.position;
        if ((t.x - p.x) ** 2 + (t.y - p.y) ** 2 > reach) continue;
        done = true;
        const shooter = all.find((s) => s.rep.ownerId === shot.shooter);
        if (shooter) shooter.data.score++;
        const [x, y] = spawnPoint(target.rep.ownerId, shooter?.node.transform!.position);
        t.set(x, y, 0);
      }
      if (done) GameObject.destroy(row.node);
    }
  },
});
