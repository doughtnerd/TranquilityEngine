import { GameBehavior, behavior } from "tranquility";

/**
 * Marks the arena scene's node that players and shots go under. The server spawns them there; a
 * prefab ghost under a scene node spawns under the same node on clients, so they appear once the
 * client has loaded the arena too.
 */
@behavior("arena.Actors")
export class Actors extends GameBehavior {}
