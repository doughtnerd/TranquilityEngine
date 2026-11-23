/**
 * The WebSocket transport's Node side (ADR 0033, 0035): accepts connections with the `ws`
 * package. Node only; nothing under src/engine/ may import this file or `ws`, so browser bundles
 * stay clean.
 *
 * Importing this module re-registers "websocket" as `NodeWebSocketTransport`, which listens and
 * also connects (as the browser-safe client does), so a server World in Node can `listen`.
 *
 * ## One port, many paths (ADR 0067)
 *
 * Listeners share HTTP servers: a process-wide table holds one per `host:port`. A transport that
 * listens on a port another already serves joins that server at its own path, and upgrade
 * requests are routed by URL path (the query is ignored) to the transport listening there; an
 * unknown path is refused with HTTP 404. A listener at "/" alone on its port accepts every path
 * (as before 0067); once other paths share the port, "/" is just one more exact path. The HTTP
 * server closes when its last listener closes (when its World is destroyed). Port 0 always opens
 * a new server, which later listeners can then share by its real port.
 *
 * ## Datagram lanes (ADR 0333)
 *
 * A client whose URL asks with `myco-rtc=1` is offered a WebRTC data channel for its unreliable
 * messages. Node has no WebRTC, so the peer connections are node-datachannel's (libdatachannel,
 * native), loaded on the first connection that wants one; if it can't load, that's logged once and
 * every connection stays on the socket. Connections this transport opens as a client get them too.
 * The `webrtc` option: `false`, or `{ udpPort, publicIp, bindAddress, iceServers, maxDatagramBytes,
 * connectTimeoutMs }` (`NodeWebRtcOptions`).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { parseListenAddress } from "../engine/net/listenTarget";
import { registerTransport } from "../engine/net/Transport";
import { hostCandidateRewriter, type PeerConnectionConstructor } from "../engine/net/transport/datagramLane";
import { frameBytesLimit, RTC_QUERY, rtcSetupParts, WebSocketTransport, type RtcSetup, type WebRtcOptions } from "../engine/net/transport/websocket";

/** The Node server's `webrtc` transport option (ADR 0333), when it isn't `false`. */
export interface NodeWebRtcOptions extends WebRtcOptions {
  /** Every connection's data channel on this one UDP port (ICE UDP mux). Default: an ephemeral port per connection. */
  udpPort?: number;
  /** The address put in this server's host candidates in place of its interfaces' (a host behind one-to-one NAT). */
  publicIp?: string;
  /** The local address the data channels bind. Default: every interface. */
  bindAddress?: string;
}

let nodePeerConnection: Promise<PeerConnectionConstructor | null> | null = null;

/** node-datachannel's `RTCPeerConnection`, loaded once; null (logged once) if it can't load here. */
function loadNodePeerConnection(): Promise<PeerConnectionConstructor | null> {
  return (nodePeerConnection ??= import("node-datachannel/polyfill").then(
    (module) => module.RTCPeerConnection as unknown as PeerConnectionConstructor,
    (error: Error) => {
      console.warn(`[myco] WebRTC isn't available (node-datachannel didn't load: ${error.message}); unreliable messages stay on WebSocket.`);
      return null;
    },
  ));
}

/** Check the Node-only keys of the `webrtc` option; throws for a bad one. */
function checkNodeWebRtc(rtc: NodeWebRtcOptions): void {
  if (rtc.udpPort !== undefined && !(Number.isInteger(rtc.udpPort) && rtc.udpPort >= 1 && rtc.udpPort <= 65535)) {
    throw new Error(`webrtc.udpPort must be a port from 1 to 65535 (got ${JSON.stringify(rtc.udpPort)}).`);
  }
  for (const key of ["publicIp", "bindAddress"] as const) {
    const value = rtc[key];
    if (value !== undefined && !(typeof value === "string" && value.trim() !== "" && !/\s/.test(value))) throw new Error(`webrtc.${key} must be an address (got ${JSON.stringify(value)}).`);
  }
}

/** Whether an upgrade request's URL asks for a datagram lane. */
function wantsDatagramLane(request: IncomingMessage): boolean {
  try {
    return new URL(request.url ?? "/", "http://localhost").searchParams.get(RTC_QUERY) === "1";
  } catch {
    return false;
  }
}

/** Where a `NodeWebSocketTransport` is listening. */
export interface ListenAddress {
  /** The bound host, e.g. "0.0.0.0" or "::". */
  readonly host: string;
  /** The bound port; the real one when listening on port 0. */
  readonly port: number;
  /** Only upgrades to this path reach this transport ("/" alone on a port accepts any). */
  readonly path: string;
  /** A URL clients on this machine can connect to (wildcard hosts become localhost). */
  readonly url: string;
}

/** One HTTP server shared by the listeners on its port. */
interface SharedServer {
  readonly http: Server;
  /** Table keys it's filed under (the asked-for one, and the real port's for port 0). */
  readonly keys: Set<string>;
  /** Listening transports by path. */
  readonly routes: Map<string, NodeWebSocketTransport>;
  /** Resolves once bound; rejects if binding failed. */
  readonly ready: Promise<AddressInfo>;
  info: AddressInfo | null;
}

/** Process-wide: shared HTTP servers by `host:port` ("*" for every interface). */
const servers = new Map<string, SharedServer>();

const serverKey = (host: string | undefined, port: number) => `${host ?? "*"}:${port}`;

/** The path part of an upgrade request's URL, without the query. */
function requestPath(request: IncomingMessage): string {
  const raw = request.url ?? "/";
  const q = raw.indexOf("?");
  const path = q >= 0 ? raw.slice(0, q) : raw;
  try {
    return decodeURIComponent(path) || "/";
  } catch {
    return path || "/";
  }
}

function refuse(socket: Duplex, status: number, text: string): void {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  } catch {
    // The socket is already gone.
  }
  socket.destroy();
}

function openServer(host: string | undefined, port: number): SharedServer {
  const http = createServer((_request, response) => {
    response.writeHead(426, { "Content-Type": "text/plain" }); // a plain HTTP request: this port only speaks WebSocket
    response.end("Upgrade Required");
  });
  const shared: SharedServer = {
    http,
    keys: new Set([serverKey(host, port)]),
    routes: new Map(),
    info: null,
    ready: new Promise<AddressInfo>((resolve, reject) => {
      http.once("listening", () => resolve(http.address() as AddressInfo));
      http.once("error", reject);
    }),
  };
  shared.ready.then(
    (info) => {
      shared.info = info;
      if (port === 0) {
        const real = serverKey(host, info.port);
        shared.keys.add(real);
        servers.set(real, shared);
      }
      // After binding, a server error (rare) shouldn't crash the process; connections report their own.
      http.on("error", (error) => console.error(`[myco] WebSocket server on port ${info.port}:`, error));
    },
    () => {
      for (const k of shared.keys) if (servers.get(k) === shared) servers.delete(k);
    },
  );
  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = requestPath(request);
    let target = shared.routes.get(path);
    // A listener at "/" alone on its port accepts every path (the behavior before ADR 0067).
    if (!target && shared.routes.size === 1) target = shared.routes.get("/");
    if (!target) return refuse(socket, 404, "Not Found");
    target._upgrade(request, socket, head);
  });
  if (port !== 0) servers.set(serverKey(host, port), shared);
  http.listen(port, host);
  return shared;
}

function releaseServer(shared: SharedServer): void {
  if (shared.routes.size > 0) return;
  for (const k of shared.keys) if (servers.get(k) === shared) servers.delete(k);
  shared.http.close();
  shared.http.closeAllConnections?.();
}

/** A WebSocket transport that can listen (Node only) as well as connect. */
class NodeWebSocketTransport extends WebSocketTransport {
  private shared: SharedServer | null = null;
  private wss: WebSocketServer | null = null;
  private bound: ListenAddress | null = null;
  private path = "/";

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    if (this.rtc) checkNodeWebRtc(this.rtc as NodeWebRtcOptions);
  }

  /** Where it's listening, once `listen` resolves; null before that and after `close`. */
  get address(): ListenAddress | null {
    return this.bound;
  }

  /**
   * Start accepting connections. Resolves once bound (so `address.port` is real for port 0). A
   * port another transport in this process serves is shared, by path (see the top of this file).
   */
  override async listen(address: string | number): Promise<void> {
    if (this.shared) throw new Error(`This transport is already listening on ${this.bound?.url ?? "a port"}.`);
    const { host, port, path } = parseListenAddress(address);
    let shared = port === 0 ? undefined : servers.get(serverKey(host, port));
    if (shared?.routes.has(path)) {
      const other = shared.routes.get(path)!;
      throw new Error(`Can't listen on "${address}": path "${path}" on port ${port} is already listened on${other.bound ? ` (${other.bound.url})` : ""}.`);
    }
    shared ??= openServer(host, port);
    // maxPayload: ws rejects bigger frames before buffering them (its default is 100 MiB).
    const wss = new WebSocketServer({ noServer: true, maxPayload: frameBytesLimit(this.limits) });
    shared.routes.set(path, this);
    this.shared = shared;
    this.wss = wss;
    this.path = path;
    let info: AddressInfo;
    try {
      info = await shared.ready;
    } catch (error) {
      shared.routes.delete(path);
      this.shared = null;
      this.wss = null;
      wss.close();
      throw new Error(`Can't listen on "${address}": ${(error as Error).message}`);
    }
    if (this.shared !== shared) return; // closed while binding
    const local = info.address === "0.0.0.0" || info.address === "::" ? "localhost" : info.family === "IPv6" ? `[${info.address}]` : info.address;
    this.bound = { host: info.address, port: info.port, path, url: `ws://${local}:${info.port}${path === "/" ? "" : encodeURI(path)}` };
    wss.on("connection", (socket: WebSocket, request: IncomingMessage) =>
      this.accept(socket, `${request.socket.remoteAddress}:${request.socket.remotePort}`, wantsDatagramLane(request) ? this.rtcSetup("offer") : null),
    );
  }

  /** @internal The shared server routed an upgrade request here. */
  _upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const wss = this.wss;
    if (!wss || !this.bound) return refuse(socket, 503, "Service Unavailable");
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  }

  override close(): void {
    for (const connection of [...this.connections]) connection.close("server closed");
    const shared = this.shared;
    this.shared = null;
    this.bound = null;
    this.wss?.close();
    this.wss = null;
    if (shared && shared.routes.get(this.path) === this) {
      shared.routes.delete(this.path);
      releaseServer(shared);
    }
  }

  /**
   * @internal Node's peer connections (node-datachannel) for both roles; an offering (server)
   * connection also gets the server's UDP port, bind address and public address.
   */
  protected override rtcSetup(role: RtcSetup["role"]): RtcSetup | null {
    if (!this.rtc) return null;
    const rtc = this.rtc as NodeWebRtcOptions;
    const config: Record<string, unknown> = { iceServers: rtc.iceServers ?? [] };
    if (role === "offer") {
      if (rtc.udpPort !== undefined) Object.assign(config, { portRangeBegin: rtc.udpPort, portRangeEnd: rtc.udpPort, enableIceUdpMux: true });
      if (rtc.bindAddress) config.bindAddress = rtc.bindAddress;
    }
    return {
      role,
      load: loadNodePeerConnection,
      config: config as RTCConfiguration,
      ...rtcSetupParts(rtc),
      ...(role === "offer" && rtc.publicIp ? { rewriteCandidate: hostCandidateRewriter(rtc.publicIp) } : {}),
    };
  }

  private accept(socket: WebSocket, remote: string, rtc: RtcSetup | null): void {
    socket.binaryType = "arraybuffer";
    const connection = this.addConnection(
      remote,
      {
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        get bufferedAmount() {
          return socket.bufferedAmount; // for dropping stale unreliable data on a slow link
        },
      },
      rtc,
    );
    socket.on("message", (data: RawData, isBinary: boolean) => connection.handleMessage(isBinary ? data : String(data)));
    socket.on("error", (error) => connection.handleError(error.message));
    socket.on("close", (code, reason) => connection.handleClose(code, reason.toString()));
    connection.handleOpen();
  }
}

/** Create a Node WebSocket transport (the factory registered as "websocket" in Node). */
export function createWebSocketServerTransport(options: Record<string, unknown> = {}): NodeWebSocketTransport {
  return new NodeWebSocketTransport(options);
}

registerTransport("websocket", createWebSocketServerTransport);
