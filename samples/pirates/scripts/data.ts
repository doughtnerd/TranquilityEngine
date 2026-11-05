// King of Pirates' shared data (ADR 0017, 0033): components, the input stream, RPCs and the rules
// every World uses. Client and server load the same scripts, so both define the same replicated
// components, inputs and RPCs, as the handshake requires.
import { GameObject, Replicated, defineComponent, defineInput, defineRpc, f32, i32, replicate, u8, type DataView } from "myco";

export const SHIP_PREFAB = "prefabs/ship.prefab.json";
export const BALL_PREFAB = "prefabs/cannonball.prefab.json";
export const SPLASH_PREFAB = "prefabs/splash.prefab.json";
export const CLOUD_PREFAB = "prefabs/fogcloud.prefab.json";
export const BOLT_PREFAB = "prefabs/bolt.prefab.json";
export const PICKUP_PREFABS = ["", "prefabs/powerup_wind.prefab.json", "prefabs/powerup_ghost.prefab.json", "prefabs/powerup_storm.prefab.json"];

// --- the rules -------------------------------------------------------------------------------------

/** Ships sail inside the arena's radius (`Game.radius`, default this); outside it the hull takes `OUTSIDE_DAMAGE` a second. */
export const ARENA_RADIUS = 80;
export const OUTSIDE_DAMAGE = 12;

export const SHIP_HP = 100;
/** Full sail, metres a second. Turning hard slows a ship to half of it. */
export const SHIP_SPEED = 9;
export const SHIP_ACCEL = 4;
/** Degrees a second. */
export const SHIP_TURN_RATE = 65;
/** The hull, for hits and collisions: half width and half length (the model is 1.4 × 4.2). */
export const HULL_HALF_WIDTH = 0.8;
export const HULL_HALF_LENGTH = 2.1;
/** Ships collide with obstacles and each other as circles of this radius. */
export const SHIP_RADIUS = 1.5;

/** Seconds between broadsides from one battery. */
export const RELOAD = 2.4;
/** Balls per broadside, spread along the hull. */
export const BROADSIDE = 3;
export const BALL_SPEED = 20;
export const BALL_LIFT = 4.5;
export const BALL_GRAVITY = 9.81;
export const BALL_DAMAGE = 9;
export const BALL_RADIUS = 0.15;

/** Ramming an obstacle head-on: damage per metre a second of speed. */
export const RAM_DAMAGE = 3;
/** Seconds a sunk ship waits, and then how long it can't be hurt. */
export const RESPAWN_DELAY = 5;
export const SPAWN_INVULNERABLE = 3;

/** Ships in a match started without a lobby: players first, then bots fill the rest. */
export const DEFAULT_SHIPS = 6;

/** A match's length, and how long the results show before a match started without a lobby restarts. */
export const MATCH_SECONDS = 300;
export const RESULTS_SECONDS = 10;

/** The flag: a ship this close picks it up; its holder scores a point a second. */
export const FLAG_REACH = 3;
/** A dropped flag can't be picked up again for this long. */
export const FLAG_COOLDOWN = 1;

/** Power-ups: picked up within `PICKUP_REACH`; a spot grows a new one `PICKUP_RESPAWN` seconds after. */
export const PICKUP_REACH = 2.6;
export const PICKUP_RESPAWN = 20;
export const PowerUp = { none: 0, wind: 1, ghost: 2, storm: 3 } as const;
/** Wind in your sails: seconds of extra speed, and how much. */
export const WIND_SECONDS = 5;
export const WIND_SPEEDUP = 1.6;
/** Ghost ship: seconds of ghostliness; F drops one fog cloud that lasts `CLOUD_SECONDS`. */
export const GHOST_SECONDS = 60;
export const CLOUD_SECONDS = 20;
export const CLOUD_RADIUS = 9;
/** Bots' path cost through a fog cloud (the cloud's NavCostVolume). */
export const CLOUD_COST = 8;
/** Stormy seas: seconds; the waves grow this much; lightning strikes another ship every so often. */
export const STORM_SECONDS = 30;
export const STORM_WAVES = 2.2;
export const LIGHTNING_EVERY: readonly [number, number] = [2, 4];
export const LIGHTNING_DAMAGE = 18;

/** Batteries: none chosen yet, the port (left) side, the starboard (right) side. */
export const Battery = { none: 0, port: 1, starboard: 2 } as const;

/** Team colours, one per slot; `sail_team<n>.png` matches. */
export const TEAM_COLORS = ["#d84a3a", "#3a7bd8", "#4caf50", "#f2c230", "#9c4fd8", "#f08a24", "#26a69a", "#ec6fa8"];

// --- data ------------------------------------------------------------------------------------------

/**
 * A ship. `heading` (degrees about Y, 0 = +Z) and `speed` are predicted by the owner; the rest is
 * the server's. `aimX`/`aimZ`/`fire`/`battery` are a bot's helm (players' come from `Helm`).
 */
export const Ship = defineComponent("pirates.Ship", {
  heading: f32,
  speed: f32,
  hp: f32,
  battery: u8,
  reloadPort: f32,
  reloadStarboard: f32,
  team: u8,
  bot: u8,
  sunk: f32,
  invulnerable: f32,
  sinks: i32,
  kills: i32,
  score: f32,
  flag: u8,
  wind: f32,
  ghost: f32,
  cloud: u8,
  aimX: f32,
  aimZ: f32,
  fire: u8,
});
replicate(Ship, {
  fields: ["heading", "speed", "hp", "battery", "reloadPort", "reloadStarboard", "team", "bot", "sunk", "invulnerable", "sinks", "kills", "score", "flag", "wind", "ghost", "cloud"],
  predicted: ["heading", "speed"],
  encoding: {
    hp: { quantize: 0.5 },
    reloadPort: { quantize: 0.05 },
    reloadStarboard: { quantize: 0.05 },
    sunk: { quantize: 0.05 },
    invulnerable: { quantize: 0.05 },
    score: { quantize: 0.1 },
    wind: { quantize: 0.05 },
    ghost: { quantize: 0.1 },
  },
});
export type ShipView = DataView<typeof Ship.schema>;

/** A cannonball, moved on the server; clients see it interpolated. */
export const Ball = defineComponent("pirates.Ball", { vx: f32, vy: f32, vz: f32, shooter: i32, life: f32 });
export type BallView = DataView<typeof Ball.schema>;

/**
 * The match, on the scene's replicated `Match` node: the time left, the phase (waiting for
 * players, playing, over), the storm's time left and who called it, and the winner's team (-1:
 * none yet). `radius` is the arena's, set in the scene.
 */
export const Game = defineComponent("pirates.Game", { phase: u8, timeLeft: f32, storm: f32, stormTeam: i32, winner: i32, radius: f32, results: f32 });
replicate(Game, { fields: ["phase", "timeLeft", "storm", "stormTeam", "winner", "radius"], encoding: { timeLeft: { quantize: 0.1 }, storm: { quantize: 0.1 } } });
export type GameView = DataView<typeof Game.schema>;
export const Phase = { waiting: 0, playing: 1, over: 2 } as const;

/** The flag, on the scene's replicated `Flag` node: the team carrying it (-1: nobody) and its pickup cooldown. */
export const FlagState = defineComponent("pirates.Flag", { carrier: i32, cooldown: f32 });
replicate(FlagState, { fields: ["carrier"] });
export type FlagView = DataView<typeof FlagState.schema>;

/** A power-up floating on the water (a replicated prefab). */
export const Pickup = defineComponent("pirates.Pickup", { kind: u8, spot: i32 });
export type PickupView = DataView<typeof Pickup.schema>;

/** Where power-ups grow: `kind` (0: any), and the time until the next one. */
export const PickupSpot = defineComponent("pirates.PickupSpot", { kind: u8, timer: f32, index: i32 });
export type PickupSpotView = DataView<typeof PickupSpot.schema>;

/** A ghost ship's fog cloud (a replicated prefab): who dropped it and how long it has left. */
export const Cloud = defineComponent("pirates.Cloud", { team: i32, life: f32 });
replicate(Cloud, { fields: ["team", "life"], encoding: { life: { quantize: 0.1 } } });
export type CloudView = DataView<typeof Cloud.schema>;

/** An island or rock ships can't sail through: a circle on the water. */
export const Obstacle = defineComponent("pirates.Obstacle", { radius: f32 });
export type ObstacleView = DataView<typeof Obstacle.schema>;

/**
 * Each client's per-tick helm: the point on the water the mouse is over (`steer` 0 when the mouse
 * isn't over the game), the chosen battery, and the fire button.
 */
export const Helm = defineInput("pirates.Helm", { x: f32, z: f32, steer: u8, battery: u8, fire: u8, drop: u8 });

/** Effects the server tells clients about: where and what. */
export const FxKind = { fire: 1, splash: 2, hit: 3, crunch: 4, sink: 5, lightning: 6, pickup: 7, flag: 8, cloud: 9 } as const;
export const Fx = defineRpc("pirates.Fx", { kind: u8, x: f32, y: f32, z: f32 });

// --- helpers ---------------------------------------------------------------------------------------

/** A ship in the current World. */
export interface ShipInfo {
  readonly node: GameObject;
  readonly rep: Replicated;
  readonly data: ShipView;
}

/** The ships in the current World, by owner id (bots, owned by the server, first). */
export function ships(): ShipInfo[] {
  const out: ShipInfo[] = [];
  for (const rep of GameObject.findObjectsOfType(Replicated)) {
    if (!rep.node.isValid) continue;
    const data = rep.node.getData(Ship) as ShipView | null;
    if (data) out.push({ node: rep.node, rep, data });
  }
  return out;
}

/** The ship this client steers, if it has one yet. */
export function myShip(): ShipInfo | null {
  return ships().find((s) => s.rep.isOwnedLocally) ?? null;
}

/** Unit vector a heading points along, on the water. */
export function forward(headingDeg: number): { x: number; z: number } {
  const r = (headingDeg * Math.PI) / 180;
  return { x: Math.sin(r), z: Math.cos(r) };
}

/** The starboard (right-hand) side of a heading; port is its negation. */
export function starboard(headingDeg: number): { x: number; z: number } {
  const r = (headingDeg * Math.PI) / 180;
  return { x: -Math.cos(r), z: Math.sin(r) };
}

/** The heading (degrees) that points from (x, z) toward (tx, tz). */
export function bearing(x: number, z: number, tx: number, tz: number): number {
  return (Math.atan2(tx - x, tz - z) * 180) / Math.PI;
}

/** `a - b` wrapped to -180..180 degrees. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** The match state in the current World (the scene's `Match` node), if the scene has one. */
export function game(): GameView | null {
  for (const rep of GameObject.findObjectsOfType(Replicated)) {
    if (!rep.node.isValid) continue;
    const g = rep.node.getData(Game) as GameView | null;
    if (g) return g;
  }
  return null;
}

/** The flag node and its state in the current World. */
export function flag(): { node: GameObject; data: FlagView } | null {
  for (const rep of GameObject.findObjectsOfType(Replicated)) {
    if (!rep.node.isValid) continue;
    const data = rep.node.getData(FlagState) as FlagView | null;
    if (data) return { node: rep.node, data };
  }
  return null;
}

/** The fog clouds in the current World. */
export function clouds(): { node: GameObject; data: CloudView }[] {
  const out: { node: GameObject; data: CloudView }[] = [];
  for (const rep of GameObject.findObjectsOfType(Replicated)) {
    if (!rep.node.isValid) continue;
    const data = rep.node.getData(Cloud) as CloudView | null;
    if (data) out.push({ node: rep.node, data });
  }
  return out;
}

/** True when (x, z) is inside a fog cloud (`except`: a team whose own clouds don't count). */
export function inCloud(x: number, z: number, except = -1): boolean {
  for (const c of clouds()) {
    if (c.data.team === except) continue;
    const p = c.node.transform!.position;
    if ((p.x - x) ** 2 + (p.z - z) ** 2 < CLOUD_RADIUS * CLOUD_RADIUS) return true;
  }
  return false;
}

/** Ships ranked: score, then enemy ships sunk (the tiebreaker), then fewest times sunk. */
export function ranking<T extends { data: ShipView }>(all: readonly T[]): T[] {
  return [...all].sort((a, b) => b.data.score - a.data.score || b.data.kills - a.data.kills || a.data.sinks - b.data.sinks || a.data.team - b.data.team);
}
