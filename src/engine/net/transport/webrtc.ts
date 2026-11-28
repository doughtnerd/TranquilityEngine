/**
 * The `webrtc` transport (ADR 0403 "Transports"): a connection that is a peer-to-peer `RTCPeerConnection` alone, for
 * pairs where neither side can reach a listener on the other (a page on http ↔ a page on http, a page on https ↔
 * anything). "Two data channels, one reliable and ordered (`myco-r`) and 0333's unreliable one (`myco-u`), on the page's
 * own `RTCPeerConnection`. On one network it uses host candidates only (browsers' `.local` names included): no STUN or
 * TURN. ICE servers are a setting for later use beyond the LAN."
 *
 * Unlike 0333's lane (`datagramLane.ts`), nothing rides beside a socket: the offer, answer and candidates cross through
 * an injected `WebRtcSignaller` (in the link, a rendezvous client, `debugLink/rendezvous/`), and both channels carry the
 * connection's traffic. The transport's two ends map to the `Transport` interface as:
 * - `listen(address)`: the waiting side (it showed the room code): it answers the offer arriving through the signaller
 *   the factory makes for `address`; one connection per signaller session;
 * - `connect(address)`: the joining side (it typed the code): it makes the offer through its signaller for `address`.
 * `address` is opaque here (the link passes the rendezvous URL and room); only the signaller factory reads it.
 *
 * Message size (plan §7a, O5): a data channel message is at most `WEBRTC_MAX_MESSAGE_BYTES` (64 KiB), the existing
 * ceiling of 0333's lane (`webrtc.maxDatagramBytes` up to 65,536). A larger reliable message is fragmented on `myco-r`
 * and reassembled before delivery (up to `maxMessageBytes`); an unreliable message larger than the ceiling travels on
 * `myco-r` too, as the WebSocket transport sends one too big for its lane on the socket. Stale unreliable messages are
 * dropped as the `Channel` contract says. Close rules match `websocket.ts`: either channel closing, the peer connection
 * failing or the signaller failing before open closes the connection with a reason.
 *
 * Not registered with `createTransport` yet (R2 fills it, R5 registers it). Reached only from the debug link, so a
 * release export holds none of it (the `DEBUG_LINK` rule in `vite.shared.ts`).
 *
 * Wire format:
 * - `myco-u`: a 4-byte big-endian sequence number, then the payload (at most `WEBRTC_MAX_MESSAGE_BYTES` in all). The
 *   receiver drops one that isn't newer than the newest unreliable message it delivered, whichever channel brought it
 *   (0333's rule). Unreliable sends are dropped, latest-wins, while the channel's send buffer holds over 64 KiB.
 * - `myco-r`: each data channel message is a 1-byte header then at most `WEBRTC_MAX_MESSAGE_BYTES - 1` bytes. Header
 *   bit 0: the message is unreliable (its reassembled payload starts with its sequence number); bit 1: more fragments
 *   of this message follow; bit 2: a close frame (the payload is the UTF-8 reason, which the peer's `close` event
 *   carries). Bits 3-7 are reserved: a peer that sees one set closes with a protocol error.
 * - Reliable sends queue in the connection and feed `myco-r` as its buffer drains (so a multi-megabyte message never
 *   overruns a browser's data channel buffer); a connection whose backlog is over 8 MiB when a reliable message is sent
 *   is closed as too slow, as the WebSocket transport's is.
 *
 * Minimal use from a plain page (two peers, signals carried by hand; a rendezvous client does the same over a socket):
 *
 *     const box = { a: [] as WebRtcSignal[], b: [] as WebRtcSignal[] }; // a's inbox, b's inbox
 *     const handSignaller = (inbox: WebRtcSignal[], outbox: WebRtcSignal[]): WebRtcSignaller => ({
 *       state: "open", closedReason: "",
 *       send: (s) => outbox.push(s), poll: () => inbox.splice(0), connected() {}, close() {},
 *     });
 *     const host = new WebRtcTransport({ signaller: () => handSignaller(box.a, box.b) });
 *     const join = new WebRtcTransport({ signaller: () => handSignaller(box.b, box.a) });
 *     await host.listen("room");               // answers
 *     const toHost = join.connect("room");     // offers; poll both until each sees { kind: "open" }
 *     setInterval(() => { for (const e of [...host.poll(), ...join.poll()]) console.log(e.kind); }, 16);
 *     toHost.send("reliable", new Uint8Array([1, 2, 3]));
 *
 * The listening side's connection is reported only by its `open` event; a session that fails before it opens reports
 * nothing (as a WebSocket server reports no failed handshake). The caller made the signaller, so it reads why there.
 */
import type { Channel, ConnectionState, Transport, TransportConnection, TransportEvent } from "../Transport";
import type { PeerConnectionConstructor } from "./datagramLane";
import { readSeq, SEQUENCE_BYTES, UnreliableSequence, withSeq } from "./sequence";

/** The reliable, ordered data channel's label. */
export const RELIABLE_CHANNEL = "myco-r";
/** The unreliable, unordered data channel's label (0333's, `datagramLane.ts` `DATAGRAM_CHANNEL`). */
export const UNRELIABLE_CHANNEL = "myco-u";
/** The largest data channel message, bytes (64 KiB). */
export const WEBRTC_MAX_MESSAGE_BYTES = 65_536;
/** The largest message a connection reassembles from `myco-r` fragments, by default (the WebSocket transport's 1 MiB). */
export const DEFAULT_WEBRTC_MAX_MESSAGE_BYTES = 1024 * 1024;
/** A connection whose channels haven't opened by then is given up, ms, by default. */
export const DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS = 15_000;

/** A signal between the two peers (the rendezvous relays it unread: `RendezvousSignal`). */
export type WebRtcSignal =
  | { readonly t: "offer" | "answer"; readonly sdp: string }
  /** `candidate` "" with `mid` null is the end of candidates. */
  | { readonly t: "candidate"; readonly candidate: string; readonly mid: string | null };

/**
 * One signalling session with the other peer (a rendezvous room seat). Polled, as transports are (ADR 0033): the
 * transport calls `poll()` once per `Transport.poll()`.
 */
export interface WebRtcSignaller {
  /** `connecting` until the other peer is there to signal, `open` while it is, `closed` after (the room expired or failed). */
  readonly state: "connecting" | "open" | "closed";
  /** Why it closed ("" while it hasn't). */
  readonly closedReason: string;
  /** Sends a signal to the other peer. Ignored unless `open`. */
  send(signal: WebRtcSignal): void;
  /** The signals that arrived since the last call, in order. */
  poll(): WebRtcSignal[];
  /** The peer connection opened: the signaller may let the rendezvous forget the room, and close. */
  connected(): void;
  /** Gives up the session. */
  close(): void;
}

/** One `RTCIceServer`: `urls` and optional credentials (`debug.iceServers`, Preferences). */
export interface WebRtcIceServer {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/** `createTransport("webrtc", options)`'s options. */
export interface WebRtcTransportOptions {
  /**
   * Makes the signalling session for `address` and this side's `role` (`answer` for `listen`, `offer` for `connect`).
   * Required: without one the transport can't connect.
   */
  readonly signaller: (address: string, role: "offer" | "answer") => WebRtcSignaller;
  /** STUN/TURN servers. Default none: host candidates only (0403: "On one network it uses host candidates only"). */
  readonly iceServers?: readonly WebRtcIceServer[];
  /** The largest message a connection reassembles, bytes (default `DEFAULT_WEBRTC_MAX_MESSAGE_BYTES`); a bigger one closes it. */
  readonly maxMessageBytes?: number;
  /** Give up on a connection whose channels haven't opened by then, ms (default `DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS`). */
  readonly connectTimeoutMs?: number;
  /**
   * The `RTCPeerConnection` constructor (default the global one). Node has none; the Node side passes
   * node-datachannel's polyfill, as the WebSocket server does for 0333's lane.
   */
  readonly PeerConnection?: PeerConnectionConstructor;
}

const UNRELIABLE_BIT = 0x01;
const MORE_BIT = 0x02;
const CLOSE_BIT = 0x04;
const RESERVED_BITS = 0xf8;
/** Payload bytes of one `myco-r` fragment. */
const FRAGMENT_BYTES = WEBRTC_MAX_MESSAGE_BYTES - 1;
/** The largest unreliable payload that travels on `myco-u`. */
const MAX_DATAGRAM_PAYLOAD = WEBRTC_MAX_MESSAGE_BYTES - SEQUENCE_BYTES;
/** Unreliable sends are dropped while this much waits in the channel's send buffer (the WebSocket transport's default). */
const UNRELIABLE_BACKLOG_BYTES = 64 * 1024;
/** A connection whose reliable backlog is over this when a reliable message is sent is closed as too slow (as WebSocket). */
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;
/** Fragments are handed to `myco-r` while its buffer holds less than this; the rest wait in the connection. */
const RELIABLE_HIGH_WATER = 1024 * 1024;
/** `myco-r`'s `bufferedAmountLowThreshold`: below it, the connection hands it more. */
const RELIABLE_LOW_WATER = 256 * 1024;
/** Bytes received between two polls before a connection is closed as flooding (at least the WebSocket transport's 4 MiB). */
const MIN_QUEUED_BYTES = 4 * 1024 * 1024;
/** Signals a connection accepts before it treats the other peer as misbehaving. */
const MAX_SIGNALS = 256;
/** After a local close, the peer connection is closed once `myco-r` has drained, or after this long, ms. */
const CLOSE_DRAIN_MS = 5000;

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** One end of a `webrtc` connection. The transport polls it once per `Transport.poll()`. */
class WebRtcConnection implements TransportConnection {
  state: ConnectionState = "connecting";
  /** Unreliable messages dropped because a send buffer was backed up (for the network panel). */
  droppedUnreliable = 0;
  /** Bytes received since the last poll. */
  queuedBytes = 0;
  private readonly pc: RTCPeerConnection;
  private reliable: RTCDataChannel | null = null;
  private unreliable: RTCDataChannel | null = null;
  private signaller: WebRtcSignaller | null;
  /** Signals waiting for the signaller to open. */
  private outSignals: WebRtcSignal[] = [];
  /** Signalling is applied in order: each step waits for the one before (descriptions are async). */
  private chain: Promise<void> = Promise.resolve();
  private signals = 0;
  /** The other peer's description has arrived (candidates before it wait in `early`). */
  private described = false;
  private early: WebRtcSignal[] = [];
  /** Local candidates found before this end's description went out; null once it has. */
  private unsent: WebRtcSignal[] | null = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Messages sent while connecting, sent on open. */
  private pending: { channel: Channel; data: Uint8Array }[] = [];
  /** `myco-r` frames waiting for its buffer to drain, and their bytes. */
  private outbox: Uint8Array[] = [];
  private outboxBytes = 0;
  /** Fragments of the `myco-r` message being reassembled. */
  private parts: Uint8Array[] = [];
  private partsBytes = 0;
  private partsHeader = 0;
  /** Its unreliable messages' numbers, on whichever channel they go (0333). */
  private readonly sequence = new UnreliableSequence();

  constructor(
    readonly id: number,
    readonly remote: string,
    private readonly role: "offer" | "answer",
    signaller: WebRtcSignaller,
    PeerConnection: PeerConnectionConstructor,
    config: RTCConfiguration,
    private readonly maxMessageBytes: number,
    private readonly connectTimeoutMs: number,
    private readonly events: TransportEvent[],
    /** Whether this connection's events reach the caller before it opens (the connecting side's do). */
    private readonly surfaced: boolean,
    private readonly onClosed: (connection: WebRtcConnection) => void,
  ) {
    this.signaller = signaller;
    this.pc = new PeerConnection(config);
    this.pc.onicecandidate = (event) => {
      if (this.state === "closed") return;
      const c = event.candidate;
      const message: WebRtcSignal = c && c.candidate ? { t: "candidate", candidate: c.candidate, mid: c.sdpMid ?? null } : { t: "candidate", candidate: "", mid: null };
      if (this.unsent) this.unsent.push(message); // the description goes first
      else this.signal(message);
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed" || s === "closed") this.fail(`peer connection ${s}`);
    };
    if (role === "offer") {
      this.startTimer();
      this.attach(this.pc.createDataChannel(RELIABLE_CHANNEL, { ordered: true }));
      this.attach(this.pc.createDataChannel(UNRELIABLE_CHANNEL, { ordered: false, maxRetransmits: 0 }));
      this.step(async () => {
        await this.pc.setLocalDescription(await this.pc.createOffer());
        this.sendDescription("offer");
      });
    } else {
      this.pc.ondatachannel = (event) => {
        const channel = event.channel;
        if (channel.label === RELIABLE_CHANNEL && !this.reliable) this.attach(channel);
        else if (channel.label === UNRELIABLE_CHANNEL && !this.unreliable) this.attach(channel);
        else channel.close();
      };
    }
  }

  /** While open: the largest unreliable message that goes as one lossy data channel message. */
  get maxDatagramBytes(): number | undefined {
    return this.state === "open" ? MAX_DATAGRAM_PAYLOAD : undefined;
  }

  send(channel: Channel, data: Uint8Array): void {
    if (this.state === "closed") throw new Error(`Can't send on closed connection ${this.id} (${this.remote}).`);
    if (this.state === "connecting") {
      this.pending.push({ channel, data: data.slice() });
      return;
    }
    if (channel === "reliable") {
      const backlog = this.backlog();
      if (backlog > MAX_BACKLOG_BYTES) return this.close(`too slow: ${backlog} bytes waiting to send`);
      this.enqueue(0, data);
      return;
    }
    const seq = this.sequence.next();
    if (data.byteLength <= MAX_DATAGRAM_PAYLOAD) {
      const u = this.unreliable!;
      if (u.bufferedAmount > UNRELIABLE_BACKLOG_BYTES) {
        this.droppedUnreliable++;
        return;
      }
      try {
        u.send(withSeq(seq, data));
      } catch {
        this.droppedUnreliable++; // lost, as a datagram may be
      }
      return;
    }
    // Too big for one data channel message: the reliable channel carries it, unless it's backed up (latest-wins).
    if (this.backlog() > UNRELIABLE_BACKLOG_BYTES) {
      this.droppedUnreliable++;
      return;
    }
    this.enqueue(UNRELIABLE_BIT, withSeq(seq, data));
  }

  close(reason = "closed"): void {
    if (this.state === "closed") return;
    const reliable = this.reliable;
    if (this.state === "open" && reliable) {
      // Everything sent before the close goes first, then the reason; the peer connection closes once it has drained.
      try {
        for (const frame of this.outbox) reliable.send(frame as Uint8Array<ArrayBuffer>);
        const text = new TextEncoder().encode(reason);
        const frame = new Uint8Array(Math.min(text.byteLength, FRAGMENT_BYTES) + 1);
        frame[0] = CLOSE_BIT;
        frame.set(text.subarray(0, frame.byteLength - 1), 1);
        reliable.send(frame);
      } catch {
        // The channel is failing; the close below is what matters.
      }
      this.closed(reason, true);
    } else {
      this.closed(reason, false);
    }
  }

  /** Read the signaller and feed `myco-r`; called once per transport poll. */
  pump(): void {
    this.queuedBytes = 0;
    if (this.state === "closed") return;
    const signaller = this.signaller;
    if (signaller) {
      if (signaller.state === "open" && this.outSignals.length > 0) for (const s of this.outSignals.splice(0)) signaller.send(s);
      for (const s of signaller.poll()) this.handleSignal(s);
      if (this.state === "connecting" && signaller.state === "closed") {
        return this.fail(`signalling closed${signaller.closedReason ? ` (${signaller.closedReason})` : ""}`);
      }
      if (signaller.state === "closed") this.signaller = null;
    }
    this.drain();
  }

  private signal(message: WebRtcSignal): void {
    const signaller = this.signaller;
    if (signaller?.state === "open" && this.outSignals.length === 0) signaller.send(message);
    else this.outSignals.push(message);
  }

  private handleSignal(message: WebRtcSignal): void {
    if (this.state === "closed") return;
    if (++this.signals > MAX_SIGNALS) return this.fail("protocol error: too many signalling messages");
    if (message.t === "candidate") {
      if (this.state === "open" || message.candidate === "") return; // late, or the end of candidates: nothing to add
      if (!this.described) this.early.push(message);
      else this.step(() => this.addCandidate(message));
      return;
    }
    const expected = this.role === "offer" ? "answer" : "offer";
    if (message.t !== expected || this.described) return this.fail(`protocol error: unexpected ${message.t}`);
    this.described = true; // candidates queued after this wait for it on the chain
    if (this.role === "answer") this.startTimer();
    this.step(async () => {
      await this.pc.setRemoteDescription({ type: message.t, sdp: message.sdp });
      for (const early of this.early.splice(0)) await this.addCandidate(early);
      if (this.role === "answer") {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.sendDescription("answer");
      }
    });
  }

  private addCandidate(message: WebRtcSignal): Promise<void> {
    if (message.t !== "candidate") return Promise.resolve();
    return this.pc.addIceCandidate({ candidate: message.candidate, sdpMid: message.mid ?? undefined });
  }

  private sendDescription(t: "offer" | "answer"): void {
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new Error(`no local ${t}`);
    if (this.state === "closed") return;
    this.signal({ t, sdp });
    for (const candidate of this.unsent ?? []) this.signal(candidate);
    this.unsent = null;
  }

  /** Run `work` after the signalling before it; a failure closes the connection. */
  private step(work: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.state === "closed") return;
      try {
        await work();
      } catch (error) {
        this.fail(`signalling failed: ${(error as Error).message}`);
      }
    });
  }

  private startTimer(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state === "connecting") this.fail(`didn't open within ${this.connectTimeoutMs} ms`);
    }, this.connectTimeoutMs);
  }

  private attach(channel: RTCDataChannel): void {
    const isReliable = channel.label === RELIABLE_CHANNEL;
    if (isReliable) this.reliable = channel;
    else this.unreliable = channel;
    channel.binaryType = "arraybuffer";
    if (isReliable) {
      channel.bufferedAmountLowThreshold = RELIABLE_LOW_WATER;
      channel.onbufferedamountlow = () => this.drain();
    }
    channel.onopen = () => this.maybeOpen();
    channel.onclose = () => {
      if (this.state === "closed") {
        if (isReliable) this.closePeer(); // a local close has drained
        return;
      }
      this.fail(`${channel.label} closed`);
    };
    channel.onmessage = (event: MessageEvent) => {
      if (this.state !== "open") return;
      const data = bytesOf(event.data);
      if (!data) {
        if (isReliable) this.close("protocol error: text message");
        return; // a text datagram isn't part of the protocol; dropped like a lost one
      }
      if (isReliable) this.receiveFrame(data);
      else this.receiveDatagram(data);
    };
    if (channel.readyState === "open") queueMicrotask(() => this.maybeOpen());
  }

  private maybeOpen(): void {
    if (this.state !== "connecting" || this.reliable?.readyState !== "open" || this.unreliable?.readyState !== "open") return;
    this.state = "open";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.events.push({ kind: "open", connection: this });
    this.signaller?.connected();
    for (const { channel, data } of this.pending.splice(0)) {
      if (this.state !== "open") break;
      this.send(channel, data);
    }
    this.drain();
  }

  private receiveDatagram(datagram: Uint8Array): void {
    if (datagram.byteLength < SEQUENCE_BYTES || datagram.byteLength > WEBRTC_MAX_MESSAGE_BYTES) return; // malformed: dropped like a lost one
    if (!this.account(datagram.byteLength)) return;
    this.deliverUnreliable(readSeq(datagram, 0), datagram.subarray(SEQUENCE_BYTES));
  }

  private receiveFrame(frame: Uint8Array): void {
    if (frame.byteLength === 0 || frame.byteLength > WEBRTC_MAX_MESSAGE_BYTES) return this.close(`protocol error: a ${frame.byteLength}-byte frame`);
    if (!this.account(frame.byteLength)) return;
    const header = frame[0];
    if (header & RESERVED_BITS) return this.close(`protocol error: unknown frame flags 0x${header.toString(16)}`);
    if (header & CLOSE_BIT) {
      if (header !== CLOSE_BIT) return this.close(`protocol error: bad close frame flags 0x${header.toString(16)}`);
      return this.closed(new TextDecoder().decode(frame.subarray(1)), false);
    }
    const kind = header & UNRELIABLE_BIT;
    if (this.parts.length > 0 && kind !== this.partsHeader) return this.close("protocol error: fragments of different channels");
    const payload = frame.subarray(1);
    const limit = this.maxMessageBytes + (kind ? SEQUENCE_BYTES : 0);
    if (this.partsBytes + payload.byteLength > limit) {
      const size = this.partsBytes + payload.byteLength - (kind ? SEQUENCE_BYTES : 0);
      return this.close(`message too big (over ${this.maxMessageBytes} bytes: at least ${size})`);
    }
    this.partsHeader = kind;
    if (header & MORE_BIT) {
      this.parts.push(payload.slice());
      this.partsBytes += payload.byteLength;
      return;
    }
    let message: Uint8Array;
    if (this.parts.length === 0) message = payload.slice();
    else {
      message = new Uint8Array(this.partsBytes + payload.byteLength);
      let at = 0;
      for (const part of this.parts) {
        message.set(part, at);
        at += part.byteLength;
      }
      message.set(payload, at);
      this.parts = [];
      this.partsBytes = 0;
    }
    if (!kind) {
      this.events.push({ kind: "data", connection: this, channel: "reliable", data: message });
      return;
    }
    if (message.byteLength < SEQUENCE_BYTES) return this.close("protocol error: short unreliable message");
    this.deliverUnreliable(readSeq(message, 0), message.subarray(SEQUENCE_BYTES));
  }

  /** Deliver an unreliable payload unless something newer was delivered already (0333). */
  private deliverUnreliable(seq: number, data: Uint8Array): void {
    if (!this.sequence.accept(seq)) return; // stale
    this.events.push({ kind: "data", connection: this, channel: "unreliable", data });
  }

  /** Count received bytes towards the flood limit; false (and closed) when over it. */
  private account(bytes: number): boolean {
    this.queuedBytes += bytes;
    if (this.queuedBytes <= Math.max(MIN_QUEUED_BYTES, this.maxMessageBytes * 4)) return true;
    this.close(`flooding: ${this.queuedBytes} bytes received since the last poll`);
    return false;
  }

  /** Bytes sent on `myco-r` but not yet on the network. */
  private backlog(): number {
    return this.outboxBytes + (this.reliable?.bufferedAmount ?? 0);
  }

  /** Split a `myco-r` message into frames for the outbox. */
  private enqueue(kind: number, data: Uint8Array): void {
    let at = 0;
    do {
      const size = Math.min(FRAGMENT_BYTES, data.byteLength - at);
      const frame = new Uint8Array(size + 1);
      frame[0] = kind | (at + size < data.byteLength ? MORE_BIT : 0);
      frame.set(data.subarray(at, at + size), 1);
      this.outbox.push(frame);
      this.outboxBytes += frame.byteLength;
      at += size;
    } while (at < data.byteLength);
    this.drain();
  }

  /** Hand queued frames to `myco-r` while its buffer is below the high-water mark. */
  private drain(): void {
    const reliable = this.reliable;
    if (this.state !== "open" || !reliable) return;
    while (this.outbox.length > 0 && reliable.bufferedAmount < RELIABLE_HIGH_WATER) {
      const frame = this.outbox.shift()!;
      this.outboxBytes -= frame.byteLength;
      try {
        reliable.send(frame as Uint8Array<ArrayBuffer>);
      } catch (error) {
        return this.fail(`send failed: ${(error as Error).message}`);
      }
    }
  }

  /** Close because something failed: before open the connection failed, after it the connection was lost. */
  private fail(what: string): void {
    if (this.state === "closed") return;
    this.closed(`${this.state === "connecting" ? "connection failed" : "connection lost"}: ${what}`, false);
  }

  /** Mark the connection closed and release it; `drainFirst` leaves the peer connection open until `myco-r` drains. */
  private closed(reason: string, drainFirst: boolean): void {
    if (this.state === "closed") return;
    const surfaced = this.surfaced || this.state === "open";
    this.state = "closed";
    this.pending = [];
    this.outbox = [];
    this.outboxBytes = 0;
    this.parts = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.signaller?.close();
    } catch {
      // Already closed.
    }
    this.signaller = null;
    for (const channel of [this.unreliable, this.reliable]) {
      try {
        channel?.close();
      } catch {
        // Already closing.
      }
    }
    if (drainFirst && this.reliable && this.reliable.readyState !== "closed") {
      this.timer = setTimeout(() => this.closePeer(), CLOSE_DRAIN_MS);
    } else this.closePeer();
    if (surfaced) this.events.push({ kind: "close", connection: this, reason });
    this.onClosed(this);
  }

  private closePeer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      // Already closed.
    }
  }
}

/** The `webrtc` transport: both ends connect through a signaller; neither opens a socket. */
export class WebRtcTransport implements Transport {
  private readonly events: TransportEvent[] = [];
  private readonly connections = new Set<WebRtcConnection>();
  private readonly PeerConnection: PeerConnectionConstructor;
  private readonly config: RTCConfiguration;
  private readonly maxMessageBytes: number;
  private readonly connectTimeoutMs: number;
  private nextId = 1;

  constructor(private readonly options: WebRtcTransportOptions) {
    if (typeof options?.signaller !== "function") throw new Error('The "webrtc" transport needs a signaller option (a function making a WebRtcSignaller).');
    const PeerConnection = options.PeerConnection ?? (globalThis as { RTCPeerConnection?: PeerConnectionConstructor }).RTCPeerConnection;
    if (!PeerConnection) throw new Error('The "webrtc" transport needs RTCPeerConnection, and there\'s none here: pass the PeerConnection option.');
    this.PeerConnection = PeerConnection;
    this.config = {
      iceServers: (options.iceServers ?? []).map((s) => ({
        urls: typeof s.urls === "string" ? s.urls : [...s.urls],
        ...(s.username !== undefined ? { username: s.username } : {}),
        ...(s.credential !== undefined ? { credential: s.credential } : {}),
      })),
    };
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_WEBRTC_MAX_MESSAGE_BYTES;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS;
  }

  /** Waits for an offer through the signaller for `address`; resolves once the signaller session is set up. */
  async listen(address: string): Promise<void> {
    this.add(address, "answer", false);
  }

  /** Offers a connection through the signaller for `address`; the connection opens when both channels do. */
  connect(address: string): TransportConnection {
    return this.add(address, "offer", true);
  }

  poll(): TransportEvent[] {
    for (const connection of [...this.connections]) connection.pump();
    return this.events.splice(0);
  }

  close(): void {
    for (const connection of [...this.connections]) connection.close("transport closed");
  }

  private add(address: string, role: "offer" | "answer", surfaced: boolean): WebRtcConnection {
    const signaller = this.options.signaller(address, role);
    const connection = new WebRtcConnection(
      this.nextId++,
      address,
      role,
      signaller,
      this.PeerConnection,
      this.config,
      this.maxMessageBytes,
      this.connectTimeoutMs,
      this.events,
      surfaced,
      (c) => this.connections.delete(c),
    );
    this.connections.add(connection);
    return connection;
  }
}
