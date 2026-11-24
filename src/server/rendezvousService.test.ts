// The rendezvous service over real WebSockets (plan task R3): two real clients signal through it.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RendezvousClient } from "../engine/debugLink/rendezvous/client";
import { RENDEZVOUS_PATH } from "../engine/debugLink/rendezvous/protocol";
import { WebSocketTransport } from "../engine/net/transport/websocket";
import { startRendezvous, type RunningRendezvous } from "./rendezvousService";

const cleanup: { close(): unknown }[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c.close();
});

async function until(condition: () => boolean, clients: RendezvousClient[]): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i++) {
    for (const c of clients) c.step();
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(condition()).toBe(true);
}

async function exchange(running: RunningRendezvous, url: string): Promise<void> {
  const a = RendezvousClient.openRoom({ transport: new WebSocketTransport(), url, kind: "native", draw: () => ({ room: 7, token: 1234 }) });
  const b = RendezvousClient.joinRoom({ transport: new WebSocketTransport(), url, kind: "page-http", room: 7, token: 1234 });
  cleanup.push(a, b);
  await until(() => a.joined && b.joined && a.state === "open" && b.state === "open", [a, b]);
  expect(running.server.roomCount).toBe(1);
  b.send({ t: "offer", sdp: "offer-sdp" });
  const atA: unknown[] = [];
  await until(() => atA.push(...a.poll()) > 0, [a, b]);
  expect(atA).toEqual([{ t: "offer", sdp: "offer-sdp" }]);
  a.send({ t: "answer", sdp: "answer-sdp" });
  const atB: unknown[] = [];
  await until(() => atB.push(...b.poll()) > 0, [a, b]);
  expect(atB).toEqual([{ t: "answer", sdp: "answer-sdp" }]);
}

describe("the rendezvous service", () => {
  it("runs on a port of its own", async () => {
    const running = await startRendezvous({ port: 0, host: "127.0.0.1" });
    cleanup.push(running);
    expect(running.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/myco-rendezvous$/);
    await exchange(running, running.url!);
  });

  it("mounts on an existing http server beside its other handlers", async () => {
    const http = createServer((_req, res) => res.end("page"));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    cleanup.push({
      close: () =>
        new Promise<void>((r) => {
          http.closeAllConnections();
          http.close(() => r());
        }),
    });
    const running = await startRendezvous(http, RENDEZVOUS_PATH);
    cleanup.push(running);
    const port = (http.address() as { port: number }).port;
    expect(running.url).toBe(`ws://127.0.0.1:${port}${RENDEZVOUS_PATH}`);
    await exchange(running, running.url!);
  });
});
