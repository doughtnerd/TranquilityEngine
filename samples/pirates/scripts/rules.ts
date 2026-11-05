// The match's rules, on the server (ADR 0017, 0033): the clock and the result, the flag (its
// holder scores a point a second; a sunk holder drops it where it sank), power-ups growing at
// their spots and what they do, ghost ships' fog clouds, and the storm's lightning. Weather and
// wave height follow the replicated match state in every World (weather.ts).
import { GameObject, Replicated, Transform, defineSystem } from "myco";
import { Actors } from "./behaviors/Actors";
import {
  CLOUD_PREFAB,
  CLOUD_SECONDS,
  Cloud,
  FLAG_COOLDOWN,
  FLAG_REACH,
  Fx,
  FxKind,
  GHOST_SECONDS,
  LIGHTNING_DAMAGE,
  LIGHTNING_EVERY,
  MATCH_SECONDS,
  PICKUP_PREFABS,
  PICKUP_REACH,
  PICKUP_RESPAWN,
  Phase,
  Pickup,
  PickupSpot,
  PowerUp,
  RESULTS_SECONDS,
  STORM_SECONDS,
  WIND_SECONDS,
  clouds,
  flag,
  game,
  ranking,
  ships,
  type CloudView,
  type PickupSpotView,
  type PickupView,
  type ShipInfo,
} from "./data";
import { damage, helmOf, resetShip } from "./systems";

/** A match's result: teams in finishing order, with their scores. */
export interface MatchResult {
  readonly winner: number;
  readonly order: readonly { team: number; bot: boolean; score: number; kills: number; sinks: number }[];
}

/**
 * What happens when a match ends. Without a lobby, the results show for `RESULTS_SECONDS` and a
 * new match starts; a lobby's match World replaces this to hand the result back (lobby.ts).
 */
let matchOver: ((result: MatchResult) => "restart" | "hold") | null = null;
export function onMatchOver(handler: ((result: MatchResult) => "restart" | "hold") | null): void {
  matchOver = handler;
}

/** How long a match lasts; the lobby's settings can change it. */
let matchLength = MATCH_SECONDS;
export function setMatchLength(seconds: number): void {
  matchLength = seconds;
}

/** Where the flag started, per World, so a new match puts it back. */
const flagHome = new WeakMap<object, { x: number; z: number }>();

function startMatch(world: object): void {
  const g = game();
  if (!g) return;
  g.phase = Phase.playing;
  g.timeLeft = matchLength;
  g.storm = 0;
  g.stormTeam = -1;
  g.winner = -1;
  g.results = 0;
  for (const s of ships()) {
    s.data.score = 0;
    s.data.kills = 0;
    s.data.sinks = 0;
    resetShip(s.node, s.data);
  }
  const f = flag();
  const home = flagHome.get(world);
  if (f && home) {
    f.data.carrier = -1;
    f.data.cooldown = 0;
    f.node.transform!.position.set(home.x, 0, home.z);
  }
  for (const c of clouds()) GameObject.destroy(c.node);
}

/** The clock: a match starts when the first ship is on the water, ends when time runs out, and (without a lobby) restarts. */
defineSystem({
  name: "pirates.Match",
  phase: "fixedUpdate",
  worlds: ["server"],
  before: ["pirates.Sail"],
  run(_rows, ctx) {
    const g = game();
    if (!g) return;
    const f = flag();
    if (f && !flagHome.has(ctx.world)) flagHome.set(ctx.world, { x: f.node.transform!.position.x, z: f.node.transform!.position.z });
    if (g.phase === Phase.waiting) {
      if (ships().length > 0) startMatch(ctx.world);
      return;
    }
    if (g.phase === Phase.playing) {
      g.timeLeft = Math.max(0, g.timeLeft - ctx.dt);
      if (g.timeLeft > 0) return;
      const order = ranking(ships());
      g.phase = Phase.over;
      g.winner = order[0]?.data.team ?? -1;
      g.results = 0;
      g.storm = 0;
      const result: MatchResult = { winner: g.winner, order: order.map((s) => ({ team: s.data.team, bot: s.data.bot !== 0, score: Math.floor(s.data.score), kills: s.data.kills, sinks: s.data.sinks })) };
      holdResults.set(ctx.world, (matchOver?.(result) ?? "restart") === "hold");
      return;
    }
    g.results += ctx.dt;
    if (g.results >= RESULTS_SECONDS && !holdResults.get(ctx.world)) startMatch(ctx.world);
  },
});
const holdResults = new WeakMap<object, boolean>();

/** The flag: picked up by the nearest ship that sails over it, carried above its holder, dropped where the holder sinks. Its holder scores a point a second. */
defineSystem({
  name: "pirates.Flag",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["pirates.Collide"],
  run(_rows, ctx) {
    const f = flag();
    const g = game();
    if (!f || !g) return;
    const all = ships();
    const p = f.node.transform!.position;
    f.data.cooldown = Math.max(0, f.data.cooldown - ctx.dt);
    if (f.data.carrier >= 0) {
      const holder = all.find((s) => s.data.team === f.data.carrier);
      if (!holder || holder.data.sunk > 0 || g.phase === Phase.over) {
        if (holder) holder.data.flag = 0;
        f.data.carrier = -1;
        f.data.cooldown = FLAG_COOLDOWN;
        p.y = 0;
        if (holder && holder.data.sunk > 0) Fx.send({ kind: FxKind.flag, x: p.x, y: 0, z: p.z });
        return;
      }
      const h = holder.node.transform!.position;
      p.set(h.x, 0, h.z);
      if (g.phase === Phase.playing) holder.data.score += ctx.dt;
      return;
    }
    if (f.data.cooldown > 0 || g.phase !== Phase.playing) return;
    let best: ShipInfo | null = null, bestD = FLAG_REACH;
    for (const s of all) {
      if (s.data.sunk > 0) continue;
      const q = s.node.transform!.position;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    if (!best) return;
    f.data.carrier = best.data.team;
    best.data.flag = 1;
    Fx.send({ kind: FxKind.flag, x: p.x, y: 1, z: p.z });
  },
});

/** Power-ups: each spot grows one (its kind, or any), a ship that sails through takes it, and the spot grows another later. */
defineSystem({
  name: "pirates.PickupSpots",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["pirates.Flag"],
  query: [Transform, PickupSpot],
  run(rows, ctx) {
    const g = game();
    if (!g || g.phase !== Phase.playing) return;
    const pickups: { node: GameObject; data: PickupView }[] = [];
    for (const rep of GameObject.findObjectsOfType(Replicated)) {
      const data = rep.node.isValid ? (rep.node.getData(Pickup) as PickupView | null) : null;
      if (data) pickups.push({ node: rep.node, data });
    }
    let index = 0;
    for (const row of rows) {
      const spot = row.pickupSpot as PickupSpotView;
      spot.index = ++index;
      if (pickups.some((p) => p.data.spot === spot.index)) continue;
      spot.timer -= ctx.dt;
      if (spot.timer > 0) continue;
      const kind = spot.kind || 1 + Math.floor(Math.random() * 3);
      const w = row.transform.worldPosition;
      const node = GameObject.instantiate(PICKUP_PREFABS[kind], { parent: GameObject.findObjectOfType(Actors)?.node ?? null, position: [w.x, 0, w.z] });
      const data = node.getData(Pickup) as PickupView;
      data.kind = kind;
      data.spot = spot.index;
      spot.timer = PICKUP_RESPAWN;
    }
    const all = ships().filter((s) => s.data.sunk <= 0);
    for (const pickup of pickups) {
      const p = pickup.node.transform!.position;
      const taker = all.find((s) => Math.hypot(s.node.transform!.position.x - p.x, s.node.transform!.position.z - p.z) < PICKUP_REACH);
      if (!taker) continue;
      apply(taker, pickup.data.kind);
      Fx.send({ kind: FxKind.pickup, x: p.x, y: 0.5, z: p.z });
      GameObject.destroy(pickup.node);
    }
  },
});

function apply(ship: ShipInfo, kind: number): void {
  const g = game();
  if (kind === PowerUp.wind) ship.data.wind = WIND_SECONDS;
  else if (kind === PowerUp.ghost) {
    ship.data.ghost = GHOST_SECONDS;
    ship.data.cloud = 1;
  } else if (kind === PowerUp.storm && g) {
    g.storm = STORM_SECONDS;
    g.stormTeam = ship.data.team;
  }
}

/** Power-ups wear off; a ghost ship drops its fog cloud with F (a bot, when it fires); clouds fade. */
defineSystem({
  name: "pirates.PowerUps",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["pirates.PickupSpots"],
  run(_rows, ctx) {
    for (const s of ships()) {
      s.data.wind = Math.max(0, s.data.wind - ctx.dt);
      s.data.ghost = Math.max(0, s.data.ghost - ctx.dt);
      if (s.data.ghost <= 0) s.data.cloud = 0;
      if (!s.data.cloud || s.data.sunk > 0) continue;
      const helm = helmOf(s.node, s.data);
      if (!helm?.drop) continue;
      s.data.cloud = 0;
      const p = s.node.transform!.position;
      const node = GameObject.instantiate(CLOUD_PREFAB, { parent: s.node.parent, position: [p.x, 0, p.z] });
      const cloud = node.getData(Cloud) as CloudView;
      cloud.team = s.data.team;
      cloud.life = CLOUD_SECONDS;
      Fx.send({ kind: FxKind.cloud, x: p.x, y: 0, z: p.z });
    }
    for (const c of clouds()) {
      c.data.life -= ctx.dt;
      if (c.data.life <= 0) GameObject.destroy(c.node);
    }
  },
});

/** Seconds to the next lightning strike, per World. */
const nextStrike = new WeakMap<object, number>();

/** The storm wears off; while it lasts, lightning strikes a ship other than the one that called it every few seconds. */
defineSystem({
  name: "pirates.Storm",
  phase: "fixedUpdate",
  worlds: ["server"],
  after: ["pirates.PowerUps"],
  run(_rows, ctx) {
    const g = game();
    if (!g || g.storm <= 0) return;
    g.storm = Math.max(0, g.storm - ctx.dt);
    let t = (nextStrike.get(ctx.world) ?? LIGHTNING_EVERY[0]) - ctx.dt;
    if (t <= 0) {
      t = LIGHTNING_EVERY[0] + Math.random() * (LIGHTNING_EVERY[1] - LIGHTNING_EVERY[0]);
      const targets = ships().filter((s) => s.data.team !== g.stormTeam && s.data.sunk <= 0 && s.data.invulnerable <= 0);
      const target = targets[Math.floor(Math.random() * targets.length)];
      if (target) {
        const p = target.node.transform!.position;
        damage(target, LIGHTNING_DAMAGE);
        Fx.send({ kind: FxKind.lightning, x: p.x, y: 0, z: p.z });
      }
    }
    nextStrike.set(ctx.world, t);
  },
});
