// The arena's data (ADR 0017, 0033): components, the input stream and the rules every World
// shares. Client and server load the same scripts, so both ends define the same replicated
// components and inputs, as the handshake requires.
import { GameObject, Replicated, defineComponent, defineInput, f32, i32, replicate, u8, type DataView } from "myco";

/** Scenes and the Worlds the menu makes (templates in project.json's bootstrap). */
export const ARENA_SCENE = "scenes/arena.scene.json";
export const SERVER_WORLD = "Server";
export const SECOND_CLIENT_WORLD = "Client 2";
export const PLAYER_PREFAB = "prefabs/player.prefab.json";
export const SHOT_PREFAB = "prefabs/shot.prefab.json";

/** Where a dedicated server (`npm run server -- samples/arena`) listens by default. */
export const DEDICATED_SERVER_URL = "ws://localhost:7777";

/** The playing field: players and shots stay inside ±HALF_WIDTH × ±HALF_HEIGHT. */
export const HALF_WIDTH = 7.5;
export const HALF_HEIGHT = 5.5;
export const PLAYER_RADIUS = 0.45;
export const PLAYER_SPEED = 6;
export const SHOT_RADIUS = 0.15;
export const SHOT_SPEED = 14;
export const SHOT_LIFE = 1.2;
/** Seconds between shots while fire is held. */
export const FIRE_COOLDOWN = 0.3;

/** Where players start and respawn, in order of connection id. */
export const SPAWN_POINTS: readonly (readonly [number, number])[] = [
  [-5.5, 3.5],
  [5.5, -3.5],
  [5.5, 3.5],
  [-5.5, -3.5],
];

/** One color per connection id (cycled), so each player looks the same in every World. */
export const PLAYER_COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#f06292"];

/**
 * A player. `score` is the server's and replicated; `aimX`/`aimY` (the last direction moved) are
 * predicted, since the predicted movement system sets them; `cooldown` stays on the server.
 */
export const Player = defineComponent("arena.Player", { score: i32, aimX: f32, aimY: f32, cooldown: f32 });
replicate(Player, { fields: ["score", "aimX", "aimY"], predicted: ["aimX", "aimY"] });

/** A shot, moved and checked for hits on the server only; clients see it interpolated. */
export const Shot = defineComponent("arena.Shot", { vx: f32, vy: f32, shooter: i32, life: f32 });

/** Each client's per-tick input (Unity's `IInputComponentData`): a move direction and the fire button. */
export const Move = defineInput("arena.Move", { x: f32, y: f32, fire: u8 });

export type PlayerView = DataView<typeof Player.schema>;

/** A client World's connection to its server, as `arena.WatchConnection` last saw it. */
export type ClientConnection = "none" | "connecting" | "open" | "lost";

/**
 * Client Worlds' connection states, keyed by the World's clock (Worlds share these modules, so
 * state is per World): a behavior's `this.time` is the same object as a system's `ctx.time` in
 * that World.
 */
export const connectionStates = new WeakMap<object, ClientConnection>();

/** A player in the current World. */
export interface PlayerInfo {
  readonly node: GameObject;
  readonly rep: Replicated;
  readonly data: PlayerView;
}

/** The players in the current World (nodes with `Player` and `Replicated`), by owner id. */
export function players(): PlayerInfo[] {
  const out: PlayerInfo[] = [];
  for (const rep of GameObject.findObjectsOfType(Replicated)) {
    const data = rep.node.getData(Player) as PlayerView | null;
    if (data) out.push({ node: rep.node, rep, data });
  }
  return out.sort((a, b) => a.rep.ownerId - b.rep.ownerId);
}
