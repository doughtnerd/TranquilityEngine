/**
 * The lobby's message kinds (ADR 0068): registered with the network session at module level, so
 * every engine build that has lobbies defines them and handshakes agree. See `protocol.ts`.
 */
import { registerNetMessage } from "../session";

/** Lobby client World to lobby server World. */
export const LOBBY_C2S = registerNetMessage("lobby.c2s");
/** Lobby server World to lobby client World. */
export const LOBBY_S2C = registerNetMessage("lobby.s2c");

/** Engine internals the lobby uses through a World's `_engine` (kept structural to avoid an import cycle with `core/Engine.ts`). */
export interface LobbyEngine {
  readonly settings: { readonly bootstrap?: unknown };
  createWorld(config: import("../../core/worlds").WorldConfig | string): import("../../core/worlds").WorldHandle;
  findWorld(name: string): import("../../core/worlds").WorldHandle | null;
  worlds(): readonly import("../../core/worlds").WorldHandle[];
  _world(name: string): import("../../core/World").World | null;
  _worldConfig?(name: string): Readonly<import("../../core/worlds").WorldConfig> | null;
  _viewStates?(): readonly { readonly name: string; readonly renders: boolean; readonly paused: boolean }[];
}

/** The Engine a World belongs to, or null. */
export function engineOf(world: import("../../core/World").World): LobbyEngine | null {
  const engine = world._engine as Partial<LobbyEngine> | null;
  return engine && typeof engine.createWorld === "function" && typeof engine._world === "function" ? (engine as LobbyEngine) : null;
}

/**
 * The bootstrap a World template is looked up in: the one passed to `Engine.create`, else
 * `project.json`'s (as `Engine.createWorld(templateName)` does).
 */
export function declaredBootstrap(engine: LobbyEngine): unknown {
  const passed = (engine as unknown as { options?: { bootstrap?: unknown } }).options?.bootstrap;
  return typeof passed === "object" && passed !== null ? passed : engine.settings.bootstrap;
}

/** A random string of `bytes` bytes, as hex. */
export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
