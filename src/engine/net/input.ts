/**
 * Input streams (ADR 0033 §5, T12): per-tick input from each client to the server, as data rather
 * than callbacks (ADR 0017). Unity's `IInputComponentData` and command buffers.
 *
 * - A client World writes this tick's input during fixedUpdate (`Move.write({ x })`, or the
 *   writable `Move.local`). Fields it doesn't write keep last tick's values. The input is stored
 *   under the client's `time.network.serverTick` (the prediction timeline).
 * - The server reads `Move.of(connectionNode)`: that connection's input for the current server
 *   tick, read-only, or null before any input arrived. If a tick's input is missing (lost, or
 *   late), the newest earlier one is repeated and counted (`Move.stats(node).repeated`): a
 *   misprediction source for T13.
 *
 * ## Wire format
 *
 * One registered message kind per stream, `net.input:<id>(<field>:<type>,…)` (so the handshake
 * refuses a client whose input schemas differ), on the unreliable channel. The session header's
 * tick is the newest input's tick, T. The body is a varuint count n, then the inputs for ticks
 * T-n+1 … T, oldest first: the first whole, each next delta-encoded against the one before it with
 * the stream's `recordCodec` (a changed bit per field, then the changed fields). Each packet is
 * self-contained, so it needs no acks. n is at most `redundancy + 1` (default 3 + 1): a lost packet
 * loses nothing as long as one of the next `redundancy` packets arrives.
 *
 * ## Timing
 *
 * Inputs are tagged with the client's `serverTick`, which runs RTT/2 plus the command slack
 * (`session.ts`, default 2 ticks) ahead of the server, so an input arrives about `commandSlack`
 * ticks before the server simulates its tick. The server buffers inputs per connection by tick,
 * applies each at its tick, and drops those for ticks it has already simulated: an input that
 * arrives after its tick was simulated with a repeated input counts as `late`.
 *
 * ## System order
 *
 * - `engine.NetInputTick` (fixedUpdate, after `engine.NetReceiveTick`, before
 *   `engine.FixedUpdateScripts` and so before physics and user systems):
 *   - server: drains received inputs into the per-connection buffers and applies this tick's, so
 *     every script and system of the tick reads the same input with `of()`;
 *   - client: sends the previous fixed step's input (so writes from any fixedUpdate script or
 *     system of that step are in it, whatever their order), then starts this step's input at this
 *     step's `serverTick`, carrying over last tick's values.
 * - `engine.NetInputSend` (lateUpdate, before `engine.NetSend`): client: sends the frame's last
 *   fixed step's input, so it leaves with the frame's other messages rather than a frame later.
 * Both do nothing in Worlds without a session. A client sends nothing until its connection is open.
 *
 * ## Extension points
 *
 * - Ownership (T11): `of(node)` accepts a connection node. `registerInputOwnerResolver` lets
 *   replication map another node (a ghost owned by a connection, `Replicated.owner`) to its
 *   connection node, on both ends.
 * - Prediction (T13): `inputAt(def, world, tick)` returns a client's input for a past tick, and
 *   `setInputReplayTick(world, tick)` makes `of()` return that tick's input while re-simulating.
 */
import { World } from "../core/World";
import type { DataView, Schema } from "../core/data";
import { _isReplacingRegistrations } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { createBitReader, createBitWriter, recordCodec, type RecordCodec } from "./codec";
import type { InputDef, InputOptions } from "./messages";
import { netSession, registerNetMessage, type NetPeer, type NetSession } from "./session";

/** Past inputs sent with each packet when `defineInput` isn't given `redundancy`. */
export const DEFAULT_INPUT_REDUNDANCY = 3;

/** A client keeps this many ticks of its own input (for redundancy, and T13's re-simulation). */
const CLIENT_HISTORY = 128;
/** A server buffers inputs at most this many ticks ahead of its tick; further ones are dropped. */
const MAX_AHEAD = 128;
/** A server remembers this many repeated ticks, to count their inputs late if they turn up. */
const MISSED_KEPT = 256;
/** Inputs per packet at most, whatever `redundancy` says (and what a receiver accepts). */
const MAX_PER_PACKET = 32;

type Values = Record<string, number>;

/** A client World's state for one stream. */
interface ClientState {
  /** What the game writes: this tick's input. */
  readonly current: Values;
  /** Sent inputs by tick, as the server will decode them. */
  readonly history: Map<number, Readonly<Values>>;
  /** The tick the current input is for, and whether it's been sent. */
  tick: number;
  pending: boolean;
  /** Newest tick in `history`; -1 before the first. */
  newest: number;
}

/** A server's state for one stream from one connection. */
interface PeerState {
  /** Received inputs for ticks not yet simulated. */
  readonly buffer: Map<number, Readonly<Values>>;
  /** Ticks simulated with a repeated input, whose own input might still turn up (late). */
  readonly missed: Set<number>;
  /** The input applied at the current tick; null before the first. */
  current: Readonly<Values> | null;
  /** The newest tick simulated (inputs for it or earlier are dropped). */
  simulated: number;
  readonly stats: { received: number; repeated: number; late: number };
}

/** One defined stream, as the built-in systems see it. */
interface Stream {
  readonly id: string;
  readonly kind: number;
  readonly codec: RecordCodec;
  readonly fields: readonly string[];
  readonly coerce: (values: Values) => Values;
  readonly redundancy: number;
  readonly clients: WeakMap<World, ClientState>;
  readonly servers: WeakMap<NetSession, Map<NetPeer, PeerState>>;
}

const streams = new Map<string, Stream>();

/** Client Worlds: the `serverTick` of their latest fixed step (-1 while not connected). */
const fixedTicks = new WeakMap<World, number>();

// --- extension points ---------------------------------------------------------------------------

/** Maps a node to the connection node whose input it reads (T11: a ghost to its owner's connection). */
export type InputOwnerResolver = (world: World, node: GameObject) => GameObject | null;

const ownerResolvers: InputOwnerResolver[] = [];

/** @internal Let `of(node)` accept nodes other than connection nodes (replication, T11). */
export function registerInputOwnerResolver(resolver: InputOwnerResolver): void {
  if (!ownerResolvers.includes(resolver)) ownerResolvers.push(resolver);
}

/** The connection node `node` stands for: itself if it's one, else what a resolver says. */
function connectionOf(session: NetSession, world: World, node: GameObject): NetPeer | null {
  const peer = session.peerOf(node);
  if (peer) return peer;
  for (const resolve of ownerResolvers) {
    const owner = resolve(world, node);
    if (owner) return session.peerOf(owner);
  }
  return null;
}

const replayTicks = new WeakMap<World, number>();

/** @internal Prediction (T13): while set, a client's `of()` returns its input for `tick`. null clears it. */
export function setInputReplayTick(world: World, tick: number | null): void {
  if (tick === null) replayTicks.delete(world);
  else replayTicks.set(world, tick);
}

/** @internal Prediction (T13): a client World's input for `tick`, as the server gets it; null if it has none. */
export function inputAt<S extends Schema>(def: InputDef<S>, world: World, tick: number): Readonly<DataView<S>> | null {
  const state = streams.get(def.id)?.clients.get(world);
  return (state?.history.get(tick) as Readonly<DataView<S>> | undefined) ?? null;
}

// --- defining -----------------------------------------------------------------------------------

/**
 * Declare an input stream. Both ends of a connection must define the same streams, with the same
 * schemas (the handshake checks), before they connect.
 *
 * ```ts
 * export const Move = defineInput("game.Move", { x: f32, y: f32, jump: u8 });
 * Move.write({ x: stick.x, jump: pressed ? 1 : 0 });      // client, in fixedUpdate
 * const input = Move.of(connection);                       // server, in fixedUpdate
 * if (input) body.velocity.x = input.x * speed;
 * ```
 */
export function defineInput<S extends Schema>(id: string, schema: S, options: InputOptions = {}): InputDef<S> {
  if (typeof id !== "string" || id.trim() === "" || /[()]/.test(id)) throw new Error(`defineInput: the id must be a non-empty string without parentheses (got ${JSON.stringify(id)}).`);
  if (streams.has(id) && !_isReplacingRegistrations()) throw new Error(`Input "${id}" is already defined.`);
  const redundancy = options.redundancy ?? DEFAULT_INPUT_REDUNDANCY;
  if (!(Number.isInteger(redundancy) && redundancy >= 0 && redundancy < MAX_PER_PACKET)) {
    throw new Error(`defineInput("${id}"): redundancy must be an integer from 0 to ${MAX_PER_PACKET - 1} (got ${redundancy}).`);
  }
  const codec = recordCodec(schema) as RecordCodec;
  const fields = codec.fields;
  const kinds = fields.map((f) => schema[f].kind);
  const descriptor = `net.input:${id}(${fields.map((f, i) => `${f}:${kinds[i]}`).join(",")})`;
  const coerce = (values: Values): Values => {
    const out: Values = {};
    for (let i = 0; i < fields.length; i++) {
      const v = values[fields[i]];
      out[fields[i]] = kinds[i] === "f32" ? Math.fround(v) : kinds[i] === "i32" ? v | 0 : v & 0xff;
    }
    return out;
  };
  const stream: Stream = {
    id,
    kind: registerNetMessage(descriptor),
    codec,
    fields,
    coerce,
    redundancy,
    clients: streams.get(id)?.clients ?? new WeakMap(),
    servers: streams.get(id)?.servers ?? new WeakMap(),
  };
  streams.set(id, stream);

  const clientState = (world: World, what: string): ClientState => {
    if (netSession(world)?.isServer) throw new Error(`Can't ${what} input "${id}" in World "${world.name}": it's a network server; read clients' input with ${id}.of(connection).`);
    let state = stream.clients.get(world);
    if (!state) {
      const current: Values = {};
      for (const f of fields) current[f] = 0;
      // First written during a fixed step: the input is for that step's tick.
      const tick = fixedTicks.get(world) ?? -1;
      stream.clients.set(world, (state = { current, history: new Map(), tick, pending: tick >= 0, newest: -1 }));
    }
    return state;
  };

  const def: InputDef<S> = {
    id,
    schema,
    get local() {
      return clientState(World.require(), "write").current as DataView<S>;
    },
    write(values) {
      const state = clientState(World.require(), "write");
      for (const key of Object.keys(values)) {
        const v = (values as Record<string, unknown>)[key];
        if (!fields.includes(key)) throw new Error(`Input "${id}".write: there's no field "${key}" (fields: ${fields.join(", ")}).`);
        if (typeof v !== "number") throw new Error(`Input "${id}".write: field "${key}" must be a number (got ${typeof v}).`);
        state.current[key] = v;
      }
    },
    of(node) {
      const world = World.require();
      const session = netSession(world);
      if (!session) return null;
      if (session.isServer) {
        const peer = connectionOf(session, world, node);
        const state = peer ? stream.servers.get(session)?.get(peer) : undefined;
        return (state?.current as Readonly<DataView<S>> | undefined) ?? null;
      }
      // A client has its own input only, for its connection node (or a node it owns, T11).
      const peer = connectionOf(session, world, node);
      if (!peer || peer !== session.serverPeer) return null;
      const state = stream.clients.get(world);
      if (!state) return null;
      const replay = replayTicks.get(world);
      if (replay !== undefined) return (state.history.get(replay) as Readonly<DataView<S>> | undefined) ?? null;
      return state.current as Readonly<DataView<S>>;
    },
    stats(node) {
      const world = World.require();
      const session = netSession(world);
      if (!session?.isServer) return null;
      const peer = connectionOf(session, world, node);
      const state = peer ? stream.servers.get(session)?.get(peer) : undefined;
      return state ? { ...state.stats } : null;
    },
  };
  defs.set(id, def as unknown as InputDef<Schema>); // T15 tools
  return def;
}

// --- T15 tools (additive): the editor's Network panel and thin clients --------------------------

/** Defined streams, by id (the newest definition of each). */
const defs = new Map<string, InputDef<Schema>>();

/** @internal Editor tools: every defined input stream. */
export function definedInputs(): InputDef<Schema>[] {
  return [...defs.values()];
}

// --- client -------------------------------------------------------------------------------------

/** Store the pending input under its tick and send it with the ones before it. */
function commit(stream: Stream, session: NetSession, state: ClientState): void {
  state.pending = false;
  const tick = state.tick;
  if (tick < 0) return;
  const values = stream.coerce(state.current);
  // serverTick can skip a tick when the estimate is corrected: those ticks get this input too.
  if (state.newest >= 0 && tick > state.newest + 1) {
    const prev = state.history.get(state.newest) ?? values;
    for (let t = Math.max(state.newest + 1, tick - stream.redundancy); t < tick; t++) state.history.set(t, prev);
  }
  state.history.set(tick, values);
  state.newest = Math.max(state.newest, tick);
  for (const t of state.history.keys()) {
    if (t > state.newest - CLIENT_HISTORY) break; // in insertion order, oldest first
    state.history.delete(t);
  }

  // The newest input and up to `redundancy` before it, as long as the ticks are consecutive.
  const newest = state.newest;
  let count = 1;
  while (count <= stream.redundancy && state.history.has(newest - count)) count++;
  const w = createBitWriter();
  w.writeVarUint(count);
  let baseline: Values | undefined;
  for (let t = newest - count + 1; t <= newest; t++) {
    const v = state.history.get(t)!;
    stream.codec.write(w, v, baseline);
    baseline = v;
  }
  session.send(stream.kind, "server", "unreliable", w.finish(), newest);
}

function clientTick(world: World, session: NetSession): void {
  const peer = session.serverPeer;
  const open = peer?.state === "open";
  fixedTicks.set(world, open ? session.time.serverTick : -1);
  for (const stream of streams.values()) {
    const state = stream.clients.get(world);
    if (!state) continue; // never written: nothing to send
    if (state.pending && open) commit(stream, session, state);
    if (!open) {
      // Not connected (yet, or any more): a new connection starts a new history.
      state.history.clear();
      state.newest = -1;
    }
    state.tick = open ? session.time.serverTick : -1;
    state.pending = open;
  }
}

function clientSend(world: World, session: NetSession): void {
  if (session.serverPeer?.state !== "open") return;
  for (const stream of streams.values()) {
    const state = stream.clients.get(world);
    if (state?.pending) commit(stream, session, state);
  }
}

// --- server -------------------------------------------------------------------------------------

function serverTick(session: NetSession): void {
  const tick = session.tick;
  for (const stream of streams.values()) {
    let peers = stream.servers.get(session);
    if (!peers) stream.servers.set(session, (peers = new Map()));
    for (const peer of peers.keys()) if (peer.state === "closed") peers.delete(peer);

    for (const m of session.drain(stream.kind)) {
      if (m.peer.state === "closed") continue;
      let state = peers.get(m.peer);
      if (!state) peers.set(m.peer, (state = { buffer: new Map(), missed: new Set(), current: null, simulated: tick - 1, stats: { received: 0, repeated: 0, late: 0 } }));
      receive(stream, state, m.tick, m.data);
    }

    for (const state of peers.values()) {
      const input = state.buffer.get(tick);
      if (input) {
        state.current = input;
        state.stats.received++;
      } else if (state.current) {
        state.stats.repeated++;
        state.missed.add(tick);
        if (state.missed.size > MISSED_KEPT) state.missed.delete(state.missed.values().next().value!);
      }
      state.simulated = tick;
      for (const t of state.buffer.keys()) if (t <= tick) state.buffer.delete(t);
    }
  }
}

/** Decode one packet into a connection's buffer. A malformed one is dropped. */
function receive(stream: Stream, state: PeerState, newest: number, data: Uint8Array): void {
  let decoded: Readonly<Values>[];
  try {
    const r = createBitReader(data);
    const count = r.readVarUint();
    if (count < 1 || count > MAX_PER_PACKET) return;
    decoded = [];
    let baseline: Values | undefined;
    for (let i = 0; i < count; i++) {
      const v = stream.codec.read(r, baseline) as Values;
      decoded.push(Object.freeze(v));
      baseline = v;
    }
  } catch {
    return; // truncated: unreliable messages from a misbehaving client aren't worth a disconnect
  }
  const first = newest - decoded.length + 1;
  for (let i = 0; i < decoded.length; i++) {
    const t = first + i;
    if (t <= state.simulated) {
      // Already simulated: late if that tick repeated an input; otherwise a redundant copy.
      if (state.missed.delete(t)) state.stats.late++;
    } else if (t <= state.simulated + MAX_AHEAD && !state.buffer.has(t)) {
      state.buffer.set(t, decoded[i]);
    }
  }
}

// --- built-in systems ---------------------------------------------------------------------------

defineBuiltinSystem({
  name: "engine.NetInputTick",
  phase: "fixedUpdate",
  after: ["engine.NetReceiveTick"],
  before: ["engine.FixedUpdateScripts"],
  run(world) {
    const session = netSession(world);
    if (session?.isServer) serverTick(session);
    else if (session?.isClient) clientTick(world, session);
  },
});
defineBuiltinSystem({
  name: "engine.NetInputSend",
  phase: "lateUpdate",
  before: ["engine.NetSend"],
  run(world) {
    const session = netSession(world);
    if (session?.isClient) clientSend(world, session);
  },
});
