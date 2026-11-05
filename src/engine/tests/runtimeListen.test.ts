import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import "../../server/websocketServer"; // the Node "websocket" transport, which can listen
import { Assets, Connection, ConnectionState, Engine, GameBehavior, GameObject, Replicated, behavior, defineComponent, defineInput, defineRpc, defineSystem, field, i32, str, type BootstrapConfig } from "../index";
import { World } from "../core/World";
import { WebSocketTransport } from "../net/transport/websocket";
import { NodeWebSocketTransport, _sharedServers } from "../../server/websocketServer";
import { netSession } from "../net/session";

// ADR 0067: WorldHandle.listen at runtime, several Worlds on one WebSocket port by path.
// ADR 0068 (strings): `str` RPC fields and replicated String behavior fields.

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

async function stepUntil(list: Engine[], done: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    for (const e of list) e.step(1 / 60);
  }
}

function connectionStates(w: World): number[] {
  return [...w._query([Connection])].map((row) => (row.connection as { state: number }).state);
}

/** The HTTP status a WebSocket upgrade request to `url` gets. */
function upgradeStatus(url: string): Promise<number> {
  const u = new URL(url.replace(/^ws/, "http"));
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("WorldHandle.listen (ADR 0067)", () => {
  it("makes a World created at runtime a loopback server; a path makes the address unique", async () => {
    const engine = await create({ worlds: [{ name: "Menu" }] });
    const match = engine.createWorld({ name: "Match 3", tags: ["server"] });
    expect(match.addresses()).toEqual([]);
    const address = await match.listen("loopback", { path: "/match/3" });
    expect(address).toMatch(/^engine-\d+\/match\/3$/);
    expect(match.addresses()).toEqual([address]);
    expect(() => match.listen("loopback", { path: "/match/3" })).toThrow(/already listens over "loopback"/);
    await expect(match.listen("pigeon", { port: 1 })).rejects.toThrow(/no transport "pigeon"/);

    engine.findWorld("Menu")!.connect(address, "loopback");
    for (let i = 0; i < 5; i++) engine.step(1 / 60);
    expect(connectionStates(engine._world("Menu")!)).toEqual([ConnectionState.open]);
    expect(() => engine.findWorld("Menu")!.listen("loopback")).toThrow(/is a network client/);
    match.destroy();
    expect(match.addresses()).toEqual([]);
  });

  it("rejects a WebSocket listen with no port, and in the browser transport", async () => {
    const engine = await create({ worlds: [{ name: "Server", tags: ["server"] }] });
    await expect(engine.findWorld("Server")!.listen("websocket")).rejects.toThrow(/without an address/);
    await expect(new WebSocketTransport().listen("ws://0.0.0.0:7777")).rejects.toThrow(/can only connect/);
  });

  it("shares one WebSocket port between Worlds by path, refuses unknown paths with 404, and closes the port with its last World", async () => {
    const engine = await create({ worlds: [{ name: "Lobby", tags: ["server"] }] });
    const lobbyUrl = await engine.findWorld("Lobby")!.listen("websocket", { address: "ws://127.0.0.1:0" });
    const port = Number(new URL(lobbyUrl).port);
    const m1 = engine.createWorld({ name: "Match 1", tags: ["server"] });
    const m2 = engine.createWorld({ name: "Match 2", tags: ["server"] });
    const u1 = await m1.listen("websocket", { host: "127.0.0.1", port, path: "/match/1" });
    const u2 = await m2.listen("websocket", { address: `ws://127.0.0.1:${port}/match/2` });
    expect(u1).toBe(`ws://127.0.0.1:${port}/match/1`);
    expect(u2).toBe(`ws://127.0.0.1:${port}/match/2`);
    expect(_sharedServers().filter((s) => s.key.includes(`:${port}`))).toEqual([{ key: expect.stringContaining(`127.0.0.1:${port}`), paths: ["/", "/match/1", "/match/2"] }]);
    // The same path twice is refused.
    const m3 = engine.createWorld({ name: "Match 3", tags: ["server"] });
    await expect(m3.listen("websocket", { host: "127.0.0.1", port, path: "/match/1" })).rejects.toThrow(/already listened on/);

    // Clients in another Engine reach each World by its path.
    const players = await create({ worlds: [{ name: "P0", tags: ["client"] }, { name: "P1", tags: ["client"] }, { name: "P2", tags: ["client"] }] });
    players.findWorld("P0")!.connect(lobbyUrl, "websocket");
    players.findWorld("P1")!.connect(u1, "websocket");
    players.findWorld("P2")!.connect(`${u2}?token=x`, "websocket"); // the query doesn't matter
    const servers = ["Lobby", "Match 1", "Match 2"].map((n) => engine._world(n)!);
    await stepUntil([engine, players], () => servers.every((w) => netSession(w)!.openPeers().length === 1) && ["P0", "P1", "P2"].every((n) => connectionStates(players._world(n)!)[0] === ConnectionState.open), "one client on each World");
    expect(["P0", "P1", "P2"].map((n) => connectionStates(players._world(n)!))).toEqual([[ConnectionState.open], [ConnectionState.open], [ConnectionState.open]]);

    expect(await upgradeStatus(`ws://127.0.0.1:${port}/match/9`)).toBe(404);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/match/1`)).toBe(101);

    // A World's going frees its path; the port closes with the last one.
    m1.destroy();
    engine.step(1 / 60);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/match/1`)).toBe(404);
    m2.destroy();
    m3.destroy();
    engine.dispose();
    engines.splice(engines.indexOf(engine), 1);
    expect(_sharedServers().filter((s) => s.key.includes(`:${port}`))).toEqual([]);
    await expect(upgradeStatus(`ws://127.0.0.1:${port}/`)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("a lone listener at / still accepts any path (as before 0067)", async () => {
    const s = new NodeWebSocketTransport();
    try {
      await s.listen("ws://127.0.0.1:0");
      expect(await upgradeStatus(`${s.address!.url}/anything`)).toBe(101);
    } finally {
      s.close();
    }
  });
});

// --- strings (ADR 0068) -------------------------------------------------------------------------

const Chat = defineRpc("test.strings.Chat", { team: i32, text: str, from: str });

@behavior("test.strings.Nameplate")
class Nameplate extends GameBehavior {
  @field(String, { replicate: true }) label = "";
  @field(String) local = "mine"; // not replicated
  @field(Number, { replicate: true }) n = 0;
}

Assets.addSource(
  Assets.fromObject({
    "prefabs/test-strings-ship.json": {
      format: "myco.scene@1",
      nodes: [{ id: "ship", name: "Ship", components: [{ type: "net.Replicated" }, { type: "test.strings.Nameplate" }] }],
    },
  }),
);

describe("strings on the wire (ADR 0068)", () => {
  const linked: BootstrapConfig = {
    worlds: [
      { name: "Client", tags: ["client", "strings-client"] },
      { name: "Server", tags: ["server", "strings-server"] },
    ],
    links: [{ from: "Client", to: "Server", transport: "loopback" }],
  };

  it("sends str RPC fields as UTF-8, capped at 255 bytes", async () => {
    const got: { team: number; text: string; from: string }[] = [];
    defineSystem({ name: "test.strings.read", phase: "update", worlds: ["strings-server"], run: () => void got.push(...[...Chat.read()].map(({ team, text, from }) => ({ team, text, from }))) });
    const engine = await create(linked);
    for (let i = 0; i < 5; i++) engine.step(1 / 60);
    const client = engine._world("Client")!;
    World._runIn(client, () => Chat.send({ team: 2, text: "Ahoy, ⚓ mateys!", from: "" }));
    for (let i = 0; i < 3; i++) engine.step(1 / 60);
    expect(got).toEqual([{ team: 2, text: "Ahoy, ⚓ mateys!", from: "" }]);
    expect(() => World._runIn(client, () => Chat.send({ team: 1, text: "x".repeat(256), from: "" }))).toThrow(/256 bytes of UTF-8; str fields hold at most 255/);
    expect(() => World._runIn(client, () => Chat.send({ team: 1, text: 5 as never, from: "" }))).toThrow(/field "text" must be a string/);
  });

  it("str isn't allowed in data components or inputs", () => {
    expect(() => defineComponent("test.strings.Bad", { name: str } as never)).toThrow(/strings are for RPCs only/);
    expect(() => defineInput("test.strings.BadInput", { name: str } as never)).toThrow(/inputs hold numbers/);
  });

  it("replicates String behavior fields whole when they change", async () => {
    const engine = await create(linked);
    for (let i = 0; i < 5; i++) engine.step(1 / 60);
    const server = engine._world("Server")!;
    const client = engine._world("Client")!;
    const ship = World._runIn(server, () => GameObject.instantiate("prefabs/test-strings-ship.json"));
    const plate = ship.getBehavior(Nameplate)!;
    plate.label = "Black Pearl";
    plate.local = "server only";
    plate.n = 3;
    const ghost = () => client._componentsOfType(Replicated).find((r) => r.isGhost)?.node.getBehavior(Nameplate) ?? null;
    for (let i = 0; i < 20 && ghost()?.label !== "Black Pearl"; i++) engine.step(1 / 60);
    expect(ghost()).toMatchObject({ label: "Black Pearl", local: "mine", n: 3 });

    const sent = () => netSession(server)!.openPeers()[0].sent.byKind.get("net.ghostStrings")?.messages ?? 0;
    const before = sent();
    for (let i = 0; i < 10; i++) engine.step(1 / 60);
    expect(sent()).toBe(before); // unchanged: nothing more sent
    plate.label = "Flying Dutchman";
    for (let i = 0; i < 5; i++) engine.step(1 / 60);
    expect(ghost()!.label).toBe("Flying Dutchman");
    expect(sent()).toBe(before + 1);
  });
});
