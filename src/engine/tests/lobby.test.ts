import { afterEach, describe, expect, it, vi } from "vitest";
import "../../server/websocketServer"; // the Node "websocket" transport, which can listen
import { Connection, ConnectionState, Engine, Lobby, Match, defineSystem, type BootstrapConfig, type LobbyOptions, type MatchInfo } from "../index";
import { World } from "../core/World";
import { LobbyClient } from "../net/lobby/client";
import { lobbyServerOf } from "../net/lobby/server";
import { _matchOf } from "../net/lobby/match";
import { lobbyOptionProblems, resolveLobbyOptions } from "../net/lobby/protocol";
import { validateBootstrap } from "../core/settings";
import { netSession } from "../net/session";

// ADR 0068: lobbies, rooms, quick match and match Worlds, headless. Over loopback ("local") with
// several LobbyClients in one Engine, and over a real WebSocket between Engines.

const engines: Engine[] = [];
const clients: LobbyClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
  for (const e of engines.splice(0)) e.dispose();
  Lobby.disconnect();
  vi.restoreAllMocks();
});

const LOBBY: LobbyOptions = {
  matchTemplate: "Match",
  clientTemplate: "MatchClient",
  maxPlayers: 4,
  startCountdown: 0.5,
  settings: { arena: ["bay", "open", "maze"] },
  quickMatchWait: 2,
};

function bootstrap(lobby: Partial<LobbyOptions> = {}): BootstrapConfig {
  return {
    worlds: [{ name: "Menu" }],
    templates: {
      Lobby: { tags: ["server", "lobby"], lobby: { ...LOBBY, ...lobby } },
      Match: { tags: ["server", "test-match"] },
      MatchClient: { tags: ["client", "test-match"] },
    },
  };
}

async function create(config: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap: config });
  engines.push(engine);
  return engine;
}

function player(): LobbyClient {
  const c = new LobbyClient();
  clients.push(c);
  return c;
}

/** Step the Engines (and let promises settle) until `done` holds. */
async function stepUntil(list: Engine[], done: () => boolean, what = "condition", maxFrames = 2000, realWait = false): Promise<void> {
  for (let i = 0; i < maxFrames; i++) {
    if (done()) return;
    for (const e of list) e.step(1 / 60);
    await new Promise((resolve) => (realWait ? setTimeout(resolve, 2) : resolve(undefined)));
  }
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
}

function matchOf(engine: Engine, name: string): MatchInfo {
  return _matchOf(engine._world(name)!)!;
}

describe("lobby options (ADR 0068)", () => {
  it("validates a World's lobby config in the bootstrap, and fills in defaults", () => {
    expect(validateBootstrap(bootstrap())).toEqual([]);
    const problems = validateBootstrap({ worlds: [{ name: "L", tags: ["server"], lobby: { maxPlayers: 0, settings: { arena: [] }, extra: 1 } as never }] });
    expect(problems.join("\n")).toMatch(/lobby\.matchTemplate must name a server template/);
    expect(problems.join("\n")).toMatch(/maxPlayers must be a whole number from 1 to 64/);
    expect(problems.join("\n")).toMatch(/settings\.arena must be a non-empty list/);
    expect(problems.join("\n")).toMatch(/unknown key "extra"/);
    expect(lobbyOptionProblems({ matchTemplate: "M", settings: { a: { choices: ["x", "y"], default: "z" } } })).toEqual([expect.stringMatching(/default must be one of its choices/)]);
    const o = resolveLobbyOptions({ matchTemplate: "M", settings: { a: { choices: ["x", "y"], default: "y" } } });
    expect(o).toMatchObject({ maxPlayers: 8, minPlayers: 1, fillWithBots: false, startCountdown: 3, quickMatchWait: 10, joinTimeout: 30, settings: { a: ["y", "x"] } });
  });
});

describe("lobby over loopback (ADR 0068)", () => {
  it("quick match puts two players in one room; ready-up counts down and starts a match both join; end() brings them back with results", async () => {
    const engine = await create(bootstrap());
    const a = player();
    const b = player();
    a.connect("local", { name: "Anne" });
    b.connect("local", { name: "Bart" });
    expect(a.state).toBe("connecting");
    await stepUntil([engine], () => a.state === "lobby" && b.state === "lobby", "both in the lobby");
    expect(engine.findWorld("Lobby")).not.toBeNull(); // made from the template with "lobby"
    expect(engine.findWorld("Lobby Client")!.tags).toEqual(["lobby-client"]);

    a.quickMatch({ arena: "open" });
    await stepUntil([engine], () => a.state === "room", "Anne in a room");
    expect(a.room).toMatchObject({ name: "Quick match", public: true, quick: true, settings: { arena: "open" }, state: "waiting" });
    expect(a.me).toEqual({ slot: 0, host: true, name: "Anne" });
    b.quickMatch({ arena: "open" });
    await stepUntil([engine], () => b.state === "room" && a.room?.members.length === 2, "Bart in Anne's room");
    expect(b.room!.code).toBe(a.room!.code);
    expect(b.me).toEqual({ slot: 1, host: false, name: "Bart" });
    expect(a.rooms).toEqual([{ code: a.room!.code, name: "Quick match", members: 2, maxPlayers: 4, state: "waiting", settings: { arena: "open" } }]);

    a.setReady(true);
    b.setReady(true);
    await stepUntil([engine], () => a.state === "starting", "the countdown");
    expect(a.room!.state).toBe("countdown");
    expect(a.room!.countdown).toBe(1); // 0.5 s, in whole seconds rounded up
    await stepUntil([engine], () => a.state === "match" && b.state === "match", "the match");
    const server = engine.findWorld("Match 1")!;
    expect(server.tags).toEqual(["server", "test-match"]);
    expect(server.addresses()).toEqual([expect.stringMatching(/\/match\/1$/)]);
    expect(a.matchWorld!.name).toBe("Match 1 Client");
    expect(b.matchWorld!.name).toBe("Match 1 Client 2");
    expect(engine.findWorld("Menu")!.paused).toBe(true); // the page's rendering World waits
    // ...having handed the view, and input with it, to the match client Worlds (hot-seat: the last one has it).
    const view = (name: string) => engine._viewStates().find((v) => v.name === name)!;
    expect(view("Menu")).toMatchObject({ mainView: false, takesInput: false, viewHanded: true });
    expect(view("Match 1 Client 2")).toMatchObject({ mainView: true, takesInput: true });

    const match = matchOf(engine, "Match 1");
    await stepUntil([engine], () => match.players.every((p) => p.connectionId > 0), "both players' connections");
    expect(match.players.map((p) => [p.slot, p.name, p.bot])).toEqual([
      [0, "Anne", false],
      [1, "Bart", false],
    ]);
    expect(match.settings).toEqual({ arena: "open" });
    expect(match.roomId).toBe(a.room!.id);
    // Match.current in the match World's own code.
    let seen: MatchInfo | null = null;
    World._runIn(engine._world("Match 1")!, () => (seen = Match.current));
    expect(seen).toBe(match);
    expect(Match.current).toBeNull(); // the Menu isn't a match World
    // Connection ids match the client Worlds' own connection ids.
    const ids = [a.matchWorld!, b.matchWorld!].map((h) => netSession(engine._world(h.name)!)!.serverPeer!.id);
    expect(match.players.map((p) => p.connectionId)).toEqual(ids);

    match.end({ winner: "Bart" });
    await stepUntil([engine], () => a.state === "room" && b.state === "room", "back in the room");
    expect(engine.findWorld("Match 1")).toBeNull();
    expect(a.matchWorld).toBeNull();
    expect(engine.findWorld("Match 1 Client")).toBeNull();
    expect(a.room!.results).toEqual({ winner: "Bart" });
    expect(a.room!.members.every((m) => !m.ready)).toBe(true);
    expect(engine.findWorld("Menu")!.paused).toBe(false);
    expect(view("Menu")).toMatchObject({ mainView: true, takesInput: true, viewHanded: false }); // and has the view back
  });

  it("private rooms by code, host settings, kicking, host hand-over and refusals with reasons", async () => {
    const engine = await create(bootstrap());
    const a = player();
    const b = player();
    const c = player();
    for (const [p, name] of [[a, "Anne"], [b, "Bart"], [c, "Cleo"]] as const) p.connect("local", { name });
    await stepUntil([engine], () => [a, b, c].every((p) => p.state === "lobby"), "everyone in the lobby");

    a.createRoom({ name: "Anne's cove", public: false, settings: { arena: "maze" } });
    await stepUntil([engine], () => a.state === "room", "Anne's room");
    expect(a.room).toMatchObject({ name: "Anne's cove", public: false, settings: { arena: "maze" } });
    expect(a.room!.code).toMatch(/^[A-Z]{5}$/);
    expect(b.rooms).toEqual([]); // private rooms aren't listed

    b.joinRoom("ZZZZZ");
    await stepUntil([engine], () => b.error !== "", "a refusal");
    expect(b.error).toMatch(/no room with the code "ZZZZZ"/);
    b.joinRoom(a.room!.code.toLowerCase());
    c.joinRoom(a.room!.code);
    await stepUntil([engine], () => a.room?.members.length === 3, "three members");

    b.setSetting("arena", "bay");
    await stepUntil([engine], () => /Only the room's host/.test(b.error), "not the host");
    a.setSetting("arena", "volcano");
    await stepUntil([engine], () => /isn't allowed for "arena"/.test(a.error), "a bad value");
    a.setSetting("arena", "bay");
    await stepUntil([engine], () => c.room?.settings.arena === "bay", "the new setting");

    a.kick(2);
    await stepUntil([engine], () => c.state === "lobby", "Cleo kicked");
    expect(c.error).toMatch(/kicked/);
    expect(a.room!.members.map((m) => m.name)).toEqual(["Anne", "Bart"]);

    a.leaveRoom();
    await stepUntil([engine], () => b.me?.host === true, "Bart hosts");
    expect(b.room!.hostSlot).toBe(1);
    expect(a.state).toBe("lobby");
  });

  it("the host starts early; a quick-match room fills its empty slots with bots after quickMatchWait", async () => {
    const engine = await create(bootstrap({ fillWithBots: true, quickMatchWait: 1, minPlayers: 2 }));
    const a = player();
    a.connect("local", { name: "Anne" });
    await stepUntil([engine], () => a.state === "lobby", "lobby");
    a.createRoom({ name: "Solo" });
    await stepUntil([engine], () => a.state === "room", "room");
    a.start();
    await stepUntil([engine], () => /at least 2 players/.test(a.error), "minPlayers refusal");
    a.leaveRoom();

    a.quickMatch();
    await stepUntil([engine], () => a.state === "room", "quick room");
    const startedAt = engine._world("Lobby")!.time.realtimeSinceStartup;
    await stepUntil([engine], () => a.state === "match", "the quick match");
    expect(engine._world("Lobby")!.time.realtimeSinceStartup - startedAt).toBeGreaterThanOrEqual(0.95);
    const match = matchOf(engine, "Match 1");
    expect(match.players.map((p) => p.bot)).toEqual([false, true, true, true]);
    expect(match.players[1]).toMatchObject({ slot: 1, name: "", connectionId: 0 });
    match.players[1].name = "Captain Hook"; // the game names its bots
    expect(match.players[1].name).toBe("Captain Hook");
    expect(match.settings).toEqual({ arena: "bay" }); // the default

    // When it ends, Anne is back in the room, and it stays there: a quick room starts only its
    // first match on its own (it used to start another at once, its timer long run out).
    match.end({ winner: "Anne" });
    await stepUntil([engine], () => a.state === "room" && a.room?.state === "waiting", "back in the room");
    expect(a.room).toMatchObject({ quick: false, results: { winner: "Anne" } });
    const backAt = engine._world("Lobby")!.time.realtimeSinceStartup;
    await stepUntil([engine], () => engine._world("Lobby")!.time.realtimeSinceStartup - backAt > 2, "longer than quickMatchWait");
    expect(a.state).toBe("room");
    expect(engine.findWorld("Match 2")).toBeNull();
  });

  it("a match admits only ticketed connections, once; it ends when every player has left, or nobody joins in time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(bootstrap({ joinTimeout: 1 }));
    const a = player();
    a.connect("local", { name: "Anne" });
    await stepUntil([engine], () => a.state === "lobby", "lobby");
    a.createRoom();
    await stepUntil([engine], () => a.state === "room", "room");
    a.setReady(true);
    await stepUntil([engine], () => a.state === "match", "match");
    const address = engine.findWorld("Match 1")!.addresses()[0];

    // A World without a ticket is refused, with the reason.
    const stranger = engine.createWorld({ name: "Stranger", tags: ["client"] });
    stranger.connect(address, "loopback");
    const strangerSession = netSession(engine._world("Stranger")!)!;
    await stepUntil([engine], () => strangerSession.closed.length > 0, "the refusal");
    expect(strangerSession.closed[0].reason).toMatch(/only admits players with a ticket/);

    const match = matchOf(engine, "Match 1");
    await stepUntil([engine], () => match.players[0].connectionId > 0, "Anne joins");
    a.leaveMatch();
    expect(a.state).toBe("room");
    await stepUntil([engine], () => a.room?.state === "waiting" && engine.findWorld("Match 1") === null, "the match ending");
    expect(a.room!.results).toEqual({ reason: "Every player left." });

    // Nobody joins: Anne's page fails to make the match client World (no such template).
    const lobby = lobbyServerOf(engine._world("Lobby")!)!;
    (lobby.options as { clientTemplate: string }).clientTemplate = "Nope";
    a.setReady(true);
    await stepUntil([engine], () => engine.findWorld("Match 2") !== null, "match 2");
    await stepUntil([engine], () => engine.findWorld("Match 2") === null, "match 2 timing out");
    expect(a.error).toMatch(/template "Nope"/);
    expect(a.room!.results).toEqual({ reason: "No player joined within 1 s." });
  });

  it("the page-wide Lobby works from a World's code, and goes offline when its Engine goes", async () => {
    const engine = await create(bootstrap());
    World._runIn(engine._world("Menu")!, () => Lobby.connect("local", { name: "Pat" }));
    await stepUntil([engine], () => Lobby.state === "lobby", "lobby");
    Lobby.quickMatch();
    await stepUntil([engine], () => Lobby.state === "room", "room");
    expect(Lobby.me).toMatchObject({ name: "Pat", host: true });
    engine.dispose();
    engines.splice(engines.indexOf(engine), 1);
    expect(Lobby.state).toBe("offline");
    expect(Lobby.room).toBeNull();
  });

  it("game systems in client Worlds don't run in the hidden lobby World", async () => {
    const ran: string[] = [];
    defineSystem({ name: "test.lobby.clientSystem", phase: "update", worlds: ["client"], run: (_rows, ctx) => void ran.push(ctx.world.name) });
    const engine = await create(bootstrap());
    const a = player();
    a.connect("local", { name: "Anne" });
    await stepUntil([engine], () => a.state === "lobby", "lobby");
    expect(ran).not.toContain("Lobby Client");
  });
});

describe("lobby over WebSocket (ADR 0067, 0068)", () => {
  it("players in other Engines join a lobby by URL, and their match shares the lobby's port by path", async () => {
    const host = await create({ ...bootstrap(), worlds: [{ name: "Lobby", tags: ["server", "lobby"], lobby: LOBBY }] });
    const url = await host.findWorld("Lobby")!.listen("websocket", { address: "ws://127.0.0.1:0" });
    const port = new URL(url).port;
    const pages = [await create(bootstrap()), await create(bootstrap())];
    const [a, b] = [player(), player()];
    World._runIn(pages[0].world, () => a.connect(url, { name: "Anne" }));
    World._runIn(pages[1].world, () => b.connect(url, { name: "Bart" }));
    const all = [host, ...pages];
    await stepUntil(all, () => a.state === "lobby" && b.state === "lobby", "both in the lobby", 3000, true);
    a.createRoom({ name: "Net" });
    await stepUntil(all, () => a.state === "room", "room", 3000, true);
    b.joinRoom(a.room!.code);
    await stepUntil(all, () => a.room?.members.length === 2, "two members", 3000, true);
    a.setReady(true);
    b.setReady(true);
    await stepUntil(all, () => a.state === "match" && b.state === "match", "the match", 3000, true);

    const matchAddress = host.findWorld("Match 1")!.addresses()[0];
    expect(matchAddress).toBe(`ws://127.0.0.1:${port}/match/1`);
    const match = matchOf(host, "Match 1");
    await stepUntil(all, () => match.players.every((p) => p.connectionId > 0), "both connected to the match", 3000, true);
    // The server counts a player connected when it accepts the handshake; the client's Connection opens
    // when the accept arrives over the socket, a moment later.
    const clientWorld = pages[0]._world(a.matchWorld!.name)!;
    const clientState = () => ([...clientWorld._query([Connection])][0]?.connection as { state: number } | undefined)?.state;
    await stepUntil(all, () => clientState() === ConnectionState.open, "Anne's match connection to open", 3000, true);

    match.end({ winner: "Anne" });
    await stepUntil(all, () => a.state === "room" && b.state === "room", "back in the room", 3000, true);
    expect(b.room!.results).toEqual({ winner: "Anne" });
  });
});
