// King of Pirates' shared data (ADR 0017, 0033): components, the input stream, RPCs and the rules
// every World uses. Client and server load the same scripts, so both define the same replicated
// components, inputs and RPCs, as the handshake requires.
import { GameObject, Replicated, defineComponent, defineInput, defineRpc, f32, i32, replicate, u8, type DataView } from "myco";

export const SHIP_PREFAB = "prefabs/ship.prefab.json";
export const BALL_PREFAB = "prefabs/cannonball.prefab.json";
export const SPLASH_PREFAB = "prefabs/splash.prefab.json";

// --- the rules -------------------------------------------------------------------------------------

/** Ships sail inside this radius; outside it the hull takes `OUTSIDE_DAMAGE` a second. */
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

/** Ships in the prototype: players first, then bots fill the rest. */
export const PROTOTYPE_SHIPS = 4;

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
  aimX: f32,
  aimZ: f32,
  fire: u8,
});
replicate(Ship, {
  fields: ["heading", "speed", "hp", "battery", "reloadPort", "reloadStarboard", "team", "bot", "sunk", "invulnerable", "sinks"],
  predicted: ["heading", "speed"],
  encoding: { hp: { quantize: 0.5 }, reloadPort: { quantize: 0.05 }, reloadStarboard: { quantize: 0.05 }, sunk: { quantize: 0.05 }, invulnerable: { quantize: 0.05 } },
});
export type ShipView = DataView<typeof Ship.schema>;

/** A cannonball, moved on the server; clients see it interpolated. */
export const Ball = defineComponent("pirates.Ball", { vx: f32, vy: f32, vz: f32, shooter: i32, life: f32 });
export type BallView = DataView<typeof Ball.schema>;

/** An island or rock ships can't sail through: a circle on the water. */
export const Obstacle = defineComponent("pirates.Obstacle", { radius: f32 });
export type ObstacleView = DataView<typeof Obstacle.schema>;

/**
 * Each client's per-tick helm: the point on the water the mouse is over (`steer` 0 when the mouse
 * isn't over the game), the chosen battery, and the fire button.
 */
export const Helm = defineInput("pirates.Helm", { x: f32, z: f32, steer: u8, battery: u8, fire: u8 });

/** Effects the server tells clients about: where and what. */
export const FxKind = { fire: 1, splash: 2, hit: 3, crunch: 4, sink: 5 } as const;
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
