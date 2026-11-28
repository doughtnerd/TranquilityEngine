/**
 * The net message catalogue (ADR 0457): every message kind and RPC type this process can send, the
 * one list the handshake compares and numbers. Netcode modules define their kinds here (snapshots,
 * acks, lobby messages, one kind per input stream), `defineRpc` its RPC types, and the editor
 * forgets what a deleted or changed script defined, so a hello lists what's defined now, whatever
 * was defined and forgotten before (two processes with different reload histories agree).
 *
 * **Local kind ids are positions.** `defineMessage` returns a small number that never changes and is
 * never reused: forgetting a kind takes it out of the handshake, not out of the numbering. So a
 * connection that numbered its kinds at its handshake (`handshakeSet`) keeps sending and receiving a
 * kind forgotten since, and a kind defined again under the same name gets its old id back.
 *
 * **When the set is captured.** Each connection captures `handshakeSet()` once: a client when it
 * sends its hello (and numbers with that capture when the welcome arrives), a server when it checks
 * the hello. Definitions made or forgotten later change the next connection's handshake only.
 *
 * **Kind names.** Engine kinds are plain names (`net.snapshot`, `lobby.c2s`); an input stream's kind
 * is `net.input:<id>(<signature>)` (`inputKindName`), carrying its schema as the codec describes it
 * (`schemaSignature`), so a difference there reads as the game's definitions differing, like an
 * RPC's. `describeKind` tells the two apart; nothing else parses the names.
 */

/** @internal An RPC type as the session sees it (defined by `defineRpc`). */
export interface RpcEntry {
  readonly id: string;
  /** Its id and schema, compared in the handshake: `game.Ready(team:u8)`. */
  readonly descriptor: string;
  /** Decode a received body to values (numbers, and strings for `str` fields). */
  decode(data: Uint8Array): Record<string, number | string>;
}

/** What one connection's handshake carries and numbers, captured at once (see the top of this file). */
export interface HandshakeSet {
  /** RPC descriptors, sorted: the hello's list. */
  readonly rpcDescriptors: readonly string[];
  /** RPC types by wire number (sorted by id). */
  readonly rpcs: readonly RpcEntry[];
  /** Message kind names, sorted: the hello's list. */
  readonly kindNames: readonly string[];
  /** Local kind ids by wire order (the names sorted). */
  readonly kinds: readonly number[];
}

/** What a kind's name says. */
export type KindDescription =
  /** An input stream's kind: `descriptor` is `<id>(<signature>)`, compared like an RPC's. */
  | { readonly family: "input"; readonly descriptor: string }
  /** One of the engine's own kinds: a difference means different engine versions. */
  | { readonly family: "engine"; readonly descriptor: string };

const INPUT_PREFIX = "net.input:";

/** Kind names by local id: only ever appended to. */
const kinds: string[] = [];
const idByName = new Map<string, number>();
/** Local ids of the kinds defined now (the rest were forgotten). */
const live = new Set<number>();
const rpcs = new Map<string, RpcEntry>();

/** Throw unless `id` can name an RPC or input stream: a non-empty string without parentheses (they delimit its schema on the wire). */
export function checkMessageId(what: string, id: string): void {
  if (typeof id !== "string" || id.trim() === "" || /[()]/.test(id)) throw new Error(`${what}: the id must be a non-empty string without parentheses (got ${JSON.stringify(id)}).`);
}

/**
 * @internal Define a message kind for netcode internals (snapshots, acks, inputs). Returns its local
 * id, for `send` and `drain`. Defining a name again (forgotten or not) returns the same id.
 */
export function defineMessage(name: string): number {
  let id = idByName.get(name);
  if (id === undefined) {
    id = kinds.push(name) - 1;
    idByName.set(name, id);
  }
  live.add(id);
  return id;
}

/** @internal Take a kind out of the handshake (its definition went). Its id stays its own; open connections keep their numbering. */
export function forgetMessage(name: string): void {
  const id = idByName.get(name);
  if (id !== undefined) live.delete(id);
}

/** @internal Make an RPC type known to sessions (by `defineRpc`). A later entry with the same id replaces it. */
export function defineRpcEntry(entry: RpcEntry): void {
  rpcs.set(entry.id, entry);
}

/** @internal Take an RPC type out of the handshake (the script that defined it went). Open connections keep their numbering. */
export function forgetRpc(id: string): void {
  rpcs.delete(id);
}

/** @internal Whether an RPC type is defined now. */
export function hasRpc(id: string): boolean {
  return rpcs.has(id);
}

/** @internal A local kind id's name (also a forgotten one's), or undefined for an id never defined. */
export function kindName(local: number): string | undefined {
  return kinds[local];
}

/** @internal The kind name of input stream `id` whose schema travels as `signature` (`RecordCodec.signature`). */
export function inputKindName(id: string, signature: string): string {
  return `${INPUT_PREFIX}${id}(${signature})`;
}

/** @internal Whether a kind name is an input stream's or the engine's own, and its descriptor for mismatch reports. */
export function describeKind(name: string): KindDescription {
  return name.startsWith(INPUT_PREFIX) ? { family: "input", descriptor: name.slice(INPUT_PREFIX.length) } : { family: "engine", descriptor: name };
}

/** @internal What a connection's handshake carries and numbers now (see the top of this file). */
export function handshakeSet(): HandshakeSet {
  const ids = [...rpcs.keys()].sort();
  const names = [...live].map((id) => kinds[id]).sort();
  return {
    rpcDescriptors: [...rpcs.values()].map((r) => r.descriptor).sort(),
    rpcs: ids.map((id) => rpcs.get(id)!),
    kindNames: names,
    kinds: names.map((n) => idByName.get(n)!),
  };
}
