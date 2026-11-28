import { afterEach, describe, expect, it, vi } from "vitest";
import "../../server/websocketServer"; // the Node "websocket" transport, which can listen
import { Engine, Lobby, Match, defineSystem, type BootstrapConfig, type LobbyOptions, type MatchInfo } from "../index";
import { World } from "../core/World";
import { lobbyServerOf } from "../net/lobby/server";
import { _matchOf } from "../net/lobby/match";
import { lobbyOptionProblems, resolveLobbyOptions } from "../net/lobby/protocol";
import { validateBootstrap } from "../core/settings";
import { netSession } from "../net/session";

// ADR 0068: lobbies, rooms, quick match and match Worlds, headless. One player plays from this
// page's `Lobby` over loopback ("local"). Several players are pages of their own (the engine
// imported afresh, so each has its own page-wide `Lobby`, as in production) that join a lobby World
// in another Engine by URL over a real WebSocket.

const engines: Engine[] = [];
const pages: Page[] = [];
afterEach(() => {
  for (const p of pages.splice(0)) {
    p.Lobby.disconnect();
    p.engine.dispose();
  }
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

/** An Engine running a lobby World that listens over WebSocket, and its URL. */
async function lobbyHost(): Promise<{ host: Engine; url: string }> {
  const host = await create({ ...bootstrap(), worlds: [{ name: "Lobby", tags: ["server", "lobby"], lobby: LOBBY }] });
  const url = await host.findWorld("Lobby")!.listen("websocket", { address: "ws://127.0.0.1:0" });
  return { host, url };
}

/** A player's page: the engine imported afresh, with its own page-wide `Lobby`. */
interface Page {
  readonly engine: Engine;
  readonly Lobby: typeof Lobby;
  /** The page's own engine module. */
  readonly api: typeof import("../index");
  /** The page's own network session of a World (its module copy). */
  readonly netSession: typeof netSession;
  /** Connect the page's `Lobby` from its World's code, as its menu would. */
  connect(address: string, name: string): void;
}

async function page(): Promise<Page> {
  vi.resetModules();
  await import("../../server/websocketServer");
  const myco = await import("../index");
  const { World: PageWorld } = await import("../core/World");
  const session = await import("../net/session");
  const engine = await myco.Engine.create({ headless: true, bootstrap: bootstrap() });
  const p: Page = {
    engine: engine as unknown as Engine,
    Lobby: myco.Lobby as unknown as typeof Lobby,
    api: myco,
    netSession: session.netSession as unknown as typeof netSession,
    connect: (address, name) => PageWorld._runIn(engine.world, () => myco.Lobby.connect(address, { name })),
  };
  pages.push(p);
  return p;
}

/** This page's `Lobby`, connected to its own lobby World over loopback from the Menu's code. */
function playLocal(engine: Engine, name: string): typeof Lobby {
  World._runIn(engine._world("Menu")!, () => Lobby.connect("local", { name }));
  return Lobby;
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

/** Step the host and every page, over the network, until `done` holds. */
function netUntil(host: Engine, done: () => boolean, what: string): Promise<void> {
  return stepUntil([host, ...pages.map((p) => p.engine)], done, what, 3000, true);
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

  it("reports a lobby no dedicated server would run (ADR 0281)", () => {
    const untagged = validateBootstrap({ worlds: [{ name: "Menu" }], templates: { Lobby: { tags: ["lobby"], lobby: LOBBY } } });
    expect(untagged).toEqual([expect.stringMatching(/templates\["Lobby"\]: a World with a "lobby" config must be tagged "server"/)]);
    const unstarted = validateBootstrap({ worlds: [{ name: "Game", tags: ["server"] }], templates: { Lobby: { tags: ["server"], lobby: LOBBY } } });
    expect(unstarted).toEqual([expect.stringMatching(/a dedicated server never starts this lobby/)]);
  });
});

// ADR 0281: Lobby.connect("local") runs the lobby the dedicated server would, from the declared bootstrap.
describe("a local lobby agrees with the dedicated server (ADR 0281)", () => {
  it("refuses a lobby template the server wouldn't start, saying why, even under a code bootstrap", async () => {
    const engine = await Engine.create({
      headless: true,
      // The templates are project.json's (the declared bootstrap), the Worlds the code bootstrap's.
      project: { bootstrap: { worlds: [{ name: "Menu" }], templates: { Lobby: { tags: ["lobby"], lobby: LOBBY }, Match: { tags: ["server"] } } } },
      bootstrap: (e) => void e.createWorld({ name: "Menu" }),
    });
    engines.push(engine);
    World._runIn(engine.world, () => Lobby.connect("local", { name: "Pat" }));
    expect(Lobby.state).toBe("offline");
    expect(Lobby.error).toMatch(/templates\["Lobby"\]: a World with a "lobby" config must be tagged "server"/);
    expect(engine.worlds().map((w) => w.name)).toEqual(["Menu"]);
  });

  it("runs the server-tagged lobby template under a code bootstrap", async () => {
    const engine = await Engine.create({
      headless: true,
      project: { bootstrap: bootstrap() },
      bootstrap: (e) => void e.createWorld({ name: "Menu" }),
    });
    engines.push(engine);
    World._runIn(engine.world, () => Lobby.connect("local", { name: "Pat" }));
    await stepUntil([engine], () => Lobby.state === "lobby", "lobby");
    expect(engine.findWorld("Lobby")?.tags).toEqual(["server", "lobby"]);
  });
});

// A page's fresh engine import takes a few seconds.
describe("lobby with several players, each in a page of their own (ADR 0067, 0068)", { timeout: 30_000 }, () => {
  it("quick match puts two players in one room; ready-up counts down and starts a match both join; end() brings them back with results", async () => {
    const { host, url } = await lobbyHost();
    const [anne, bart] = [await page(), await page()];
    const [a, b] = [anne.Lobby, bart.Lobby];
    anne.connect(url, "Anne");
    bart.connect(url, "Bart");
    expect(a.state).toBe("connecting");
    await netUntil(host, () => a.state === "lobby" && b.state === "lobby", "both in the lobby");
    expect(anne.engine.findWorld("Lobby Client")!.tags).toEqual(["lobby-client"]);

    a.quickMatch({ arena: "open" });
    await netUntil(host, () => a.state === "room", "Anne in a room");
    expect(a.room).toMatchObject({ name: "Quick match", public: true, quick: true, settings: { arena: "open" }, state: "waiting" });
    expect(a.me).toEqual({ slot: 0, host: true, name: "Anne" });
    b.quickMatch({ arena: "open" });
    await netUntil(host, () => b.state === "room" && a.room?.members.length === 2, "Bart in Anne's room");
    expect(b.room!.code).toBe(a.room!.code);
    expect(b.me).toEqual({ slot: 1, host: false, name: "Bart" });
    expect(a.rooms).toEqual([{ code: a.room!.code, name: "Quick match", members: 2, maxPlayers: 4, state: "waiting", settings: { arena: "open" } }]);

    a.setReady(true);
    b.setReady(true);
    await netUntil(host, () => a.state === "starting", "the countdown");
    expect(a.room!.state).toBe("countdown");
    expect(a.room!.countdown).toBe(1); // 0.5 s, in whole seconds rounded up
    await netUntil(host, () => a.state === "match" && b.state === "match", "the match");
    const server = host.findWorld("Match 1")!;
    expect(server.tags).toEqual(["server", "test-match"]);
    expect(server.addresses()).toEqual([expect.stringMatching(/\/match\/1$/)]);
    for (const p of [anne, bart]) {
      expect(p.Lobby.matchWorld!.name).toBe("Match 1 Client");
      expect(p.engine.findWorld("Menu")!.paused).toBe(true); // the page's rendering World waits
      // ...having handed the view, and input with it, to the match client World.
      const view = (name: string) => p.engine._viewStates().find((v) => v.name === name)!;
      expect(view("Menu")).toMatchObject({ mainView: false, takesInput: false, viewHanded: true });
      expect(view("Match 1 Client")).toMatchObject({ mainView: true, takesInput: true });
    }

    const match = matchOf(host, "Match 1");
    await netUntil(host, () => match.players.every((p) => p.connectionId > 0), "both players' connections");
    expect(match.players.map((p) => [p.slot, p.name, p.bot])).toEqual([
      [0, "Anne", false],
      [1, "Bart", false],
    ]);
    expect(match.settings).toEqual({ arena: "open" });
    expect(match.roomId).toBe(a.room!.id);
    // Match.current in the match World's own code.
    let seen: MatchInfo | null = null;
    World._runIn(host._world("Match 1")!, () => (seen = Match.current));
    expect(seen).toBe(match);
    expect(Match.current).toBeNull(); // outside a match World

    match.end({ winner: "Bart" });
    await netUntil(host, () => a.state === "room" && b.state === "room", "back in the room");
    expect(host.findWorld("Match 1")).toBeNull();
    expect(a.matchWorld).toBeNull();
    expect(anne.engine.findWorld("Match 1 Client")).toBeNull();
    expect(a.room!.results).toEqual({ winner: "Bart" });
    expect(a.room!.members.every((m) => !m.ready)).toBe(true);
    expect(anne.engine.findWorld("Menu")!.paused).toBe(false);
    expect(anne.engine._viewStates().find((v) => v.name === "Menu")).toMatchObject({ mainView: true, takesInput: true, viewHanded: false }); // and has the view back
  });

  it("a quick-match room stops its own timer once a member readies up, and waits for the others", async () => {
    const { host, url } = await lobbyHost();
    const [anne, bart] = [await page(), await page()];
    const [a, b] = [anne.Lobby, bart.Lobby];
    anne.connect(url, "Anne");
    bart.connect(url, "Bart");
    await netUntil(host, () => a.state === "lobby" && b.state === "lobby", "both in the lobby");
    a.quickMatch();
    await netUntil(host, () => a.state === "room" && a.room?.quick === true, "Anne in a quick room");
    b.quickMatch();
    await netUntil(host, () => b.state === "room" && a.room?.members.length === 2, "Bart in Anne's room");
    b.setReady(true);
    await netUntil(host, () => a.room?.quick === false, "an ordinary room");
    const lobbyTime = () => host._world("Lobby")!.time.realtimeSinceStartup;
    const since = lobbyTime();
    await netUntil(host, () => lobbyTime() - since > LOBBY.quickMatchWait! + 0.5, "longer than quickMatchWait");
    expect(a.room?.state).toBe("waiting");
    expect(host.findWorld("Match 1")).toBeNull();
    a.setReady(true); // now everyone's ready: it counts down and starts
    await netUntil(host, () => a.state === "match" && b.state === "match", "the match");
  });

  it("private rooms by code, host settings, kicking, host hand-over and refusals with reasons", async () => {
    const { host, url } = await lobbyHost();
    const players: (typeof Lobby)[] = [];
    for (const name of ["Anne", "Bart", "Cleo"]) {
      const p = await page();
      p.connect(url, name);
      players.push(p.Lobby);
    }
    const [a, b, c] = players;
    await netUntil(host, () => [a, b, c].every((p) => p.state === "lobby"), "everyone in the lobby");

    a.createRoom({ name: "Anne's cove", public: false, settings: { arena: "maze" } });
    await netUntil(host, () => a.state === "room", "Anne's room");
    expect(a.room).toMatchObject({ name: "Anne's cove", public: false, settings: { arena: "maze" } });
    expect(a.room!.code).toMatch(/^[A-Z]{5}$/);
    expect(b.rooms).toEqual([]); // private rooms aren't listed

    b.joinRoom("ZZZZZ");
    await netUntil(host, () => b.error !== "", "a refusal");
    expect(b.error).toMatch(/no room with the code "ZZZZZ"/);
    b.joinRoom(a.room!.code.toLowerCase());
    await netUntil(host, () => a.room?.members.length === 2, "two members");
    c.joinRoom(a.room!.code);
    await netUntil(host, () => a.room?.members.length === 3, "three members");

    b.setSetting("arena", "bay");
    await netUntil(host, () => /Only the room's host/.test(b.error), "not the host");
    a.setSetting("arena", "volcano");
    await netUntil(host, () => /isn't allowed for "arena"/.test(a.error), "a bad value");
    a.setSetting("arena", "bay");
    await netUntil(host, () => c.room?.settings.arena === "bay", "the new setting");

    a.kick(2);
    await netUntil(host, () => c.state === "lobby", "Cleo kicked");
    expect(c.error).toMatch(/kicked/);
    expect(a.room!.members.map((m) => m.name)).toEqual(["Anne", "Bart"]);

    a.leaveRoom();
    await netUntil(host, () => b.me?.host === true, "Bart hosts");
    expect(b.room!.hostSlot).toBe(1);
    expect(a.state).toBe("lobby");
  });

  it("players in other Engines join a lobby by URL, and their match shares the lobby's port by path", async () => {
    const { host, url } = await lobbyHost();
    const port = new URL(url).port;
    const [anne, bart] = [await page(), await page()];
    const [a, b] = [anne.Lobby, bart.Lobby];
    anne.connect(url, "Anne");
    bart.connect(url, "Bart");
    await netUntil(host, () => a.state === "lobby" && b.state === "lobby", "both in the lobby");
    a.createRoom({ name: "Net" });
    await netUntil(host, () => a.state === "room", "room");
    b.joinRoom(a.room!.code);
    await netUntil(host, () => a.room?.members.length === 2, "two members");
    a.setReady(true);
    b.setReady(true);
    await netUntil(host, () => a.state === "match" && b.state === "match", "the match");

    const matchAddress = host.findWorld("Match 1")!.addresses()[0];
    expect(matchAddress).toBe(`ws://127.0.0.1:${port}/match/1`);
    const match = matchOf(host, "Match 1");
    await netUntil(host, () => match.players.every((p) => p.connectionId > 0), "both connected to the match");
    // The server counts a player connected when it accepts the handshake; the client's Connection opens
    // when the accept arrives over the socket, a moment later.
    const clientWorld = anne.engine._world(a.matchWorld!.name)!;
    const clientState = () => ([...clientWorld._query([anne.api.Connection as never])][0]?.connection as { state: number } | undefined)?.state;
    await netUntil(host, () => clientState() === anne.api.ConnectionState.open, "Anne's match connection to open");

    match.end({ winner: "Anne" });
    await netUntil(host, () => a.state === "room" && b.state === "room", "back in the room");
    expect(b.room!.results).toEqual({ winner: "Anne" });
  });
});

describe("lobby over loopback (ADR 0068)", () => {
  it("the host starts early; a quick-match room fills its empty slots with bots after quickMatchWait", async () => {
    const engine = await create(bootstrap({ fillWithBots: true, quickMatchWait: 1, minPlayers: 2 }));
    const a = playLocal(engine, "Anne");
    await stepUntil([engine], () => a.state === "lobby", "lobby");
    expect(engine.findWorld("Lobby")).not.toBeNull(); // made from the template with "lobby"
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
    // Connection ids match the client World's own connection id.
    await stepUntil([engine], () => match.players[0].connectionId > 0, "Anne's connection");
    expect(match.players[0].connectionId).toBe(netSession(engine._world(a.matchWorld!.name)!)!.serverPeer!.id);

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

  it("a quick-match room stops its own timer once the host picks a setting", async () => {
    const engine = await create(bootstrap({ fillWithBots: true, quickMatchWait: 2, minPlayers: 1 }));
    const a = playLocal(engine, "Anne");
    await stepUntil([engine], () => a.state === "lobby", "lobby");
    const lobbyTime = () => engine._world("Lobby")!.time.realtimeSinceStartup;

    a.quickMatch();
    await stepUntil([engine], () => a.state === "room" && a.room?.quick === true, "quick room");
    a.setSetting("arena", "maze");
    await stepUntil([engine], () => a.room?.quick === false, "an ordinary room");
    let since = lobbyTime();
    await stepUntil([engine], () => lobbyTime() - since > 3, "longer than quickMatchWait");
    expect(a.state).toBe("room");
    expect(engine.findWorld("Match 1")).toBeNull();
    a.setReady(true); // everyone's ready: it counts down and starts
    await stepUntil([engine], () => a.state === "match", "the ready match");
    matchOf(engine, "Match 1").end({ winner: "Anne" });
    await stepUntil([engine], () => a.state === "room" && a.room?.state === "waiting", "back in the room");
  });

  it("a match admits only ticketed connections, once; it ends when every player has left, or nobody joins in time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(bootstrap({ joinTimeout: 1 }));
    const a = playLocal(engine, "Anne");
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
    const a = playLocal(engine, "Anne");
    await stepUntil([engine], () => a.state === "lobby", "lobby");
    expect(engine.findWorld("Lobby Client")!.tags).toEqual(["lobby-client"]);
    expect(ran).not.toContain("Lobby Client");
  });
});
