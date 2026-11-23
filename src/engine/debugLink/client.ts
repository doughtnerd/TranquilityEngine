// The tool's end of a debug link (ADR 0376): the editor and the Studio listen, and every build that connects becomes a
// `DebugLinkPeer` once it says hello. The listener owns a listening transport and polls it (the tool calls `poll()` on
// its own clock); a peer subscribes to topics (pulled: the build sends only what a subscription asks for), sends
// requests (answered by promises) and commands (applied at the build's next frame start). Nothing reaches a build before
// the tool accepts it (`accept()`): the tool decides, asking first for a non-local one.
import type { Transport, TransportConnection } from "../net/Transport";
import { EnvelopeKind, decodeEnvelope, encodeEnvelope, jsonPayload, readHello, readJsonPayload, type DebugHello, type Envelope } from "./protocol";
import { readRecords, type LinkRecord } from "./records";

export type PeerState = "pending" | "accepted" | "closed";

/** A live subscription, from the tool's side. */
export interface PeerSubscription {
  readonly topic: string;
  /** Ends it (the build stops sending). */
  unsubscribe(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

interface Watch {
  readonly topic: string;
  readonly onSample: (records: readonly LinkRecord[]) => void;
  readonly onError?: (message: string) => void;
}

/** @internal A connected build, as the tool sees it. */
export class DebugLinkPeer {
  private status: PeerState = "pending";
  private nextId = 1;
  private readonly requests = new Map<number, Pending>();
  private readonly watches = new Map<number, Watch>();
  private reason = "";
  /** Hears errors the build sent that answer no request or subscription. */
  onError: ((message: string) => void) | null = null;

  constructor(
    private readonly connection: TransportConnection,
    /** Who the build says it is. */
    readonly hello: DebugHello,
  ) {}

  /** The build's address, as the transport names it. */
  get remote(): string {
    return this.connection.remote;
  }

  get state(): PeerState {
    return this.status;
  }

  /** Why the peer closed ("" while it's open). */
  get closedReason(): string {
    return this.reason;
  }

  /** Lets the build in: it may then be subscribed to and sent requests and commands. */
  accept(): void {
    if (this.status !== "pending") return;
    this.status = "accepted";
    this.send({ kind: EnvelopeKind.welcome, topic: "", id: 0, payload: new Uint8Array(0) });
  }

  /** Starts a subscription to `topic` for `params`; `onSample` hears each sample's records. */
  subscribe(topic: string, params: unknown, onSample: (records: readonly LinkRecord[]) => void, onError?: (message: string) => void): PeerSubscription {
    const id = this.nextId++;
    this.watches.set(id, { topic, onSample, onError });
    this.send({ kind: EnvelopeKind.subscribe, topic, id, payload: jsonPayload(params ?? null) });
    return {
      topic,
      unsubscribe: () => {
        if (!this.watches.delete(id)) return;
        this.send({ kind: EnvelopeKind.unsubscribe, topic, id, payload: new Uint8Array(0) });
      },
    };
  }

  /** Asks `topic` something; resolves with its reply, rejects with the build's error or when the link closes. */
  request(topic: string, method: string, params?: unknown): Promise<unknown> {
    if (this.status !== "accepted") return Promise.reject(new Error(this.status === "closed" ? "The build is gone." : "The build hasn't been accepted."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.send({ kind: EnvelopeKind.request, topic, id, payload: jsonPayload({ method, params }) });
    });
  }

  /** Sends a command to `topic`, applied at the build's next frame start. False when the build isn't accepted or is gone. */
  command(topic: string, name: string, params?: unknown): boolean {
    if (this.status !== "accepted") return false;
    this.send({ kind: EnvelopeKind.command, topic, id: this.nextId++, payload: jsonPayload({ name, params }) });
    return true;
  }

  /** Closes the link to the build. */
  close(reason = "The tool closed the debug link."): void {
    if (this.status === "closed") return;
    if (this.connection.state !== "closed") this.connection.close(reason);
    this.closed(reason);
  }

  /** @internal The listener: a message from the build. */
  receive(e: Envelope): void {
    if (this.status === "closed") return;
    if (e.kind === EnvelopeKind.sample) {
      const w = this.watches.get(e.id);
      if (!w || w.topic !== e.topic) return; // unsubscribed meanwhile
      w.onSample(readRecords(e.payload).records);
      return;
    }
    if (e.kind === EnvelopeKind.reply || e.kind === EnvelopeKind.error) {
      const read = readJsonPayload(e.payload);
      const value = "value" in read ? read.value : undefined;
      const r = this.requests.get(e.id);
      if (e.kind === EnvelopeKind.reply) {
        if (!r) return;
        this.requests.delete(e.id);
        r.resolve(value);
        return;
      }
      const message = value && typeof (value as { message?: unknown }).message === "string" ? (value as { message: string }).message : "The build refused it.";
      if (r) {
        this.requests.delete(e.id);
        r.reject(new Error(message));
      } else if (this.watches.has(e.id)) {
        const w = this.watches.get(e.id)!;
        this.watches.delete(e.id);
        w.onError?.(message);
      } else this.onError?.(message);
    }
  }

  /** @internal The listener: the connection closed. */
  closed(reason: string): void {
    if (this.status === "closed") return;
    this.status = "closed";
    this.reason = reason;
    for (const r of this.requests.values()) r.reject(new Error(`The build is gone (${reason}).`));
    this.requests.clear();
    this.watches.clear();
  }

  private send(e: Envelope): void {
    if (this.status === "closed" || this.connection.state !== "open") return;
    this.connection.send("reliable", encodeEnvelope(e)); // everything a tool sends is a request or a command
  }
}

export interface ListenerEvents {
  /** A build said hello (pending: accept it, or close it). */
  onPeer?(peer: DebugLinkPeer): void;
  /** A peer's connection closed. */
  onClose?(peer: DebugLinkPeer): void;
}

/** @internal Listens on a transport and turns connecting builds into peers. */
export class DebugLinkListener {
  private readonly connections = new Map<TransportConnection, DebugLinkPeer | null>();
  private stopped = false;

  constructor(
    private readonly transport: Transport,
    private readonly events: ListenerEvents = {},
  ) {}

  /** Starts listening at `address` (a transport address: "ws://0.0.0.0:7790/debug", a loopback name). */
  listen(address: string): Promise<void> {
    return this.transport.listen(address);
  }

  /** Every peer that said hello and is still connected. */
  get peers(): readonly DebugLinkPeer[] {
    return [...this.connections.values()].filter((p): p is DebugLinkPeer => p !== null && p.state !== "closed");
  }

  /** Handles what arrived since the last call. */
  poll(): void {
    if (this.stopped) return;
    for (const event of this.transport.poll()) {
      const c = event.connection;
      if (event.kind === "open") {
        this.connections.set(c, null);
      } else if (event.kind === "close") {
        const peer = this.connections.get(c);
        this.connections.delete(c);
        if (peer) {
          peer.closed(event.reason);
          this.events.onClose?.(peer);
        }
      } else {
        const decoded = decodeEnvelope(event.data);
        if ("refused" in decoded) {
          if (c.state === "open") c.send("reliable", encodeEnvelope({ kind: EnvelopeKind.error, topic: "", id: 0, payload: jsonPayload({ message: decoded.refused }) }));
          continue;
        }
        const e = decoded.envelope;
        const peer = this.connections.get(c);
        if (peer) peer.receive(e);
        else if (e.kind === EnvelopeKind.hello) {
          const read = readJsonPayload(e.payload);
          const made = new DebugLinkPeer(c, readHello("value" in read ? read.value : undefined));
          this.connections.set(c, made);
          this.events.onPeer?.(made);
        }
      }
    }
  }

  /** Closes every connection and stops listening. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [c, peer] of this.connections) {
      if (peer) peer.close("The tool stopped listening.");
      else if (c.state !== "closed") c.close("The tool stopped listening.");
    }
    this.connections.clear();
    this.transport.close();
  }
}
