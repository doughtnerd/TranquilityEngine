import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _matchOf } from "../engine/net/lobby/match";
import { startServer, type RunningServer } from "./run";

// ADR 0067, 0068 on the dedicated server: a lobby World from the bootstrap, whose match Worlds
// (created at runtime) listen on the server's port by path; players join by URL. Each player is a
// page of its own (the engine imported afresh, so its own page-wide `Lobby`), as in production.

const FIXTURE = fileURLToPath(new URL("./fixtures/lobby", import.meta.url));
const servers: RunningServer[] = [];
interface Page {
  readonly engine: import("../engine").Engine;
  readonly Lobby: typeof import("../engine").Lobby;
  /** Run `fn` in the page's World, as its scripts' code runs. */
  run(fn: () => void): void;
}
const pages: Page[] = [];

afterEach(async () => {
  for (const p of pages.splice(0)) {
    p.Lobby.disconnect();
    p.engine.dispose();
  }
  for (const s of servers.splice(0)) await s.close();
});

/** A player's page: the engine imported afresh, so it has its own `Lobby`. */
async function page(): Promise<Page> {
  vi.resetModules();
  const myco = await import("../engine");
  const { World } = await import("../engine/core/World");
  const engine = await myco.Engine.create({
    headless: true,
    project: { time: { fixedDeltaTime: 1 / 30 } },
    bootstrap: { worlds: [{ name: "Menu" }], templates: { MatchClient: { tags: ["client", "match"], scenes: [] } } },
  });
  const p: Page = { engine, Lobby: myco.Lobby, run: (fn) => World._runIn(engine.world, fn) };
  pages.push(p);
  return p;
}

async function until(done: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = performance.now();
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const now = performance.now();
    for (const p of pages) p.engine.step((now - last) / 1000);
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

    const [anne, bart] = [await page(), await page()];
    const [a, b] = [anne.Lobby, bart.Lobby];
    expect(a).not.toBe(b);
    anne.run(() => a.connect(url, { name: "Anne" }));
    bart.run(() => b.connect(url, { name: "Bart" }));
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
