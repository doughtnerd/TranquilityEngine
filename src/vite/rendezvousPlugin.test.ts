// The dev-server plugin attached to a test HTTP server: two `RendezvousClient`s signal through it, and another upgrade
// path (Vite's HMR socket) is left to its own handler.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { ViteDevServer } from "vite";
import { RendezvousClient } from "../engine/debugLink/rendezvous/client";
import { RENDEZVOUS_PATH } from "../engine/debugLink/rendezvous/protocol";
import { WebSocketTransport } from "../engine/net/transport/websocket";
import { rendezvous } from "./rendezvousPlugin";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

async function devServer(): Promise<number> {
  const http = createServer((_req, res) => res.end("page"));
  const hmr = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (req.url === "/hmr") hmr.handleUpgrade(req, socket, head, (ws) => ws.send("hello"));
  });
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const configureServer = rendezvous().configureServer as (server: ViteDevServer) => Promise<void>;
  await configureServer({ httpServer: http } as unknown as ViteDevServer);
  return (http.address() as AddressInfo).port;
}

async function until(condition: () => boolean, clients: RendezvousClient[]): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i++) {
    for (const c of clients) c.step();
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(condition()).toBe(true);
}

describe("the dev server's rendezvous plugin", () => {
  it("serves a signalling exchange between two clients on the dev server's port", async () => {
    const port = await devServer();
    const url = `ws://127.0.0.1:${port}${RENDEZVOUS_PATH}`;
    const a = RendezvousClient.openRoom({ transport: new WebSocketTransport(), url, kind: "page-http", draw: () => ({ room: 4242, token: 99 }) });
    const b = RendezvousClient.joinRoom({ transport: new WebSocketTransport(), url, kind: "page-http", room: 4242, token: 99 });
    try {
      await until(() => a.joined && b.joined && a.state === "open" && b.state === "open", [a, b]);
      b.send({ t: "offer", sdp: "offer-sdp" });
      const atA: unknown[] = [];
      await until(() => atA.push(...a.poll()) > 0, [a, b]);
      expect(atA).toEqual([{ t: "offer", sdp: "offer-sdp" }]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("leaves other upgrade paths to their own handlers", async () => {
    const port = await devServer();
    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`);
      ws.on("message", (m) => {
        resolve(String(m));
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(message).toBe("hello");
  });
});
