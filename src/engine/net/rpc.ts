/**
 * RPCs (ADR 0033 §4): reliable one-off messages between a client World and its server, as buffers
 * rather than callbacks (ADR 0017). Sending queues a record that the network session encodes with
 * the codec and sends at the end of the frame; the receiving World reads what arrived as rows.
 *
 * Rows are readable in the frame they arrive in: in fixedUpdate, each row is seen at exactly one
 * fixed step (the one it arrived at, or the next one if it arrived in update); in update and
 * lateUpdate, during the frame it arrived in. Then it's gone. So a system reads each RPC once
 * whichever phase it runs in.
 *
 * Body: the numeric fields with the codec (`recordCodec`, in schema order), then the `str` fields
 * (ADR 0068) in schema order, each UTF-8 with a varuint byte length, at most `MAX_STR_BYTES`.
 */
import { World } from "../core/World";
import type { Schema } from "../core/data";
import { _isReplacingRegistrations } from "../core/registry";
import { createBitReader, createBitWriter, recordCodec } from "./codec";
import { MAX_STR_BYTES, type RpcDef, type RpcRow, type RpcSchema, type RpcTarget } from "./messages";
import { netSession, registerRpc } from "./session";

const defined = new Set<string>();
const encoder = new TextEncoder();

/**
 * Declare an RPC type. Both ends of a connection must define the same RPCs, with the same
 * schemas (the handshake checks), before they connect.
 *
 * ```ts
 * export const Ready = defineRpc("game.Ready", { team: u8, name: str });
 * Ready.send({ team: 1, name: "Anne" });                          // a client tells the server
 * for (const m of Ready.read()) assignTeam(m.connection, m.team); // in a server system
 * ```
 */
export function defineRpc<S extends RpcSchema>(id: string, schema: S): RpcDef<S> {
  if (typeof id !== "string" || id.trim() === "" || /[()]/.test(id)) throw new Error(`defineRpc: the id must be a non-empty string without parentheses (got ${JSON.stringify(id)}).`);
  if (defined.has(id) && !_isReplacingRegistrations()) throw new Error(`RPC "${id}" is already defined.`);
  if ("connection" in schema) throw new Error(`defineRpc("${id}"): a field can't be named "connection"; received rows use it for the connection node.`);
  const all = Object.keys(schema);
  const strings = all.filter((f) => schema[f].kind === "str");
  const numeric: Schema = {};
  for (const f of all) if (schema[f].kind !== "str") numeric[f] = schema[f] as Schema[string];
  const codec = recordCodec(numeric);
  const numbers = codec.fields;
  const descriptor = `${id}(${all.map((f) => `${f}:${schema[f].kind}`).join(",")})`;
  defined.add(id);
  const entry = {
    id,
    descriptor,
    decode: (data: Uint8Array) => {
      const r = createBitReader(data);
      const values: Record<string, number | string> = codec.read(r);
      for (const f of strings) {
        const s = r.readString();
        if (encoder.encode(s).byteLength > MAX_STR_BYTES) throw new RangeError(`RPC "${id}": field "${f}" is over ${MAX_STR_BYTES} bytes`);
        values[f] = s;
      }
      return values;
    },
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
      const v = values as Record<string, unknown>;
      for (const f of numbers) {
        if (typeof v[f] !== "number") throw new Error(`RPC "${id}".send: field "${f}" must be a number (got ${v[f] === undefined ? "nothing" : typeof v[f]}).`);
      }
      for (const f of strings) {
        if (typeof v[f] !== "string") throw new Error(`RPC "${id}".send: field "${f}" must be a string (got ${v[f] === undefined ? "nothing" : typeof v[f]}).`);
        const bytes = encoder.encode(v[f] as string).byteLength;
        if (bytes > MAX_STR_BYTES) throw new Error(`RPC "${id}".send: field "${f}" is ${bytes} bytes of UTF-8; str fields hold at most ${MAX_STR_BYTES}.`);
      }
      const w = createBitWriter();
      codec.write(w, v as Record<string, number>);
      for (const f of strings) w.writeString(v[f] as string);
      session.sendRpc(entry, w.finish(), to);
    },
    read() {
      return (netSession(World.require())?.readRpc(id) ?? []) as unknown as RpcRow<S>[];
    },
  };
}
