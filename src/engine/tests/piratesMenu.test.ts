import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, Lobby } from "../index";
import { UIButton, UIInputField, UIPanel, UIText } from "../ui/components";
import { UIView } from "../../plugins/ui/runtime/UIView";
import type { UIHostElement } from "../ui/host/UIHost";
import { serveSampleUI } from "./sampleUI";
import type { World } from "../core/World";
import { readProject } from "../../server/project";
import { UIPointer } from "./uiPointer";
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
import { Menu } from "../../../samples/pirates/scripts/behaviors/Menu";
import "../../../samples/pirates/scripts/behaviors/MenuBackdrop";
import "../../../samples/pirates/scripts/lobby";

// The pirates menu is a Svelte component (ADR 0423): scenes/menu.scene.json has one UI node, with a
// UIView (ui/Menu.svelte) and the Menu script. Played headless from the sample's own bootstrap, it
// mounts with no problems, shows what the lobby says, renders the crew and settings rows, and its
// buttons create rooms, step settings and start a practice match.

const SAMPLE = fileURLToPath(new URL("../../../samples/pirates", import.meta.url));
const STEP = 1 / 60;

const engines: Engine[] = [];
const pointers: UIPointer[] = [];
afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
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

/** The sample, from its own bootstrap: the Menu World on scenes/menu.scene.json. */
async function openMenu(warnings: string[]): Promise<{ engine: Engine; menu: World; ui: UIView; click(el: UIHostElement): void }> {
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
  const project = await readProject(SAMPLE);
  Assets.addSource(project.assets);
  serveSampleUI(import.meta.glob("../../../samples/pirates/ui/*.svelte", { eager: true }));
  const engine = await Engine.create({ headless: true, project: project.settings });
  engines.push(engine);
  const menu = engine._world("Menu")!;
  await stepUntil(engine, () => Lobby.state === "lobby", "the menu's lobby");
  engine.step(STEP); // the script shows the state it's in from the next frame
  const ui = menu._componentsOfType(UIView)[0];
  await ui.ready;
  // The buttons are pressed through a UI core and Input, as the renderer routes a player's clicks.
  const pointer = await UIPointer.create(menu);
  pointers.push(pointer);
  return { engine, menu, ui, click: (el) => pointer.click(el.as(UIButton)) };
}

/** Laid out and drawn: its node active, and neither it nor an element above it `display: none` (the script's `.hidden`). */
const shown = (el: UIHostElement | null): boolean => {
  if (!el || !el.node.activeInHierarchy) return false;
  for (let e: UIHostElement | null = el; e; e = e.parent) if ((e.component as UIPanel).display === "none") return false;
  return true;
};
const textOf = (el: UIHostElement | null) => el!.as(UIText).text;

describe("the pirates menu (a Svelte component)", () => {
  it("mounts the component with no problems, showing what the lobby says", { timeout: 60_000 }, async () => {
    const warnings: string[] = [];
    const { menu, ui } = await openMenu(warnings);
    expect(menu._componentsOfType(Menu)).toHaveLength(1);
    expect(warnings.filter((w) => /Menu\.svelte/.test(w))).toEqual([]);

    // The scene has one UI node: the view's (its elements aren't in the scene file).
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
    expect(ui.query("#quick-match span")!.as(UIText).fontWeight).toBe("bold"); // inherited through the button
    expect(ui.query("#left")!.as(UIPanel).width).toBe("430");
    expect(ui.query("#code")!.as(UIInputField).maxLength).toBe(5);
    expect(ui.query("#help")!.as(UIText).text).toContain("left stick.  A / D"); // an expression keeps its double spaces

    // Bindings and the home screen.
    expect(textOf(ui.query("#where"))).toBe("Harbour: this computer");
    expect(textOf(ui.query("#status"))).toBe("Connected");
    expect(ui.query("#name")!.value).toMatch(/^Captain \d\d$/);
    expect(shown(ui.query("#home"))).toBe(true);
    expect(shown(ui.query("#room"))).toBe(false);
    expect(shown(ui.query("#no-rooms"))).toBe(true);
    expect(shown(ui.query("#local"))).toBe(false);
    expect(shown(ui.query("#sailing"))).toBe(false);
    expect(ui.query("#sailing")!.as(UIPanel).positionType).toBe("absolute"); // `position: absolute`
    // Screens are hidden with a class (`display: none`), not by deactivating nodes: their nodes stay active.
    expect(ui.query("#room")!.classes.includes("hidden")).toBe(true);
    expect(ui.query("#room")!.node.activeInHierarchy).toBe(true);
    // Keyboard and gamepad play (ADR 0340): the home screen's main button has focus.
    expect(quick.focused).toBe(true);
  });

  it("creates a room from its button: the crew and settings rows come from list(), and the host steps a setting", { timeout: 60_000 }, async () => {
    const { engine, ui, click } = await openMenu([]);
    click(ui.query("#create-room")!);
    await stepUntil(engine, () => Lobby.state === "room", "the room");
    engine.step(STEP);
    expect(Lobby.room).toMatchObject({ public: true, settings: { arena: "bay", ships: "6" } });
    expect(shown(ui.query("#home"))).toBe(false);
    expect(shown(ui.query("#room"))).toBe(true);
    expect(textOf(ui.query("#room-title"))).toBe(Lobby.room!.name);
    expect(ui.query("#ready")!.as(UIButton).focused).toBe(true); // the room's main button takes focus
    expect(textOf(ui.query("#room-code"))).toBe(`Room code ${Lobby.room!.code}  -  open to all`);

    // Six ships: the player, then five bots.
    const seats = ui.queryAll("#slots > .slot");
    expect(seats).toHaveLength(6);
    expect(seats[0].classes.includes("me")).toBe(true);
    expect(textOf(seats[0].query(".slot-name"))).toMatch(/\(you\)$/);
    expect(textOf(seats[0].query(".slot-tag"))).toBe("Host");
    expect(seats.slice(1).every((s) => s.classes.includes("bot") && / \(bot\)$/.test(textOf(s.query(".slot-name"))))).toBe(true);
    expect(seats[1].query(".slot-name")!.as(UIText).color.a).toBeCloseTo(0.55, 2); // .slot.bot .slot-name
    expect(seats[1].query(".swatch")!.as(UIPanel).backgroundColor!.a).toBeCloseTo(0.45, 2); // bound colour

    // The settings rows, and the host's > on the arena.
    const settings = ui.queryAll("#setting-rows > .setting");
    expect(settings.map((r) => textOf(r.query(".setting-label")))).toEqual(["Arena", "Match length", "Ships"]);
    expect(settings[0].query(".next")!.as(UIButton).visible).toBe(true); // the host's: not :disabled
    click(settings[0].query(".next")!);
    await stepUntil(engine, () => Lobby.room?.settings.arena === "open", "the arena setting");
    engine.step(STEP);
    expect(textOf(ui.query("#setting-rows > .setting .setting-value"))).toBe("Open Ocean");

    // Ships 6 -> 5 drops a bot row; the rows by slot are kept.
    const before = ui.queryAll("#slots > .slot");
    click(settings[2].query(".prev")!);
    await stepUntil(engine, () => Lobby.room?.settings.ships === "5", "the ships setting");
    engine.step(STEP);
    const after = ui.queryAll("#slots > .slot");
    expect(after).toHaveLength(5);
    expect(after).toEqual(before.slice(0, 5));

    // Ready, then Leave goes home.
    click(ui.query("#ready")!);
    await stepUntil(engine, () => textOf(ui.query("#ready span")) === "Ready!", "ready");
    expect(Lobby.room!.members.find((m) => m.slot === Lobby.me!.slot)!.ready).toBe(true);
    expect(ui.query("#ready")!.classes.includes("on")).toBe(true);
    expect(ui.query("#ready")!.as(UIButton).backgroundColor!.toHex().toLowerCase()).toBe("#3f8f4a");
    click(ui.query("#leave")!);
    await stepUntil(engine, () => Lobby.state === "lobby", "back in the lobby");
    engine.step(STEP);
    expect(shown(ui.query("#home"))).toBe(true);
  });

  it("starts a practice match from its button", { timeout: 120_000 }, async () => {
    const { engine, ui, click } = await openMenu([]);
    click(ui.query("#practice")!);
    await stepUntil(engine, () => Lobby.state === "match", "the practice match");
    expect(Lobby.room).toMatchObject({ name: "Practice", public: false, settings: { arena: "bay", ships: "6", length: "300" } });
    expect(engine.findWorld("Menu")!.paused).toBe(true); // the match World has the screen
  });
});
