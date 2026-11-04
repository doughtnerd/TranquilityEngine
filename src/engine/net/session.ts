/**
 * Network sessions (ADR 0033, T10): everything a networked World does with its transports. Each
 * networked World has one session. A server World's session listens (one transport per transport
 * name and address, shared by every client that connects there); a client World's session has one
 * connection, to its server. A World can't be both yet (a relay).
 *
 * The session owns its transports (created with `createWorldTransport`, so they close with the
 * World), the handshake, tick sync and message routing. Game code never sees it: connections are
 * nodes with a `net.Connection` data component (`connection.ts`), RPCs are buffer rows
 * (`rpc.ts`), and ticks are `world.time.network`.
 *
 * ## Wire format
 *
 * Every transport message is one session message: a header of two LEB128 varuints, the message
 * kind and the sender's tick (its `time.network.serverTick` when the message was queued: the
 * server's tick, or the server tick a client predicts), then the body.
 *
 * ## Handshake (reliable channel)
 *
 * When the transport opens, the client sends `hello`: the protocol version, its tick rate, its
 * World's name, and the RPCs and message kinds it defines (with their schemas). The server either
 * accepts with `welcome` (the connection's id and its current tick) or closes the connection with
 * a reason: a version, tick-rate, RPC or message-kind mismatch. Both ends then number RPCs and
 * message kinds the same way (sorted by name), so the wire carries small numbers.
 *
 * ## Ticks (ADR 0033 §7)
 *
 * Networked Worlds count their fixed steps from when the session started. Servers: `tick`, and
 * `serverTick` = `interpolationTick` = `tick`. Clients estimate the server's tick from ping/pong
 * on the unreliable channel (every `PING_INTERVAL_MS`): each pong carries the server's tick
 * position when it was sent, and the client takes it as the server's position RTT/2 ago. The
 * estimate is a smoothed offset between the client's tick and the server's, so it advances by one
 * per fixed step. `serverTick` is that estimate plus RTT/2 plus the command slack (the prediction
 * timeline; the slack is explained below);
 * `interpolationTick` (+ `interpolationFraction`) is the newest server tick that should have
 * arrived by now (the estimate minus RTT/2) minus the interpolation buffer (`interpolationMs`, a
 * link option, default 100). Neither goes backwards. The client's simulation rate isn't adjusted
 * (prediction's time adjustment is T13).
 *
 * Command slack (T12, Unity's `TargetCommandSlack`): a client's inputs (`input.ts`) are tagged with
 * its `serverTick`. At exactly estimate + RTT/2 they'd reach the server just as it simulates that
 * tick, so any jitter would make them late. `serverTick` therefore runs `commandSlack` ticks
 * further ahead (a link option, default `DEFAULT_COMMAND_SLACK_TICKS`), and inputs arrive that
 * much before the tick they're for.
 *
 * ## System order
 *
 * - `engine.NetReceiveTick` (fixedUpdate, before the fixedUpdate scripts and so before physics
 *   and game systems): advances the tick, polls the transports (handshakes, pings, routing) and
 *   updates `time.network`. So game systems and scripts in fixedUpdate see this tick's messages.
 * - `engine.NetReceive` (update, before the update scripts): polls again, so frames without a
 *   fixed step still receive, and updates `time.network` with the frame's fraction.
 * - `engine.NetSend` (lateUpdate, after the lateUpdate scripts): sends everything queued this
 *   frame, and pings. Anything queued after it (a later lateUpdate system, code between frames) is
 *   sent at the start of the next frame's first receive.
 * All three do nothing in Worlds without a session.
 *
 * ## The internal message API (for replication, T11, and inputs, T12)
 *
 * ```ts
 * // Once, at module level: a message kind, by a name unique across the engine.
 * const SNAPSHOT = registerNetMessage("net.snapshot");
 *
 * // Sending, in a system of a networked World (sent at the end of the frame):
 * const session = netSession(world);              // null if the World isn't networked
 * for (const peer of session?.openPeers() ?? []) {
 *   session!.send(SNAPSHOT, peer, "unreliable", (w) => writeSnapshot(w, peer));
 * }
 * session.send(INPUT, "server", "unreliable", bytes);  // a client's one connection
 *
 * // Receiving, in a system that runs after engine.NetReceiveTick: drain the queue each frame.
 * for (const m of session.drain(SNAPSHOT)) applySnapshot(m.peer, m.tick, m.reader());
 * ```
 *
 * - `registerNetMessage(name): number`: a local kind id. Both ends must register the same names
 *   (checked in the handshake).
 * - `netSession(world): NetSession | null`.
 * - `session.send(kind, to, channel, body, tick?)`: `to` is a `NetPeer`, a connection node,
 *   `"all"` (every open connection) or `"server"`; `body` is bytes or a function that writes it
 *   with a `BitWriter`; `tick` defaults to the World's `time.network.serverTick`. Messages to a
 *   client's connection queued before its handshake completes wait for it.
 * - `session.drain(kind): NetMessage[]`: everything received of that kind since the last drain,
 *   in arrival order, each with its `peer`, connection `node`, `tick` (the sender's), `channel`,
 *   `data` (the body) and `reader()`. Undrained queues are capped at `MAX_QUEUED` (oldest dropped).
 * - `session.openPeers()`, `session.peerOf(node)`, `session.isServer`, `session.isClient`,
 *   `session.tick`, `session.tickRate`; per peer, `id`, `node`, `rtt` and `lastAckedTick` (whose
 *   setter also writes the node's `Connection`).
 */
import { World } from "../core/World";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { createBitReader, createBitWriter, type BitReader, type BitWriter } from "./codec";
import { Connection, ConnectionState } from "./connection";
import { createWorldTransport, type Channel, type Transport, type TransportConnection, type TransportEvent } from "./Transport";
import type { NetworkTime } from "./time";
// The built-in transports register themselves; links and `WorldHandle.connect` find them by name.
import "./transport/loopback";
import "./transport/websocket";

/** Bumped whenever the wire format or handshake changes; both ends must match. (2: field shapes in replication spawns.) */
export const NET_PROTOCOL_VERSION = 2;

/** How often a client pings its server, for RTT and the server-tick estimate. */
export const PING_INTERVAL_MS = 100;

/** The interpolation buffer when a link doesn't set `interpolationMs`. */
export const DEFAULT_INTERPOLATION_MS = 100;

/** T12: how many ticks ahead of the server inputs aim to arrive, when a link doesn't set `commandSlack`. */
export const DEFAULT_COMMAND_SLACK_TICKS = 2;

/** Undrained messages kept per kind per World; older ones are dropped. */
export const MAX_QUEUED = 1024;

/** A connection that hasn't finished its handshake this long after opening is closed (link option `handshakeTimeoutMs`). */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
/**
 * A connection nothing has arrived on for this long is closed as lost (link option `idleTimeoutMs`).
 * Clients ping every 100 ms and servers answer, so a live link is never quiet this long; a
 * paused World (the editor's Pause) stops answering, so its peers time out after this.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
/** Connections a server accepts at once, counting ones still in their handshake (listen option `maxConnections`). */
export const DEFAULT_MAX_CONNECTIONS = 64;

const MSG_HELLO = 0;
const MSG_WELCOME = 1;
const MSG_PING = 2;
const MSG_PONG = 3;
const MSG_RPC = 4;
/** Registered message kinds are numbered from here on the wire. */
const FIRST_REGISTERED = 8;

/** Smoothing for RTT and the clock offset (exponential moving averages). */
const RTT_SMOOTHING = 0.125;
const OFFSET_SMOOTHING = 0.1;
/** A clock-offset sample this many ticks off the estimate replaces it instead of nudging it. */
const OFFSET_SNAP_TICKS = 4;

// --- registries ---------------------------------------------------------------------------------

/** @internal An RPC type as the session sees it (registered by `defineRpc`). */
export interface RpcEntry {
  readonly id: string;
  /** Its id and schema, compared in the handshake: `game.Ready(team:u8)`. */
  readonly descriptor: string;
  /** Decode a received body to values. */
  decode(data: Uint8Array): Record<string, number>;
}

const rpcs = new Map<string, RpcEntry>();
const messageKinds: string[] = [];

/** @internal Make an RPC type known to sessions (by `defineRpc`). A later entry with the same id replaces it. */
export function registerRpc(entry: RpcEntry): void {
  rpcs.set(entry.id, entry);
}

/**
 * @internal Register a message kind for netcode internals (snapshots, acks, inputs). Returns its
 * local id, for `send` and `drain`. Registering a name again returns the same id.
 */
export function registerNetMessage(name: string): number {
  const existing = messageKinds.indexOf(name);
  if (existing >= 0) return existing;
  messageKinds.push(name);
  return messageKinds.length - 1;
}

// --- sessions -----------------------------------------------------------------------------------

/** A received message of a registered kind. */
export interface NetMessage {
  readonly peer: NetPeer;
  /** The connection node it came over. */
  readonly node: GameObject;
  /** The sender's tick when it queued the message (see the header above). */
  readonly tick: number;
  readonly channel: Channel;
  /** The body. */
  readonly data: Uint8Array;
  /** A reader over the body. */
  reader(): BitReader;
}

/** Who a message goes to. */
export type NetTarget = NetPeer | GameObject | readonly (NetPeer | GameObject)[] | "all" | "server";

/** @internal A received RPC, kept until both fixedUpdate and update readers have had it. */
interface RpcRowEntry {
  readonly row: Readonly<Record<string, unknown>>;
  /** The frame it arrived in: update and lateUpdate readers see it then. */
  readonly frame: number;
  /** The fixed step fixedUpdate readers see it in: the one it arrived at, or the next. */
  readonly step: number;
}

/** A message waiting to be sent (until the end of the frame, or until the handshake completes). */
interface Outgoing {
  readonly channel: Channel;
  /** A registered kind's local id, or the RPC it carries. */
  readonly kind: number | RpcEntry;
  readonly tick: number;
  readonly body: Uint8Array;
}

/** @internal One connection of a session: the transport connection, its node and its numbering. */
export class NetPeer {
  /** The id the server assigned (0 on a client until the handshake completes). */
  id = 0;
  /** `handshake` until accepted; `closed` once the transport closed. */
  state: "handshake" | "open" | "closed" = "handshake";
  /** Its `net.Connection` node; null on a server until the handshake is accepted. */
  node: GameObject | null = null;
  /** Smoothed RTT in ms: measured on a client, reported by the client on a server. */
  rtt = 0;
  /** Queued for sending, in order. */
  readonly outbox: Outgoing[] = [];
  /** When the connection started (the session's clock, ms), for the handshake timeout. */
  openedAt = 0;
  /** When anything last arrived on it, for the idle timeout. */
  heardAt = 0;
  private ackedTick = 0;
  /** RPC wire numbers by id, and RPCs by wire number. Filled when the handshake completes. */
  rpcOut = new Map<string, number>();
  rpcIn: RpcEntry[] = [];
  /** Registered kinds: local id → wire number, and wire number - FIRST_REGISTERED → local id. */
  kindOut = new Map<number, number>();
  kindIn: number[] = [];
  // T15 tools: traffic counters (additive; the editor's Network panel reads them). Whole session
  // messages, header included, as handed to and received from the transport.
  /** @internal What this end sent on the connection: totals and per message kind. */
  readonly sent: NetTraffic = newTraffic();
  /** @internal What arrived on the connection: totals and per message kind. */
  readonly received: NetTraffic = newTraffic();

  constructor(
    readonly link: TransportConnection,
    readonly transport: Transport,
  ) {}

  /** The newest tick the other end has acknowledged (replication, T11). Writing it updates the node's `Connection`. */
  get lastAckedTick(): number {
    return this.ackedTick;
  }

  set lastAckedTick(tick: number) {
    this.ackedTick = tick;
    const data = this.node?.isValid ? this.node.getData(Connection) : null;
    if (data) data.lastAckedTick = tick;
  }

  /** Number RPCs and message kinds the same way on both ends: sorted by name. */
  number(): void {
    const ids = [...rpcs.keys()].sort();
    this.rpcIn = ids.map((id) => rpcs.get(id)!);
    this.rpcOut = new Map(ids.map((id, i) => [id, i]));
    const names = [...messageKinds].sort();
    this.kindIn = names.map((n) => messageKinds.indexOf(n));
    this.kindOut = new Map(names.map((n, i) => [messageKinds.indexOf(n), FIRST_REGISTERED + i]));
  }
}

/** A mutable `NetworkTime`, the object on `world.time.network`. */
type MutableNetworkTime = { -readonly [K in keyof NetworkTime]: NetworkTime[K] };

/** A listening transport of a server session. */
interface Listener {
  readonly transport: Transport;
  /** Resolves with the address clients in this process connect to. */
  ready: Promise<string>;
  /** Set once listening (synchronously, for transports that can). */
  address: string | null;
}

const sessions = new WeakMap<World, NetSession>();

/** @internal The World's session, or null if it isn't networked. */
export function netSession(world: World = World.require()): NetSession | null {
  return sessions.get(world) ?? null;
}

/** @internal A World's network session. See the top of this file. */
export class NetSession {
  /** Fixed steps since the session started. */
  tick = 0;
  /** Fixed ticks per second, fixed when the session starts (the World's rate). */
  readonly tickRate: number;
  /** What the World's `time.network` shows. */
  readonly time: MutableNetworkTime;
  /** Recently closed connections and why (newest last, at most 16), for logs and tools. */
  readonly closed: { id: number; reason: string }[] = [];
  /** Client: the newest server tick received in any message. -1 before the first. */
  newestServerTick = -1;
  /** Client: the server's tick right now, as estimated (fractional). */
  estimatedServerTick = 0;
  /** Client: the interpolation buffer in ms. */
  interpolationMs = DEFAULT_INTERPOLATION_MS;
  /** Client (T12): extra ticks `serverTick` runs ahead, so inputs arrive before their tick. See the top of this file. */
  commandSlack = DEFAULT_COMMAND_SLACK_TICKS;
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS;
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  /** Server: connections accepted at once. */
  maxConnections = DEFAULT_MAX_CONNECTIONS;

  private role: "server" | "client" | null = null;
  private readonly transports: Transport[] = [];
  private readonly peers = new Map<TransportConnection, NetPeer>();
  private readonly listeners = new Map<string, Listener>();
  private nextConnectionId = 1;
  private readonly queues = new Map<number, NetMessage[]>();
  private readonly rows = new Map<string, RpcRowEntry[]>();
  /** Which readers `readRpc` serves: fixedUpdate's (during fixed steps) or update's. */
  private phase: "fixed" | "frame" = "frame";
  private closedForGood = false;

  // Client time sync.
  private synced = false;
  /** Server tick position minus client tick position. */
  private offset = 0;
  private helloSentAt = 0;
  private nextPingAt = 0;
  private pingSequence = 0;
  private readonly pings = new Map<number, number>();

  constructor(readonly world: World) {
    this.tickRate = 1 / world.time.fixedDeltaTime;
    this.time = { tick: 0, serverTick: 0, interpolationTick: 0, interpolationFraction: 0, rtt: 0, tickRate: this.tickRate };
  }

  get isServer(): boolean {
    return this.role === "server";
  }

  get isClient(): boolean {
    return this.role === "client";
  }

  /** Milliseconds per tick. */
  get tickMs(): number {
    return 1000 / this.tickRate;
  }

  /** Connections whose handshake is complete. */
  openPeers(): NetPeer[] {
    return [...this.peers.values()].filter((p) => p.state === "open");
  }

  /** The client's connection to its server, if it has one. */
  get serverPeer(): NetPeer | null {
    if (this.role !== "client") return null;
    for (const p of this.peers.values()) return p;
    return null;
  }

  /** @internal Editor: where this server listens, per transport (the Worlds panel matches clients to it, ADR 0062). */
  listening(): { transport: string; address: string }[] {
    return [...this.listeners].flatMap(([key, l]) => (l.address === null ? [] : [{ transport: key.slice(0, key.indexOf("|")), address: l.address }]));
  }

  /** The peer whose connection node is `node`, or null. */
  peerOf(node: GameObject): NetPeer | null {
    for (const p of this.peers.values()) if (p.node === node) return p;
    return null;
  }

  // --- roles and links --------------------------------------------------------------------------

  /** @internal Take on a role, or throw if the World already has the other one. `check`: only throw. */
  claim(role: "server" | "client", check = false): void {
    if (this.closedForGood) throw new Error(`World "${this.world.name}"'s network session is closed.`);
    if (this.role === role) return;
    if (this.role !== null) {
      throw new Error(`World "${this.world.name}" is already a network ${this.role}; a World can't be both a server and a client yet.`);
    }
    if (check) return;
    this.role = role;
    this.world.time.network = this.time; // a networked World from now on
  }

  /**
   * @internal Start listening over `transportName` (once per transport and address). Returns the
   * listener: `address` is set already for transports that listen synchronously (loopback).
   */
  listen(transportName: string, options: Record<string, unknown>): Listener {
    const address = listenAddress(this.world, transportName, options);
    const key = `${transportName}|${address}`;
    const existing = this.listeners.get(key);
    if (existing) return existing;
    this.claim("server", true);
    const transport = createWorldTransport(this.world, transportName, options);
    this.claim("server");
    this.applyOptions(options);
    if (typeof options.maxConnections === "number" && options.maxConnections >= 1) this.maxConnections = Math.floor(options.maxConnections);
    this.transports.push(transport);
    const listener: Listener = { transport, ready: Promise.resolve(address), address: null };
    this.listeners.set(key, listener);
    listener.ready = (async () => {
      try {
        await transport.listen(address);
      } catch (err) {
        this.listeners.delete(key);
        this.dropTransport(transport);
        throw new Error(`World "${this.world.name}" can't listen over "${transportName}" at "${address}": ${(err as Error).message}`);
      }
      // A transport that knows a URL for itself (the Node WebSocket server) gives that to clients.
      const url = (transport as { address?: { url?: unknown } | null }).address?.url;
      listener.address = typeof options.url === "string" ? options.url : typeof url === "string" ? url : address;
      return listener.address;
    })();
    listener.ready.catch(() => {}); // reported to whoever awaits `ready`
    // Loopback listens synchronously; connecting at once lets `WorldHandle.connect` and the next
    // `engine.step()` happen without an await in between.
    if ((transport as { listening?: unknown }).listening === address) listener.address = typeof options.url === "string" ? options.url : address;
    return listener;
  }

  /** @internal Client: connect to `address` over `transportName`. The connection node appears now, `connecting`. */
  connect(transportName: string, address: string, options: Record<string, unknown>): void {
    if (this.role === "client" && this.peers.size > 0) throw new Error(`World "${this.world.name}" is already connected to a server; a client World has one connection.`);
    this.claim("client", true);
    const transport = createWorldTransport(this.world, transportName, options);
    this.claim("client");
    if (typeof options.interpolationMs === "number" && options.interpolationMs >= 0) this.interpolationMs = options.interpolationMs;
    if (typeof options.commandSlack === "number" && options.commandSlack >= 0) this.commandSlack = options.commandSlack; // T12
    this.applyOptions(options);
    this.transports.push(transport);
    const link = transport.connect(address);
    const peer = new NetPeer(link, transport);
    peer.openedAt = peer.heardAt = this.nowMs();
    peer.node = this.createNode("Connection (server)", 0, ConnectionState.connecting);
    this.peers.set(link, peer);
    this.resetTimeline(); // a new server (perhaps restarted, at tick 0): start its timeline afresh
  }

  /** Timeouts from link or listen options. */
  private applyOptions(options: Record<string, unknown>): void {
    if (typeof options.handshakeTimeoutMs === "number" && options.handshakeTimeoutMs > 0) this.handshakeTimeoutMs = options.handshakeTimeoutMs;
    if (typeof options.idleTimeoutMs === "number" && options.idleTimeoutMs > 0) this.idleTimeoutMs = options.idleTimeoutMs;
  }

  /**
   * Client: forget the server's timeline. serverTick and interpolationTick never go back while
   * connected; across connections they must, or a client reconnecting to a restarted server would
   * tag inputs far ahead (the server drops them) and hold every ghost at its last state.
   */
  private resetTimeline(): void {
    this.synced = false;
    this.offset = 0;
    this.estimatedServerTick = 0;
    this.newestServerTick = -1;
    this.pings.clear();
    const t = this.time;
    t.serverTick = t.interpolationTick = 0;
    t.interpolationFraction = 0;
  }

  /** Close every connection and transport; the World is going. */
  close(): void {
    if (this.closedForGood) return;
    this.closedForGood = true;
    for (const peer of [...this.peers.values()]) {
      if (peer.link.state !== "closed") peer.link.close(`World "${this.world.name}" was closed.`);
      this.removePeer(peer, `World "${this.world.name}" was closed.`, false);
    }
    for (const t of this.transports.splice(0)) t.close();
    this.listeners.clear();
    if (this.world.time.network === this.time) this.world.time.network = undefined;
    sessions.delete(this.world);
  }

  // --- sending ----------------------------------------------------------------------------------

  /** Queue a registered-kind message (see the top of this file). */
  send(kind: number, to: NetTarget, channel: Channel, body: Uint8Array | ((writer: BitWriter) => void), tick = this.time.serverTick): void {
    if (!(kind >= 0 && kind < messageKinds.length)) throw new Error(`Unknown net message kind ${kind}; register it with registerNetMessage first.`);
    this.queue(this.targets(to, `message "${messageKinds[kind]}"`), { channel, kind, tick, body: toBytes(body) });
  }

  /** @internal Queue an RPC (`RpcDef.send`). */
  sendRpc(entry: RpcEntry, body: Uint8Array, to: NetTarget | undefined): void {
    const target = to ?? (this.role === "client" ? "server" : "all");
    this.queue(this.targets(target, `RPC "${entry.id}"`), { channel: "reliable", kind: entry, tick: this.time.serverTick, body });
  }

  private queue(peers: NetPeer[], message: Outgoing): void {
    for (const p of peers) p.outbox.push(message);
  }

  private targets(to: NetTarget, what: string): NetPeer[] {
    if (to === "all") {
      if (this.role === "client") return this.peers.size ? [...this.peers.values()] : [];
      return this.openPeers();
    }
    if (to === "server") {
      if (this.role !== "client") throw new Error(`Can't send ${what} to "server" from World "${this.world.name}": it isn't a network client.`);
      const peer = this.serverPeer;
      if (!peer) throw new Error(`Can't send ${what} from World "${this.world.name}": it isn't connected to a server.`);
      return [peer];
    }
    if (Array.isArray(to)) return [...new Set(to.flatMap((t: NetPeer | GameObject) => this.targets(t, what)))];
    if (to instanceof NetPeer) return [to];
    const peer = this.peerOf(to as GameObject);
    if (!peer) throw new Error(`Can't send ${what} to ${String(to)}: it isn't a connection node of World "${this.world.name}".`);
    return [peer];
  }

  /** Send what's queued to every open connection (those still in their handshake keep theirs). */
  flush(): void {
    for (const peer of this.peers.values()) {
      if (peer.state !== "open" || peer.outbox.length === 0) continue;
      for (const m of peer.outbox.splice(0)) {
        const kind = typeof m.kind === "number" ? peer.kindOut.get(m.kind) : MSG_RPC;
        if (kind === undefined) {
          console.error(`[myco] Net message "${messageKinds[m.kind as number]}" was registered after World "${this.world.name}" connected; it can't be sent on that connection.`);
          continue;
        }
        let body = m.body;
        if (typeof m.kind !== "number") {
          const index = peer.rpcOut.get(m.kind.id);
          if (index === undefined) {
            console.error(`[myco] RPC "${m.kind.id}" was defined after World "${this.world.name}" connected; it can't be sent on that connection.`);
            continue;
          }
          body = concat(varuint(index), m.body);
        }
        if (!this.transmit(peer, m.channel, kind, m.tick, body)) break;
      }
    }
  }

  /** Send one message now. False if the connection has closed. */
  private transmit(peer: NetPeer, channel: Channel, kind: number, tick: number, body: Uint8Array): boolean {
    if (peer.link.state === "closed") return false;
    try {
      const data = concat(varuint(kind), varuint(Math.max(0, Math.floor(tick))), body);
      peer.link.send(channel, data);
      count(peer.sent, wireKindName(peer, kind), data.byteLength); // T15 tools
      return true;
    } catch {
      return false; // closed under us; its close event follows
    }
  }

  // --- receiving --------------------------------------------------------------------------------

  /** @internal Drain a registered kind's queue. */
  drain(kind: number): NetMessage[] {
    const queue = this.queues.get(kind);
    if (!queue || queue.length === 0) return [];
    this.queues.set(kind, []);
    return queue;
  }

  /** @internal RPC rows for the current reader: this fixed step's in fixedUpdate, this frame's otherwise. */
  readRpc(id: string): Readonly<Record<string, unknown>>[] {
    const list = this.rows.get(id);
    if (!list || list.length === 0) return [];
    const t = this.world.time;
    return this.phase === "fixed" ? list.filter((r) => r.step === t.fixedStepCount).map((r) => r.row) : list.filter((r) => r.frame === t.frameCount).map((r) => r.row);
  }

  /**
   * @internal One receive pass (the network systems). `fixed`: at the start of a fixed step, after
   * advancing the tick.
   */
  receive(fixed: boolean): void {
    if (fixed) this.tick++;
    this.phase = fixed ? "fixed" : "frame";
    this.flush();
    this.pruneRows();
    for (const transport of [...this.transports]) {
      let events: TransportEvent[];
      try {
        events = transport.poll();
      } catch (err) {
        console.error(`[myco] World "${this.world.name}": polling a transport failed:`, err);
        continue;
      }
      for (const event of events) this.handle(transport, event);
    }
    // A server kicks a client by destroying its connection node; quiet and stalled connections time out.
    const now = this.nowMs();
    for (const peer of [...this.peers.values()]) {
      if (peer.state === "open" && peer.node && !peer.node.isValid) peer.link.close("The connection node was destroyed.");
      else if (peer.state === "handshake" && now - peer.openedAt > this.handshakeTimeoutMs) this.drop(peer, `The handshake didn't finish within ${this.handshakeTimeoutMs} ms.`);
      else if (peer.state === "open" && now - peer.heardAt > this.idleTimeoutMs) this.drop(peer, `Nothing arrived for ${this.idleTimeoutMs} ms; the connection is lost.`);
    }
    this.updateTime(fixed);
  }

  /** @internal End of frame (`engine.NetSend`): pings, then everything queued. */
  endFrame(): void {
    const peer = this.serverPeer;
    if (peer && peer.state === "open" && this.nowMs() >= this.nextPingAt) this.ping(peer);
    this.flush();
  }

  private handle(transport: Transport, event: TransportEvent): void {
    const link = event.connection;
    if (event.kind === "open") {
      if (this.role === "client") {
        const peer = this.peers.get(link);
        if (peer) this.sendHello(peer);
      } else if (!this.peers.has(link)) {
        if (this.peers.size >= this.maxConnections) {
          link.close(`The server World "${this.world.name}" is full (${this.maxConnections} connections).`);
          return;
        }
        const peer = new NetPeer(link, transport);
        peer.openedAt = peer.heardAt = this.nowMs();
        this.peers.set(link, peer);
      }
      return;
    }
    const peer = this.peers.get(link);
    if (!peer) return;
    peer.heardAt = this.nowMs();
    if (event.kind === "close") {
      this.removePeer(peer, event.reason, true);
      return;
    }
    try {
      this.route(peer, event.channel, event.data);
    } catch (err) {
      const reason = `protocol error: ${(err as Error).message}`;
      link.close(reason);
      this.removePeer(peer, reason, true);
    }
  }

  private route(peer: NetPeer, channel: Channel, data: Uint8Array): void {
    let at = 0;
    const [kind, afterKind] = readVaruint(data, at);
    const [tick, afterTick] = readVaruint(data, afterKind);
    at = afterTick;
    const body = data.subarray(at);
    count(peer.received, wireKindName(peer, kind), data.byteLength); // T15 tools
    if (this.role === "client" && peer.state === "open") this.newestServerTick = Math.max(this.newestServerTick, tick);

    if (peer.state === "handshake") {
      if (this.role === "server" && kind === MSG_HELLO) return this.accept(peer, createBitReader(body));
      if (this.role === "client" && kind === MSG_WELCOME) return this.welcomed(peer, tick, createBitReader(body));
      // The server sends unreliably (snapshots) once it has accepted, so those can overtake a
      // delayed or retransmitted welcome: drop them, as if lost.
      if (this.role === "client" && channel === "unreliable") return;
      throw new Error(`message ${kind} before the handshake completed`);
    }
    switch (kind) {
      case MSG_PING:
        return this.pong(peer, createBitReader(body));
      case MSG_PONG:
        return this.ponged(createBitReader(body));
      case MSG_RPC: {
        const [index, start] = readVaruint(body, 0);
        const entry = peer.rpcIn[index];
        if (!entry) throw new Error(`unknown RPC number ${index}`);
        const values = entry.decode(body.subarray(start));
        this.pushRow(entry.id, { ...values, connection: peer.node });
        return;
      }
      default: {
        const local = peer.kindIn[kind - FIRST_REGISTERED];
        if (local === undefined) throw new Error(`unknown message kind ${kind}`);
        let queue = this.queues.get(local);
        if (!queue) this.queues.set(local, (queue = []));
        if (queue.length >= MAX_QUEUED) queue.shift();
        queue.push({ peer, node: peer.node!, tick, channel, data: body, reader: () => createBitReader(body) });
      }
    }
  }

  // --- handshake --------------------------------------------------------------------------------

  private sendHello(peer: NetPeer): void {
    const w = createBitWriter();
    w.writeVarUint(NET_PROTOCOL_VERSION);
    w.writeFloat32(this.tickRate);
    w.writeString(this.world.name);
    const descriptors = [...rpcs.values()].map((r) => r.descriptor).sort();
    w.writeVarUint(descriptors.length);
    for (const d of descriptors) w.writeString(d);
    const kinds = [...messageKinds].sort();
    w.writeVarUint(kinds.length);
    for (const k of kinds) w.writeString(k);
    this.helloSentAt = this.nowMs();
    this.transmit(peer, "reliable", MSG_HELLO, 0, w.finish());
  }

  /** Server: check a client's hello; accept it or close with the reason. */
  private accept(peer: NetPeer, r: BitReader): void {
    const version = r.readVarUint();
    const tickRate = r.readFloat32();
    const client = r.readString();
    const theirRpcs = readStrings(r);
    const theirKinds = readStrings(r);
    const who = `World "${client}"`;
    let reason = "";
    if (version !== NET_PROTOCOL_VERSION) {
      reason = `Protocol version mismatch: ${who} speaks netcode version ${version}, the server World "${this.world.name}" version ${NET_PROTOCOL_VERSION}.`;
    } else if (Math.abs(tickRate - this.tickRate) > this.tickRate * 1e-4) {
      reason = `Tick rate mismatch: ${who} runs at ${round(tickRate)} ticks per second, the server World "${this.world.name}" at ${round(this.tickRate)}. Linked Worlds must use the same tick rate.`;
    } else {
      // Input streams carry their schema in their kind's name (`net.input:id(fields)`): a difference
      // there is the game's definitions, like an RPC's, not the engine's.
      const isInput = (k: string) => k.startsWith("net.input:");
      const input = (k: string) => k.slice("net.input:".length);
      reason =
        setMismatch("RPC", theirRpcs, [...rpcs.values()].map((e) => e.descriptor)) ||
        setMismatch("input", theirKinds.filter(isInput).map(input), messageKinds.filter(isInput).map(input)) ||
        setMismatch("message kind", theirKinds.filter((k) => !isInput(k)), messageKinds.filter((k) => !isInput(k)), " (the client and server run different engine versions)");
    }
    if (reason) {
      peer.link.close(reason);
      this.removePeer(peer, reason, true);
      return;
    }
    peer.id = this.nextConnectionId++;
    peer.state = "open";
    peer.number();
    peer.node = this.createNode(`Connection ${peer.id}`, peer.id, ConnectionState.open);
    const w = createBitWriter();
    w.writeVarUint(peer.id);
    writePosition(w, this.position(this.phase === "fixed"));
    this.transmit(peer, "reliable", MSG_WELCOME, this.tick, w.finish());
  }

  /** Client: the server accepted. */
  private welcomed(peer: NetPeer, tick: number, r: BitReader): void {
    peer.id = r.readVarUint();
    const serverPosition = readPosition(r);
    peer.state = "open";
    peer.number();
    const data = peer.node?.isValid ? peer.node.getData(Connection) : null;
    if (data) {
      data.id = peer.id;
      data.state = ConnectionState.open;
    }
    if (peer.node?.isValid) peer.node.name = `Connection ${peer.id} (server)`;
    this.newestServerTick = Math.max(this.newestServerTick, tick);
    this.sample(this.nowMs() - this.helloSentAt, serverPosition);
    this.nextPingAt = this.nowMs(); // first ping at the end of this frame
  }

  // --- ping and tick sync -----------------------------------------------------------------------

  private ping(peer: NetPeer): void {
    const now = this.nowMs();
    const seq = this.pingSequence++;
    this.pings.set(seq, now);
    // Forget pings whose pongs were lost.
    for (const [s, at] of this.pings) if (now - at > 10_000) this.pings.delete(s);
    const w = createBitWriter();
    w.writeVarUint(seq);
    w.writeVarUint(Math.round(this.time.rtt));
    this.transmit(peer, "unreliable", MSG_PING, this.time.serverTick, w.finish());
    this.nextPingAt = now + PING_INTERVAL_MS;
  }

  /** Server: answer a ping at once with its tick position; note the client's RTT. */
  private pong(peer: NetPeer, r: BitReader): void {
    const seq = r.readVarUint();
    peer.rtt = r.readVarUint();
    const data = peer.node?.isValid ? peer.node.getData(Connection) : null;
    if (data) data.rtt = peer.rtt;
    const w = createBitWriter();
    w.writeVarUint(seq);
    writePosition(w, this.position(this.phase === "fixed"));
    this.transmit(peer, "unreliable", MSG_PONG, this.tick, w.finish());
  }

  private ponged(r: BitReader): void {
    const seq = r.readVarUint();
    const serverPosition = readPosition(r);
    const sentAt = this.pings.get(seq);
    if (sentAt === undefined) return;
    this.pings.delete(seq);
    this.sample(this.nowMs() - sentAt, serverPosition);
  }

  /** Client: one round trip measured, and where the server was when it answered. */
  private sample(rtt: number, serverPosition: number): void {
    const peer = this.serverPeer;
    this.time.rtt = this.synced ? this.time.rtt + (rtt - this.time.rtt) * RTT_SMOOTHING : rtt;
    if (peer) {
      peer.rtt = this.time.rtt;
      const data = peer.node?.isValid ? peer.node.getData(Connection) : null;
      if (data) data.rtt = this.time.rtt;
    }
    // The server answered about RTT/2 ago, so it's that much further on now.
    const offset = serverPosition + rtt / 2 / this.tickMs - this.position(this.phase === "fixed");
    if (!this.synced || Math.abs(offset - this.offset) > OFFSET_SNAP_TICKS) this.offset = offset;
    else this.offset += (offset - this.offset) * OFFSET_SMOOTHING;
    this.synced = true;
  }

  /**
   * This World's position on its tick timeline right now, in ticks: at the start of a fixed step,
   * `tick` plus the time the Engine still has to catch up on; in update, `tick` plus `fixedAlpha`.
   */
  private position(fixed: boolean): number {
    const t = this.world.time;
    return fixed ? this.tick + this.world._accumulator / t.fixedDeltaTime - 1 : this.tick + t.fixedAlpha;
  }

  private updateTime(fixed: boolean): void {
    const time = this.time;
    time.tick = this.tick;
    if (this.role !== "client") {
      time.serverTick = time.interpolationTick = this.tick;
      time.interpolationFraction = 0;
      return;
    }
    if (!this.synced) return;
    // Fixed steps use the step's own position, so serverTick advances by one per step.
    const position = fixed ? this.tick : this.position(false);
    this.estimatedServerTick = position + this.offset;
    const halfRtt = time.rtt / 2 / this.tickMs;
    // T12: plus the command slack, so inputs tagged with serverTick reach the server ahead of it.
    time.serverTick = Math.max(time.serverTick, Math.floor(this.estimatedServerTick + halfRtt + this.commandSlack));
    const interpolation = Math.max(0, this.estimatedServerTick - halfRtt - this.interpolationMs / this.tickMs);
    const whole = Math.floor(interpolation);
    if (whole > time.interpolationTick || (whole === time.interpolationTick && interpolation - whole > time.interpolationFraction)) {
      time.interpolationTick = whole;
      time.interpolationFraction = interpolation - whole;
    }
  }

  // --- nodes, rows and bookkeeping --------------------------------------------------------------

  private createNode(name: string, id: number, state: number): GameObject {
    const world = this.world;
    const node = world._createNode(name, world.root.entity, { transform: false });
    node.addData(Connection, { id, state, rtt: 0, lastAckedTick: 0 });
    return node;
  }

  private removePeer(peer: NetPeer, reason: string, log: boolean): void {
    if (peer.state === "closed") return;
    const wasOpen = peer.state === "open";
    peer.state = "closed";
    this.peers.delete(peer.link);
    const node = peer.node;
    if (node?.isValid) {
      const data = node.getData(Connection);
      if (data) data.state = ConnectionState.closing;
      this.world._destroyNode(node.entity);
    }
    this.closed.push({ id: peer.id, reason });
    if (this.closed.length > 16) this.closed.shift();
    if (this.role === "client") this.resetTimeline();
    if (log && (this.role === "client" || !wasOpen)) {
      const what = this.role === "client" ? "its connection to the server" : `a connection from ${peer.link.remote}`;
      console.warn(`[myco] World "${this.world.name}" ${wasOpen ? "lost" : "couldn't open"} ${what}: ${reason}`);
    }
  }

  /** Close a connection from this end, with a reason both ends see. */
  private drop(peer: NetPeer, reason: string): void {
    if (peer.link.state !== "closed") peer.link.close(reason);
    this.removePeer(peer, reason, true);
  }

  private pushRow(id: string, row: Readonly<Record<string, unknown>>): void {
    const t = this.world.time;
    let list = this.rows.get(id);
    if (!list) this.rows.set(id, (list = []));
    list.push({ row, frame: t.frameCount, step: this.phase === "fixed" ? t.fixedStepCount : t.fixedStepCount + 1 });
  }

  /** Forget rows both kinds of reader have had: from an earlier frame, and an earlier fixed step. */
  private pruneRows(): void {
    const t = this.world.time;
    for (const [id, list] of this.rows) {
      if (list.length === 0) continue;
      this.rows.set(id, list.filter((r) => r.frame >= t.frameCount || r.step >= t.fixedStepCount));
    }
  }

  private dropTransport(transport: Transport): void {
    const i = this.transports.indexOf(transport);
    if (i >= 0) this.transports.splice(i, 1);
    transport.close();
  }

  private nowMs(): number {
    return this.world.time.realtimeSinceStartup * 1000;
  }

  // --- T15 tools (additive): what the editor's Network panel and conditions sliders read --------

  /** @internal Every connection, those still in their handshake included. */
  allPeers(): NetPeer[] {
    return [...this.peers.values()];
  }

  /** @internal The session's transports (listening and connecting), e.g. to set loopback conditions. */
  transportList(): readonly Transport[] {
    return this.transports;
  }
}

/** @internal The World's session, created (and set to close with the World) if it has none. */
export function ensureSession(world: World): NetSession {
  let session = sessions.get(world);
  if (!session) {
    session = new NetSession(world);
    sessions.set(world, session);
    world._transports.add(session); // closed when the World is destroyed, like its transports
  }
  return session;
}

/**
 * @internal Join `client` to `server` over a transport: the server listens (once per transport
 * and address) and the client connects. Throws at once for what can be checked at once (roles,
 * a missing port); the promise rejects if listening fails. For loopback, the client is connecting
 * when this returns.
 */
export function connectWorlds(client: World, server: World, transportName: string, options: Record<string, unknown> = {}): Promise<void> {
  if (client === server) throw new Error(`Can't connect World "${client.name}" to itself.`);
  const clientSession = sessions.get(client);
  if (clientSession?.isServer) throw new Error(`World "${client.name}" is already a network server; a World can't be both a server and a client yet.`);
  if (clientSession?.serverPeer) throw new Error(`World "${client.name}" is already connected to a server; a client World has one connection.`);
  if (sessions.get(server)?.isClient) throw new Error(`World "${server.name}" is already a network client; a World can't be both a server and a client yet.`);
  const listener = ensureSession(server).listen(transportName, options);
  if (listener.address !== null) {
    ensureSession(client).connect(transportName, listener.address, options);
    return Promise.resolve();
  }
  return listener.ready.then((address) => {
    // Either World may have been destroyed while the server started listening.
    if (isDestroyed(client) || isDestroyed(server)) return;
    ensureSession(client).connect(transportName, address, options);
  });
}

/**
 * @internal Server only: listen over a transport without a client World in this Engine (a
 * dedicated server, or clients in another Engine). Resolves with the address clients in this
 * process can connect to.
 */
export function listenWorld(server: World, transportName: string, options: Record<string, unknown> = {}): Promise<string> {
  const listener = ensureSession(server).listen(transportName, options);
  return listener.address !== null ? Promise.resolve(listener.address) : listener.ready;
}

/** @internal Client only: connect to a server by address (`options.url`, else `options.address`), with no server World in this Engine. */
export function connectWorld(client: World, transportName: string, options: Record<string, unknown>): void {
  const address = typeof options.url === "string" ? options.url : typeof options.address === "string" ? options.address : undefined;
  if (address === undefined) throw new Error(`Connecting World "${client.name}" over "${transportName}" needs options.url or options.address.`);
  ensureSession(client).connect(transportName, address, options);
}

/** A World whose Engine dropped it (destroyed). Worlds created without an Engine count as alive. */
function isDestroyed(world: World): boolean {
  const engine = world._engine as { _world?(name: string): World | null } | null;
  return !!engine?._world && engine._world(world.name) !== world;
}

/** Loopback addresses made up for links that don't give one, unique per Engine and server World. */
const engineNumbers = new WeakMap<object, number>();
let nextEngineNumber = 1;

function listenAddress(world: World, transportName: string, options: Record<string, unknown>): string {
  if (typeof options.address === "string" && options.address !== "") return options.address;
  if (typeof options.port === "number" || typeof options.port === "string") return String(options.port);
  if (transportName === "loopback") {
    const owner = (world._engine as object | null) ?? world;
    let n = engineNumbers.get(owner);
    if (n === undefined) engineNumbers.set(owner, (n = nextEngineNumber++));
    return `engine-${n}/${world.name}`;
  }
  throw new Error(`World "${world.name}" can't listen over "${transportName}" without an address: give the link options.port or options.address.`);
}

// --- encoding helpers ---------------------------------------------------------------------------

function toBytes(body: Uint8Array | ((writer: BitWriter) => void)): Uint8Array {
  if (body instanceof Uint8Array) return body.slice();
  const w = createBitWriter();
  body(w);
  return w.finish();
}

function varuint(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

/** Read a LEB128 varuint at `at`: [value, next offset]. Throws on truncated or over-long input. */
function readVaruint(data: Uint8Array, at: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 8; i++) {
    if (at >= data.length) throw new RangeError("truncated message header");
    const byte = data[at++];
    value += (byte & 0x7f) * scale;
    if (!(byte & 0x80)) return [value, at];
    scale *= 0x80;
  }
  throw new RangeError("over-long varint in message header");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A tick position: whole ticks as a varuint, the fraction in 8 bits. */
function writePosition(w: BitWriter, position: number): void {
  const p = Math.max(0, position);
  const whole = Math.floor(p);
  w.writeVarUint(whole);
  w.writeBits(Math.min(255, Math.round((p - whole) * 256)), 8);
}

function readPosition(r: BitReader): number {
  return r.readVarUint() + r.readBits(8) / 256;
}

function readStrings(r: BitReader): string[] {
  const n = r.readVarUint();
  if (n > 100_000) throw new RangeError("too many strings");
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(r.readString());
  return out;
}

/** "" if the client's and server's lists hold the same things; otherwise what differs, as a reason. */
function setMismatch(what: string, client: readonly string[], server: readonly string[], hint = ""): string {
  const name = (descriptor: string) => descriptor.replace(/\(.*$/, "");
  const serverByName = new Map(server.map((d) => [name(d), d]));
  const clientByName = new Map(client.map((d) => [name(d), d]));
  const problems: string[] = [];
  const onlyClient = [...clientByName.keys()].filter((n) => !serverByName.has(n));
  const onlyServer = [...serverByName.keys()].filter((n) => !clientByName.has(n));
  if (onlyClient.length) problems.push(`only the client defines ${onlyClient.map((n) => `"${n}"`).join(", ")}`);
  if (onlyServer.length) problems.push(`only the server defines ${onlyServer.map((n) => `"${n}"`).join(", ")}`);
  for (const [n, d] of clientByName) {
    const s = serverByName.get(n);
    if (s !== undefined && s !== d) problems.push(`"${n}" differs (client ${d}, server ${s})`);
  }
  return problems.length ? `${what[0].toUpperCase()}${what.slice(1)} mismatch: ${problems.join("; ")}${hint}. Both ends must define the same ${what}s.` : "";
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// --- T15 tools: traffic counters (additive) ------------------------------------------------------

/** @internal Bytes and messages one way on a connection, in total and per message kind (by name). */
export interface NetTraffic {
  bytes: number;
  messages: number;
  /** By kind: `net.hello`, `net.welcome`, `net.ping`, `net.pong`, `net.rpc`, or a registered kind's name (`net.snapshot`, `net.input:…`). */
  readonly byKind: Map<string, { bytes: number; messages: number }>;
}

function newTraffic(): NetTraffic {
  return { bytes: 0, messages: 0, byKind: new Map() };
}

function count(traffic: NetTraffic, kind: string, bytes: number): void {
  traffic.bytes += bytes;
  traffic.messages++;
  let entry = traffic.byKind.get(kind);
  if (!entry) traffic.byKind.set(kind, (entry = { bytes: 0, messages: 0 }));
  entry.bytes += bytes;
  entry.messages++;
}

const BUILTIN_KIND_NAMES = ["net.hello", "net.welcome", "net.ping", "net.pong", "net.rpc"];

/** The name of a wire kind number on `peer` (registered kinds are numbered per connection). */
function wireKindName(peer: NetPeer, kind: number): string {
  if (kind < FIRST_REGISTERED) return BUILTIN_KIND_NAMES[kind] ?? `net.unknown(${kind})`;
  const local = peer.kindIn[kind - FIRST_REGISTERED];
  return local === undefined ? `net.unknown(${kind})` : messageKinds[local];
}

// --- built-in systems ---------------------------------------------------------------------------

defineBuiltinSystem({
  name: "engine.NetReceiveTick",
  phase: "fixedUpdate",
  before: ["engine.FixedUpdateScripts"],
  run: (world) => sessions.get(world)?.receive(true),
});
defineBuiltinSystem({
  name: "engine.NetReceive",
  phase: "update",
  before: ["engine.UpdateScripts"],
  run: (world) => sessions.get(world)?.receive(false),
});
defineBuiltinSystem({
  name: "engine.NetSend",
  phase: "lateUpdate",
  after: ["engine.LateUpdateScripts"],
  run: (world) => sessions.get(world)?.endFrame(),
});
