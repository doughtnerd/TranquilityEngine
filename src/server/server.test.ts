import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Connection, ConnectionState, Engine, Replicated, defineSystem, i32, type GameObject, type RpcDef } from "../engine";
import { World } from "../engine/core/World";
import { connectWorld } from "../engine/net/session";
import { loadedScriptModule } from "../editor/scriptLoader";
import { parseArgs } from "./main";
import { ServerError, startServer, type RunningServer, type ServerOptions } from "./run";

// T14: the dedicated server, in-process, on real sockets (port 0), with a client Engine in the
// test connecting to it by URL. The fixture project's scripts register into this process's
// registry, so the client World shares the server's components and RPCs, as a real client built
// from the same project would.

const FIXTURE = fileURLToPath(new URL("./fixtures/multiplayer", import.meta.url));
const servers: RunningServer[] = [];
const engines: Engine[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const e of engines.splice(0)) e.dispose();
  for (const s of servers.splice(0)) await s.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

async function start(options: Partial<ServerOptions> = {}, lines: string[] = []): Promise<RunningServer> {
  const server = await startServer({ projectDir: FIXTURE, port: 0, host: "127.0.0.1", statsIntervalMs: 0, log: (l) => lines.push(l), ...options });
  servers.push(server);
  return server;
}

/** A client Engine like the game's: the fixture's tick rate and scene, connected by URL. */
async function client(url: string): Promise<World> {
  const engine = await Engine.create({
    headless: true,
    project: { time: { fixedDeltaTime: 1 / 30 } },
    bootstrap: { worlds: [{ name: "Player", tags: ["client"], scenes: ["scenes/arena.scene.json"] }] },
  });
  engines.push(engine);
  connectWorld(engine.world, "websocket", { url });
  return engine.world;
}

/** Step the client Engines on real time (the server steps itself) until `done` holds. */
async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = performance.now();
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const now = performance.now();
    for (const e of engines) e.step((now - last) / 1000);
    last = now;
  }
}

function connectionStates(w: World): number[] {
  return [...w._query([Connection])].map((row) => (row.connection as { state: number }).state);
}

function ghost(w: World): GameObject | null {
  for (const rep of w._componentsOfType(Replicated)) if (rep.isGhost && rep.node.isValid) return rep.node;
  return null;
}

describe("tranquility-server (T14)", () => {
  it("runs the server World, which a client joins and sees its replicated node move", async () => {
    const lines: string[] = [];
    const server = await start({}, lines);
    expect(server.listeners).toHaveLength(1);
    expect(server.listeners[0].world).toBe("Server");
    expect(server.listeners[0].url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(server.listeners[0].port).toBeGreaterThan(0);
    expect(server.tickRate).toBeCloseTo(30);

    const player = await client(server.listeners[0].url);
    await until(() => connectionStates(player)[0] === ConnectionState.open && ghost(player) !== null);
    const ball = ghost(player)!;
    expect(ball.name).toBe("Ball");
    const x0 = ball.transform!.position.x;
    await until(() => ball.transform!.position.x > x0 + 0.2);
    await until(() => lines.some((l) => /World "Server": connection 1 opened/.test(l)));
  });

  it("answers an RPC from a client", async () => {
    const server = await start();
    const { Ping, Pong } = (await loadedScriptModule("scripts/game.ts")) as Record<"Ping" | "Pong", RpcDef<{ n: typeof i32 }>>;
    const got: number[] = [];
    defineSystem({ name: "test.server.readPong", phase: "update", worlds: ["client"], run: () => got.push(...[...Pong.read()].map((m) => m.n)) });
    const player = await client(server.listeners[0].url);
    await until(() => connectionStates(player)[0] === ConnectionState.open);
    World._runIn(player, () => Ping.send({ n: 21 }));
    await until(() => got.length > 0);
    expect(got).toEqual([42]);
  });

  it("skips Worlds that aren't tagged server", async () => {
    const lines: string[] = [];
    const server = await start({}, lines);
    expect(server.engine.worlds().map((w) => w.name)).toEqual(["Server"]);
    expect(lines).toContain('[server] Skipping World "Client": it isn\'t tagged "server".');
    // Binary assets aren't loaded, but their paths resolve.
    expect(server.project.assets.has("images/ball.png")).toBe(true);
    expect(server.project.assets.get("images/ball.png")).toMatch(/^file:/);
  });

  it("closes clients' connections when it shuts down", async () => {
    const lines: string[] = [];
    const server = await start({}, lines);
    const player = await client(server.listeners[0].url);
    await until(() => connectionStates(player)[0] === ConnectionState.open);
    const warn = console.warn;
    console.warn = () => {}; // the client World reports losing its connection
    try {
      await server.close();
      await until(() => connectionStates(player).length === 0);
    } finally {
      console.warn = warn;
    }
    expect(lines.at(-1)).toBe("[server] Stopped.");
  });

  it("fails clearly for a missing folder, a folder without project.json and a port in use", async () => {
    await expect(start({ projectDir: join(FIXTURE, "missing") })).rejects.toThrow(/There's no folder/);
    const empty = mkdtempSync(join(tmpdir(), "tranquility-server-"));
    temps.push(empty);
    await expect(start({ projectDir: empty })).rejects.toThrow(/has no project\.json/);

    writeFileSync(join(empty, "project.json"), JSON.stringify({ bootstrap: { worlds: [{ name: "Solo" }] } }));
    await expect(start({ projectDir: empty })).rejects.toThrow(/no Worlds or templates tagged "server"/);
    writeFileSync(join(empty, "project.json"), JSON.stringify({ bootstrap: { worlds: [{ name: "S", tags: ["server"], tickrate: 30 }] } }));
    await expect(start({ projectDir: empty })).rejects.toThrow(/bootstrap is invalid:\n.*unknown key "tickrate"/);

    const first = await start();
    const second = start({ port: first.listeners[0].port });
    await expect(second).rejects.toBeInstanceOf(ServerError);
    await expect(second).rejects.toThrow(`Port ${first.listeners[0].port} is already in use`);
  });

  it("uses the bootstrap link's port and options unless the command line overrides them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tranquility-server-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        bootstrap: {
          worlds: [{ name: "Game", tags: ["client"] }, { name: "Lobby", tags: ["server"] }, { name: "Match", tags: ["server"] }],
          links: [{ from: "Game", to: "Match", transport: "websocket", options: { address: "ws://127.0.0.1:0/match" } }],
        },
      }),
    );
    const lines: string[] = [];
    const server = await startServer({ projectDir: dir, statsIntervalMs: 0, log: (l) => lines.push(l), port: 0, host: "127.0.0.1", maxConnections: 3 });
    servers.push(server);
    // --port applies to the first server World; the other listens where its link says.
    expect(server.listeners.map((l) => l.world)).toEqual(["Lobby", "Match"]);
    expect(server.listeners[1].url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/match$/);
    const { netSession } = await import("../engine/net/session");
    expect(netSession(server.engine._world("Lobby")!)!.maxConnections).toBe(3);
  });

  it("runs server-tagged templates when the bootstrap's Worlds are all clients (a Host button's layout)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tranquility-server-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({ bootstrap: { worlds: [{ name: "Client", tags: ["client"] }], templates: { Server: { tags: ["server"], renders: false }, Extra: { tags: ["client"] } } } }),
    );
    const server = await startServer({ projectDir: dir, statsIntervalMs: 0, log: () => {}, port: 0, host: "127.0.0.1" });
    servers.push(server);
    expect(server.engine.worlds().map((w) => w.name)).toEqual(["Server"]);
    expect(server.listeners.map((l) => l.world)).toEqual(["Server"]);
  });

  it("ignores a loopback link's address (a name for editor play) and listens on the server's own port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tranquility-server-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        bootstrap: {
          worlds: [{ name: "Client", tags: ["client"] }, { name: "Server", tags: ["server"] }],
          links: [{ from: "Client", to: "Server", transport: "loopback", options: { address: "arena", latencyMs: 50 } }],
        },
      }),
    );
    const lines: string[] = [];
    const server = await startServer({ projectDir: dir, statsIntervalMs: 0, log: (l) => lines.push(l), port: 0, host: "127.0.0.1" });
    servers.push(server);
    expect(server.listeners).toHaveLength(1);
    expect(server.listeners[0].url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/?$/);
  });

  it("runs a code bootstrap's server Worlds, listening where its skipped client Worlds connect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tranquility-server-"));
    temps.push(dir);
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "project.json"), JSON.stringify({ bootstrap: "scripts/Bootstrap.ts" }));
    writeFileSync(
      join(dir, "scripts", "Bootstrap.ts"),
      `import type { BootstrapEngine } from "tranquility";
export function bootstrap(engine: BootstrapEngine): void {
  const host = engine.createWorld({ name: "Host", tags: ["server"] });
  const local = engine.createWorld({ name: "Local", tags: ["client"] });
  local.connect(host, "websocket", { address: "ws://127.0.0.1:0/code" });
}
`,
    );
    const lines: string[] = [];
    const server = await startServer({ projectDir: dir, statsIntervalMs: 0, log: (l) => lines.push(l) });
    servers.push(server);
    expect(server.engine.worlds().map((w) => w.name)).toEqual(["Host"]);
    expect(lines).toContain('[server] Skipping World "Local": it isn\'t tagged "server".');
    expect(server.listeners[0].url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/code$/);
  });
});

describe("tranquility-server's command line", () => {
  it("parses flags", () => {
    expect(parseArgs(["proj", "--port", "7000", "--host=0.0.0.0", "--max-connections", "8", "--tick-rate", "20"])).toEqual({
      projectDir: "proj",
      port: 7000,
      host: "0.0.0.0",
      maxConnections: 8,
      tickRate: 20,
    });
    expect(parseArgs(["--help"])).toBe("help");
    expect(() => parseArgs([])).toThrow(/project folder/);
    expect(() => parseArgs(["proj", "--port", "70000"])).toThrow(/--port needs a port/);
    expect(() => parseArgs(["proj", "--bogus"])).toThrow(/Unknown option --bogus/);
  });

  it("runs from source in Node: --help, and a clear exit for a bad folder", () => {
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^Usage: tranquility-server <projectDir>/);
    // Loads the whole engine through the TypeScript hooks before failing on the folder.
    const bad = spawnSync(process.execPath, [cli, join(FIXTURE, "missing")], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/tranquility-server: There's no folder/);
  }, 20_000);
});
