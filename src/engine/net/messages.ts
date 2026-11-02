/**
 * Connections, RPCs and inputs (ADR 0033): the data game code uses for networking. No callbacks:
 * connections are nodes with a `Connection` data component, received RPCs are buffer rows, and
 * inputs are per-tick data on the player's node. Implemented by T10 (connections, RPCs) and T12
 * (inputs).
 */
import { notYet } from "../core/worlds";
import type { DataView, Schema } from "../core/data";
import type { GameObject } from "../scene/GameObject";

/** The connection node a message came from or goes to. On a client, its one connection to the server. */
export type ConnectionNode = GameObject;

/** Schema of the `net.Connection` data component on connection nodes (defined by T10). */
export const CONNECTION_FIELDS = ["id", "state", "rtt", "lastAckedTick"] as const;

/** Values of `net.Connection`'s `state` field. */
export const ConnectionStates = { connecting: 0, open: 1, closing: 2 } as const;

/** Who an RPC goes to: every connection (server), one or several connection nodes, or the server (client). */
export type RpcTarget = "all" | "server" | ConnectionNode | readonly ConnectionNode[];

/** A received RPC: its values, plus the connection node it came from. */
export type RpcRow<S extends Schema> = DataView<S> & { readonly connection: ConnectionNode };

/** A reliable message type (Unity's `IRpcCommand`). */
export interface RpcDef<S extends Schema = Schema> {
  readonly id: string;
  readonly schema: S;
  /** Queue a message from the current World. Sent at the end of its frame. */
  send(values: Readonly<Record<keyof S, number>>, to?: RpcTarget): void;
  /** Messages the current World received this frame, in arrival order. Cleared at the end of the frame. */
  read(): Iterable<RpcRow<S>>;
}

/**
 * Declare an RPC type.
 *
 * ```ts
 * export const Ready = defineRpc("game.Ready", { team: u8 });
 * Ready.send({ team: 1 });                                    // a client tells the server
 * for (const m of Ready.read()) assignTeam(m.connection, m.team); // in a server system
 * ```
 */
export function defineRpc<S extends Schema>(id: string, _schema: S): RpcDef<S> {
  return notYet("T10", `defineRpc(${JSON.stringify(id)})`);
}

/** A per-tick input stream (Unity's `IInputComponentData`). */
export interface InputDef<S extends Schema = Schema> {
  readonly id: string;
  readonly schema: S;
  /** Client: this tick's input for the local player's node (write it in fixedUpdate). Server: the input applied at the current tick. */
  of(node: GameObject): DataView<S> | null;
}

/**
 * Declare an input stream. Clients write it each fixed tick on the node they own; packets carry
 * the last few ticks so a lost packet doesn't lose input; the server applies each at its tick.
 *
 * ```ts
 * export const Move = defineInput("game.Move", { x: f32, y: f32, jump: u8 });
 * ```
 */
export function defineInput<S extends Schema>(id: string, _schema: S): InputDef<S> {
  return notYet("T12", `defineInput(${JSON.stringify(id)})`);
}
