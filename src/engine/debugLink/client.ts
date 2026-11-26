// The tool's end of a debug link (ADR 0376): the editor and the Studio listen, and every build that connects becomes a
// `DebugLinkPeer` once it says hello. The listener owns a listening transport and polls it (the tool calls `poll()` on
// its own clock); a peer subscribes to topics (pulled: the build sends only what a subscription asks for), sends
// requests (answered by promises) and commands (applied at the build's next frame start). Nothing reaches a build before
// the tool accepts it (`accept()`): the tool decides, asking first for a non-local one.
//
// ADR 0403 adds the other direction: a `ToolConnector` connects out to a listening build (`host.ts`'s
// `BuildListener`), pairing with the code the build shows; its peers are the same `DebugLinkPeer`s.
//
// **The tool listener's accept rule (version 2, C1).** A build that connects sends `pair` (role build) and then `hello`.
// The listener answers the pair before it reads the hello: a build-role pair whose token its `TokenGate` admits is
// `paired` via `token` and its peer arrives already accepted (a valid token skips the prompt); a same-machine one is
// `paired` via `same-machine`; a tokenless one from another machine is `paired` via `prompt` and its peer arrives
// pending, for the tool to ask; a wrong, expired or used token, or any token while the gate is locked, is refused with
// `paired` and the connection closes, and the hello behind it is never read. A listener without a gate shows no code, so
// a token can't be checked: it reads every pair as tokenless (the prompt still guards it). A `hello` before any `pair`
// is a tokenless build's (a build that says hello first, `DebugLinkSession` without `pair`): its peer arrives pending,
// exactly as in version 1, and the tool decides.
import type { Transport, TransportConnection } from "../net/Transport";
import type { GateVerdict, TokenGate } from "./pairing/gate";
import {
  EnvelopeKind,
  decodeEnvelope,
  encodeEnvelope,
  jsonPayload,
  pairedEnvelope,
  pairEnvelope,
  pairRefusalMessage,
  readHello,
  readJsonPayload,
  readPair,
  readPairReply,
  type DebugHello,
  type DebugPair,
  type DebugPairReply,
  type EndpointKind,
  type Envelope,
} from "./protocol";
import { readRecords, type LinkRecord } from "./records";
import { sameMachineRemote } from "./session";

/** Why a peer was let in, as its `paired` said: `token`, `same-machine`, `prompt` (the tool asks), or null (it said hello first). */
export type PeerAdmission = "token" | "same-machine" | "prompt" | null;

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
    /** The `pair` the build sent before its hello (on a tool listener), or null: it said hello first, or this tool connected to it. */
    readonly pair: DebugPair | null = null,
    /** Why it was let in (`PeerAdmission`). */
    readonly admission: PeerAdmission = null,
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
  /** A build said hello (pending: accept it, or close it; already accepted when its `pair` carried a valid token). */
  onPeer?(peer: DebugLinkPeer): void;
  /** A peer's connection closed. */
  onClose?(peer: DebugLinkPeer): void;
}

/** How a tool listener checks connecting builds (version 2, ADR 0403). */
export interface ListenerOptions {
  /**
   * The gate behind the code the tool shows (the Studio's, the editor's). Absent: the tool shows no code, and every
   * build's pair is read as tokenless (same machine: in; another machine: the tool's prompt).
   */
  readonly gate?: TokenGate;
  /**
   * Whether a connection whose transport names its far end `remote` comes from this machine. Default: loopback
   * addresses and in-process loopback links (`sameMachineRemote`); a transport that names remotes its own way, or a
   * listener that knows the machine's interface addresses, passes its own.
   */
  readonly sameMachine?: (remote: string) => boolean;
}

/** A connection on a tool listener before its hello: nothing yet, or its pair answered. */
interface Door {
  readonly pair: DebugPair | null;
  readonly admission: PeerAdmission;
}

/** @internal Listens on a transport and turns connecting builds into peers. */
export class DebugLinkListener {
  private readonly connections = new Map<TransportConnection, DebugLinkPeer | Door>();
  private stopped = false;

  constructor(
    private readonly transport: Transport,
    private readonly events: ListenerEvents = {},
    private readonly options: ListenerOptions = {},
  ) {}

  /** Starts listening at `address` (a transport address: "ws://0.0.0.0:7790/debug", a loopback name). */
  listen(address: string): Promise<void> {
    return this.transport.listen(address);
  }

  /** Every peer that said hello and is still connected. */
  get peers(): readonly DebugLinkPeer[] {
    return [...this.connections.values()].filter((p): p is DebugLinkPeer => p instanceof DebugLinkPeer && p.state !== "closed");
  }

  /** Handles what arrived since the last call. */
  poll(): void {
    if (this.stopped) return;
    for (const event of this.transport.poll()) {
      const c = event.connection;
      if (event.kind === "open") {
        this.connections.set(c, { pair: null, admission: null });
      } else if (event.kind === "close") {
        const peer = this.connections.get(c);
        this.connections.delete(c);
        if (peer instanceof DebugLinkPeer) {
          peer.closed(event.reason);
          this.events.onClose?.(peer);
        }
      } else {
        const entry = this.connections.get(c);
        if (!entry) continue; // refused or closed by this end: what it sent behind that is never read
        const decoded = decodeEnvelope(event.data);
        if ("refused" in decoded) {
          // Not this protocol (a malformed envelope, another version): say so, then close (ADR 0376).
          if (c.state === "open") c.send("reliable", encodeEnvelope({ kind: EnvelopeKind.error, topic: "", id: 0, payload: jsonPayload({ message: decoded.refused }) }));
          const reason = `The tool closed the debug link: ${decoded.refused}`;
          this.connections.delete(c);
          if (entry instanceof DebugLinkPeer) {
            entry.close(reason);
            this.events.onClose?.(entry);
          } else if (c.state !== "closed") c.close(reason);
          continue;
        }
        const e = decoded.envelope;
        if (entry instanceof DebugLinkPeer) entry.receive(e);
        else if (e.kind === EnvelopeKind.pair && entry.pair === null) this.pairing(c, e);
        else if (e.kind === EnvelopeKind.hello) {
          const read = readJsonPayload(e.payload);
          const made = new DebugLinkPeer(c, readHello("value" in read ? read.value : undefined), entry.pair, entry.admission);
          this.connections.set(c, made);
          if (entry.admission === "token") made.accept();
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
      if (peer instanceof DebugLinkPeer) peer.close("The tool stopped listening.");
      else if (c.state !== "closed") c.close("The tool stopped listening.");
    }
    this.connections.clear();
    this.transport.close();
  }

  /** Answers a build's `pair` (the accept rule at the head of this file). */
  private pairing(c: TransportConnection, e: Envelope): void {
    const read = readJsonPayload(e.payload);
    const pair = "refused" in read ? read : readPair(read.value);
    if ("refused" in pair) {
      c.send("reliable", encodeEnvelope({ kind: EnvelopeKind.error, topic: "", id: 0, payload: jsonPayload({ message: pair.refused }) }));
      return this.refuse(c, pair.refused);
    }
    if (pair.pair.role !== "build") return this.answer(c, { accepted: false, reason: "role", message: pairRefusalMessage("role") });
    const sameMachine = (this.options.sameMachine ?? sameMachineRemote)(c.remote);
    const gate = this.options.gate;
    const verdict: GateVerdict = gate ? gate.check(pair.pair.token, { sameMachine }) : sameMachine ? { verdict: "admit", via: "same-machine" } : { verdict: "prompt" };
    if (verdict.verdict === "refuse") return this.answer(c, { accepted: false, reason: verdict.reason, message: pairRefusalMessage(verdict.reason) });
    const admission = verdict.verdict === "admit" ? verdict.via : "prompt";
    this.connections.set(c, { pair: pair.pair, admission });
    this.answer(c, { accepted: true, via: admission });
  }

  private answer(c: TransportConnection, reply: DebugPairReply): void {
    if (c.state === "open") c.send("reliable", encodeEnvelope(pairedEnvelope(reply)));
    if (!reply.accepted) this.refuse(c, reply.message);
  }

  private refuse(c: TransportConnection, reason: string): void {
    this.connections.delete(c);
    if (c.state !== "closed") c.close(reason);
  }
}

// --- the tool connects out (ADR 0403 "Roles"; plan contract C3) ------------------------------------------------------------

/**
 * Where one connection attempt to a listening build stands:
 * - `connecting`: the transport is opening;
 * - `pairing`: open, `pair` sent, waiting for `paired` (and, once accepted, for the build's hello);
 * - `paired`: accepted; the build's `hello` arrived and `peer` is its accepted peer;
 * - `refused`: the build answered `paired` with a refusal (`refusal`), and closed;
 * - `failed`: it never opened, or closed before the hello (`reason`), or was cancelled.
 */
export type ConnectAttemptState = "connecting" | "pairing" | "paired" | "refused" | "failed";

/** One attempt to connect to a listening build. */
export interface ConnectAttempt {
  /** The address it connects to. */
  readonly address: string;
  readonly state: ConnectAttemptState;
  /** The build's refusal while `refused` (its reason and sentence), else null. */
  readonly refusal: Extract<DebugPairReply, { accepted: false }> | null;
  /** Why it `failed` ("" otherwise). */
  readonly reason: string;
  /** The build, once `paired`; null before. */
  readonly peer: DebugLinkPeer | null;
  /** Gives the attempt up (closes its connection); a `paired` attempt's peer closes too. */
  cancel(): void;
}

export interface ToolConnectorOptions {
  /** This tool's endpoint kind, sent in `pair`. */
  readonly kind: EndpointKind;
  /** This tool's name, sent in `pair` for the build's list ("Audio Studio on DESKTOP-1"). */
  readonly name?: string;
  /** Hears peers (once paired) and their closes, as a listener's events do. */
  readonly events?: ListenerEvents;
}

/** One attempt, as the connector keeps it. */
class Attempt implements ConnectAttempt {
  state: ConnectAttemptState = "connecting";
  refusal: Extract<DebugPairReply, { accepted: false }> | null = null;
  reason = "";
  peer: DebugLinkPeer | null = null;
  /** The build accepted the pair; its hello is next. */
  accepted = false;

  constructor(
    readonly address: string,
    readonly connection: TransportConnection,
    readonly token: number | undefined,
    private readonly drop: (a: Attempt) => void,
  ) {}

  cancel(): void {
    if (this.peer) {
      this.peer.close("The tool disconnected.");
      return;
    }
    if (this.state === "connecting" || this.state === "pairing") this.fail("Cancelled.");
  }

  /** Ends the attempt as `failed` with `reason`, closing its connection. */
  fail(reason: string): void {
    this.state = "failed";
    this.reason = reason;
    this.end(reason);
  }

  /** Closes the connection and forgets the attempt. */
  end(reason: string): void {
    if (this.connection.state !== "closed") this.connection.close(reason);
    this.drop(this);
  }
}

/**
 * A tool that connects out to listening builds (ADR 0403: a native build listens and the tool connects). Each
 * `connect` opens one connection on the transport, sends `pair` (role `tool`, this tool's kind and name, the token from
 * the build's code) as its first message, and on `paired` (accepted) waits for the build's `hello`; the peer it makes is
 * accepted at once (the tool chose to connect, so there is nothing to ask: it sends `welcome`), and `events.onPeer`
 * hears it. Peers behave as a listener's do. Polled on the tool's own clock, as `DebugLinkListener` is. Trying an
 * address code's candidates in turn is the caller's (`connectFlow.ts`): one attempt per address. An attempt that fails
 * or is refused stays as it ended; connecting again is a new `connect` (a used code is spent: the build shows the next).
 */
export class ToolConnector {
  private readonly attempts = new Map<TransportConnection, Attempt>();
  private stopped = false;

  constructor(
    private readonly transport: Transport,
    private readonly options: ToolConnectorOptions,
  ) {}

  /** Starts connecting to the build listening at `address` with `token` (absent: same machine, or the build may ask). */
  connect(address: string, token?: number): ConnectAttempt {
    if (this.stopped) throw new Error("This tool connector is closed.");
    const drop = (a: Attempt) => {
      if (this.attempts.get(a.connection) === a && !a.peer) this.attempts.delete(a.connection);
    };
    let connection: TransportConnection;
    try {
      connection = this.transport.connect(address);
    } catch (err) {
      const failed = new Attempt(address, { id: -1, remote: address, state: "closed", send() {}, close() {} }, token, () => {});
      failed.state = "failed";
      failed.reason = `Couldn't connect to ${address} (${(err as Error)?.message ?? err}).`;
      return failed;
    }
    const attempt = new Attempt(address, connection, token, drop);
    this.attempts.set(connection, attempt);
    if (connection.state === "open") this.opened(attempt);
    return attempt;
  }

  /** Every paired peer still connected. */
  get peers(): readonly DebugLinkPeer[] {
    const out: DebugLinkPeer[] = [];
    for (const a of this.attempts.values()) if (a.peer && a.peer.state !== "closed") out.push(a.peer);
    return out;
  }

  /** Handles what arrived since the last call (pairing replies, hellos, peers' messages, closes). */
  poll(): void {
    if (this.stopped) return;
    for (const event of this.transport.poll()) {
      const a = this.attempts.get(event.connection);
      if (!a) continue;
      if (event.kind === "open") {
        this.opened(a);
      } else if (event.kind === "close") {
        this.attempts.delete(event.connection);
        if (a.peer) {
          a.peer.closed(event.reason);
          this.options.events?.onClose?.(a.peer);
        } else if (a.state === "connecting" || a.state === "pairing") {
          a.state = "failed";
          a.reason = event.reason;
        }
      } else {
        const decoded = decodeEnvelope(event.data);
        if ("refused" in decoded) {
          if (a.connection.state === "open") a.connection.send("reliable", encodeEnvelope({ kind: EnvelopeKind.error, topic: "", id: 0, payload: jsonPayload({ message: decoded.refused }) }));
          continue;
        }
        this.receive(a, decoded.envelope);
      }
    }
  }

  /** Closes every attempt and peer, and the transport. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const a of [...this.attempts.values()]) {
      if (a.peer) a.peer.close("The tool closed the debug link.");
      else a.cancel();
    }
    this.attempts.clear();
    this.transport.close();
  }

  private opened(a: Attempt): void {
    if (a.state !== "connecting") return;
    a.state = "pairing";
    a.connection.send("reliable", encodeEnvelope(pairEnvelope({ role: "tool", kind: this.options.kind, token: a.token, name: this.options.name })));
  }

  private receive(a: Attempt, e: Envelope): void {
    if (a.peer) return a.peer.receive(e);
    if (a.state !== "pairing") return;
    if (e.kind === EnvelopeKind.paired && !a.accepted) {
      const read = readJsonPayload(e.payload);
      const reply = "refused" in read ? read : readPairReply(read.value);
      if ("refused" in reply) return a.fail(`The build's answer to the pairing didn't make sense (${reply.refused}).`);
      if (reply.reply.accepted) {
        a.accepted = true;
        return;
      }
      a.state = "refused";
      a.refusal = reply.reply;
      return a.end(reply.reply.message);
    }
    if (e.kind === EnvelopeKind.hello && a.accepted) {
      const read = readJsonPayload(e.payload);
      const peer = new DebugLinkPeer(a.connection, readHello("value" in read ? read.value : undefined));
      a.peer = peer;
      a.state = "paired";
      peer.accept();
      this.options.events?.onPeer?.(peer);
      return;
    }
    if (e.kind === EnvelopeKind.error) {
      const read = readJsonPayload(e.payload);
      const value = "value" in read ? read.value : undefined;
      const message = value && typeof (value as { message?: unknown }).message === "string" ? (value as { message: string }).message : "The build refused it.";
      return a.fail(message);
    }
    a.fail(e.kind === EnvelopeKind.hello ? "The build said hello before it answered the pairing." : "The build sent something before it answered the pairing.");
  }
}
