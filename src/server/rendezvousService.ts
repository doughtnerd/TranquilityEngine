// The rendezvous as a Node service (ADR 0403 "Rendezvous", 0404; plan task R3). Node only, over `ws`.
//
// `startRendezvous(target, path)` runs a `RendezvousServer` (src/engine/debugLink/rendezvous/server.ts) over WebSockets
// and polls it on a timer. `target` is either an existing `http.Server` (the dev server's, or a debug export's
// `serve.mjs`'s: the rendezvous then answers upgrade requests at `path` on the same port as the pages, ADR 0067, and
// leaves every other upgrade request alone) or `{ port, host }` (it opens an HTTP server of its own and refuses
// everything but `path`). It carries only the signalling handshake, never debug traffic.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { RENDEZVOUS_PATH } from "../engine/debugLink/rendezvous/protocol";
import { RendezvousServer } from "../engine/debugLink/rendezvous/server";
import { WebSocketTransport } from "../engine/net/transport/websocket";

/** How often the rendezvous is polled, ms. */
export const RENDEZVOUS_POLL_MS = 20;

/** A `WebSocketTransport` whose connections come from upgrade requests an HTTP server hands over (`upgrade`). */
class AttachedTransport extends WebSocketTransport {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  /** Adopt the upgrade request `socket` (already routed to this transport by path). */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws: WebSocket) => this.accept(ws, `${request.socket.remoteAddress}:${request.socket.remotePort}`));
  }

  override async listen(): Promise<void> {
    // Nothing to bind: the HTTP server it is attached to does that.
  }

  override close(): void {
    super.close();
    this.wss.close();
  }

  private accept(socket: WebSocket, remote: string): void {
    socket.binaryType = "arraybuffer";
    const connection = this.addConnection(remote, {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
    });
    socket.on("message", (data: RawData, isBinary: boolean) => connection.handleMessage(isBinary ? data : String(data)));
    socket.on("error", (error) => connection.handleError(error.message));
    socket.on("close", (code, reason) => connection.handleClose(code, reason.toString()));
    connection.handleOpen();
  }
}

function pathOf(request: IncomingMessage): string {
  const raw = request.url ?? "/";
  const q = raw.indexOf("?");
  return q >= 0 ? raw.slice(0, q) : raw;
}

function refuse(socket: Duplex, status: number, text: string): void {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  } catch {
    // The socket is already gone.
  }
  socket.destroy();
}

/** A running rendezvous. */
export interface RunningRendezvous {
  readonly server: RendezvousServer;
  /** The bound host and port (the attached server's when attached). Null if an attached server wasn't listening yet. */
  readonly address: AddressInfo | null;
  /** `ws://host:port/path` for clients on this machine (wildcard hosts become localhost); null if `address` is. */
  readonly url: string | null;
  /** Stop polling, close every connection, detach (an attached server stays up) or close the server it opened. */
  close(): Promise<void>;
}

/**
 * Start a rendezvous at `path`. Pass an `http.Server` to mount it on that server (it may not be listening yet; the
 * caller listens), or `{ port, host }` to run it alone (resolves once bound; port 0 picks a free one).
 */
export async function startRendezvous(target: Server | { port: number; host?: string }, path: string = RENDEZVOUS_PATH): Promise<RunningRendezvous> {
  const transport = new AttachedTransport();
  const server = new RendezvousServer({ transport, now: () => Date.now() });
  await server.listen(path);
  const owned =
    "on" in target
      ? null
      : createServer((_request, response) => {
          response.writeHead(426, { "Content-Type": "text/plain" });
          response.end("Upgrade Required");
        });
  const http: Server = owned ?? (target as Server);
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (pathOf(request) === path) transport.upgrade(request, socket, head);
    else if (owned) refuse(socket, 404, "Not Found");
    // Attached: another handler (the dev server's HMR socket) may want it; leave it.
  };
  http.on("upgrade", onUpgrade);
  const timer = setInterval(() => server.poll(), RENDEZVOUS_POLL_MS);
  timer.unref?.();
  if (owned) {
    const { port, host } = target as { port: number; host?: string };
    await new Promise<void>((resolve, reject) => {
      owned.once("error", reject);
      owned.listen(port, host, resolve);
    });
  }
  const a = http.address();
  const bound: AddressInfo | null = a && typeof a === "object" ? a : null;
  let url: string | null = null;
  if (bound) {
    const local = bound.address === "0.0.0.0" || bound.address === "::" ? "localhost" : bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
    url = `ws://${local}:${bound.port}${path}`;
  }
  return {
    server,
    address: bound,
    url,
    async close() {
      clearInterval(timer);
      http.off("upgrade", onUpgrade);
      server.close();
      if (owned) {
        owned.closeAllConnections?.();
        await new Promise<void>((resolve) => owned.close(() => resolve()));
      }
    },
  };
}
