import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Connection, ConnectionState, Engine, Input, Replicated, defineSystem, i32, type DataComponentDef, type GameObject, type RpcDef } from "../engine";
import { World } from "../engine/core/World";
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
  engine.findWorld("Player")!.connect(url, "websocket"); // by address (ADR 0036), as a browser client joins
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

describe("myco-server (T14)", () => {
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
    const empty = mkdtempSync(join(tmpdir(), "myco-server-"));
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
    const dir = mkdtempSync(join(tmpdir(), "myco-server-"));
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
    const dir = mkdtempSync(join(tmpdir(), "myco-server-"));
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

  it("runs only the lobby template when the templates include one: its match templates are the lobby's to create (ADR 0068)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-server-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        bootstrap: {
          worlds: [{ name: "Menu" }],
          templates: {
            Match: { tags: ["server", "match"], renders: false },
            Lobby: { tags: ["server", "lobby"], renders: false, lobby: { matchTemplate: "Match", clientTemplate: "MatchClient" } },
            MatchClient: { tags: ["client", "match-client"] },
          },
        },
      }),
    );
    const server = await startServer({ projectDir: dir, statsIntervalMs: 0, log: () => {}, port: 0, host: "127.0.0.1" });
    servers.push(server);
    expect(server.engine.worlds().map((w) => w.name)).toEqual(["Lobby"]);
    expect(server.listeners.map((l) => l.world)).toEqual(["Lobby"]);
  });

  it("ignores a loopback link's address (a name for editor play) and listens on the server's own port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-server-"));
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
    const dir = mkdtempSync(join(tmpdir(), "myco-server-"));
    temps.push(dir);
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "project.json"), JSON.stringify({ bootstrap: "scripts/Bootstrap.ts" }));
    writeFileSync(
      join(dir, "scripts", "Bootstrap.ts"),
      `import type { BootstrapEngine } from "myco";
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

// T16: the arena sample (samples/arena) on the dedicated server, read as a data folder by path
// (nothing in src/ imports the sample's code; startServer loads its scripts like any project's).
// Its bootstrap has only a client World, so the server runs the `Server` template (Unity's
// frontend pattern: in the browser a Host button creates that World).
describe("the arena sample on myco-server (T16)", () => {
  const ARENA = fileURLToPath(new URL("../../samples/arena", import.meta.url));
  type PlayerData = { score: number; aimX: number; aimY: number };
  interface ArenaPlayer {
    node: GameObject;
    ownerId: number;
    data: PlayerData;
  }

  /** Start the server on the arena; resolves with it and the sample's `Player` component (its scripts are loaded then). */
  async function startArena(lines: string[] = []): Promise<{ server: RunningServer; Player: DataComponentDef }> {
    const server = await start({ projectDir: ARENA }, lines);
    const { Player } = (await loadedScriptModule("scripts/data.ts")) as { Player: DataComponentDef };
    return { server, Player };
  }

  /** A client Engine like the arena's after Join: a client World in the arena scene that takes the keyboard. */
  async function arenaClient(server: RunningServer): Promise<World> {
    const engine = await Engine.create({
      headless: true,
      project: server.project.settings,
      bootstrap: { worlds: [{ name: "Player", tags: ["client"], input: true, scenes: ["scenes/arena.scene.json"] }] },
    });
    engines.push(engine);
    engine.findWorld("Player")!.connect(server.listeners[0].url, "websocket"); // as the menu's Join does
    return engine.world;
  }

  /** Players (nodes with arena.Player) in a World, by owner id. */
  function playersIn(w: World, Player: DataComponentDef): ArenaPlayer[] {
    return w
      ._componentsOfType(Replicated)
      .filter((rep) => rep.node.isValid && rep.node.getData(Player))
      .map((rep) => ({ node: rep.node, ownerId: rep.ownerId, data: rep.node.getData(Player) as unknown as PlayerData }))
      .sort((a, b) => a.ownerId - b.ownerId);
  }

  afterEach(() => Input.reset());

  it("runs the Server template; a client joins, gets a predicted player it owns, moves it with input, and leaving removes it", async () => {
    const lines: string[] = [];
    const { server, Player } = await startArena(lines);
    expect(server.engine.worlds().map((w) => w.name)).toEqual(["Server"]);
    expect(server.listeners.map((l) => l.world)).toEqual(["Server"]);
    expect(server.tickRate).toBeCloseTo(60);
    const serverWorld = server.engine._world("Server")!;

    const client = await arenaClient(server);
    await until(() => connectionStates(client)[0] === ConnectionState.open && playersIn(client, Player).length === 1);
    const mine = playersIn(client, Player)[0];
    const rep = mine.node.getBehavior(Replicated)!;
    expect(rep.mode).toBe("predicted");
    expect(rep.isOwnedLocally).toBe(true);
    expect(rep.isPredictedLocally).toBe(true);
    const onServer = playersIn(serverWorld, Player);
    expect(onServer.map((p) => p.ownerId)).toEqual([mine.ownerId]);
    await until(() => lines.some((l) => /World "Server": connection 1 opened/.test(l)));

    // D held: the client predicts the move at once, and the server moves its player too.
    const x0 = mine.node.transform!.position.x;
    const serverX0 = onServer[0].node.transform!.position.x;
    Input.simulate("down", "d");
    await until(() => mine.node.transform!.position.x > x0 + 1 && onServer[0].node.transform!.position.x > serverX0 + 1);
    Input.simulate("up", "d");
    expect(mine.data.aimX).toBe(1);

    // Leaving removes the player.
    const engine = engines.pop()!;
    engine.dispose();
    await until(() => playersIn(serverWorld, Player).length === 0);
  });

  it("scores a hit for the shooter on the server, and both clients see the score", async () => {
    const { server, Player } = await startArena();
    const serverWorld = server.engine._world("Server")!;
    const a = await arenaClient(server);
    const b = await arenaClient(server);
    await until(() => playersIn(serverWorld, Player).length === 2 && playersIn(a, Player).length === 2 && playersIn(b, Player).length === 2);
    const [shooter, target] = playersIn(serverWorld, Player);
    // Line them up across the arena; the shooter aims at the target, the target at a wall.
    shooter.node.transform!.position.set(-3, 0, 0);
    shooter.data.aimX = 1;
    shooter.data.aimY = 0;
    target.node.transform!.position.set(3, 0, 0);
    target.data.aimX = 0;
    target.data.aimY = 1;
    await until(() => playersIn(a, Player).every((p) => Math.abs(Math.abs(p.node.transform!.position.x) - 3) < 0.05));

    // Both clients hold Space (they share the keyboard here); only the shooter's shots can hit.
    Input.simulate("down", "space");
    await until(() => shooter.data.score > 0, 5000);
    Input.simulate("up", "space");
    expect(target.data.score).toBe(0);
    // The target respawned at the spawn point farthest from the shooter.
    expect(target.node.transform!.position.x).toBeCloseTo(5.5, 3);
    // The score reaches both clients.
    await until(() => [a, b].every((w) => playersIn(w, Player).find((p) => p.ownerId === shooter.ownerId)!.data.score === shooter.data.score));
  });
});

describe("myco-server's command line", () => {
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
    expect(help.stdout).toMatch(/^Usage: myco-server <projectDir>/);
    // Loads the whole engine through the TypeScript hooks before failing on the folder.
    const bad = spawnSync(process.execPath, [cli, join(FIXTURE, "missing")], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/myco-server: There's no folder/);
  }, 20_000);
});
