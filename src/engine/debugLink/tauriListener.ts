// The desktop editor's listening `websocket` transport (ADR 0379). A page can't open a server socket, so under Tauri
// the WebSocket server is native (`src-tauri/src/debug_link.rs` over `native/ws-listener`) and this transport drives it
// over Tauri's IPC: `myco_debuglink_listen_range` binds and streams events (accept, message, close, error) to a channel
// as raw bytes; `myco_debuglink_send` takes an outbox of sends and closes; `myco_debuglink_close` stops it. The native side
// moves whole binary messages only; framing, limits and close rules stay in `WebSocketConnection` (websocket.ts), the
// same code the Node server uses, so the debug link (`EditorDebugLink`) runs on it unchanged. Connecting is the plain
// client's (the page's own `WebSocket`).
//
// The IPC commands (C8 of the pairing plan; the Rust side is `src-tauri/src/debug_link.rs`, moving to
// `native/debug-link-tauri`):
// - `myco_debuglink_listen_range` { host: string, firstPort: number, count: number, path: string, events: Channel }
//   -> { id: number, port: number }. Binds the first free port of `firstPort .. firstPort + count - 1` (ADR 0403: 7790
//   .. 7799, so the editor, the Studio and a game share a machine; "port in use" moves to the next port, any other
//   error fails at once). `port` is the one it got. Rejects with the reason (a string) when all are taken or the bind
//   fails. A `firstPort` of 0 means "any free port" and `count` is then 1.
// - `myco_debuglink_listen` { host, port, path, events } -> { id, port }: the single-port command that exists today.
//   Until the Rust side has `myco_debuglink_listen_range` ("Command ... not found"), the transport falls back to it with
//   `port` = `firstPort` (no range), (each transport tries the range command once).
// - `myco_debuglink_send` (raw body = the outbox, header `myco-listener: <id>`) and `myco_debuglink_close` { id }.
// The port a listening transport got: `tauriListenerPort(transport)`.
//
// Wire format (`native/ws-listener/src/wire.rs` is the other side; big-endian, UTF-8):
// - events, one per channel message: [kind u8][connection u32][rest]; 1 accept (rest: the peer's address, then a newline
//   and the path the upgrade asked for; an older native side sends the address alone), 2 message
//   (rest: the payload), 3 close (rest: [code u16][reason]; only for closes the page didn't ask for), 4 error
//   (connection 0, rest: the message);
// - an outbox body: records [op u8][connection u32][length u32][bytes]; 1 send (bytes: the payload), 2 close (bytes:
//   [code u16][reason]).
//
// One native listener serves more than one path (ADR 0403 "Rendezvous", ADR 0067): the native side takes one listen
// path, and "/" accepts every path and reports each accept's path, so this transport routes by it. `routePath` (before
// `listen`) hands a path's connections to a second transport (`RoutedTransport`); `hostRendezvous` runs a
// `RendezvousServer` over one at `/myco-rendezvous`. With routes, the listen path moves to "/" natively and any path
// that is neither the listen path nor a route is closed here (the native side no longer refuses it).
//
// IPC calls go one at a time, in order (listen, then each outbox, then close), so sends and closes reach the native
// side in the order the page made them.
import { Channel, invoke } from "@tauri-apps/api/core";
import { parseListenAddress } from "../net/listenTarget";
import type { NetworkInterfaceAddress } from "./pairing/address";
import { registerTransport, type Transport } from "../net/Transport";
import { WebSocketTransport, type SocketLike } from "../net/transport/websocket";
import { RENDEZVOUS_PATH } from "./rendezvous/protocol";
import { RendezvousServer } from "./rendezvous/server";

/** How many ports from the requested one the native listener may try (ADR 0403: 7790..7799). */
const PORT_RANGE = 10;

function isMissingCommand(err: unknown): boolean {
  return /not found|not allowed|unknown command/i.test(err instanceof Error ? err.message : String(err));
}

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

/** @internal The connections of one extra path of a native listener (`routePath`): the parent transport adopts them here. */
class RoutedTransport extends WebSocketTransport {
  /** Called once when this transport closes (a parent that closes closes it too). */
  onClosed: (() => void) | null = null;
  private closedOnce = false;

  override async listen(): Promise<void> {
    // Nothing to bind: the parent's native listener does that.
  }

  adopt(remote: string, socket: SocketLike): Accepted {
    return this.addConnection(remote, socket);
  }

  override close(): void {
    super.close();
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.onClosed?.();
  }
}

/** @internal A WebSocket transport that listens through the desktop shell's native server and connects as the client does. */
class TauriWebSocketTransport extends WebSocketTransport {
  /** The native listener's id once `listen` resolved; null before, and after `close`. */
  private listenerId: number | null = null;
  private listening = false;
  /** Set once the native side turned out not to have `myco_debuglink_listen_range`. */
  private rangeUnsupported = false;
  /** The port the native listener bound; null before `listen` resolved. */
  boundPort: number | null = null;
  private closed = false;
  /** Native connection id → its connection here. */
  private readonly accepted = new Map<number, Accepted>();
  private outbox: OutboxRecord[] = [];
  /** Bytes in the outbox per native connection (each socket's `bufferedAmount`). */
  private readonly outboxBytes = new Map<number, number>();
  /** The IPC chain: every call waits for the one before it. */
  private ipc: Promise<unknown> = Promise.resolve();
  private flushQueued = false;
  /** Extra paths this listener serves, by path (`routePath`). */
  private readonly routes = new Map<string, RoutedTransport>();
  /** The path `listen` was asked for. */
  private mainPath = "/";
  /** The native listener takes every path and this transport filters (there are routes). */
  private filtering = false;

  /** A transport for the connections to `path`, or null when this one is listening or closed already (routes come first). */
  routePath(path: string): Transport | null {
    if (this.listening || this.closed) return null;
    let route = this.routes.get(path);
    if (!route) {
      route = new RoutedTransport();
      this.routes.set(path, route);
    }
    return route;
  }

  override async listen(address: string): Promise<void> {
    if (this.listening || this.closed) throw new Error(this.closed ? "This transport is closed." : "This transport is already listening.");
    this.listening = true;
    const { host, port, path: asked } = parseListenAddress(address);
    this.mainPath = asked;
    this.filtering = this.routes.size > 0 && asked !== "/";
    const path = this.filtering ? "/" : asked;
    const events = new Channel<ArrayBuffer>((message) => this.handleEvent(message));
    const bindHost = host ?? "0.0.0.0";
    const call = this.ipc.then(async () => {
      if (!this.rangeUnsupported) {
        try {
          const count = Math.max(1, Math.min(port === 0 ? 1 : PORT_RANGE, 65536 - port));
          return await invoke<{ id: number; port: number }>("myco_debuglink_listen_range", { host: bindHost, firstPort: port, count, path, events });
        } catch (err) {
          if (!isMissingCommand(err)) throw err;
          this.rangeUnsupported = true;
        }
      }
      return invoke<{ id: number; port: number }>("myco_debuglink_listen", { host: bindHost, port, path, events });
    });
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
    this.boundPort = bound.port;
    this.scheduleFlush(); // anything accepted connections queued while the listen call was returning
  }

  override close(): void {
    if (this.closed) return;
    super.close(); // every connection, which queues its close
    for (const route of this.routes.values()) route.close();
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
        const text = decoder.decode(rest);
        const at = text.indexOf("\n");
        const remote = at < 0 ? text : text.slice(0, at);
        const path = at < 0 ? undefined : text.slice(at + 1);
        const route = path === undefined ? undefined : this.routes.get(path);
        if (!route && this.filtering && path !== undefined && path !== this.mainPath) {
          this.queue({ op: CLOSE_OP, connection: id, bytes: closeBytes(1008, "Not found.") }); // neither the listen path nor a route
          break;
        }
        const connection = route ? route.adopt(remote, this.socket(id)) : this.addConnection(remote, this.socket(id));
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

/**
 * This machine's network addresses from the desktop shell (`myco_debuglink_interfaces`: the primary IPv4 address and
 * loopback), for the pairing code's LAN address (`startBuildListener`'s and `connectToBuild`'s `interfaces`). Empty
 * outside Tauri, or when the command fails or is missing (an older shell).
 */
export async function nativeInterfaces(): Promise<NetworkInterfaceAddress[]> {
  if (!("__TAURI_INTERNALS__" in globalThis)) return [];
  try {
    const list = await invoke<NetworkInterfaceAddress[]>("myco_debuglink_interfaces");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** The port a transport from `registerTauriWebSocketTransport` got from the native listener (null before it is listening, or for another transport). */
export function tauriListenerPort(transport: Transport): number | null {
  return transport instanceof TauriWebSocketTransport ? transport.boundPort : null;
}

/** How often a hosted rendezvous is polled, ms. */
const RENDEZVOUS_POLL_MS = 33;

/**
 * Runs a rendezvous (ADR 0403 "Rendezvous") on the native listener `transport` is, at `/myco-rendezvous` on the same
 * port, so a native Myco app hosts rooms for pages and tools on its LAN. Call it before `transport.listen`. Returns the
 * stop, or null when `transport` isn't the native listener or has started listening. The rendezvous stops with the
 * transport. It carries only signalling.
 */
export function hostRendezvous(transport: Transport, path: string = RENDEZVOUS_PATH): (() => void) | null {
  if (!(transport instanceof TauriWebSocketTransport)) return null;
  const route = transport.routePath(path);
  if (!(route instanceof RoutedTransport)) return null;
  const server = new RendezvousServer({ transport: route, now: () => Date.now() });
  void server.listen(path);
  const timer = setInterval(() => server.poll(), RENDEZVOUS_POLL_MS);
  route.onClosed = () => clearInterval(timer);
  return () => {
    clearInterval(timer);
    server.close();
  };
}

/**
 * The transport name whose listeners also host the rendezvous (`hostRendezvous`): a listening desktop game passes it to
 * `startBuildListener`, which makes its own transport, so the game can host rooms for pages on its LAN as the editor
 * and the Studio do (they wrap theirs with `listeningTransport`).
 */
export const TAURI_HOSTING_TRANSPORT = "websocket-hosting";

/**
 * Registers "websocket" as the transport above, which can listen: called once by the desktop editor, the Studio and a
 * debug desktop game before their debug link starts. It also registers `TAURI_HOSTING_TRANSPORT`, the same transport
 * with the rendezvous on its port.
 */
export function registerTauriWebSocketTransport(): void {
  registerTransport("websocket", (options) => new TauriWebSocketTransport(options), { listen: true });
  registerTransport(
    TAURI_HOSTING_TRANSPORT,
    (options) => {
      const transport = new TauriWebSocketTransport(options);
      hostRendezvous(transport);
      return transport;
    },
    { listen: true },
  );
}
