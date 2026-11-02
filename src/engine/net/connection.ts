/**
 * Connections as data (ADR 0017, 0033): each open connection between two Worlds is a node under
 * the World root with a `net.Connection` data component, so "a player joined" is a query, not an
 * event. The network session (`session.ts`) creates and destroys these nodes; game code only reads
 * them.
 *
 * - A server World has one node per accepted client, created once the client's handshake is
 *   accepted (so its state is `open` from the first frame it's seen).
 * - A client World has one node, for its connection to the server, created when it starts
 *   connecting (`connecting`) and `open` once the server accepts the handshake.
 * - When a connection closes, its node's state becomes `closing` for the rest of that frame and
 *   the node is destroyed at the end of the frame.
 *
 * Connection nodes persist across scene loads (they aren't scene nodes) and have no transform.
 */
import { defineComponent, f32, i32, u8 } from "../core/data";

/**
 * The `net.Connection` data component. Fields:
 * - `id`: the connection's id, assigned by the server when it accepts the handshake (1, 2, …;
 *   unique per server World). The client's node has the same id as the server's node for it, so
 *   ids can name owners across Worlds (`Replicated.ownerId`). 0 on a client until accepted.
 * - `state`: a `ConnectionState` value.
 * - `rtt`: smoothed round-trip time in milliseconds. On a server, the client's measurement, as it
 *   last reported it.
 * - `lastAckedTick`: the newest tick the other end has acknowledged (set by replication, T11; 0
 *   until then).
 */
export const Connection = defineComponent("net.Connection", { id: i32, state: u8, rtt: f32, lastAckedTick: i32 });

/** Values of `Connection`'s `state` field. */
export const ConnectionState = {
  /** Client only: waiting for the transport to open and the server to accept the handshake. */
  connecting: 0,
  /** Handshake accepted: messages flow both ways. */
  open: 1,
  /** Closed this frame; the node is destroyed at the end of the frame. */
  closing: 2,
} as const;

export type ConnectionStateValue = (typeof ConnectionState)[keyof typeof ConnectionState];
