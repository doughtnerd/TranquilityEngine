/**
 * RPCs (ADR 0033 §4): reliable one-off messages between a client World and its server, as buffers
 * rather than callbacks (ADR 0017). Sending queues a record that the network session encodes with
 * the codec and sends at the end of the frame; the receiving World reads what arrived as rows.
 *
 * Rows are readable in the frame they arrive in: in fixedUpdate, each row is seen at exactly one
 * fixed step (the one it arrived at, or the next one if it arrived in update); in update and
 * lateUpdate, during the frame it arrived in. Then it's gone. So a system reads each RPC once
 * whichever phase it runs in.
 */
import { World } from "../core/World";
import type { Schema } from "../core/data";
import { _isReplacingRegistrations } from "../core/registry";
import { createBitReader, createBitWriter, recordCodec } from "./codec";
import type { RpcDef, RpcRow, RpcTarget } from "./messages";
import { netSession, registerRpc } from "./session";

const defined = new Set<string>();

/**
 * Declare an RPC type. Both ends of a connection must define the same RPCs, with the same
 * schemas (the handshake checks), before they connect.
 *
 * ```ts
 * export const Ready = defineRpc("game.Ready", { team: u8 });
 * Ready.send({ team: 1 });                                        // a client tells the server
 * for (const m of Ready.read()) assignTeam(m.connection, m.team); // in a server system
 * ```
 */
export function defineRpc<S extends Schema>(id: string, schema: S): RpcDef<S> {
  if (typeof id !== "string" || id.trim() === "" || /[()]/.test(id)) throw new Error(`defineRpc: the id must be a non-empty string without parentheses (got ${JSON.stringify(id)}).`);
  if (defined.has(id) && !_isReplacingRegistrations()) throw new Error(`RPC "${id}" is already defined.`);
  if ("connection" in schema) throw new Error(`defineRpc("${id}"): a field can't be named "connection"; received rows use it for the connection node.`);
  const codec = recordCodec(schema);
  const fields = codec.fields;
  const descriptor = `${id}(${fields.map((f) => `${f}:${schema[f].kind}`).join(",")})`;
  defined.add(id);
  const entry = {
    id,
    descriptor,
    decode: (data: Uint8Array) => codec.read(createBitReader(data)) as Record<string, number>,
  };
  registerRpc(entry);

  return {
    id,
    schema,
    send(values, to?: RpcTarget) {
      const world = World.require();
      const session = netSession(world);
      if (!session || !(session.isServer || session.isClient)) {
        throw new Error(`Can't send RPC "${id}" from World "${world.name}": it isn't networked (link it to another World first).`);
      }
      for (const f of fields) {
        const v = (values as Record<string, unknown>)[f];
        if (typeof v !== "number") throw new Error(`RPC "${id}".send: field "${f}" must be a number (got ${v === undefined ? "nothing" : typeof v}).`);
      }
      const w = createBitWriter();
      codec.write(w, values);
      session.sendRpc(entry, w.finish(), to);
    },
    read() {
      return (netSession(World.require())?.readRpc(id) ?? []) as unknown as RpcRow<S>[];
    },
  };
}
