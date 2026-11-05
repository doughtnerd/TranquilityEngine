/**
 * Connections, RPCs and inputs (ADR 0033): the data game code uses for networking. No callbacks:
 * connections are nodes with a `Connection` data component, received RPCs are buffer rows, and
 * inputs are per-tick data read per connection. Connections and RPCs are T10's (`connection.ts`,
 * `rpc.ts`, `session.ts`); inputs are T12's (`input.ts`).
 */
import type { DataView, ScalarType, Schema } from "../core/data";
import type { GameObject } from "../scene/GameObject";

/** The connection node a message came from or goes to. On a client, its one connection to the server. */
export type ConnectionNode = GameObject;

/** Connection nodes' data component and its states: see `connection.ts`. */
export { Connection, ConnectionState, type ConnectionStateValue } from "./connection";

/** Who an RPC goes to: every connection (server), one or several connection nodes, or the server (client). */
export type RpcTarget = "all" | "server" | ConnectionNode | readonly ConnectionNode[];

/** A string field type (ADR 0068): UTF-8, at most `MAX_STR_BYTES` bytes. For RPC schemas only. */
export interface StringType {
  readonly kind: "str";
}

/** The longest `str` value, in UTF-8 bytes. */
export const MAX_STR_BYTES = 255;

/**
 * A string field, for RPCs (ADR 0068): sent as UTF-8 with a length prefix, at most 255 bytes.
 * Not allowed in data components (`defineComponent` throws) or inputs.
 *
 * ```ts
 * export const Chat = defineRpc("game.Chat", { team: u8, text: str });
 * ```
 */
export const str: StringType = { kind: "str" };

/** An RPC's fields: numbers (`f32`, `i32`, `u8`) and strings (`str`). */
export type RpcSchema = Record<string, ScalarType | StringType>;

/** An RPC's values: a number per numeric field, a string per `str` field. */
export type RpcValues<S extends RpcSchema> = { [K in keyof S]: S[K] extends StringType ? string : number };

/** A received RPC: its values, plus the connection node it came from. */
export type RpcRow<S extends RpcSchema> = Readonly<RpcValues<S>> & { readonly connection: ConnectionNode };

/** A reliable message type (Unity's `IRpcCommand`). */
export interface RpcDef<S extends RpcSchema = RpcSchema> {
  readonly id: string;
  readonly schema: S;
  /** Queue a message from the current World. Sent at the end of its frame. */
  send(values: Readonly<RpcValues<S>>, to?: RpcTarget): void;
  /**
   * Messages the current World received, in arrival order: in fixedUpdate, those that arrived for
   * this fixed step; in update and lateUpdate, those that arrived this frame. Each is seen once by
   * each phase, then dropped.
   */
  read(): Iterable<RpcRow<S>>;
}

export { defineRpc } from "./rpc";

/** Options for `defineInput`. */
export interface InputOptions {
  /** Past ticks' inputs sent again with each tick's, so a lost packet doesn't lose input. Default 3. */
  readonly redundancy?: number;
}

/** A connection's input counters for one stream (server). */
export interface InputStats {
  /** Ticks simulated with their own input. */
  readonly received: number;
  /** Ticks simulated with the newest earlier input because theirs hadn't arrived (a misprediction on the client). */
  readonly repeated: number;
  /** Of those, ticks whose input arrived after all, too late to use. */
  readonly late: number;
}

/**
 * A per-tick input stream (Unity's `IInputComponentData`). Clients write their input each fixed
 * tick; the server reads each connection's input for the tick it's simulating.
 */
export interface InputDef<S extends Schema = Schema> {
  readonly id: string;
  readonly schema: S;
  /**
   * Client: this tick's input, writable (write it in fixedUpdate). Fields not written keep last
   * tick's values. Throws in a server World.
   */
  readonly local: DataView<S>;
  /** Client: set some of this tick's input fields (the rest keep last tick's values). Throws in a server World. */
  write(values: Partial<Readonly<DataView<S>>>): void;
  /**
   * Server: the input from `node`'s connection for the current server tick, or null before any
   * arrived. If this tick's is missing, the newest earlier one. Client: its own input, for its
   * connection node. `node` is a connection node; nodes owned by a connection will work too
   * (replication, T11). Null in Worlds that aren't networked.
   */
  of(node: GameObject): Readonly<DataView<S>> | null;
  /** Server: `node`'s connection's counters for this stream; null elsewhere or before its first input. */
  stats(node: GameObject): InputStats | null;
}

/**
 * Declare an input stream. Clients write it each fixed tick; packets carry the last few ticks so
 * a lost packet doesn't lose input; the server applies each at its tick. Both ends must define
 * the same streams with the same schemas.
 *
 * ```ts
 * export const Move = defineInput("game.Move", { x: f32, y: f32, jump: u8 });
 * Move.write({ x: stick.x, jump: pressed ? 1 : 0 });   // client, in fixedUpdate
 * const input = Move.of(connection);                    // server, in fixedUpdate
 * ```
 */
export { defineInput } from "./input";
