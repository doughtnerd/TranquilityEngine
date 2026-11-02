/**
 * The loopback transport (ADR 0033, T7): Worlds in one process talk through it, for hosting (a
 * server World and client Worlds in one Engine) and for testing netcode headless. It simulates
 * latency, jitter and loss with no timers: a sent message is queued with a delivery time, and the
 * receiver's `poll()` returns what's due.
 *
 * Conditions apply to what a connection sends, so each direction can differ. Both ends of a link
 * should share a clock; delivery times are computed on the sender's.
 */
import {
  registerTransport,
  type Channel,
  type ConnectionState,
  type LinkConditions,
  type Transport,
  type TransportConnection,
  type TransportEvent,
} from "../Transport";

export interface LoopbackOptions extends LinkConditions {
  /** Milliseconds clock. Defaults to `performance.now()`. Inject one for deterministic tests. */
  now?: () => number;
  /** Uniform 0..1 source for jitter and loss. Defaults to `Math.random`. */
  random?: () => number;
}

/** Retransmits of one lost reliable message are capped, so `loss: 1` doesn't spin forever. */
const MAX_RETRANSMITS = 16;

/** Listening transports by address. */
const listeners = new Map<string, LoopbackTransport>();

/** Tie-breaker for events due at the same time: the order they were queued in. */
let nextSequence = 0;
let nextTransportNumber = 0;

interface Pending {
  at: number;
  seq: number;
  connection: LoopbackConnection;
  event: TransportEvent;
  /** Unreliable messages: the sender's sequence number, for dropping stale ones on receipt. */
  unreliableSeq?: number;
}

export class LoopbackConnection implements TransportConnection {
  readonly id: number;
  readonly remote: string;
  /** @internal What the owning transport's `poll()` has returned: the open event, then the close. */
  seen: ConnectionState = "connecting";
  /** @internal This end called `close` (or its transport did): it's closed for sending at once. */
  localClosed = false;
  /** @internal The other end closed; this end hears about it when the close event is due. */
  remoteClosed = false;
  /** @internal The other end; undefined when nothing was listening. */
  peer: LoopbackConnection | undefined;
  /** @internal Whether this end called `connect` (only it hears about a close before opening). */
  readonly initiator: boolean;
  /** @internal When the open event reaches this end; nothing is delivered to it before. */
  openAt = 0;
  /** @internal Overrides the transport's conditions for what this end sends. */
  private ownConditions: LinkConditions | undefined;
  /** @internal Delivery time of the last reliable message sent, which later ones wait behind. */
  private lastReliableAt = -Infinity;
  private unreliableSent = 0;
  /** @internal Newest unreliable sequence number delivered to this end. */
  newestUnreliable = -1;

  constructor(readonly transport: LoopbackTransport, id: number, remote: string, initiator: boolean) {
    this.id = id;
    this.remote = remote;
    this.initiator = initiator;
  }

  /** `closed` as soon as this end closes; otherwise what its transport's `poll()` has reported. */
  get state(): ConnectionState {
    return this.localClosed ? "closed" : this.seen;
  }

  /** The conditions applied to what this end sends: its own if set, else its transport's. */
  get conditions(): Readonly<LinkConditions> {
    return this.ownConditions ?? this.transport.conditions;
  }

  /** Override the transport's conditions for this end's sends. `undefined` goes back to the transport's. */
  setConditions(conditions: LinkConditions | undefined): void {
    this.ownConditions = conditions && { ...this.transport.conditions, ...conditions };
  }

  send(channel: Channel, data: Uint8Array): void {
    if (this.state === "closed") throw new Error(`Can't send on closed loopback connection ${this.id} (${this.remote}).`);
    const peer = this.peer;
    // Nothing is listening, or the other end closed and its close event is on its way: drop it.
    if (!peer || this.remoteClosed) return;
    const { latencyMs = 0, jitterMs = 0, loss = 0 } = this.conditions;
    const random = this.transport.random;
    const now = this.transport.now();
    let at = now + latencyMs + jitterMs * random();
    const copy = data.slice();
    if (channel === "reliable") {
      // A lost reliable message arrives a round trip later, as if retransmitted; later ones wait behind it.
      for (let i = 0; i < MAX_RETRANSMITS && random() < loss; i++) at += 2 * latencyMs;
      at = Math.max(at, this.lastReliableAt, peer.openAt);
      this.lastReliableAt = at;
      peer.transport.enqueue({ at, seq: nextSequence++, connection: peer, event: { kind: "data", connection: peer, channel, data: copy } });
    } else {
      const unreliableSeq = this.unreliableSent++;
      if (random() < loss) return;
      at = Math.max(at, peer.openAt);
      peer.transport.enqueue({ at, seq: nextSequence++, connection: peer, event: { kind: "data", connection: peer, channel, data: copy }, unreliableSeq });
    }
  }

  close(reason = "Closed by the local end."): void {
    if (this.state === "closed") return;
    this.localClosed = true;
    this.transport.forget(this);
    // This end hears about it on its next poll; the peer after what was sent reliably before it.
    const now = this.transport.now();
    this.transport.enqueue({ at: now, seq: nextSequence++, connection: this, event: { kind: "close", connection: this, reason } });
    const peer = this.peer;
    if (peer && !peer.localClosed && !peer.remoteClosed) {
      peer.remoteClosed = true;
      peer.transport.forget(peer);
      const at = Math.max(now + (this.conditions.latencyMs ?? 0), this.lastReliableAt, peer.openAt);
      peer.transport.enqueue({ at, seq: nextSequence++, connection: peer, event: { kind: "close", connection: peer, reason: `Closed by the remote end: ${reason}` } });
    }
  }
}

export class LoopbackTransport implements Transport {
  /** @internal */
  readonly now: () => number;
  /** @internal */
  readonly random: () => number;
  /** For logs and the remote address the other end sees. */
  readonly name = `loopback-${nextTransportNumber++}`;
  private currentConditions: LinkConditions;
  private address: string | undefined;
  private closed = false;
  private nextConnectionId = 1;
  private readonly connections = new Set<LoopbackConnection>();
  /** Sorted by (at, seq). */
  private readonly inbox: Pending[] = [];

  constructor(options: Record<string, unknown> | LoopbackOptions = {}) {
    const o = options as LoopbackOptions;
    this.now = typeof o.now === "function" ? o.now : () => performance.now();
    this.random = typeof o.random === "function" ? o.random : Math.random;
    this.currentConditions = pickConditions(o);
  }

  /** The conditions applied to what this transport's connections send. */
  get conditions(): Readonly<LinkConditions> {
    return this.currentConditions;
  }

  /** Change the simulated conditions (merged into the current ones). Applies to messages sent from now on. */
  setConditions(conditions: LinkConditions): void {
    this.currentConditions = { ...this.currentConditions, ...pickConditions(conditions) };
  }

  /** The address this transport listens at, if any. */
  get listening(): string | undefined {
    return this.address;
  }

  async listen(address: string): Promise<void> {
    if (this.closed) throw new Error(`Loopback transport ${this.name} is closed.`);
    if (this.address !== undefined) throw new Error(`Loopback transport ${this.name} already listens at "${this.address}".`);
    if (listeners.has(address)) throw new Error(`Loopback address "${address}" is already taken.`);
    listeners.set(address, this);
    this.address = address;
  }

  connect(address: string): TransportConnection {
    if (this.closed) throw new Error(`Loopback transport ${this.name} is closed.`);
    const local = new LoopbackConnection(this, this.nextConnectionId++, address, true);
    this.connections.add(local);
    const now = this.now();
    const latency = this.currentConditions.latencyMs ?? 0;
    const server = listeners.get(address);
    if (!server) {
      // Refused: the client hears it on its next poll, and sends until then are dropped.
      local.remoteClosed = true;
      this.connections.delete(local);
      this.enqueue({ at: now, seq: nextSequence++, connection: local, event: { kind: "close", connection: local, reason: `Nothing is listening at loopback address "${address}".` } });
      return local;
    }
    // The server hears the connect after one way; the client hears it accepted after a round trip.
    const remote = new LoopbackConnection(server, server.nextConnectionId++, `${this.name}#${local.id}`, false);
    server.connections.add(remote);
    local.peer = remote;
    remote.peer = local;
    remote.openAt = now + latency;
    local.openAt = now + 2 * latency;
    server.enqueue({ at: remote.openAt, seq: nextSequence++, connection: remote, event: { kind: "open", connection: remote } });
    this.enqueue({ at: local.openAt, seq: nextSequence++, connection: local, event: { kind: "open", connection: local } });
    return local;
  }

  poll(): TransportEvent[] {
    const now = this.now();
    let due = 0;
    while (due < this.inbox.length && this.inbox[due].at <= now) due++;
    const events: TransportEvent[] = [];
    for (const p of this.inbox.splice(0, due)) {
      const c = p.connection;
      if (c.seen === "closed") continue;
      const kind = p.event.kind;
      if (kind === "open") {
        if (c.localClosed) continue;
        c.seen = "open";
      } else if (kind === "close") {
        const unseen = c.seen === "connecting" && !c.initiator;
        c.seen = "closed";
        if (unseen) continue; // A server never hears about a connection that closed before it opened.
      } else if (c.seen !== "open" || c.localClosed) {
        continue;
      } else if (p.unreliableSeq !== undefined) {
        if (p.unreliableSeq <= c.newestUnreliable) continue; // Stale: something newer already arrived.
        c.newestUnreliable = p.unreliableSeq;
      }
      events.push(p.event);
    }
    return events;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of [...this.connections]) c.close("The transport was closed.");
    if (this.address !== undefined && listeners.get(this.address) === this) listeners.delete(this.address);
    this.address = undefined;
  }

  /** @internal */
  enqueue(p: Pending): void {
    // Binary search for the first entry that sorts after p.
    let lo = 0;
    let hi = this.inbox.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const m = this.inbox[mid];
      if (m.at < p.at || (m.at === p.at && m.seq < p.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.inbox.splice(lo, 0, p);
  }

  /** @internal */
  forget(c: LoopbackConnection): void {
    this.connections.delete(c);
  }
}

function pickConditions(o: LinkConditions): LinkConditions {
  const out: LinkConditions = {};
  if (typeof o.latencyMs === "number") out.latencyMs = Math.max(0, o.latencyMs);
  if (typeof o.jitterMs === "number") out.jitterMs = Math.max(0, o.jitterMs);
  if (typeof o.loss === "number") out.loss = Math.min(1, Math.max(0, o.loss));
  return out;
}

registerTransport("loopback", options => new LoopbackTransport(options));
