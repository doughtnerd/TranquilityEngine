/**
 * Input streams (ADR 0033 §5, T12): per-tick input from each client to the server, as data rather
 * than callbacks (ADR 0017). Unity's `IInputComponentData` and command buffers.
 *
 * - A client World writes this tick's input during fixedUpdate (`Move.write({ x })`, or the
 *   writable `Move.local`). Fields it doesn't write keep last tick's values. The input is stored
 *   under the client's `time.network.serverTick` (the prediction timeline). A tick's input is sent
 *   once: a second fixed step on the same `serverTick` (it held while its estimate came back)
 *   sends nothing more for that tick, and its writes carry over to the next. The client's own
 *   `of()` gives values as they travel (f32, quantized, i32, u8), as the server will read them.
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
 * **Local players.** A client may send input for several of its local players (local co-op over
 * one connection, ADR 0337): `write(values, player)`. Each player's inputs travel in their own
 * packets and are buffered, repeated and counted on their own; the server reads them with
 * `of(node, player)`. Player 0's packets are as above; another player's body starts with a varuint
 * 0 (never a valid count), then the player's index as a varuint, then the count and inputs.
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
 * ## What the session answers (ADR 0311)
 *
 * - Ownership (T11): `of(node)` accepts a connection node, or a node with `Replicated` whose
 *   `ownerId` the session says a connection owns (`session.ownerPeer`), on both ends.
 * - Prediction (T13): a client keeps its input for past ticks; while prediction replays a tick
 *   (`session.replay`, `session.replayTick`), `of()` returns that tick's input (the newest earlier
 *   one if that tick has none, as the server repeats it).
 */
import { World } from "../core/World";
import { _recordRegistration } from "../core/registry";
import type { DataView, Schema } from "../core/data";
import { _isReplacingRegistrations } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { createBitReader, createBitWriter, recordCodec, type RecordCodec } from "./codec";
import type { InputDef, InputOptions } from "./messages";
import { Replicated } from "./Replicated";
import { netSession, registerNetMessage, type NetPeer, type NetSession } from "./session";
import { TickHistory } from "./tickHistory";

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
/** Local players per connection at most (indices 0 … MAX_LOCAL_PLAYERS - 1). */
export const MAX_LOCAL_PLAYERS = 64;

type Values = Record<string, number>;

/** A client World's state for one stream. */
interface ClientState {
  /** What the game writes: this tick's input. */
  readonly current: Values;
  /** Sent inputs by tick, as the server will decode them: the newest `CLIENT_HISTORY` ticks. */
  readonly history: TickHistory<Readonly<Values>>;
  /** The tick the current input is for, and whether it's been sent. */
  tick: number;
  pending: boolean;
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
  /** Client Worlds' state, by local player. */
  readonly clients: WeakMap<World, Map<number, ClientState>>;
  /** Server sessions' state, by connection, then by the client's local player. */
  readonly servers: WeakMap<NetSession, Map<NetPeer, Map<number, PeerState>>>;
  /** Editor (thin clients): set a client World's current input, as `write` would. */
  readonly writeSynthetic: (world: World, values: Values) => void;
}

const streams = new Map<string, Stream>();

/**
 * Editor: client Worlds whose input on a stream comes from the editor (multiplayer play's thin
 * clients), by World, as stream ids. The game's own writes there go nowhere, so a system that
 * writes the keyboard every tick (zeros, in a World without input) doesn't undo the synthetic input.
 */
const synthetic = new WeakMap<World, Set<string>>();

/** Client Worlds: the `serverTick` of their latest fixed step (-1 while not connected). */
const fixedTicks = new WeakMap<World, number>();

/** The connection `node` stands for: its own if it's a connection node, else its `Replicated` owner's (T11). */
function connectionOf(session: NetSession, node: GameObject): NetPeer | null {
  return session.peerOf(node) ?? session.ownerPeer((node.isValid && node.getBehavior(Replicated)?.ownerId) || 0);
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
  for (const f of Object.keys(schema)) {
    if ((schema[f] as { kind: string }).kind === "str") throw new Error(`defineInput("${id}"): field "${f}" is str; inputs hold numbers (send strings with an RPC).`);
  }
  const encoding = options.encoding ?? {};
  for (const f of Object.keys(encoding)) if (!(f in schema)) throw new Error(`defineInput("${id}"): encoding names "${f}", which isn't a field.`);
  const codec = recordCodec(schema, encoding as Partial<Record<keyof S, { quantize?: number }>>) as RecordCodec;
  const fields = codec.fields;
  const kinds = fields.map((f) => schema[f].kind);
  const steps = fields.map((f) => encoding[f]?.quantize ?? 0);
  const descriptor = `net.input:${id}(${fields.map((f, i) => `${f}:${kinds[i]}${steps[i] ? `~${steps[i]}` : ""}`).join(",")})`;
  /** A value as it travels: an f32, rounded to its quantize step. */
  const wire = (i: number, v: number): number => (kinds[i] === "f32" ? Math.fround(steps[i] ? Math.round(v / steps[i]) * steps[i] : v) : kinds[i] === "i32" ? v | 0 : v & 0xff);
  const coerce = (values: Values): Values => {
    const out: Values = {};
    for (let i = 0; i < fields.length; i++) out[fields[i]] = wire(i, values[fields[i]]);
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
    writeSynthetic(world, values) {
      const state = clientState(world, "write", 0);
      for (const f of fields) if (typeof values[f] === "number") state.current[f] = values[f];
    },
  };
  streams.set(id, stream);

  const clientState = (world: World, what: string, player: number): ClientState => {
    if (netSession(world)?.isServer) throw new Error(`Can't ${what} input "${id}" in World "${world.name}": it's a network server; read clients' input with ${id}.of(connection).`);
    let players = stream.clients.get(world);
    if (!players) stream.clients.set(world, (players = new Map()));
    let state = players.get(player);
    if (!state) {
      const current: Values = {};
      for (const f of fields) current[f] = 0;
      // First written during a fixed step: the input is for that step's tick.
      const tick = fixedTicks.get(world) ?? -1;
      players.set(player, (state = { current, history: new TickHistory(CLIENT_HISTORY), tick, pending: tick >= 0 }));
    }
    return state;
  };

  /** Where the game's writes go: the current input, or a scratch copy while the editor drives it. */
  const writable = (world: World, player: number): Values => {
    const state = clientState(world, "write", player);
    return synthetic.get(world)?.has(id) ? { ...state.current } : state.current;
  };
  const checkPlayer = (what: string, player: number) => {
    if (!(Number.isInteger(player) && player >= 0 && player < MAX_LOCAL_PLAYERS)) throw new Error(`Input "${id}".${what}: player must be a local player index from 0 to ${MAX_LOCAL_PLAYERS - 1} (got ${player}).`);
  };
  const def: InputDef<S> = {
    id,
    schema,
    get local() {
      return writable(World.require(), 0) as DataView<S>;
    },
    localOf(player) {
      checkPlayer("localOf", player);
      return writable(World.require(), player) as DataView<S>;
    },
    write(values, player = 0) {
      checkPlayer("write", player);
      const current = writable(World.require(), player);
      for (const key of Object.keys(values)) {
        const v = (values as Record<string, unknown>)[key];
        const i = fields.indexOf(key);
        if (i < 0) throw new Error(`Input "${id}".write: there's no field "${key}" (fields: ${fields.join(", ")}).`);
        if (typeof v !== "number") throw new Error(`Input "${id}".write: field "${key}" must be a number (got ${typeof v}).`);
        current[key] = steps[i] ? wire(i, v) : v;
      }
    },
    of(node, player = 0) {
      const world = World.require();
      const session = netSession(world);
      if (!session) return null;
      if (session.isServer) {
        const peer = connectionOf(session, node);
        const state = peer ? stream.servers.get(session)?.get(peer)?.get(player) : undefined;
        return (state?.current as Readonly<DataView<S>> | undefined) ?? null;
      }
      // A client has its own input only, for its connection node (or a node it owns, T11).
      const peer = connectionOf(session, node);
      if (!peer || peer !== session.serverPeer) return null;
      const state = stream.clients.get(world)?.get(player);
      if (!state) return null;
      // As the server will read it (f32, quantized, i32, u8), so prediction matches it.
      const replay = session.replayTick;
      if (replay !== null) return replayed(stream, state, replay) as Readonly<DataView<S>> | null;
      return stream.coerce(state.current) as Readonly<DataView<S>>;
    },
    stats(node, player = 0) {
      const world = World.require();
      const session = netSession(world);
      if (!session?.isServer) return null;
      const peer = connectionOf(session, node);
      const state = peer ? stream.servers.get(session)?.get(peer)?.get(player) : undefined;
      return state ? { ...state.stats } : null;
    },
  };
  defs.set(id, def as unknown as InputDef<Schema>); // T15 tools
  _recordRegistration("inputs", id);
  return def;
}

// --- T15 tools (additive): the editor's Network panel and thin clients --------------------------

/** Defined streams, by id (the newest definition of each). */
const defs = new Map<string, InputDef<Schema>>();

/** @internal Editor tools: every defined input stream. */
export function definedInputs(): InputDef<Schema>[] {
  return [...defs.values()];
}

/**
 * @internal Editor (multiplayer play's thin clients): drive a client World's input on stream `id`
 * from now on. `values` become its current input, and the game's own writes to that stream in that
 * World are ignored (so a system writing the keyboard every tick doesn't overwrite them). False if
 * there's no such stream. Throws in a network server World.
 */
export function _writeSyntheticInput(world: World, id: string, values: Readonly<Record<string, number>>): boolean {
  const stream = streams.get(id);
  if (!stream) return false;
  let ids = synthetic.get(world);
  if (!ids) synthetic.set(world, (ids = new Set()));
  ids.add(id);
  stream.writeSynthetic(world, values as Values);
  return true;
}

/**
 * @internal Define `id` again in place of its stream, outside the editor's script reload: an action set asset whose
 * file changed (ADR 0433) redefines its networked set's stream.
 */
export function _redefineInput<S extends Schema>(id: string, schema: S, options: InputOptions = {}): InputDef<S> {
  if (!_isReplacingRegistrations()) {
    streams.delete(id);
    defs.delete(id);
  }
  return defineInput(id, schema, options);
}

/** @internal Editor: forget a stream a project script defined (the script was deleted, or another project opened). */
export function _undefineInput(id: string): void {
  defs.delete(id);
}

// --- client -------------------------------------------------------------------------------------

/**
 * Prediction (T13): a client's input for a replayed tick. A tick with no input of its own (its
 * step was skipped, or not committed yet) gets the newest earlier one, as the server would repeat
 * it; the tick being written gets the current input.
 */
function replayed(stream: Stream, state: ClientState, tick: number): Readonly<Values> | null {
  if (state.pending && tick === state.tick) return stream.coerce(state.current);
  const history = state.history;
  for (let t = Math.min(tick, history.newest); t >= 0 && t >= history.oldest; t--) {
    const v = history.get(t);
    if (v) return v;
  }
  return null;
}

/** Store the pending input under its tick and send it with the ones before it (for local player `player`). */
function commit(stream: Stream, session: NetSession, state: ClientState, player: number): void {
  state.pending = false;
  const tick = state.tick;
  if (tick < 0) return;
  const values = stream.coerce(state.current);
  const history = state.history;
  // serverTick can skip a tick when the estimate is corrected: those ticks get the previous input
  // (the newest sent), as the server repeats it for a tick with none; the last `redundancy` of them
  // are stored, so the packet's run of consecutive ticks reaches this one.
  const previous = history.newest;
  if (previous >= 0 && tick > previous + 1) {
    const prev = history.get(previous) ?? values;
    for (let t = Math.max(previous + 1, tick - stream.redundancy); t < tick; t++) history.set(t, prev);
  }
  history.set(tick, values);

  // The newest input and up to `redundancy` before it, as long as the ticks are consecutive.
  const newest = history.newest;
  let count = 1;
  while (count <= stream.redundancy && history.has(newest - count)) count++;
  const w = createBitWriter();
  if (player !== 0) {
    w.writeVarUint(0); // not a count: a local player's index follows
    w.writeVarUint(player);
  }
  w.writeVarUint(count);
  let baseline: Values | undefined;
  for (let t = newest - count + 1; t <= newest; t++) {
    const v = history.get(t)!;
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
    const players = stream.clients.get(world);
    if (!players) continue; // never written: nothing to send
    for (const [player, state] of players) {
      if (state.pending && open) commit(stream, session, state, player);
      if (!open) {
        // Not connected (yet, or any more): a new connection starts a new history.
        state.history.clear();
      }
      // A step on a tick whose input was already sent (serverTick held, two fixed steps on one
      // tick) doesn't send another for it: the server keeps the first. Its writes carry over to the next tick.
      const tick = open ? session.time.serverTick : -1;
      state.tick = tick;
      state.pending = open && tick > state.history.newest;
    }
  }
}

function clientSend(world: World, session: NetSession): void {
  if (session.serverPeer?.state !== "open") return;
  for (const stream of streams.values()) {
    const players = stream.clients.get(world);
    if (players) for (const [player, state] of players) if (state.pending) commit(stream, session, state, player);
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
      let players = peers.get(m.peer);
      if (!players) peers.set(m.peer, (players = new Map()));
      receive(stream, players, tick, m.tick, m.data);
    }

    for (const players of peers.values()) for (const state of players.values()) {
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

/** Decode one packet into the buffer of a connection's local player. A malformed one is dropped. */
function receive(stream: Stream, players: Map<number, PeerState>, tick: number, newest: number, data: Uint8Array): void {
  let decoded: Readonly<Values>[];
  let player = 0;
  try {
    const r = createBitReader(data);
    let count = r.readVarUint();
    if (count === 0) {
      player = r.readVarUint();
      if (player < 1 || player >= MAX_LOCAL_PLAYERS) return;
      count = r.readVarUint();
    }
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
  let state = players.get(player);
  if (!state) players.set(player, (state = { buffer: new Map(), missed: new Set(), current: null, simulated: tick - 1, stats: { received: 0, repeated: 0, late: 0 } }));
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
  before: ["engine.ReplicationSend", "engine.NetSend"], // the first: as before input loaded replication (ADR 0311)
  run(world) {
    const session = netSession(world);
    if (session?.isClient) clientSend(world, session);
  },
});
