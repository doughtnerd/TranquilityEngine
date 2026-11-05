import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { World } from "../engine/core/World";
import { LobbyClient } from "../engine/net/lobby/client";
import { _matchOf } from "../engine/net/lobby/match";
import { startServer, type RunningServer } from "./run";

// ADR 0067, 0068 on the dedicated server: a lobby World from the bootstrap, whose match Worlds
// (created at runtime) listen on the server's port by path; players join by URL.

const FIXTURE = fileURLToPath(new URL("./fixtures/lobby", import.meta.url));
const servers: RunningServer[] = [];
const engines: Engine[] = [];
const clients: LobbyClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  for (const e of engines.splice(0)) e.dispose();
  for (const s of servers.splice(0)) await s.close();
});

async function page(): Promise<Engine> {
  const engine = await Engine.create({
    headless: true,
    project: { time: { fixedDeltaTime: 1 / 30 } },
    bootstrap: { worlds: [{ name: "Menu" }], templates: { MatchClient: { tags: ["client", "match"], scenes: [] } } },
  });
  engines.push(engine);
  return engine;
}

async function until(done: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = performance.now();
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const now = performance.now();
    for (const e of engines) e.step((now - last) / 1000);
    last = now;
  }
}

describe("myco-server with a lobby (ADR 0067, 0068)", () => {
  it("runs the lobby World; its match World listens on the same port at /match/<id>, and players join it", async () => {
    const lines: string[] = [];
    const server = await startServer({ projectDir: FIXTURE, port: 0, host: "127.0.0.1", statsIntervalMs: 0, log: (l) => lines.push(l) });
    servers.push(server);
    expect(server.listeners.map((l) => l.world)).toEqual(["Lobby"]);
    const { url, port } = server.listeners[0];

    const pages = [await page(), await page()];
    const [a, b] = [new LobbyClient(), new LobbyClient()];
    clients.push(a, b);
    World._runIn(pages[0].world, () => a.connect(url, { name: "Anne" }));
    World._runIn(pages[1].world, () => b.connect(url, { name: "Bart" }));
    await until(() => a.state === "lobby" && b.state === "lobby", "both in the lobby");
    a.quickMatch({ arena: "open" });
    await until(() => a.state === "room", "a room");
    b.quickMatch({ arena: "open" });
    await until(() => a.room?.members.length === 2, "two members");
    a.setReady(true);
    b.setReady(true);
    await until(() => a.state === "match" && b.state === "match", "the match");

    const match = _matchOf(server.engine._world("Match 1")!)!;
    await until(() => match.players.every((p) => p.connectionId > 0), "both players in the match");
    expect(lines).toContain(`[server] World "Match 1" was created at runtime and is listening on ws://127.0.0.1:${port}/match/1.`);
    expect(lines.some((l) => /only listens for the bootstrap's server Worlds/.test(l))).toBe(false);

    match.end({ winner: "Anne" });
    await until(() => a.state === "room" && b.state === "room", "back in the room");
    expect(a.room!.results).toEqual({ winner: "Anne" });
    await until(() => lines.includes('[server] World "Match 1" (created at runtime) was destroyed.'), "the log line");
  });
});
