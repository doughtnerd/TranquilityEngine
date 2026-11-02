/**
 * The WebSocket transport's Node side (ADR 0033, 0035): accepts connections with the `ws`
 * package. Node only; nothing under src/engine/ may import this file or `ws`, so browser bundles
 * stay clean.
 *
 * Importing this module re-registers "websocket" as `NodeWebSocketTransport`, which listens and
 * also connects (as the browser-safe client does), so a server World in Node can `listen`.
 */
import type { AddressInfo } from "node:net";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { registerTransport } from "../engine/net/Transport";
import { WebSocketTransport } from "../engine/net/transport/websocket";

/** Where a `NodeWebSocketTransport` is listening. */
export interface ListenAddress {
  /** The bound host, e.g. "0.0.0.0" or "::". */
  readonly host: string;
  /** The bound port; the real one when listening on port 0. */
  readonly port: number;
  /** Only upgrades to this path are accepted; "/" accepts any. */
  readonly path: string;
  /** A URL clients on this machine can connect to (wildcard hosts become localhost). */
  readonly url: string;
}

/**
 * Parse a listen address: "ws://0.0.0.0:7777/game", "localhost:7777", "7777", ":7777" or a port
 * number. No host means every interface; a path other than "/" limits upgrades to that path.
 */
export function parseListenAddress(address: string | number): { host?: string; port: number; path: string } {
  if (typeof address === "number") return { port: address, path: "/" };
  const trimmed = address.trim();
  if (/^:?\d+$/.test(trimmed)) return { port: Number(trimmed.replace(":", "")), path: "/" };
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `ws://${trimmed}`);
  } catch {
    throw new Error(`Can't listen on "${address}": expected a port or a URL like "ws://0.0.0.0:7777".`);
  }
  if (url.protocol !== "ws:") throw new Error(`Can't listen on "${address}": only ws:// is supported (put TLS in a reverse proxy).`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host: host || undefined, port: url.port ? Number(url.port) : 80, path: url.pathname || "/" };
}

/** A WebSocket transport that can listen (Node only) as well as connect. */
export class NodeWebSocketTransport extends WebSocketTransport {
  private server: WebSocketServer | null = null;
  private bound: ListenAddress | null = null;

  /** Where it's listening, once `listen` resolves; null before that and after `close`. */
  get address(): ListenAddress | null {
    return this.bound;
  }

  /** Start accepting connections. Resolves once bound (so `address.port` is real for port 0). */
  override async listen(address: string | number): Promise<void> {
    if (this.server) throw new Error(`This transport is already listening on ${this.bound?.url ?? "a port"}.`);
    const { host, port, path } = parseListenAddress(address);
    const server = new WebSocketServer({ host, port, path: path === "/" ? undefined : path });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    } catch (error) {
      this.server = null;
      server.close();
      throw new Error(`Can't listen on "${address}": ${(error as Error).message}`);
    }
    const info = server.address() as AddressInfo;
    const local = info.address === "0.0.0.0" || info.address === "::" ? "localhost" : info.family === "IPv6" ? `[${info.address}]` : info.address;
    this.bound = { host: info.address, port: info.port, path, url: `ws://${local}:${info.port}${path === "/" ? "" : path}` };
    // After binding, a server error (rare) shouldn't crash the process; connections report their own.
    server.on("error", () => {});
    server.on("connection", (socket, request) => this.accept(socket, `${request.socket.remoteAddress}:${request.socket.remotePort}`));
  }

  override close(): void {
    for (const connection of [...this.connections]) connection.close("server closed");
    this.server?.close();
    this.server = null;
    this.bound = null;
  }

  private accept(socket: WebSocket, remote: string): void {
    socket.binaryType = "arraybuffer";
    const connection = this.addConnection(remote, {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    });
    socket.on("message", (data: RawData, isBinary: boolean) => connection.handleMessage(isBinary ? data : String(data)));
    socket.on("error", (error) => connection.handleError(error.message));
    socket.on("close", (code, reason) => connection.handleClose(code, reason.toString()));
    connection.handleOpen();
  }
}

/** Create a Node WebSocket transport (the factory registered as "websocket" in Node). */
export function createWebSocketServerTransport(): NodeWebSocketTransport {
  return new NodeWebSocketTransport();
}

registerTransport("websocket", createWebSocketServerTransport);
