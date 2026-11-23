// The desktop editor's listening `websocket` transport (ADR 0379). A page can't open a server socket, so under Tauri
// the WebSocket server is native (`src-tauri/src/debug_link.rs` over `native/ws-listener`) and this transport drives it
// over Tauri's IPC: `myco_debuglink_listen` binds and streams events (accept, message, close, error) to a channel as
// raw bytes; `myco_debuglink_send` takes an outbox of sends and closes; `myco_debuglink_close` stops it. The native side
// moves whole binary messages only; framing, limits and close rules stay in `WebSocketConnection` (websocket.ts), the
// same code the Node server uses, so the debug link (`EditorDebugLink`) runs on it unchanged. Connecting is the plain
// client's (the page's own `WebSocket`).
//
// Wire format (`native/ws-listener/src/wire.rs` is the other side; big-endian, UTF-8):
// - events, one per channel message: [kind u8][connection u32][rest]; 1 accept (rest: the peer's address), 2 message
//   (rest: the payload), 3 close (rest: [code u16][reason]; only for closes the page didn't ask for), 4 error
//   (connection 0, rest: the message);
// - an outbox body: records [op u8][connection u32][length u32][bytes]; 1 send (bytes: the payload), 2 close (bytes:
//   [code u16][reason]).
//
// IPC calls go one at a time, in order (listen, then each outbox, then close), so sends and closes reach the native
// side in the order the page made them.
import { Channel, invoke } from "@tauri-apps/api/core";
import { parseListenAddress } from "../../engine/net/listenTarget";
import { registerTransport } from "../../engine/net/Transport";
import { WebSocketTransport, type SocketLike } from "../../engine/net/transport/websocket";

const ACCEPT = 1;
const MESSAGE = 2;
const CLOSE = 3;
const ERROR = 4;
const SEND_OP = 1;
const CLOSE_OP = 2;

/** The part of a `WebSocketConnection` the native events drive. */
interface Accepted {
  handleOpen(): void;
  handleMessage(message: unknown): void;
  handleClose(code: number, reason: string): void;
}

interface OutboxRecord {
  readonly op: number;
  readonly connection: number;
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function closeBytes(code: number, reason: string): Uint8Array {
  const text = encoder.encode(reason);
  const out = new Uint8Array(2 + text.byteLength);
  new DataView(out.buffer).setUint16(0, code);
  out.set(text, 2);
  return out;
}

function encodeOutbox(records: readonly OutboxRecord[]): Uint8Array {
  const out = new Uint8Array(records.reduce((n, r) => n + 9 + r.bytes.byteLength, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const r of records) {
    view.setUint8(at, r.op);
    view.setUint32(at + 1, r.connection);
    view.setUint32(at + 5, r.bytes.byteLength);
    out.set(r.bytes, at + 9);
    at += 9 + r.bytes.byteLength;
  }
  return out;
}

/** @internal A WebSocket transport that listens through the desktop shell's native server and connects as the client does. */
class TauriWebSocketTransport extends WebSocketTransport {
  /** The native listener's id once `listen` resolved; null before, and after `close`. */
  private listenerId: number | null = null;
  private listening = false;
  private closed = false;
  /** Native connection id → its connection here. */
  private readonly accepted = new Map<number, Accepted>();
  private outbox: OutboxRecord[] = [];
  /** Bytes in the outbox per native connection (each socket's `bufferedAmount`). */
  private readonly outboxBytes = new Map<number, number>();
  /** The IPC chain: every call waits for the one before it. */
  private ipc: Promise<unknown> = Promise.resolve();
  private flushQueued = false;

  override async listen(address: string): Promise<void> {
    if (this.listening || this.closed) throw new Error(this.closed ? "This transport is closed." : "This transport is already listening.");
    this.listening = true;
    const { host, port, path } = parseListenAddress(address);
    const events = new Channel<ArrayBuffer>((message) => this.handleEvent(message));
    const call = this.ipc.then(() => invoke<{ id: number; port: number }>("myco_debuglink_listen", { host: host ?? "0.0.0.0", port, path, events }));
    this.ipc = call.catch(() => undefined);
    let bound: { id: number; port: number };
    try {
      bound = await call;
    } catch (err) {
      this.listening = false;
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.closed) {
      this.ipcCall("myco_debuglink_close", { id: bound.id });
      return;
    }
    this.listenerId = bound.id;
    this.scheduleFlush(); // anything accepted connections queued while the listen call was returning
  }

  override close(): void {
    if (this.closed) return;
    super.close(); // every connection, which queues its close
    this.closed = true;
    const id = this.listenerId;
    if (id === null) return; // still binding: closed once the listen call returns
    this.flush();
    this.listenerId = null;
    this.ipcCall("myco_debuglink_close", { id });
  }

  private handleEvent(message: ArrayBuffer): void {
    if (this.closed || message.byteLength < 5) return;
    const view = new DataView(message);
    const kind = view.getUint8(0);
    const id = view.getUint32(1);
    const rest = new Uint8Array(message, 5);
    switch (kind) {
      case ACCEPT: {
        const connection = this.addConnection(decoder.decode(rest), this.socket(id));
        this.accepted.set(id, connection);
        connection.handleOpen();
        break;
      }
      case MESSAGE:
        this.accepted.get(id)?.handleMessage(rest);
        break;
      case CLOSE: {
        const connection = this.accepted.get(id);
        this.forget(id);
        if (connection && rest.byteLength >= 2) connection.handleClose(view.getUint16(5), decoder.decode(rest.subarray(2)));
        else connection?.handleClose(1006, "");
        break;
      }
      case ERROR:
        console.warn(`[myco] The debug link listener: ${decoder.decode(rest)}`);
        break;
    }
  }

  /** The socket a native connection's `WebSocketConnection` drives: sends and closes go to the outbox. */
  private socket(id: number): SocketLike {
    const transport = this;
    return {
      send: (data) => transport.queue({ op: SEND_OP, connection: id, bytes: data }),
      close: (code = 1000, reason = "") => {
        if (!transport.accepted.has(id)) return; // the native side closed it already
        transport.queue({ op: CLOSE_OP, connection: id, bytes: closeBytes(code, reason) });
        transport.forget(id);
      },
      get bufferedAmount() {
        return transport.outboxBytes.get(id) ?? 0;
      },
    };
  }

  private forget(id: number): void {
    this.accepted.delete(id);
  }

  private queue(record: OutboxRecord): void {
    this.outbox.push(record);
    this.outboxBytes.set(record.connection, (this.outboxBytes.get(record.connection) ?? 0) + record.bytes.byteLength);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushQueued || this.listenerId === null || this.outbox.length === 0) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** Hands the outbox to the IPC chain as one call. */
  private flush(): void {
    const id = this.listenerId;
    if (id === null || this.outbox.length === 0) return;
    const body = encodeOutbox(this.outbox);
    this.outbox = [];
    this.outboxBytes.clear();
    this.ipcCall("myco_debuglink_send", body, { headers: { "myco-listener": String(id) } });
  }

  private ipcCall(cmd: string, args: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }): void {
    this.ipc = this.ipc
      .then(() => invoke(cmd, args, options))
      .catch((err: unknown) => console.warn(`[myco] The debug link listener (${cmd}): ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** Registers "websocket" as the transport above, which can listen: called once by the desktop editor before its debug link starts. */
export function registerTauriWebSocketTransport(): void {
  registerTransport("websocket", (options) => new TauriWebSocketTransport(options), { listen: true });
}
