/**
 * The lobby's message kinds (ADR 0068): registered with the network session at module level, so
 * every engine build that has lobbies defines them and handshakes agree. See `protocol.ts`.
 */
import { defineMessage } from "../catalogue";

/** Lobby client World to lobby server World. */
export const LOBBY_C2S = defineMessage("lobby.c2s");
/** Lobby server World to lobby client World. */
export const LOBBY_S2C = defineMessage("lobby.s2c");

/** A random string of `bytes` bytes, as hex. */
export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
