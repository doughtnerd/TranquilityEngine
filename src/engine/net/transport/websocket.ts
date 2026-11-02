/**
 * The WebSocket transport (ADR 0033), client side. Uses the global `WebSocket`, so it runs in
 * browsers, Tauri and Node 22+. Browser-safe: no Node imports. Listening needs a server, which
 * browsers can't be; the Node server is `src/server/websocketServer.ts` (ADR 0035), which
 * re-registers "websocket" as a transport that can both listen and connect.
 *
 * Framing: every WebSocket message is binary, a 1-byte header then the payload. Header bit 0 is
 * the channel (0 reliable, 1 unreliable); bits 1-7 are reserved for flags and must be 0 (a peer
 * that sees one set closes the connection, so a future flag is never silently misread).
 *
 * WebSocket runs over TCP, so everything is reliable and ordered: unreliable messages simply ride
 * along on the same stream. That keeps the contract (nothing arrives stale) but gives none of the
 * benefit: a lost packet still holds up everything behind it (head-of-line blocking). Truly
 * unreliable delivery comes with the WebRTC transport (ADR 0033).
 */
import { registerTransport, type Channel, type ConnectionState, type Transport, type TransportConnection, type TransportEvent } from "../Transport";

const UNRELIABLE_BIT = 0x01;
const RESERVED_BITS = 0xfe;

/** WebSocket close codes (RFC 6455). */
const CLOSE_NORMAL = 1000;

/** @internal Prefix `data` with the 1-byte header for `channel`. */
export function encodeFrame(channel: Channel, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(data.byteLength + 1);
  frame[0] = channel === "unreliable" ? UNRELIABLE_BIT : 0;
  frame.set(data, 1);
  return frame;
}

/** @internal Split a frame into channel and payload, or return an error message if it's malformed. */
export function decodeFrame(frame: Uint8Array): { channel: Channel; data: Uint8Array } | string {
  if (frame.byteLength === 0) return "empty frame";
  const header = frame[0];
  if (header & RESERVED_BITS) return `unknown frame flags 0x${header.toString(16)}`;
  return { channel: header & UNRELIABLE_BIT ? "unreliable" : "reliable", data: frame.subarray(1) };
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
}

/**
 * @internal One end of a WebSocket. The owning transport wires the socket's callbacks to the
 * `handle*` methods, which queue events for its next `poll()`.
 */
export class WebSocketConnection implements TransportConnection {
  state: ConnectionState = "connecting";
  /** Frames sent while connecting, flushed on open. */
  private pending: Uint8Array[] = [];
  /** Why the socket errored, if it did; the close that follows has no reason of its own. */
  private error = "";

  constructor(
    readonly id: number,
    readonly remote: string,
    private readonly socket: SocketLike,
    private readonly events: TransportEvent[],
    private readonly onClosed: (connection: WebSocketConnection) => void,
  ) {}

  send(channel: Channel, data: Uint8Array): void {
    if (this.state === "closed") throw new Error(`Can't send on closed connection ${this.id} (${this.remote}).`);
    const frame = encodeFrame(channel, data);
    if (this.state === "connecting") this.pending.push(frame);
    else this.socket.send(frame);
  }

  close(reason = "closed"): void {
    if (this.state === "closed") return;
    try {
      this.socket.close(CLOSE_NORMAL, closeReason(reason));
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
  }

  handleMessage(message: unknown): void {
    if (this.state !== "open") return;
    let frame: Uint8Array;
    if (message instanceof ArrayBuffer) frame = new Uint8Array(message);
    else if (ArrayBuffer.isView(message)) frame = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    else return this.close("protocol error: text message");
    const decoded = decodeFrame(frame);
    if (typeof decoded === "string") return this.close(`protocol error: ${decoded}`);
    this.events.push({ kind: "data", connection: this, channel: decoded.channel, data: decoded.data });
  }

  handleError(message: string): void {
    this.error ||= message;
  }

  /** The socket closed: by the peer, the network, or a failed connect. */
  handleClose(code: number, reason: string): void {
    if (this.state === "closed") return;
    const failed = this.state === "connecting";
    this.closed(reason || this.error || (failed ? `connection failed (code ${code})` : `connection lost (code ${code})`));
  }

  private closed(reason: string): void {
    this.state = "closed";
    this.pending = [];
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
  private nextId = 1;

  async listen(_address: string): Promise<void> {
    throw new Error(
      'The browser WebSocket transport can only connect; listening needs the Node server: import "src/server/websocketServer" (which registers a "websocket" transport that can listen) in Node.',
    );
  }

  /** `address` is a WebSocket URL, e.g. "ws://localhost:7777/game". */
  connect(address: string): TransportConnection {
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    const connection = this.addConnection(address, socket);
    socket.onopen = () => connection.handleOpen();
    socket.onmessage = (event) => connection.handleMessage(event.data);
    socket.onerror = () => connection.handleError("");
    socket.onclose = (event) => connection.handleClose(event.code, event.reason);
    return connection;
  }

  poll(): TransportEvent[] {
    return this.events.splice(0);
  }

  close(): void {
    for (const connection of [...this.connections]) connection.close("transport closed");
  }

  /** @internal Track a connection on `socket`; the caller wires the socket's callbacks to it. */
  protected addConnection(remote: string, socket: SocketLike): WebSocketConnection {
    const connection = new WebSocketConnection(this.nextId++, remote, socket, this.events, (c) => this.connections.delete(c));
    this.connections.add(connection);
    return connection;
  }
}

registerTransport("websocket", () => new WebSocketTransport());
