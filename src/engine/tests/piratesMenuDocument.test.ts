import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, Lobby, UIButton, UIDocument, UIInputField, UIPanel, UIText, type UIDocumentElement } from "../index";
import type { World } from "../core/World";
import { readProject } from "../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import "../../../samples/pirates/scripts/data";
import "../../../samples/pirates/scripts/systems";
import "../../../samples/pirates/scripts/client";
import "../../../samples/pirates/scripts/bots";
import "../../../samples/pirates/scripts/navigation";
import "../../../samples/pirates/scripts/rules";
import "../../../samples/pirates/scripts/weather";
import "../../../samples/pirates/scripts/behaviors/Bolt";
import "../../../samples/pirates/scripts/behaviors/Actors";
import "../../../samples/pirates/scripts/behaviors/Splash";
import "../../../samples/pirates/scripts/behaviors/FollowCamera";
import "../../../samples/pirates/scripts/behaviors/Hud";
import "../../../samples/pirates/scripts/behaviors/Menu";
import "../../../samples/pirates/scripts/behaviors/MenuBackdrop";
import { MenuDocument } from "../../../samples/pirates/scripts/behaviors/MenuDocument";
import "../../../samples/pirates/scripts/lobby";

// The pirates menu rebuilt as a UI document (ADR 0077): scenes/menu-document.scene.json is
// menu.scene.json with its 131 hand-built UI nodes replaced by one node with a UIDocument
// (ui/menu.ui.xml, ui/menu.ui.css) and the MenuDocument script. Played headless with the Menu
// World loading the duplicate instead of the original, it builds with no problems, fills its
// bindings from the lobby, makes the crew and settings rows with list(), and its buttons do what
// the original's do.

const SAMPLE = fileURLToPath(new URL("../../../samples/pirates", import.meta.url));
const SCENE = "scenes/menu-document.scene.json";
const STEP = 1 / 60;

const engines: Engine[] = [];
afterEach(() => {
  Lobby.disconnect();
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function stepUntil(engine: Engine, done: () => boolean, what: string, maxFrames = 3000): Promise<void> {
  for (let i = 0; i < maxFrames; i++) {
    if (done()) return;
    engine.step(STEP);
    if (i % 5 === 0) await settle();
  }
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
}

/** The sample with its Menu World on the document version of the menu. */
async function openMenu(warnings: string[]): Promise<{ engine: Engine; menu: World; ui: UIDocument }> {
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
  const project = await readProject(SAMPLE);
  Assets.addSource(project.assets);
  const bootstrap = project.settings.bootstrap as { worlds: { name: string; scenes?: string[] }[] };
  const worlds = bootstrap.worlds.map((w) => (w.name === "Menu" ? { ...w, scenes: [SCENE] } : w));
  const engine = await Engine.create({ headless: true, project: { ...project.settings, bootstrap: { ...bootstrap, worlds } } as typeof project.settings });
  engines.push(engine);
  const menu = engine._world("Menu")!;
  await stepUntil(engine, () => Lobby.state === "lobby", "the menu's lobby");
  engine.step(STEP); // the script shows the state it's in from the next frame
  const ui = menu._componentsOfType(UIDocument)[0];
  return { engine, menu, ui };
}

const shown = (el: UIDocumentElement | null) => !!el && el.node.activeInHierarchy;
const textOf = (el: UIDocumentElement | null) => el!.as(UIText).text;

describe("the pirates menu as a UI document", () => {
  it("builds from the markup and stylesheet with no problems, bound to the lobby", { timeout: 60_000 }, async () => {
    const warnings: string[] = [];
    const { menu, ui } = await openMenu(warnings);
    expect(menu._componentsOfType(MenuDocument)).toHaveLength(1);
    expect(ui.problems).toEqual([]);
    expect(warnings.filter((w) => /ui\/menu\.ui\.(xml|css)/.test(w))).toEqual([]);

    // The scene has one UI node: the document's (its elements aren't in the scene file).
    expect(ui.node.children.map((n) => n.name)).toEqual(["Canvas"]);
    for (const id of ["title", "name", "quick-match", "practice", "create-room", "code", "join", "rooms", "no-rooms", "url", "connect", "local", "room", "slots", "setting-rows", "ready", "start", "leave", "sailing", "help", "error"]) {
      expect(ui.query(`#${id}`), id).not.toBeNull();
    }
    // The stylesheet's theme reached the elements.
    expect(ui.query("#title")!.as(UIText).fontSize).toBe(60);
    expect(ui.query("#title")!.as(UIText).color.toHex().toLowerCase()).toBe("#ffd973");
    const quick = ui.query("#quick-match")!.as(UIButton);
    expect(quick.height).toBe("60");
    expect(quick.hoverColor.toHex().toLowerCase()).toBe(new Color(0.95, 0.7, 0.26).toHex().toLowerCase());
    expect(ui.query("#quick-match Text")!.as(UIText).fontWeight).toBe("bold"); // inherited through the button
    expect(ui.query("#left")!.as(UIPanel).width).toBe("430");
    expect(ui.query("#code")!.as(UIInputField).maxLength).toBe(5);
    expect(ui.query("#help")!.as(UIText).text).toContain("mouse.  A / D"); // an attribute keeps its double spaces

    // Bindings and the home screen.
    expect(textOf(ui.query("#where"))).toBe("Harbour: this computer");
    expect(textOf(ui.query("#status"))).toBe("Connected");
    expect(ui.query("#name")!.value).toMatch(/^Captain \d\d$/);
    expect(shown(ui.query("#home"))).toBe(true);
    expect(shown(ui.query("#room"))).toBe(false);
    expect(shown(ui.query("#no-rooms"))).toBe(true);
    expect(shown(ui.query("#local"))).toBe(false);
    expect(ui.query("#sailing")!.as(UIPanel).visible).toBe(false);
  });

  it("creates a room from its button: the crew and settings rows come from list(), and the host steps a setting", { timeout: 60_000 }, async () => {
    const { engine, ui } = await openMenu([]);
    ui.query("#create-room")!.as(UIButton)._simulateClick();
    await stepUntil(engine, () => Lobby.state === "room", "the room");
    engine.step(STEP);
    expect(Lobby.room).toMatchObject({ public: true, settings: { arena: "bay", ships: "6" } });
    expect(shown(ui.query("#home"))).toBe(false);
    expect(shown(ui.query("#room"))).toBe(true);
    expect(textOf(ui.query("#room-title"))).toBe(Lobby.room!.name);
    expect(textOf(ui.query("#room-code"))).toBe(`Room code ${Lobby.room!.code}  -  open to all`);

    // Six ships: the player, then five bots.
    const seats = ui.queryAll("#slots > .slot");
    expect(seats).toHaveLength(6);
    expect(seats[0].classList.contains("me")).toBe(true);
    expect(textOf(seats[0].query(".slot-name"))).toMatch(/\(you\)$/);
    expect(textOf(seats[0].query(".slot-tag"))).toBe("Host");
    expect(seats.slice(1).every((s) => s.classList.contains("bot") && / \(bot\)$/.test(textOf(s.query(".slot-name"))))).toBe(true);
    expect(seats[1].query(".slot-name")!.as(UIText).color.a).toBeCloseTo(0.55, 2); // .slot.bot .slot-name
    expect(seats[1].query(".swatch")!.as(UIPanel).backgroundColor!.a).toBeCloseTo(0.45, 2); // bound colour

    // The settings rows, and the host's > on the arena.
    const settings = ui.queryAll("#setting-rows > .setting");
    expect(settings.map((r) => textOf(r.query(".setting-label")))).toEqual(["Arena", "Match length", "Ships"]);
    expect(settings[0].query(".next")!.as(UIButton).visible).toBe(true); // the host's: not :disabled
    settings[0].query(".next")!.as(UIButton)._simulateClick();
    await stepUntil(engine, () => Lobby.room?.settings.arena === "open", "the arena setting");
    engine.step(STEP);
    expect(textOf(ui.query("#setting-rows > .setting .setting-value"))).toBe("Open Ocean");

    // Ships 6 -> 5 drops a bot row; the rows by slot are kept.
    const before = ui.queryAll("#slots > .slot");
    settings[2].query(".prev")!.as(UIButton)._simulateClick();
    await stepUntil(engine, () => Lobby.room?.settings.ships === "5", "the ships setting");
    engine.step(STEP);
    const after = ui.queryAll("#slots > .slot");
    expect(after).toHaveLength(5);
    expect(after).toEqual(before.slice(0, 5));

    // Ready, then Leave goes home.
    ui.query("#ready")!.as(UIButton)._simulateClick();
    await stepUntil(engine, () => textOf(ui.query("#ready Text")) === "Ready!", "ready");
    expect(Lobby.room!.members.find((m) => m.slot === Lobby.me!.slot)!.ready).toBe(true);
    expect(ui.query("#ready")!.classList.contains("on")).toBe(true);
    expect(ui.query("#ready")!.as(UIButton).backgroundColor!.toHex().toLowerCase()).toBe("#3f8f4a");
    ui.query("#leave")!.as(UIButton)._simulateClick();
    await stepUntil(engine, () => Lobby.state === "lobby", "back in the lobby");
    engine.step(STEP);
    expect(shown(ui.query("#home"))).toBe(true);
  });

  it("starts a practice match from its button, as the original menu does", { timeout: 120_000 }, async () => {
    const { engine, ui } = await openMenu([]);
    ui.query("#practice")!.as(UIButton)._simulateClick();
    await stepUntil(engine, () => Lobby.state === "match", "the practice match");
    expect(Lobby.room).toMatchObject({ name: "Practice", public: false, settings: { arena: "bay", ships: "6", length: "300" } });
    expect(engine.findWorld("Menu")!.paused).toBe(true); // the match World has the screen
  });
});
