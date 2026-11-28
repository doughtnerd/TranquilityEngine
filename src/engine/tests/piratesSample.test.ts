import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Input, Lobby, Replicated, SceneInstance } from "../index";
import { WaterWake } from "../../plugins/water/runtime";
import { UIButton, UIPanel, UIText } from "../ui/components";
import { UIView } from "../../plugins/ui/runtime/UIView";
import type { UIHostElement } from "../ui/host/UIHost";
import { serveSampleUI } from "./sampleUI";
import { World } from "../core/World";
import { readProject } from "../../server/project";
import { UIPointer } from "./uiPointer";
import "../../server/websocketServer"; // the Node "websocket" transport, which can listen
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import { Battery, CLOUD_PREFAB, CLOUD_RADIUS, Cloud, inCloudAmong, FlagState, Game, Helm, Phase, Ship, TEAM_COLORS, type CloudView, type FlagView, type GameView, type ShipView } from "../../../samples/pirates/scripts/data";
import "../../../samples/pirates/scripts/systems";
import "../../../samples/pirates/scripts/client";
import "../../../samples/pirates/scripts/bots";
import { navStats } from "../../../samples/pirates/scripts/navigation";
import "../../../samples/pirates/scripts/rules";
import "../../../samples/pirates/scripts/weather";
import "../../../samples/pirates/scripts/seaMarks";
import "../../../samples/pirates/scripts/behaviors/Bolt";
import "../../../samples/pirates/scripts/behaviors/Actors";
import "../../../samples/pirates/scripts/behaviors/Splash";
import "../../../samples/pirates/scripts/behaviors/FollowCamera";
import "../../../samples/pirates/scripts/behaviors/Hud";
import { Menu } from "../../../samples/pirates/scripts/behaviors/Menu";
import "../../../samples/pirates/scripts/behaviors/MenuBackdrop";
import "../../../samples/pirates/scripts/lobby";
import { Hud } from "../../../samples/pirates/scripts/behaviors/Hud";
import { STICK_REACH } from "../../../samples/pirates/scripts/controls";

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
const pointers: UIPointer[] = [];

/** Click a button in `world` through a UI core and Input, as the renderer routes a player's click (seen next frame). */
async function click(world: World, button: UIButton): Promise<void> {
  for (const old of pointers.splice(0)) old.dispose(); // one core routes at a time, as one renderer does
  const p = await UIPointer.create(world);
  pointers.push(p);
  p.click(button);
}

/** The UIView on the node of a behavior (the menu's, the HUD's). */
function uiOf(behavior: { node: GameObject }): UIView {
  return behavior.node.getBehavior(UIView)!;
}

/** An element a view rendered, which must be there. */
function at(ui: UIView, selector: string): UIHostElement {
  const el = ui.query(selector);
  if (!el) throw new Error(`no "${selector}" in ${ui.component}`);
  return el;
}

/** Laid out and drawn: its node active, and neither it nor an element above it `display: none` (the scripts' `.hidden`). */
function shown(el: UIHostElement): boolean {
  if (!el.node.activeInHierarchy) return false;
  for (let e: UIHostElement | null = el; e; e = e.parent) if ((e.component as UIPanel).display === "none") return false;
  return true;
}

const textOf = (el: UIHostElement | null) => el!.as(UIText).text;

/** Other players' pages, stepped with this one. */
const pages: OtherPage[] = [];
afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  for (const p of pages.splice(0)) {
    p.Lobby.disconnect();
    p.engine.dispose();
  }
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

/** Step until `done` holds (letting scene loads settle), with every other player's page; over a socket, in real time. */
async function stepUntil(engine: Engine, done: () => boolean, what: string, maxFrames = 3000): Promise<void> {
  for (let i = 0; i < maxFrames; i++) {
    if (done()) return;
    engine.step(STEP);
    for (const p of pages) p.engine.step(STEP);
    if (pages.length) await new Promise((resolve) => setTimeout(resolve, 1));
    else if (i % 5 === 0) await settle();
  }
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
}

/** Another player's page: the sample's scripts in the engine imported afresh, so it has its own page-wide `Lobby`. */
interface OtherPage {
  readonly engine: { step(dt: number): void; dispose(): void };
  readonly Lobby: typeof Lobby;
}

/** Another player's page of the project (without its menu), its `Lobby` connected to `address` as `name`. */
async function otherPage(project: Awaited<ReturnType<typeof readProject>>, address: string, name: string): Promise<OtherPage> {
  vi.resetModules();
  const myco = await import("../../myco");
  const { World: PageWorld } = await import("../core/World");
  await import("../../../samples/pirates/scripts/data");
  await import("../../../samples/pirates/scripts/systems");
  await import("../../../samples/pirates/scripts/client");
  await import("../../../samples/pirates/scripts/bots");
  await import("../../../samples/pirates/scripts/navigation");
  await import("../../../samples/pirates/scripts/rules");
  await import("../../../samples/pirates/scripts/weather");
  await import("../../../samples/pirates/scripts/seaMarks");
  await import("../../../samples/pirates/scripts/behaviors/Bolt");
  await import("../../../samples/pirates/scripts/behaviors/Actors");
  await import("../../../samples/pirates/scripts/behaviors/Splash");
  await import("../../../samples/pirates/scripts/behaviors/FollowCamera");
  await import("../../../samples/pirates/scripts/behaviors/Hud");
  await import("../../../samples/pirates/scripts/lobby");
  myco.Assets.addSource(project.assets);
  const settings = project.settings as unknown as { bootstrap: { worlds: unknown[] } };
  const engine = await myco.Engine.create({ headless: true, project: { ...settings, bootstrap: { ...settings.bootstrap, worlds: [{ name: "Page" }] } } as never });
  PageWorld._runIn(engine.world, () => myco.Lobby.connect(address, { name }));
  const page: OtherPage = { engine, Lobby: myco.Lobby as unknown as typeof Lobby };
  pages.push(page);
  return page;
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
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));

    const project = await readProject(SAMPLE);
    Assets.addSource(project.assets);
    serveSampleUI(import.meta.glob("../../../samples/pirates/ui/*.svelte", { eager: true }));
    const engine = await Engine.create({ headless: true, project: project.settings });
    engines.push(engine);
    const menu = engine._world("Menu")!;
    await stepUntil(engine, () => Lobby.state === "lobby", "the menu's lobby");
    // Practice, as the player would click it.
    await click(menu, at(uiOf(menu._componentsOfType(Menu)[0]), "#practice").as(UIButton));
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
    /** Each team's farthest distance from its spawn during the match. */
    const farthest = new Map<number, number>();
    for (let i = 0; i < 150 * 60; i++) {
      engine.step(STEP);
      if (i % 10 === 0) await settle();
      const ships = shipsIn(server);
      if (!start && ships.length === 6) start = new Map(ships.map((s) => [s.data.team, { x: s.x, z: s.z }]));
      for (const s of ships) {
        const from = start?.get(s.data.team);
        if (from) farthest.set(s.data.team, Math.max(farthest.get(s.data.team) ?? 0, Math.hypot(s.x - from.x, s.z - from.z)));
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
    // Everyone sailed somewhere. Measured over the whole match, not at its end: a ship that sank respawns at its
    // spawn point, so where it ends depends on when it last sank (which load and the bots' random choices move).
    expect(start).not.toBeNull();
    for (const s of ships) expect(farthest.get(s.data.team) ?? 0).toBeGreaterThan(5);
    // The bots planned their routes on the arena's navmesh.
    expect(navStats.get(server)?.plans).toBeGreaterThan(0);
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
    // Ships churn the water on the client: each carries a WaterWake the sea's shader draws (ADR 0445), shown
    // while it's afloat and seen (the wakes are only for the eye: the server World has none).
    expect(server._componentsOfType(WaterWake)).toEqual([]);
    const wakes = client._componentsOfType(WaterWake);
    expect(wakes).toHaveLength(6);
    for (const s of seen) {
      const wake = s.rep.node.getComponent(WaterWake)!;
      expect(wake).toBeTruthy();
      expect(wake.strength).toBe(s.data.sunk > 0 ? 0 : wake.strength);
    }
    expect(wakes.some((w) => w.strength === 1)).toBe(true);
    // The player's ship sails under their room slot's colours; the HUD names the bots.
    expect(mine[0].data.team).toBe(Lobby.me!.slot);
    // The HUD is a Svelte component (ui/Hud.svelte): its leaderboard rows are an {#each} of the captains.
    const hud = uiOf(client._componentsOfType(Hud)[0]);
    await hud.ready;
    expect(warnings.filter((w) => /Hud\.svelte/.test(w))).toEqual([]);
    const rows = () => hud.queryAll("#leaderboard > .board-row").filter(shown);
    expect(rows()).toHaveLength(6);
    const names = rows().map((r) => textOf(r.query(".name")));
    expect(names).toContain("You");
    expect(names).toContain("Anne Bonny");
    // Best first, the player's row lit, and the clock on top.
    const scores = rows().map((r) => Number(textOf(r.query(".score"))));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(rows().map((r) => textOf(r.query(".rank")))).toEqual(["1.", "2.", "3.", "4.", "5.", "6."]);
    const myRow = rows().find((r) => textOf(r.query(".name")) === "You")!;
    expect(myRow.as(UIPanel).backgroundColor!.a).toBeGreaterThan(0);
    expect(myRow.query(".name")!.as(UIText).fontWeight).toBe("bold");
    expect(textOf(at(hud, "#clock"))).toMatch(/^\d:\d\d$/);
    expect(textOf(at(hud, "#hull-label"))).toMatch(/^Hull \d+$/);
    expect(textOf(at(hud, "#port .battery-label"))).toMatch(/^\[A\] Port/);
    expect(at(hud, "#hull-fill").as(UIPanel).width).toMatch(/^\d+%$/);

    // The HUD's awareness. The minimap shows the ships afloat the player's chart shows: their own,
    // and any not inside another team's fog cloud (bots may have dropped some) and not a ghost.
    const activeDots = (layer: string) => at(hud, `#${layer}`).children.filter(shown).length;
    const playerTeam = mine[0].data.team;
    const cloudsIn = (world: World) =>
      world._componentsOfType(Replicated).filter((r) => r.node.isValid && r.node.hasData(Cloud)).map((r) => ({ team: (r.node.getData(Cloud) as CloudView).team, x: r.node.transform!.position.x, z: r.node.transform!.position.z }));
    const visible = () => {
      const spots = cloudsIn(client);
      return shipsIn(client).filter((s) => s.data.sunk <= 0 && (s.rep.isOwnedLocally || (s.data.ghost <= 0 && !inCloudAmong(spots, s.x, s.z, playerTeam)))).length;
    };
    engine.step(STEP);
    expect(activeDots("ships")).toBe(visible());
    expect(activeDots("ships")).toBeGreaterThan(0);
    expect(activeDots("land")).toBeGreaterThan(3);
    expect(activeDots("clouds")).toBe(cloudsIn(client).length);

    // A ghost ship is left off the player's minimap while the power-up lasts.
    const ghostBot = shipsIn(server).find((s) => s.data.bot && s.data.sunk <= 0 && s.data.ghost <= 0)!;
    const ghostTeam = ghostBot.data.team;
    const ghostOnClient = () => shipsIn(client).find((s) => s.data.team === ghostTeam)!;
    World._runIn(server, () => void Object.assign(ghostBot.data, { ghost: 30, cloud: 0, hp: 100, sunk: 0 }));
    await stepUntil(engine, () => ghostOnClient().data.ghost > 0, "the ghost on the client", 120);
    engine.step(STEP);
    expect(activeDots("ships")).toBe(visible());
    const chartedTeams = at(hud, "#ships").children.filter(shown).map((n) => n.as(UIPanel).backgroundColor!.toHex().toLowerCase());
    expect(chartedTeams).not.toContain(TEAM_COLORS[ghostTeam].toLowerCase());
    World._runIn(server, () => void (ghostBot.data.ghost = 0));
    await stepUntil(engine, () => ghostOnClient().data.ghost <= 0, "the ghost wearing off", 120);

    // A fog cloud dropped by another ship over a bot hides it from the player, on the minimap and on the water.
    const bot = shipsIn(server).find((s) => s.data.bot && s.data.sunk <= 0)!;
    const cloudTeam = shipsIn(server).find((s) => s.data.team !== playerTeam && s.data.team !== bot.data.team)!.data.team;
    const dropCloud = (x: number, z: number, team: number) =>
      World._runIn(server, () => {
        const node = GameObject.instantiate(CLOUD_PREFAB, { position: [x, 0, z] });
        Object.assign(node.getData(Cloud) as CloudView, { team, life: 100 });
      });
    const before = cloudsIn(client).length;
    dropCloud(bot.x, bot.z, cloudTeam);
    await stepUntil(engine, () => cloudsIn(client).length > before, "the cloud on the client");
    engine.step(STEP);
    const seenBot = shipsIn(client).find((s) => s.data.team === bot.data.team)!;
    if (seenBot.data.sunk <= 0 && Math.hypot(seenBot.x - bot.x, seenBot.z - bot.z) < CLOUD_RADIUS - 2) {
      expect(seenBot.rep.node.find("Visual")!.active).toBe(false);
    }
    expect(activeDots("ships")).toBe(visible());
    expect(activeDots("clouds")).toBe(cloudsIn(client).length);

    // The player's ship, afloat and in its own cloud, draws ghosted, with a note.
    const serverMe = () => shipsIn(server).find((s) => s.rep.ownerId === player.rep.ownerId)!;
    const place = (x: number, z: number, heading: number) =>
      World._runIn(server, () => {
        const s = serverMe();
        s.rep.node.transform!.position.set(x, 0, z);
        Object.assign(s.data, { heading, hp: 100, sunk: 0, invulnerable: 0 });
      });
    const me = () => shipsIn(client).find((s) => s.rep.isOwnedLocally)!;
    place(serverMe().x, serverMe().z, serverMe().data.heading);
    dropCloud(serverMe().x, serverMe().z, playerTeam);
    await stepUntil(engine, () => shown(at(hud, "#fog")), "the fog note", 120);
    expect(textOf(at(hud, "#fog .detail"))).toBe("Your enemies can't see you");
    expect(me().rep.node.find("Visual/GhostHull")!.active).toBe(true);
    expect(me().rep.node.find("Visual/Hull")!.active).toBe(false);

    // Past the arena's edge the banner warns and the hull takes damage; near it, a milder warning.
    const banner = () => shown(at(hud, "#edge"));
    const title = () => textOf(at(hud, "#edge .title"));
    const radius = dataIn(server, null, (n) => n.getData(Game) as GameView | null)!.radius;
    place(radius + 6, 0, 90); // sailing away from the middle, along +X
    await stepUntil(engine, () => banner() && title() === "Return to the battle!", "the out-of-arena banner", 120);
    expect(textOf(at(hud, "#edge .detail"))).toMatch(/^You're taking damage - steer (east|north-east|south-east)$/);
    for (let i = 0; i < 10; i++) engine.step(STEP);
    expect(serverMe().data.hp).toBeLessThan(100);
    expect(shown(at(hud, "#home-marker"))).toBe(true);
    place(radius - 5, 0, 0);
    await stepUntil(engine, () => title() === "The edge of the arena", "the near-edge warning", 120);
    place(0.3 * radius, 0.3 * radius, 0);
    await stepUntil(engine, () => !banner(), "the warning gone", 120);

    expect(errors).toEqual([]);
  });

  it("leaves a match from the HUD's dialog: back in the room, the ship gone from the server and a bot in its slot", { timeout: 120_000 }, async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = await readProject(SAMPLE);
    Assets.addSource(project.assets);
    serveSampleUI(import.meta.glob("../../../samples/pirates/ui/*.svelte", { eager: true }));
    const engine = await Engine.create({ headless: true, project: project.settings });
    engines.push(engine);
    const menuWorld = engine._world("Menu")!;
    const menu = uiOf(menuWorld._componentsOfType(Menu)[0]);
    // This page's lobby World listens over WebSocket first, so its matches do too, for Anne in a page
    // of her own. The menu's "local" connection, on its first frame, finds it.
    const lobbyTemplate = (project.settings as unknown as { bootstrap: { templates: { Lobby: object } } }).bootstrap.templates.Lobby;
    const lobbyWorld = engine.createWorld({ ...lobbyTemplate, name: "Lobby" });
    const url = await lobbyWorld.listen("websocket", { address: "ws://127.0.0.1:0" });
    await stepUntil(engine, () => Lobby.state === "lobby", "the menu's lobby");
    expect(engine.findWorld("Lobby 2")).toBeNull();
    // This page creates a room (Create Room, as clicked); Anne joins it by its code; the host starts it.
    await click(menuWorld, at(menu, "#create-room").as(UIButton));
    await stepUntil(engine, () => Lobby.state === "room", "the room");
    const anne = (await otherPage(project, url, "Anne")).Lobby;
    await stepUntil(engine, () => anne.state === "lobby", "Anne's lobby");
    anne.joinRoom(Lobby.room!.code);
    await stepUntil(engine, () => anne.state === "room" && Lobby.room!.members.length === 2, "Anne in the room");
    Lobby.start();
    await stepUntil(engine, () => Lobby.state === "match" && anne.state === "match", "the match");
    const server = engine._world("Match 1")!;
    const client = engine._world(Lobby.matchWorld!.name)!;
    await stepUntil(engine, () => shipsIn(server).length === 6 && shipsIn(server).filter((s) => !s.data.bot).length === 2, "both players' ships at sea", 1200);
    await stepUntil(engine, () => client._componentsOfType(Hud).length > 0 && client._componentsOfType(Hud)[0].leaveMatch !== null, "the HUD", 600);
    const myTeam = Lobby.me!.slot;
    const anneTeam = anne.me!.slot;
    const mine = shipsIn(server).find((s) => s.data.team === myTeam)!;
    expect(mine.data.bot).toBe(0);

    // Escape opens the dialog (as the HUD's keyboard check would); the ship holds fire while it's open.
    const hud = client._componentsOfType(Hud)[0];
    const ui = uiOf(hud);
    const dialog = at(ui, "#leave");
    expect(shown(dialog)).toBe(false);
    hud.leaving = true;
    engine.step(STEP);
    expect(shown(dialog)).toBe(true);
    expect(textOf(at(ui, "#leave .title"))).toBe("Leave the match?");
    expect(textOf(at(ui, "#leave .detail"))).toBe("A bot takes your ship's place.");
    expect(shown(at(ui, "#leave-go"))).toBe(true);
    // Keep sailing closes it.
    await click(client, at(ui, "#leave-stay").as(UIButton));
    engine.step(STEP);
    expect(hud.leaving).toBe(false);
    expect(shown(dialog)).toBe(false);
    // Open it again and leave.
    hud.leaving = true;
    engine.step(STEP);
    await click(client, at(ui, "#leave-go").as(UIButton));
    engine.step(STEP);
    expect(Lobby.matchWorld).toBeNull();
    expect(engine.findWorld(client.name)).toBeNull();
    // Back in the room (its match still on for Anne), the menu World has the screen again and says so.
    expect(["room", "starting"]).toContain(Lobby.state);
    expect(Lobby.room!.state).toBe("playing");
    expect(engine.findWorld("Menu")!.paused).toBe(false);
    engine.step(STEP);
    expect(shown(at(menu, "#room"))).toBe(true);
    expect(textOf(at(menu, "#room-status"))).toMatch(/^You left the match/);

    // On the server the ship goes and a bot takes the slot; Anne sails on.
    await stepUntil(engine, () => !shipsIn(server).some((s) => s.rep.node === mine.rep.node), "the ship removed on the server", 600);
    await stepUntil(engine, () => shipsIn(server).length === 6, "a bot in the slot", 600);
    const slot = shipsIn(server).find((s) => s.data.team === myTeam)!;
    expect(slot.data.bot).toBe(1);
    expect(shipsIn(server).filter((s) => !s.data.bot).map((s) => s.data.team)).toEqual([anneTeam]);
    expect(engine.findWorld("Match 1")).not.toBeNull();
    expect(anne.state).toBe("match");
    expect(errors).toEqual([]);
  });

  it("sails by a gamepad: the stick steers, the trigger fires, the HUD names the pad's buttons, and Menu and B open and close the leave dialog", { timeout: 120_000 }, async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = await readProject(SAMPLE);
    Assets.addSource(project.assets);
    serveSampleUI(import.meta.glob("../../../samples/pirates/ui/*.svelte", { eager: true }));
    const engine = await Engine.create({ headless: true, project: project.settings });
    engines.push(engine);
    const menu = engine._world("Menu")!;
    await stepUntil(engine, () => Lobby.state === "lobby", "the menu's lobby");
    await click(menu, at(uiOf(menu._componentsOfType(Menu)[0]), "#practice").as(UIButton));
    await stepUntil(engine, () => Lobby.state === "match", "the practice match");
    const server = engine._world("Match 1")!, client = engine._world("Match 1 Client")!;
    await stepUntil(engine, () => shipsIn(server).some((s) => !s.data.bot) && client._componentsOfType(Hud).length > 0, "the player's ship and the HUD", 1200);
    const hud = client._componentsOfType(Hud)[0];
    const ui = uiOf(hud);
    await ui.ready;
    const text = (selector: string) => textOf(at(ui, selector));
    const mine = () => shipsIn(server).find((s) => !s.data.bot)!;
    // What the server has from the client's helm stream, read in the server World as its systems do.
    const helm = () => World._runIn(server, () => Helm.of(mine().rep.node))!;
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) engine.step(STEP);
    };
    frames(2);
    // On the keyboard and mouse the HUD names the keys.
    expect(text("#help")).toBe("Mouse: steer   |   A / D: battery   |   Space: fire   |   F: fog cloud (ghost ship)   |   Esc: leave the match");

    const PAD = 41;
    try {
      Input.inject.gamepadConnected({ id: PAD, name: "Virtual pad", family: "xbox" });
      // Left stick east, the right trigger and the left shoulder (the port battery) held.
      Input.inject.gamepadAxis(PAD, 0, 1);
      Input.inject.gamepadButton(PAD, 7, 1);
      Input.inject.gamepadButton(PAD, 4, 1);
      frames(30);
      let h = helm();
      expect(h).toMatchObject({ steer: 1, fire: 1, battery: Battery.port });
      // The helm's point is ahead of the ship along the stick: east.
      expect(h.x - mine().x).toBeGreaterThan(STICK_REACH * 0.7);
      expect(Math.abs(h.z - mine().z)).toBeLessThan(STICK_REACH * 0.3);
      // The HUD now names the pad's controls.
      expect(text("#help")).toBe("Left Stick: steer   |   LB / RB: battery   |   RT: fire   |   X: fog cloud (ghost ship)   |   Menu: leave the match");
      expect(text("#port .battery-label")).toMatch(/^\[LB\] Port/);

      // Let go: the ship holds its course and stops firing; the battery stays picked.
      Input.inject.gamepadAxis(PAD, 0, 0);
      Input.inject.gamepadButton(PAD, 7, 0);
      Input.inject.gamepadButton(PAD, 4, 0);
      frames(30);
      h = helm();
      expect(h).toMatchObject({ steer: 0, fire: 0, battery: Battery.port });

      // Menu opens the leave dialog, with Keep sailing focused for the d-pad; B (the UI's cancel) closes it.
      Input.inject.gamepadButton(PAD, 9, 1);
      frames(2);
      Input.inject.gamepadButton(PAD, 9, 0);
      frames(2);
      expect(hud.leaving).toBe(true);
      expect(shown(at(ui, "#leave"))).toBe(true);
      expect(at(ui, "#leave-stay").as(UIButton).focused).toBe(true);
      Input.inject.gamepadButton(PAD, 1, 1);
      frames(2);
      Input.inject.gamepadButton(PAD, 1, 0);
      frames(2);
      expect(hud.leaving).toBe(false);
      expect(shown(at(ui, "#leave"))).toBe(false);
    } finally {
      Input.inject.gamepadDisconnected(PAD);
      engine.step(STEP);
      Input.inject.releaseAll();
    }
    expect(errors).toEqual([]);
  });

  it("plays a quick match with bots in the arena it asked for, ends it on the clock and reports the results to the room", { timeout: 120_000 }, async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = await readProject(SAMPLE);
    Assets.addSource(project.assets);
    serveSampleUI(import.meta.glob("../../../samples/pirates/ui/*.svelte", { eager: true }));
    // A 20-second match and a short quick-match wait, for the test.
    const settings = structuredClone(project.settings) as unknown as { bootstrap: { templates: { Lobby: { lobby: { quickMatchWait: number; settings: { length: { choices: string[] } } } } } } };
    const lobby = settings.bootstrap.templates.Lobby.lobby;
    lobby.quickMatchWait = 1;
    lobby.settings.length.choices.push("20");
    const engine = await Engine.create({ headless: true, project: settings as never });
    engines.push(engine);

    // The menu's page-wide Lobby, connected again under Anne's name.
    await stepUntil(engine, () => Lobby.state === "lobby", "the menu's lobby");
    World._runIn(engine._world("Menu")!, () => Lobby.connect("local", { name: "Anne" }));
    const anne = Lobby;
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
    expect(engine.findWorld("Match 1")).toBeNull();
    expect(anne.matchWorld).toBeNull();
    const results = anne.room!.results!;
    expect(results.winner).toMatch(/\S/);
    expect(Object.keys(results).sort()).toEqual(["1", "2", "3", "4", "winner"]);
    expect(results["1"]).toContain(results.winner);
    expect(Object.values(results).join("\n")).toMatch(/Anne\s+\d+ pts/);
    expect(errors).toEqual([]);
  });
});
