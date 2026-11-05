import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Lobby, Replicated, SceneInstance, UIButton, UIText } from "../index";
import { World } from "../core/World";
import { LobbyClient } from "../net/lobby/client";
import { readProject } from "../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import { FlagState, Game, Phase, Ship, type FlagView, type GameView, type ShipView } from "../../../samples/pirates/scripts/data";
import "../../../samples/pirates/scripts/systems";
import "../../../samples/pirates/scripts/client";
import "../../../samples/pirates/scripts/bots";
import "../../../samples/pirates/scripts/rules";
import "../../../samples/pirates/scripts/weather";
import "../../../samples/pirates/scripts/behaviors/Bolt";
import "../../../samples/pirates/scripts/behaviors/Actors";
import "../../../samples/pirates/scripts/behaviors/Splash";
import "../../../samples/pirates/scripts/behaviors/FollowCamera";
import "../../../samples/pirates/scripts/behaviors/Hud";
import { Menu } from "../../../samples/pirates/scripts/behaviors/Menu";
import "../../../samples/pirates/scripts/behaviors/MenuBackdrop";
import "../../../samples/pirates/scripts/lobby";
import { Hud } from "../../../samples/pirates/scripts/behaviors/Hud";

// King of Pirates (samples/pirates) played headless from its own bootstrap: the menu World starts a
// lobby of its own ("local", ADR 0068); Practice makes a private room and starts it, so the lobby
// makes a match World (the server) and the page a match client World, both in Island Bay. The
// client's ship spawns and sails, bots fill the other slots, race for the flag, hunt its holder and
// fire broadsides, ships take damage and sink, the flag's holders score, power-ups are taken, the
// clock runs, and the client sees the server's ships and match. A quick match in another arena
// with a short clock ends and reports its results to the room.

const SAMPLE = fileURLToPath(new URL("../../../samples/pirates", import.meta.url));
const STEP = 1 / 60;

const engines: Engine[] = [];
const players: LobbyClient[] = [];
afterEach(() => {
  for (const c of players.splice(0)) c.disconnect();
  Lobby.disconnect();
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function dataIn<T>(world: World, _def: null, pick: (node: Replicated["node"]) => T | null): T | null {
  for (const r of world._componentsOfType(Replicated)) {
    if (!r.node.isValid) continue;
    const v = pick(r.node);
    if (v) return v;
  }
  return null;
}

/** The scene file a World has loaded, if any. */
function sceneOf(world: World): string | null {
  return world.sceneNodes[0]?.getBehavior(SceneInstance)?.source ?? null;
}

/** Step until `done` holds (letting scene loads settle). */
async function stepUntil(engine: Engine, done: () => boolean, what: string, maxFrames = 3000): Promise<void> {
  for (let i = 0; i < maxFrames; i++) {
    if (done()) return;
    engine.step(STEP);
    if (i % 5 === 0) await settle();
  }
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
}

function shipsIn(world: World): { rep: Replicated; data: ShipView; x: number; z: number }[] {
  return world
    ._componentsOfType(Replicated)
    .filter((r) => r.node.isValid && r.node.hasData(Ship))
    .map((r) => ({ rep: r, data: r.node.getData(Ship) as ShipView, x: r.node.transform!.position.x, z: r.node.transform!.position.z }));
}

describe("the King of Pirates sample", () => {
  it("spawns the player's ship and bots, which sail, fight and sink ships, as the client sees", { timeout: 120_000 }, async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = await readProject(SAMPLE);
    Assets.addSource(project.assets);
    const engine = await Engine.create({ headless: true, project: project.settings });
    engines.push(engine);
    const menu = engine._world("Menu")!;
    await stepUntil(engine, () => Lobby.state === "lobby", "the menu's lobby");
    // Practice, as the player would click it.
    menu._componentsOfType(Menu)[0].node.find("Screen/Home/Left/Practice")!.getBehavior(UIButton)!._simulateClick();
    await stepUntil(engine, () => Lobby.state === "match", "the practice match");
    expect(Lobby.room).toMatchObject({ name: "Practice", public: false, settings: { arena: "bay", ships: "6", length: "300" } });
    const server = engine._world("Match 1")!, client = engine._world("Match 1 Client")!;
    expect(server && client).toBeTruthy();
    expect(engine.findWorld("Menu")!.paused).toBe(true); // the match World has the screen
    await stepUntil(engine, () => sceneOf(server) !== null && sceneOf(client) !== null, "the arena in both match Worlds");
    expect(sceneOf(server)).toBe("scenes/island-bay.scene.json");
    expect(sceneOf(client)).toBe("scenes/island-bay.scene.json");

    let start: Map<number, { x: number; z: number }> | null = null;
    let maxSinks = 0, minHp = 100, maxScore = 0, carried = false;
    for (let i = 0; i < 150 * 60; i++) {
      engine.step(STEP);
      if (i % 10 === 0) await settle();
      const ships = shipsIn(server);
      if (!start && ships.length === 6) start = new Map(ships.map((s) => [s.data.team, { x: s.x, z: s.z }]));
      for (const s of ships) {
        maxSinks = Math.max(maxSinks, s.data.sinks);
        minHp = Math.min(minHp, s.data.hp);
        maxScore = Math.max(maxScore, s.data.score);
      }
      const f = dataIn(server, null, (n) => n.getData(FlagState) as FlagView | null);
      if (f && f.carrier >= 0) carried = true;
    }

    const ships = shipsIn(server);
    expect(ships).toHaveLength(6);
    expect(ships.filter((s) => s.data.bot)).toHaveLength(5);
    const player = ships.find((s) => !s.data.bot)!;
    expect(player.rep.ownerId).toBeGreaterThan(0);
    // Everyone sailed somewhere.
    for (const s of ships) {
      const from = start!.get(s.data.team)!;
      expect(Math.hypot(s.x - from.x, s.z - from.z) + s.data.sinks).toBeGreaterThan(5);
    }
    // The bots fought: someone was hurt, and someone sank.
    expect(minHp).toBeLessThan(100);
    expect(maxSinks).toBeGreaterThan(0);

    // The flag was taken and its holders scored; the clock is running on both ends.
    expect(carried).toBe(true);
    expect(maxScore).toBeGreaterThan(1);
    const match = dataIn(server, null, (n) => n.getData(Game) as GameView | null)!;
    expect(match.phase).toBe(Phase.playing);
    expect(match.timeLeft).toBeLessThan(300 - 100);
    const seenMatch = dataIn(client, null, (n) => n.getData(Game) as GameView | null)!;
    expect(Math.abs(seenMatch.timeLeft - match.timeLeft)).toBeLessThan(1);

    // The client sees the same six ships and owns the player's, predicted.
    const seen = shipsIn(client);
    expect(seen).toHaveLength(6);
    const mine = seen.filter((s) => s.rep.isOwnedLocally);
    expect(mine).toHaveLength(1);
    expect(mine[0].rep.isPredictedLocally).toBe(true);
    // The player's ship sails under their room slot's colours; the HUD names the bots.
    expect(mine[0].data.team).toBe(Lobby.me!.slot);
    const fleet = client._componentsOfType(Hud)[0].node.find("Screen/Top/Fleet")!.getBehavior(UIText)!.text;
    const names = [...fleet.matchAll(/Calico Jack|Anne Bonny|Blackbeard|You/g)].map((m) => m[0]);
    expect(names).toContain("You");
    expect(names).toContain("Anne Bonny");
    expect(errors).toEqual([]);
  });

  it("plays a quick match with bots in the arena it asked for, ends it on the clock and reports the results to the room", { timeout: 120_000 }, async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = await readProject(SAMPLE);
    Assets.addSource(project.assets);
    // A 20-second match and a short quick-match wait, for the test.
    const settings = structuredClone(project.settings) as unknown as { bootstrap: { templates: { Lobby: { lobby: { quickMatchWait: number; settings: { length: { choices: string[] } } } } } } };
    const lobby = settings.bootstrap.templates.Lobby.lobby;
    lobby.quickMatchWait = 1;
    lobby.settings.length.choices.push("20");
    const engine = await Engine.create({ headless: true, project: settings as never });
    engines.push(engine);

    const anne = new LobbyClient();
    players.push(anne);
    World._runIn(engine._world("Menu")!, () => anne.connect("local", { name: "Anne" }));
    await stepUntil(engine, () => anne.state === "lobby", "the lobby");
    anne.quickMatch({ arena: "maze", length: "20", ships: "4" });
    await stepUntil(engine, () => anne.state === "match", "the quick match");
    const server = engine._world("Match 1")!, client = engine._world(anne.matchWorld!.name)!;
    await stepUntil(engine, () => sceneOf(server) !== null && sceneOf(client) !== null, "the arena in both match Worlds");
    expect(sceneOf(server)).toBe("scenes/rocky-maze.scene.json");
    expect(sceneOf(client)).toBe("scenes/rocky-maze.scene.json");

    await stepUntil(engine, () => shipsIn(server).length === 4 && dataIn(server, null, (n) => n.getData(Game) as GameView | null)?.phase === Phase.playing, "four ships at sea");
    const ships = shipsIn(server);
    expect(ships.filter((s) => s.data.bot)).toHaveLength(3);
    expect(ships.find((s) => !s.data.bot)!.data.team).toBe(anne.me!.slot);
    const match = dataIn(server, null, (n) => n.getData(Game) as GameView | null)!;
    expect(match.timeLeft).toBeLessThanOrEqual(20);

    // The clock runs out, the results show for a while, then everyone is back in the room with them.
    await stepUntil(engine, () => match.phase === Phase.over, "the end of the match", 30 * 60);
    expect(anne.state).toBe("match");
    await stepUntil(engine, () => anne.state === "room", "back in the room", 12 * 60);
    expect(engine._world("Match 1")).toBeNull();
    expect(anne.matchWorld).toBeNull();
    const results = anne.room!.results!;
    expect(results.winner).toMatch(/\S/);
    expect(Object.keys(results).sort()).toEqual(["1", "2", "3", "4", "winner"]);
    expect(results["1"]).toContain(results.winner);
    expect(Object.values(results).join("\n")).toMatch(/Anne\s+\d+ pts/);
    expect(errors).toEqual([]);
  });
});
