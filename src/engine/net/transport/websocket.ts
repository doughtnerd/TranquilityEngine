/**
 * The WebSocket transport (ADR 0033), client side. Uses the global `WebSocket`, so it runs in
 * browsers, Tauri and Node 22+. Browser-safe: no Node imports. Listening needs a server, which
 * browsers can't be; the Node server is `src/server/websocketServer.ts` (ADR 0035), which
 * re-registers "websocket" as a transport that can both listen and connect.
 *
 * Framing: every WebSocket message is binary, a 1-byte header then the payload. Header bit 0 is
 * the channel (0 reliable, 1 unreliable); bit 1 marks a signal frame and bit 2 a sequenced
 * unreliable frame (both ADR 0333, below); bits 3-7 are reserved and must be 0 (a peer that sees
 * one set closes the connection, so a future flag is never silently misread).
 *
 * WebSocket runs over TCP, so everything sent on it is reliable and ordered: a lost packet holds
 * up everything behind it (head-of-line blocking). So when both ends can, each connection opens a
 * WebRTC data channel beside its socket (ADR 0333, `datagramLane.ts`) and sends unreliable
 * messages that fit one packet over it, where a lost one is just lost:
 *
 * - A client that has `RTCPeerConnection` asks with `myco-rtc=1` in its URL's query; a server
 *   that can answers with an offer in a signal frame (bit 1; JSON, `SignalMessage`). Neither sends
 *   a signal frame to a peer that didn't show it understands them, so plain peers never see one.
 * - From then on ("negotiated") every unreliable message carries a 32-bit sequence number: on the
 *   socket after the header of a frame with bit 2 set, on the data channel before the payload. Each
 *   path numbers its messages on its own (ADR 0398), and the receiver drops one that isn't newer
 *   than the newest it delivered from the same path. So a message too big for a datagram, sent over
 *   the socket, still arrives when datagrams sent after it overtake it: late, never lost.
 * - Reliable messages always go over the socket. An unreliable one goes over the data channel
 *   while it's open and the message fits `maxDatagramBytes`; otherwise over the socket.
 * - A data channel that doesn't open, or closes, just leaves the traffic on the socket.
 */
import { registerTransport, type Channel, type ConnectionState, type Transport, type TransportConnection, type TransportEvent } from "../Transport";
import { DatagramLane, parseSignal, type LaneSetup, type PeerConnectionConstructor, type SignalMessage } from "./datagramLane";

const UNRELIABLE_BIT = 0x01;
/** A signal frame: the payload is a JSON `SignalMessage` for the datagram lane (ADR 0333). */
const SIGNAL_BIT = 0x02;
/** An unreliable frame whose payload starts with a 4-byte big-endian sequence number (ADR 0333). */
const SEQUENCE_BIT = 0x04;
const RESERVED_BITS = 0xf8;
/** The query parameter a client that can open a datagram lane adds to its URL. */
export const RTC_QUERY = "myco-rtc";

/** WebSocket close codes (RFC 6455). */
const CLOSE_NORMAL = 1000;
/** WebSocket close code for "message too big" (RFC 6455). */
const CLOSE_TOO_BIG = 1009;

/** Limits that keep one slow or misbehaving peer from using unbounded memory. */
export interface WebSocketLimits {
  /** Largest message accepted, in bytes (the server rejects bigger frames before buffering them). Default 1 MiB. */
  maxMessageBytes: number;
  /** Bytes received from one connection between two polls before it's closed as flooding. Default 4 MiB. */
  maxQueuedBytes: number;
  /** Unreliable sends are dropped (latest-wins) while this much is waiting in the socket's send buffer. Default 64 KiB. */
  unreliableBacklogBytes: number;
  /** A connection whose send buffer holds more than this (reliable data it can't drop) is closed as too slow. Default 8 MiB. */
  maxBacklogBytes: number;
}

const DEFAULT_WEBSOCKET_LIMITS: Readonly<WebSocketLimits> = {
  maxMessageBytes: 1024 * 1024,
  maxQueuedBytes: 4 * 1024 * 1024,
  unreliableBacklogBytes: 64 * 1024,
  maxBacklogBytes: 8 * 1024 * 1024,
};

/** Limits from transport options (`createTransport("websocket", { limits: { … } })`), over the defaults. */
export function websocketLimits(options: Record<string, unknown> = {}): WebSocketLimits {
  return { ...DEFAULT_WEBSOCKET_LIMITS, ...((options.limits as Partial<WebSocketLimits> | undefined) ?? {}) };
}

/**
 * The `webrtc` transport option (ADR 0333): `false` keeps every connection on the socket alone.
 * The Node server reads more keys (`udpPort`, `publicIp`, `bindAddress`); these are both ends'.
 */
export interface WebRtcOptions {
  /** STUN/TURN servers, as `RTCIceServer`s. None are needed between a client and a public server. */
  iceServers?: RTCIceServer[];
  /** The largest data channel message, sequence number included. Default 1,100 (one packet). */
  maxDatagramBytes?: number;
  /** A data channel that hasn't opened by then is given up. Default 5,000 ms. */
  connectTimeoutMs?: number;
}

export const DEFAULT_MAX_DATAGRAM_BYTES = 1100;
const DEFAULT_RTC_CONNECT_TIMEOUT_MS = 5000;
/** Bytes of a sequence number. */
const SEQUENCE_BYTES = 4;

/** The `webrtc` option, or null when it's `false`. Throws for a malformed one. */
export function webRtcOptions(options: Record<string, unknown> = {}): (WebRtcOptions & Record<string, unknown>) | null {
  const value = options.webrtc;
  if (value === false) return null;
  if (value === undefined || value === true) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`The "webrtc" transport option must be false or an object (got ${JSON.stringify(value)}).`);
  const rtc = value as WebRtcOptions & Record<string, unknown>;
  if (rtc.maxDatagramBytes !== undefined && !(Number.isInteger(rtc.maxDatagramBytes) && rtc.maxDatagramBytes >= 64 && rtc.maxDatagramBytes <= 65536)) {
    throw new Error(`webrtc.maxDatagramBytes must be a whole number from 64 to 65536 (got ${JSON.stringify(rtc.maxDatagramBytes)}).`);
  }
  return rtc;
}

/** @internal How a connection opens its datagram lane: a `LaneSetup` once the peer connection constructor has loaded. */
export interface RtcSetup {
  readonly role: LaneSetup["role"];
  /** Resolves with the constructor, or null when WebRTC isn't available here after all. */
  readonly load: () => Promise<PeerConnectionConstructor | null>;
  readonly config: RTCConfiguration;
  readonly maxDatagramBytes: number;
  readonly connectTimeoutMs: number;
  readonly rewriteCandidate?: (candidate: string) => string;
}

/** The largest signal frame payload (a connection offer is a few KB of SDP), whatever `maxMessageBytes` says. */
const MAX_SIGNAL_BYTES = 16 * 1024;

/**
 * @internal The largest WebSocket frame a connection with `limits` accepts: a message (or a signal),
 * its header and a sequence number. Messages are checked against `maxMessageBytes` once decoded.
 */
export function frameBytesLimit(limits: WebSocketLimits): number {
  return Math.max(limits.maxMessageBytes, MAX_SIGNAL_BYTES) + 1 + SEQUENCE_BYTES;
}

/** The parts of an `RtcSetup` that come from the `webrtc` option. */
export function rtcSetupParts(rtc: WebRtcOptions): Pick<RtcSetup, "maxDatagramBytes" | "connectTimeoutMs"> {
  return { maxDatagramBytes: rtc.maxDatagramBytes ?? DEFAULT_MAX_DATAGRAM_BYTES, connectTimeoutMs: rtc.connectTimeoutMs ?? DEFAULT_RTC_CONNECT_TIMEOUT_MS };
}

/** `address` with `myco-rtc=1` added to its query (or as written if it isn't a URL). */
function withRtcQuery(address: string): string {
  try {
    const url = new URL(address);
    url.searchParams.set(RTC_QUERY, "1");
    return url.toString();
  } catch {
    return address;
  }
}

/** Prefix `data` with the 1-byte header for `channel` and, for a sequenced unreliable frame, its sequence number. */
function encodeFrame(channel: Channel, data: Uint8Array, seq?: number): Uint8Array {
  const extra = seq === undefined ? 0 : SEQUENCE_BYTES;
  const frame = new Uint8Array(data.byteLength + 1 + extra);
  frame[0] = channel === "unreliable" ? UNRELIABLE_BIT | (seq === undefined ? 0 : SEQUENCE_BIT) : 0;
  if (seq !== undefined) new DataView(frame.buffer).setUint32(1, seq);
  frame.set(data, 1 + extra);
  return frame;
}

/** `data` after a 4-byte sequence number: a data channel message. */
function encodeDatagram(data: Uint8Array, seq: number): Uint8Array {
  const out = new Uint8Array(data.byteLength + SEQUENCE_BYTES);
  new DataView(out.buffer).setUint32(0, seq);
  out.set(data, SEQUENCE_BYTES);
  return out;
}

type DecodedFrame = { kind: "data"; channel: Channel; seq?: number; data: Uint8Array } | { kind: "signal"; message: SignalMessage };

/** Split a frame into what it carries, or return an error message if it's malformed. */
function decodeFrame(frame: Uint8Array): DecodedFrame | string {
  if (frame.byteLength === 0) return "empty frame";
  const header = frame[0];
  if (header & RESERVED_BITS) return `unknown frame flags 0x${header.toString(16)}`;
  if (header & SIGNAL_BIT) {
    if (header !== SIGNAL_BIT) return `bad signal frame flags 0x${header.toString(16)}`;
    const message = parseSignal(new TextDecoder().decode(frame.subarray(1)));
    return message ? { kind: "signal", message } : "malformed signal frame";
  }
  if (header & SEQUENCE_BIT) {
    if (!(header & UNRELIABLE_BIT)) return "sequenced reliable frame";
    if (frame.byteLength < 1 + SEQUENCE_BYTES) return "short sequenced frame";
    const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
    return { kind: "data", channel: "unreliable", seq, data: frame.subarray(1 + SEQUENCE_BYTES) };
  }
  return { kind: "data", channel: header & UNRELIABLE_BIT ? "unreliable" : "reliable", data: frame.subarray(1) };
}

/** Whether sequence number `a` is newer than `b`, across the 32-bit wrap (serial number arithmetic). */
function newer(a: number, b: number): boolean {
  return ((a - b) | 0) > 0;
}

/** One path's unreliable sequence numbers (ADR 0398): the next to send, the newest delivered. */
interface PathSequence {
  next: number;
  newest: number | null;
}

/** Take `path`'s next sequence number to send. */
function nextSeq(path: PathSequence): number {
  const seq = path.next;
  path.next = (seq + 1) >>> 0;
  return seq;
}

/** A WebSocket close reason is at most 123 bytes of UTF-8; longer ones make `close()` throw. */
function closeReason(reason: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(reason).byteLength <= 123) return reason;
  let cut = reason;
  while (encoder.encode(cut).byteLength > 120) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/** @internal The part of a socket a connection drives. Browser WebSockets and `ws` sockets both fit. */
export interface SocketLike {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued to send but not yet handed to the network (browser `WebSocket` and `ws` both have it). */
  readonly bufferedAmount?: number;
}

/**
 * @internal One end of a WebSocket, and its datagram lane when it has one (ADR 0333). The owning
 * transport wires the socket's callbacks to the `handle*` methods, which queue events for its next
 * `poll()`.
 */
class WebSocketConnection implements TransportConnection {
  state: ConnectionState = "connecting";
  /** Frames sent while connecting, flushed on open. */
  private pending: Uint8Array[] = [];
  /** Why the socket errored, if it did; the close that follows has no reason of its own. */
  private error = "";
  /** @internal Bytes received since the transport's last poll (reset by it). */
  queuedBytes = 0;
  /** Unreliable messages dropped because the send buffer was backed up (for the network panel). */
  droppedUnreliable = 0;
  /** Both ends know the datagram protocol: unreliable messages carry sequence numbers (ADR 0333). */
  private negotiated = false;
  private lane: DatagramLane | null = null;
  /**
   * Each path's sequence (ADR 0398): the next number to send on it, and the newest delivered from
   * it (null before the first). TCP keeps the socket's in order; datagrams can be lost or reordered.
   */
  private readonly socketSeq: PathSequence = { next: 0, newest: null };
  private readonly datagramSeq: PathSequence = { next: 0, newest: null };
  /** Signalling that arrived while the lane's peer connection was loading; null otherwise. */
  private laneSignals: SignalMessage[] | null = null;

  constructor(
    readonly id: number,
    readonly remote: string,
    private readonly socket: SocketLike,
    private readonly events: TransportEvent[],
    private readonly onClosed: (connection: WebSocketConnection) => void,
    private readonly limits: WebSocketLimits = DEFAULT_WEBSOCKET_LIMITS,
    /** How to open a datagram lane, when this end may: null keeps the connection on the socket. */
    private readonly rtc: RtcSetup | null = null,
  ) {}

  /** While the datagram lane is open: the largest unreliable message that goes as one datagram. */
  get maxDatagramBytes(): number | undefined {
    return this.lane?.state === "open" && this.rtc ? this.rtc.maxDatagramBytes - SEQUENCE_BYTES : undefined;
  }

  send(channel: Channel, data: Uint8Array): void {
    if (this.state === "closed") throw new Error(`Can't send on closed connection ${this.id} (${this.remote}).`);
    const sequenced = channel === "unreliable" && this.negotiated;
    if (this.state === "connecting") {
      this.pending.push(encodeFrame(channel, data, sequenced ? nextSeq(this.socketSeq) : undefined));
      return;
    }
    // A datagram that fits one packet goes over the data channel, unless its send buffer is backed
    // up (a datagram that waits is as stale as one dropped, so it's dropped, latest-wins).
    const lane = this.lane;
    if (sequenced && lane?.state === "open" && this.rtc && data.byteLength + SEQUENCE_BYTES <= this.rtc.maxDatagramBytes) {
      if (lane.bufferedAmount > this.limits.unreliableBacklogBytes) {
        this.droppedUnreliable++;
        return;
      }
      // The number is taken only once the datagram goes, so a dropped one leaves no gap.
      if (lane.send(encodeDatagram(data, this.datagramSeq.next))) {
        nextSeq(this.datagramSeq);
        return;
      }
    }
    // TCP can't drop anything, so a slow link backs up the socket's buffer. Stale unreliable data
    // (snapshots) is dropped there instead of piling up; reliable data that can't drain closes the
    // connection rather than growing without bound.
    const backlog = this.socket.bufferedAmount ?? 0;
    if (channel === "unreliable" && backlog > this.limits.unreliableBacklogBytes) {
      this.droppedUnreliable++;
      return;
    }
    if (backlog > this.limits.maxBacklogBytes) return this.close(`too slow: ${backlog} bytes waiting to send`);
    this.socket.send(encodeFrame(channel, data, sequenced ? nextSeq(this.socketSeq) : undefined));
  }

  close(reason = "closed", code = CLOSE_NORMAL): void {
    if (this.state === "closed") return;
    try {
      this.socket.close(code, closeReason(reason));
    } catch {
      // Closing a socket that's already failing; the close event below is what matters.
    }
    this.closed(reason);
  }

  handleOpen(): void {
    if (this.state !== "connecting") return;
    this.state = "open";
    this.events.push({ kind: "open", connection: this });
    for (const frame of this.pending) this.socket.send(frame);
    this.pending = [];
    if (this.rtc?.role === "offer") this.openLane(); // the server offers; a client waits for the offer
  }

  handleMessage(message: unknown): void {
    if (this.state !== "open") return;
    let frame: Uint8Array;
    if (message instanceof ArrayBuffer) frame = new Uint8Array(message);
    else if (ArrayBuffer.isView(message)) frame = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    else return this.close("protocol error: text message");
    if (frame.byteLength > frameBytesLimit(this.limits)) return this.close(`message too big (${frame.byteLength} bytes)`, CLOSE_TOO_BIG);
    if (!this.account(frame.byteLength)) return;
    const decoded = decodeFrame(frame);
    if (typeof decoded === "string") return this.close(`protocol error: ${decoded}`);
    if (decoded.kind === "signal") return this.handleSignal(decoded.message);
    if (decoded.data.byteLength > this.limits.maxMessageBytes) return this.close(`message too big (${decoded.data.byteLength} bytes)`, CLOSE_TOO_BIG);
    if (decoded.seq !== undefined) {
      // Sequenced frames come only from a peer this end negotiated with.
      if (!this.negotiated) return this.close("protocol error: a sequenced frame before negotiation");
      return this.deliverSequenced(this.socketSeq, decoded.seq, decoded.data);
    }
    this.events.push({ kind: "data", connection: this, channel: decoded.channel, data: decoded.data });
  }

  handleError(message: string): void {
    this.error ||= message;
    // A connect that fails (refused, or an upgrade rejected) is final: browsers fire "close" right
    // after "error", but Node's global WebSocket (undici) can leave it out, which hung the connection
    // in "connecting". Closing here is harmless where "close" does follow (handleClose ignores it).
    if (this.state === "connecting") this.closed(this.error || "connection failed");
  }

  /** The socket closed: by the peer, the network, or a failed connect. */
  handleClose(code: number, reason: string): void {
    if (this.state === "closed") return;
    const failed = this.state === "connecting";
    this.closed(reason || this.error || (failed ? `connection failed (code ${code})` : `connection lost (code ${code})`));
  }

  /** A signalling message: the offer opens a client's lane; the rest go to the lane. */
  private handleSignal(message: SignalMessage): void {
    if (!this.rtc) return this.close("protocol error: a signal frame this end didn't ask for");
    if (this.rtc.role === "answer" && message.t === "offer" && !this.negotiated) {
      this.negotiated = true; // the server sequences from its offer on, and so does this end now
      this.openLane([message]);
      return;
    }
    if (!this.negotiated) return this.close("protocol error: a signal frame before the offer");
    this.laneSignals?.push(message); // the lane is still loading its peer connection
    this.lane?.handleSignal(message);
  }

  /** Load the peer connection and start the lane, with `early` signalling to hand it once made. */
  private openLane(early: SignalMessage[] = []): void {
    const rtc = this.rtc!;
    this.laneSignals = early;
    rtc.load().then(
      (PeerConnection) => {
        const signals = this.laneSignals ?? [];
        this.laneSignals = null;
        if (!PeerConnection || this.state !== "open") return; // no WebRTC here: the socket carries everything
        const lane = new DatagramLane(
          { role: rtc.role, PeerConnection, config: rtc.config, connectTimeoutMs: rtc.connectTimeoutMs, rewriteCandidate: rtc.rewriteCandidate },
          {
            signal: (message) => this.sendSignal(message),
            receive: (data) => this.handleDatagram(data),
          },
        );
        this.lane = lane;
        for (const message of signals) lane.handleSignal(message);
      },
      () => {
        this.laneSignals = null;
      },
    );
  }

  private sendSignal(message: SignalMessage): void {
    if (this.state !== "open") return;
    const json = new TextEncoder().encode(JSON.stringify(message));
    const frame = new Uint8Array(json.byteLength + 1);
    frame[0] = SIGNAL_BIT;
    frame.set(json, 1);
    this.socket.send(frame);
    // The server's unreliable frames are sequenced from its offer on: the client reads the offer first.
    if (message.t === "offer") this.negotiated = true;
  }

  /** A data channel message: a sequence number, then an unreliable payload. */
  private handleDatagram(datagram: Uint8Array): void {
    if (this.state !== "open") return;
    if (datagram.byteLength < SEQUENCE_BYTES || datagram.byteLength - SEQUENCE_BYTES > this.limits.maxMessageBytes) return; // malformed: dropped like a lost one
    if (!this.account(datagram.byteLength)) return;
    const seq = new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength).getUint32(0);
    this.deliverSequenced(this.datagramSeq, seq, datagram.subarray(SEQUENCE_BYTES));
  }

  /** Deliver an unreliable payload unless something newer came by the same path already (ADR 0398). */
  private deliverSequenced(path: PathSequence, seq: number, data: Uint8Array): void {
    if (path.newest !== null && !newer(seq, path.newest)) return; // stale
    path.newest = seq;
    this.events.push({ kind: "data", connection: this, channel: "unreliable", data });
  }

  /** Count received bytes towards the flood limit; false (and closed) when over it. */
  private account(bytes: number): boolean {
    this.queuedBytes += bytes;
    if (this.queuedBytes <= this.limits.maxQueuedBytes) return true;
    this.close(`flooding: ${this.queuedBytes} bytes received since the last poll`, CLOSE_TOO_BIG);
    return false;
  }

  private closed(reason: string): void {
    this.state = "closed";
    this.pending = [];
    this.lane?.close("connection closed");
    this.lane = null;
    this.events.push({ kind: "close", connection: this, reason });
    this.onClosed(this);
  }
}

/**
 * @internal Client-side WebSocket transport. Every connection, open or closing, gets exactly one
 * `close` event, including ones closed locally. Subclassed by the Node server to add `listen`.
 */
export class WebSocketTransport implements Transport {
  /** Shared with the connections, which push to it; `poll` empties it in place. */
  protected readonly events: TransportEvent[] = [];
  protected readonly connections = new Set<WebSocketConnection>();
  protected readonly limits: WebSocketLimits;
  /** The `webrtc` option (ADR 0333); null when it's `false`. */
  protected readonly rtc: (WebRtcOptions & Record<string, unknown>) | null;
  private nextId = 1;

  constructor(options: Record<string, unknown> = {}) {
    this.limits = websocketLimits(options);
    this.rtc = webRtcOptions(options);
  }

  async listen(_address: string): Promise<void> {
    throw new Error(
      'The browser WebSocket transport can only connect; listening needs the Node server: import "src/server/websocketServer" (which registers a "websocket" transport that can listen) in Node.',
    );
  }

  /**
   * `address` is a WebSocket URL, e.g. "ws://localhost:7777/game". When this end can open a
   * datagram lane, the socket's URL asks the server for one (ADR 0333).
   */
  connect(address: string): TransportConnection {
    const rtc = this.rtcSetup("answer");
    const socket = new WebSocket(rtc ? withRtcQuery(address) : address);
    socket.binaryType = "arraybuffer";
    const connection = this.addConnection(address, socket, rtc);
    socket.onopen = () => connection.handleOpen();
    socket.onmessage = (event) => connection.handleMessage(event.data);
    socket.onerror = () => connection.handleError("");
    socket.onclose = (event) => connection.handleClose(event.code, event.reason);
    return connection;
  }

  poll(): TransportEvent[] {
    for (const connection of this.connections) connection.queuedBytes = 0;
    return this.events.splice(0);
  }

  close(): void {
    for (const connection of [...this.connections]) connection.close("transport closed");
  }

  /**
   * @internal How this end's connections open a datagram lane in `role`, or null when they can't:
   * the `webrtc` option is false, or there's no `RTCPeerConnection` here. The Node server adds its
   * own peer connections and server settings.
   */
  protected rtcSetup(role: RtcSetup["role"]): RtcSetup | null {
    const PeerConnection = (globalThis as { RTCPeerConnection?: PeerConnectionConstructor }).RTCPeerConnection;
    if (!this.rtc || !PeerConnection) return null;
    return { role, load: () => Promise.resolve(PeerConnection), config: { iceServers: this.rtc.iceServers ?? [] }, ...rtcSetupParts(this.rtc) };
  }

  /** @internal Track a connection on `socket`; the caller wires the socket's callbacks to it. */
  protected addConnection(remote: string, socket: SocketLike, rtc: RtcSetup | null = null): WebSocketConnection {
    const connection = new WebSocketConnection(this.nextId++, remote, socket, this.events, (c) => this.connections.delete(c), this.limits, rtc);
    this.connections.add(connection);
    return connection;
  }
}

registerTransport("websocket", (options) => new WebSocketTransport(options), { listen: false });
