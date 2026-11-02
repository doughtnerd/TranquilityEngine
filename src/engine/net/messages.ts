/**
 * Connections, RPCs and inputs (ADR 0033): the data game code uses for networking. No callbacks:
 * connections are nodes with a `Connection` data component, received RPCs are buffer rows, and
 * inputs are per-tick data on the player's node. Connections and RPCs are T10's
 * (`connection.ts`, `rpc.ts`, `session.ts`); inputs are T12's.
 */
import { notYet } from "../core/worlds";
import type { DataView, Schema } from "../core/data";
import type { GameObject } from "../scene/GameObject";

/** The connection node a message came from or goes to. On a client, its one connection to the server. */
export type ConnectionNode = GameObject;

/** Connection nodes' data component and its states: see `connection.ts`. */
export { Connection, ConnectionState, type ConnectionStateValue } from "./connection";

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
  /**
   * Messages the current World received, in arrival order: in fixedUpdate, those that arrived for
   * this fixed step; in update and lateUpdate, those that arrived this frame. Each is seen once by
   * each phase, then dropped.
   */
  read(): Iterable<RpcRow<S>>;
}

export { defineRpc } from "./rpc";

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
