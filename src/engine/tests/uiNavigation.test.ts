import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameBehavior, GameObject, Input, InputPlayers, defineActions, defineSystem, dpad, button as buttonAction, vec2 } from "../index";
import { UIButton, UICanvas, UIInputField, type UILength } from "../ui/components";
import { UIActions, UI_CONTEXT_PRIORITY } from "../ui/navigation";
import { _undefineSystem } from "../core/systems";
import { World } from "../core/World";
import { UIPointer, stubDocument, type FakeInput } from "./uiPointer";
import { buildUI, loadUITestSupport, uiAs, uiElement } from "./uiMarkup";

// ADR 0340: keyboard and gamepad focus navigation, driven by the built-in UI actions (`engine.UIActions`
// in the `ui` context), through Input.inject, a UI core's layout and pointer, and the public components.

defineActions("test.uiNavigation.Game", {
  move: vec2(dpad("<Keyboard>/arrowup", "<Keyboard>/arrowdown", "<Keyboard>/arrowleft", "<Keyboard>/arrowright")),
  jump: buttonAction("<Keyboard>/space"),
});

const DT = 1 / 60;
let engine: Engine;
let pointers: UIPointer[] = [];
const systems: string[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  for (const name of systems.splice(0)) _undefineSystem(name);
  Input.inject.releaseAll();
  for (const id of pads.splice(0)) Input.inject.gamepadDisconnected(id);
  engine.step(DT);
  engine.dispose();
  Input.reset();
  Assets.clearSources();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const step = (frames = 1, dt = DT) => {
  for (let i = 0; i < frames; i++) engine.step(dt);
};

/** Press and release a key, a frame each: the action performs in the first. */
function press(key: string): void {
  Input.inject.keyDown(key);
  step();
  Input.inject.keyUp(key);
  step();
}

function canvas(init: Partial<UICanvas> = {}, name = "Canvas"): UICanvas {
  return uiElement(name, null, UICanvas, init);
}

/** A 100 × 50 button at (x, y) in its canvas. */
function button(name: string, parent: { node: GameObject }, x: number, y: number, init: Partial<UIButton> = {}): UIButton {
  const px = (n: number) => String(n) as UILength;
  return uiElement(name, parent.node, UIButton, { positionType: "absolute", left: px(x), top: px(y), width: px(100), height: px(50), padding: 0, ...init });
}

/** A UI core laying the World's UI out and routing the pointer, as the renderer does. */
async function pointer(): Promise<UIPointer> {
  const p = await UIPointer.create(World.require());
  pointers.push(p);
  return p;
}

/** A 3 × 3 grid of buttons, 120 px apart across and 70 px down. */
function grid(on: UICanvas): UIButton[][] {
  return [0, 1, 2].map((row) => [0, 1, 2].map((col) => button(`B${row}${col}`, on, 20 + col * 120, 20 + row * 70)));
}

const focusedName = (...els: (UIButton | UIInputField)[]) => els.find((e) => e.focused)?.node.name ?? null;

const pads: number[] = [];
const pad = (id: number) => {
  pads.push(id);
  Input.inject.gamepadConnected({ id, name: `Pad ${id}`, family: "xbox" });
};

function padPress(id: number, buttonIndex: number): void {
  Input.inject.gamepadButton(id, buttonIndex, 1);
  step();
  Input.inject.gamepadButton(id, buttonIndex, 0);
  step();
}

const DPAD = { up: 12, down: 13, left: 14, right: 15 } as const;

describe("UIActions and the ui context (ADR 0340)", () => {
  it("is an engine action set whose bindings aren't in the default context", () => {
    expect(UIActions.id).toBe("engine.UIActions");
    expect(UIActions.actions.map((a) => a.name)).toEqual(["navigate", "submit", "cancel", "next", "previous"]);
    expect(UI_CONTEXT_PRIORITY).toBe(1000);
    step();
    Input.inject.keyDown("arrowdown");
    step();
    // Nothing is focused: the ui context is off and the arrows are the game's.
    expect(InputPlayers.get(0)!.held("engine.UIActions:navigate")).toBe(false);
    expect(InputPlayers.get(0)!.performed("test.uiNavigation.Game:move")).toBe(true);
  });
});

describe("navigate (ADR 0340)", () => {
  it("moves focus to the nearest element that way in a grid, and stops at the edges", async () => {
    const c = canvas();
    const g = grid(c);
    await pointer();
    g[1][1].focused = true;
    step();
    const all = g.flat();
    press("arrowright");
    expect(focusedName(...all)).toBe("B12");
    press("arrowright"); // the edge: no wrap
    expect(focusedName(...all)).toBe("B12");
    press("arrowdown");
    expect(focusedName(...all)).toBe("B22");
    press("arrowleft");
    press("arrowleft");
    expect(focusedName(...all)).toBe("B20");
    press("arrowup");
    expect(focusedName(...all)).toBe("B10");
  });

  it("takes candidates whose centres lie in a 90° cone, nearest first with a penalty off-axis, and lined-up ones", async () => {
    const c = canvas();
    const a = button("A", c, 0, 0);
    const far = button("Far", c, 400, 0);
    const steep = button("Steep", c, 150, 200); // centre (200, 225): 100 px right of A's edge, 175 below its span: outside the right cone
    const wide = button("Wide", c, 0, 300, { width: "800" as UILength }); // its span overlaps A's across: lined up below
    await pointer();
    a.focused = true;
    step();
    press("arrowright");
    expect(far.focused).toBe(true);
    a.focused = true;
    step();
    press("arrowdown");
    expect(focusedName(a, far, steep, wide)).toBe("Steep"); // in the down cone, and scores lower than the wide one
    press("arrowdown");
    expect(wide.focused).toBe(true);
  });

  it("repeats while held: at once, then after 0.4 s every 0.1 s", async () => {
    const c = canvas();
    const col = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => button(`R${i}`, c, 20, 20 + i * 60));
    await pointer();
    col[0].focused = true;
    step();
    Input.inject.keyDown("arrowdown");
    step(1, 0.05); // t = 0: one move
    expect(focusedName(...col)).toBe("R1");
    step(7, 0.05); // t = 0.35
    expect(focusedName(...col)).toBe("R1");
    step(1, 0.05); // t = 0.4
    expect(focusedName(...col)).toBe("R2");
    step(2, 0.05); // t = 0.5
    expect(focusedName(...col)).toBe("R3");
    Input.inject.keyUp("arrowdown");
    step(4, 0.05);
    expect(focusedName(...col)).toBe("R3");
  });

  it("moves at once when the held direction changes: rolling from one arrow to the next, or a tap in each of two frames", async () => {
    const c = canvas();
    const g = grid(c);
    const all = g.flat();
    await pointer();
    g[0][0].focused = true;
    step();
    // Right held, then down pressed before right is released: navigate never goes back to 0.
    Input.inject.keyDown("arrowright");
    step();
    expect(focusedName(...all)).toBe("B01");
    Input.inject.keyDown("arrowdown");
    Input.inject.keyUp("arrowright");
    step();
    expect(focusedName(...all)).toBe("B11");
    Input.inject.keyUp("arrowdown");
    step();
    // Two taps, each pressed and released within one frame, in consecutive frames.
    Input.inject.keyDown("arrowright");
    Input.inject.keyUp("arrowright");
    step();
    expect(focusedName(...all)).toBe("B12");
    Input.inject.keyDown("arrowdown");
    Input.inject.keyUp("arrowdown");
    step();
    expect(focusedName(...all)).toBe("B22");
    step(3);
    expect(focusedName(...all)).toBe("B22");
  });

  it("follows explicit neighbours, and navigation explicit or none turns the search off", async () => {
    const c = canvas();
    const g = grid(c);
    const all = g.flat();
    g[0][0].navDown = g[2][2].node;
    await pointer();
    g[0][0].focused = true;
    step();
    press("arrowdown");
    expect(focusedName(...all)).toBe("B22");
    g[0][0].navigation = "explicit";
    g[0][0].focused = true;
    step();
    press("arrowright"); // no explicit right neighbour: stays
    expect(focusedName(...all)).toBe("B00");
    press("arrowdown");
    expect(focusedName(...all)).toBe("B22");
    g[0][0].navigation = "none";
    g[0][0].focused = true;
    step();
    press("arrowdown");
    expect(focusedName(...all)).toBe("B00");
  });

  it("skips elements that can't take focus: focusable off, not interactable, hidden", async () => {
    const c = canvas();
    const row = [0, 1, 2].map((i) => button(`R${i}`, c, 20 + i * 120, 20));
    row[1].focusable = false;
    row[2].interactable = false;
    const p = await pointer();
    row[0].focused = true;
    step();
    press("arrowright");
    expect(row[0].focused).toBe(true); // nothing to the right can take focus
    row[2].interactable = true;
    p.sync();
    press("arrowright");
    expect(row[2].focused).toBe(true);
    row[2].visible = false; // hidden while focused: focus is lost
    p.sync();
    step();
    expect(focusedName(...row)).toBeNull();
  });

  it("drives it with the d-pad and left stick of a gamepad", async () => {
    const c = canvas();
    const g = grid(c);
    await pointer();
    pad(3);
    g[0][0].focused = true;
    step();
    padPress(3, DPAD.right);
    expect(g[0][1].focused).toBe(true);
    Input.inject.gamepadAxis(3, 1, 0.9); // left stick down (+Y down on the wire)
    step();
    Input.inject.gamepadAxis(3, 1, 0);
    step();
    expect(g[1][1].focused).toBe(true);
    Input.inject.gamepadAxis(3, 1, 0.3); // inside the stick's dead zone: no move
    step(2);
    Input.inject.gamepadAxis(3, 1, 0);
    step();
    expect(g[1][1].focused).toBe(true);
  });
});

describe("next and previous (ADR 0340)", () => {
  it("move in tree order with Tab and Shift+Tab, wrapping within the focused element's canvas", async () => {
    const c = canvas();
    const first = button("First", c, 600, 20);
    const second = button("Second", c, 20, 300);
    const third = button("Third", c, 300, 100);
    const other = canvas({ sortOrder: 5 }, "Other");
    const elsewhere = button("Elsewhere", other, 900, 600);
    await pointer();
    first.focused = true;
    step();
    const all = [first, second, third, elsewhere];
    press("tab");
    expect(focusedName(...all)).toBe("Second");
    press("tab");
    expect(focusedName(...all)).toBe("Third");
    press("tab"); // wraps, never to the other canvas
    expect(focusedName(...all)).toBe("First");
    Input.inject.keyDown("shift");
    press("tab");
    expect(focusedName(...all)).toBe("Third");
    Input.inject.keyUp("shift");
    step();
  });
});

describe("submit and cancel (ADR 0340)", () => {
  it("clicks the focused button with Enter, Space or the south button, seen by every script phase of that frame", async () => {
    const c = canvas();
    const play = button("Play", c, 20, 20);
    await pointer();
    const seen: { phase: string; frame: number; clicked: boolean }[] = [];
    class Watcher extends GameBehavior {
      fixedUpdate() {
        seen.push({ phase: "fixed", frame: this.time.frameCount, clicked: play.clicked });
      }
      update() {
        seen.push({ phase: "update", frame: this.time.frameCount, clicked: play.clicked });
      }
    }
    GameObject.create("Watcher").addBehavior(Watcher);
    play.focused = true;
    step();
    seen.length = 0;
    Input.inject.keyDown("enter");
    step();
    const frame = World.require().time.frameCount;
    expect(seen.some((s) => s.phase === "fixed")).toBe(true);
    for (const s of seen) expect(s, s.phase).toEqual({ phase: s.phase, frame, clicked: true });
    step();
    expect(play.clicked).toBe(false); // held: one click
    Input.inject.keyUp("enter");
    step();
    Input.inject.keyDown("space");
    step();
    expect(play.clicked).toBe(true);
    Input.inject.keyUp("space");
    step();
    pad(1);
    step();
    Input.inject.gamepadButton(1, 0, 1);
    step();
    expect(play.clicked).toBe(true);
  });

  it("records cancel on the focused element's canvas", async () => {
    const c = canvas();
    const play = button("Play", c, 20, 20);
    const other = canvas({}, "Other");
    await pointer();
    play.focused = true;
    step();
    Input.inject.keyDown("escape");
    step();
    expect(c.canceled).toBe(true);
    expect(other.canceled).toBe(false);
    step();
    expect(c.canceled).toBe(false);
  });
});

describe("where focus can go (ADR 0340)", () => {
  it("focuses firstSelected, or else the first focusable element, when an autoFocus canvas becomes active", async () => {
    const menu = canvas({ autoFocus: true });
    const resume = button("Resume", menu, 20, 20);
    const quit = button("Quit", menu, 20, 100);
    menu.firstSelected = quit.node;
    menu.node.setActive(false);
    const p = await pointer();
    step();
    expect(focusedName(resume, quit)).toBeNull();
    menu.node.setActive(true); // the pause menu opens
    p.sync();
    step();
    expect(quit.focused).toBe(true);
    // Closed and opened again without firstSelected: its first element.
    menu.node.setActive(false);
    p.sync();
    step();
    menu.firstSelected = null;
    menu.node.setActive(true);
    p.sync();
    step();
    expect(resume.focused).toBe(true);
  });

  it("traps focus in a modal canvas over a HUD: focus moves in, Tab stays in, clicks outside don't take it", async () => {
    const hud = canvas({}, "HUD");
    const shop = button("Shop", hud, 1100, 20);
    const menu = canvas({ modal: true, sortOrder: 10 }, "Menu");
    const resume = button("Resume", menu, 500, 300);
    const quit = button("Quit", menu, 500, 400);
    menu.node.setActive(false);
    const p = await pointer();
    shop.focused = true;
    step();
    menu.node.setActive(true);
    p.sync();
    step();
    expect(resume.focused).toBe(true);
    press("tab");
    expect(quit.focused).toBe(true);
    press("tab");
    expect(resume.focused).toBe(true);
    p.click(shop);
    step();
    expect(resume.focused).toBe(true); // the press clicked the HUD button, but focus stays in the menu
    menu.node.setActive(false); // closed: the HUD is reachable again
    p.sync();
    step(); // a frame reads the button up between two presses (ADR 0336)
    p.click(shop);
    step();
    expect(shop.focused).toBe(true);
  });

  it("navigates a canvas only with the UI actions of its player, and switches the ui context on only for that player", async () => {
    engine.dispose();
    engine = await Engine.create({ headless: true, project: { input: { join: "onePerDevice", maxPlayers: 4 } } });
    const c = canvas({ player: 1 });
    const g = grid(c);
    await pointer();
    Input.inject.keyDown("shift"); // the keyboard joins as player 0
    pad(7); // the pad as player 1
    step();
    Input.inject.keyUp("shift");
    step();
    expect(InputPlayers.all().map((p) => p.index)).toEqual([0, 1]);
    g[0][0].focused = true;
    step();
    Input.inject.keyDown("arrowright");
    step();
    expect(g[0][0].focused).toBe(true); // player 0's keyboard doesn't drive it...
    expect(InputPlayers.get(0)!.performed("test.uiNavigation.Game:move")).toBe(true); // ...and its arrows are its game's
    Input.inject.keyUp("arrowright");
    step();
    padPress(7, DPAD.right);
    expect(g[0][1].focused).toBe(true);
  });
});

describe("consumption (ADR 0340)", () => {
  it("keeps a focused menu's arrows and Space from the game, and gives them back with nothing focused", async () => {
    const c = canvas();
    const g = grid(c);
    await pointer();
    const p0 = () => InputPlayers.get(0)!;
    step();
    Input.inject.keyDown("arrowdown");
    step();
    expect(p0().performed("test.uiNavigation.Game:move")).toBe(true);
    Input.inject.keyUp("arrowdown");
    step();
    g[0][0].focused = true;
    step();
    Input.inject.keyDown("arrowdown");
    step();
    expect(p0().held("test.uiNavigation.Game:move")).toBe(false);
    expect(g[1][0].focused).toBe(true);
    Input.inject.keyUp("arrowdown");
    step();
    Input.inject.keyDown("space");
    step();
    expect(p0().held("test.uiNavigation.Game:jump")).toBe(false);
    expect(g[1][0].clicked).toBe(true);
    Input.inject.keyUp("space");
    step();
    g[1][0].focused = false;
    step();
    Input.inject.keyDown("space");
    step();
    expect(p0().performed("test.uiNavigation.Game:jump")).toBe(true);
  });
});

describe("pointer focus (ADR 0340)", () => {
  it("focuses a clicked button, publishes focus and blur, and a click on nothing unfocuses", async () => {
    const c = canvas();
    const a = button("A", c, 20, 20);
    const b = button("B", c, 300, 20);
    const p = await pointer();
    p.click(a);
    step();
    expect(a.focused).toBe(true);
    expect(a.focusedChanged).toBe(true);
    step();
    expect(a.focusedChanged).toBe(false);
    p.click(b);
    step();
    expect(b.focused).toBe(true);
    expect(a.focusedChanged).toBe(true);
    step(); // a frame reads the button up between two presses (ADR 0336)
    p.dom.moveTo(1000, 600);
    p.dom.click();
    step();
    expect(focusedName(a, b)).toBeNull();
    // A script's focus is its own: no event.
    a.focused = true;
    step();
    expect(a.focusedChanged).toBe(false);
  });
});

describe("input fields (ADR 0340)", () => {
  let fake: FakeInput;
  beforeEach(() => {
    fake = stubDocument();
  });

  function field(name: string, parent: { node: GameObject }, x: number, y: number): UIInputField {
    return uiElement(name, parent.node, UIInputField, { positionType: "absolute", left: String(x), top: String(y), width: "200", height: "40" });
  }

  it("focuses a field by navigation without typing; submit starts typing; Tab, Escape and the gamepad leave it", async () => {
    const c = canvas();
    const back = button("Back", c, 20, 20);
    const name = field("Name", c, 20, 100);
    const ok = button("OK", c, 20, 200);
    const p = await pointer();
    pad(2);
    back.focused = true;
    step();
    press("arrowdown");
    expect(name.focused).toBe(true);
    expect(name.typing).toBe(false); // focused, but the keyboard is still the UI's
    press("enter");
    expect(name.typing).toBe(true);
    p.sync(); // the renderer gives the hidden input DOM focus
    // Typing keeps the keyboard: arrows move the caret, not focus.
    press("arrowdown");
    expect(name.typing).toBe(true);
    fake.typeText("Ada");
    step();
    expect(name.value).toBe("Ada");
    // Tab leaves for the next element (the hidden input takes the key from the game until it's released).
    fake.emit("keydown", { key: "Tab" });
    Input.inject.keyDown("tab");
    step();
    expect(ok.focused).toBe(true);
    Input.inject.keyUp("tab");
    step();
    // Back into the field with Shift+Tab and Enter, then Escape stops typing but keeps focus (no cancel on the canvas).
    Input.inject.keyDown("shift");
    press("tab");
    Input.inject.keyUp("shift");
    step();
    expect(name.focused).toBe(true);
    press("enter");
    p.sync();
    expect(name.typing).toBe(true);
    fake.emit("keydown", { key: "Escape" });
    Input.inject.keyDown("escape");
    step();
    expect(name.typing).toBe(false);
    expect(name.focused).toBe(true);
    expect(c.canceled).toBe(false);
    step();
    expect(c.canceled).toBe(false); // the Escape stays the field's until released
    Input.inject.keyUp("escape");
    step();
    // The gamepad navigates out of a typing field.
    press("enter");
    p.sync();
    expect(name.typing).toBe(true);
    padPress(2, DPAD.down);
    expect(ok.focused).toBe(true);
    expect(name.typing).toBe(false);
  });
});

describe("Svelte UI (ADR 0340, 0423)", () => {
  beforeEach(async () => {
    await loadUITestSupport();
  });

  it("reads focusable, nav-*, navigation, focus-color and the view's auto-focus and first-selected, and runs focus, blur, click and keydown handlers", async () => {
    const doc = buildUI(`<Canvas auto-focus first-selected="resume">
  <div flex-direction="column" gap="10">
    <button id="title" focusable="false" width="200" height="40">Paused</button>
    <button id="resume" nav-down="quit" width="200" height="40">Resume</button>
    <button id="options" navigation="explicit" width="200" height="40">Options</button>
    <button id="quit" focus-color="#ff0000" width="200" height="40">Quit</button>
  </div>
</Canvas>`, { name: "Pause" });
    const el = (id: string) => doc.query(`#${id}`)!;
    const btn = (id: string) => uiAs(el(id), UIButton);
    const root = uiAs(doc.root, UICanvas);
    expect(root.autoFocus).toBe(true);
    expect(root.firstSelected).toBe(el("resume").node);
    expect(btn("title").focusable).toBe(false);
    expect(btn("resume").navDown).toBe(el("quit").node);
    expect(btn("options").navigation).toBe("explicit");
    expect(btn("quit").focusColor.toHex().toLowerCase()).toBe("#ff0000");

    const log: string[] = [];
    for (const id of ["resume", "options", "quit"]) {
      el(id).on("focus", () => log.push(`focus ${id}`));
      el(id).on("blur", () => log.push(`blur ${id}`));
      el(id).on("click", () => log.push(`click ${id}`));
    }
    doc.root.on("keydown", (e) => log.push(`keydown ${e.key}`));

    await pointer();
    step();
    expect(btn("resume").focused).toBe(true); // auto-focus, on first-selected
    expect(log).toEqual(["focus resume"]);
    log.length = 0;
    press("arrowdown"); // nav-down skips Options
    expect(log).toEqual(["keydown ArrowDown", "blur resume", "focus quit"]);
    log.length = 0;
    press("arrowup"); // the search: Options (Title isn't focusable)
    expect(btn("options").focused).toBe(true);
    press("arrowup"); // explicit, with no nav-up: stays
    expect(btn("options").focused).toBe(true);
    log.length = 0;
    press("enter");
    press("escape");
    expect(log).toEqual(["keydown Enter", "click options", "keydown Escape"]);
  });

  it("follows the view's firstSelected to the element that has the id now, and to nothing once it's gone or cleared", async () => {
    const doc = buildUI(`<Canvas auto-focus first-selected="#later"><div flex-direction="column"><button id="a" width="100" height="40">A</button><button id="b" width="100" height="40">B</button></div></Canvas>`);
    const root = uiAs(doc.root, UICanvas);
    step();
    expect(root.firstSelected).toBeNull(); // no element has the id yet
    const b = doc.query("#b")!;
    b.tree.setAttributes(b, new Map([...b.attributes, ["id", "later"]]));
    step();
    expect(root.firstSelected).toBe(b.node);
    doc.view.firstSelected = "a";
    step();
    expect(root.firstSelected).toBe(doc.query("#a")!.node);
    doc.view.firstSelected = "";
    step();
    expect(root.firstSelected).toBeNull();
    doc.view.firstSelected = "later";
    step();
    expect(root.firstSelected).toBe(b.node);
    b.tree.remove(b);
    step();
    expect(root.firstSelected).toBeNull();
  });

  it("follows a nav reference to the element that has the id now, and to nothing once it's gone", async () => {
    const doc = buildUI(`<Canvas><div flex-direction="column"><button id="a" nav-down="c" width="100" height="40">A</button><button id="b" width="100" height="40">B</button></div></Canvas>`);
    const a = uiAs(doc.query("#a")!, UIButton);
    expect(a.navDown).toBeNull(); // no element has the id yet
    const b = doc.query("#b")!;
    b.tree.setAttributes(b, new Map([...b.attributes, ["id", "c"]]));
    step();
    expect(a.navDown).toBe(b.node);
    b.tree.remove(b);
    step();
    expect(a.navDown).toBeNull();
  });
});

describe("rebinding (ADR 0340)", () => {
  it("rebinds a UI action in the ui context like any other", async () => {
    const c = canvas();
    const play = button("Play", c, 20, 20);
    await pointer();
    play.focused = true;
    step();
    const p0 = InputPlayers.get(0)!;
    const result = p0.rebind("engine.UIActions:submit", { context: "ui", device: "keyboard" });
    step();
    Input.inject.keyDown("k");
    step();
    expect(play.clicked).toBe(false); // the press the rebind captured isn't also a submit
    Input.inject.keyUp("k");
    step();
    await expect(result).resolves.toMatchObject({ control: "<Keyboard>/k", canceled: false });
    Input.inject.keyDown("k");
    step();
    expect(play.clicked).toBe(true);
    Input.inject.keyUp("k");
    step();
    Input.inject.keyDown("enter"); // Enter's mapping was the one rebound
    step();
    expect(play.clicked).toBe(false);
  });

  it("doesn't navigate, submit or cancel with the press a rebind captures or cancels with", async () => {
    const c = canvas();
    const g = grid(c);
    await pointer();
    g[1][1].focused = true;
    step();
    const p0 = InputPlayers.get(0)!;
    const bound = p0.rebind("test.uiNavigation.Game:jump", { device: "keyboard" });
    step();
    Input.inject.keyDown("arrowright"); // captured: jump is bound to it, focus stays
    step();
    Input.inject.keyUp("arrowright");
    step();
    await expect(bound).resolves.toMatchObject({ control: "<Keyboard>/arrowright" });
    expect(g[1][1].focused).toBe(true);

    const canceled = p0.rebind("test.uiNavigation.Game:jump", { device: "keyboard", cancel: "<Keyboard>/escape" });
    step();
    Input.inject.keyDown("escape");
    step();
    expect(c.canceled).toBe(false); // Escape canceled the rebind, not the menu
    Input.inject.keyUp("escape");
    step();
    await expect(canceled).resolves.toMatchObject({ canceled: true });
    press("arrowleft"); // and navigation goes on
    expect(g[1][0].focused).toBe(true);
  });
});

describe("navigation at a low frame rate (ADR 0336 snapshot rules, ADR 0340)", () => {
  // 10 fps: a frame lasts 100 ms, longer than a quick key press, so whole taps (and Shift+Tab) land inside frames.
  const SLOW = 0.1;
  /** Apply key events ("+key" down, "-key" up), then step one slow frame. */
  const frame = (...keys: string[]) => {
    for (const k of keys) {
      if (k.startsWith("+")) Input.inject.keyDown(k.slice(1));
      else Input.inject.keyUp(k.slice(1));
    }
    step(1, SLOW);
  };
  /** A row of four buttons, the third focused; returns the name of the focused one after each step. */
  async function row(): Promise<() => string | null> {
    const c = canvas();
    const all = ["A", "B", "C", "D"].map((name, i) => button(name, c, 20 + i * 150, 20));
    await pointer();
    all[2].focused = true;
    frame();
    return () => focusedName(...all);
  }
  const tap = (key: string) => [`+${key}`, `-${key}`];

  it("moves once for each Tab tapped in consecutive frames, and each arrow tap", async () => {
    const focus = await row();
    const seen: (string | null)[] = [];
    frame(...tap("tab"));
    seen.push(focus());
    frame(...tap("tab")); // waits a frame: this one reads Tab up
    seen.push(focus());
    frame();
    seen.push(focus());
    frame(...tap("arrowleft"));
    seen.push(focus());
    frame(...tap("arrowleft"));
    frame();
    seen.push(focus());
    expect(seen).toEqual(["D", "D", "A", "A", "A"]); // the arrows stop at the edge
    frame(...tap("arrowright"), ...tap("arrowright")); // two taps inside one frame: both count
    frame();
    frame();
    expect(focus()).toBe("C");
  });

  it("treats Shift+Tab as Shift+Tab when it's all inside one frame, or Shift is lifted in the frame Tab is tapped", async () => {
    const focus = await row();
    frame("+shift", ...tap("tab"), "-shift");
    expect(focus()).toBe("B");
    frame();
    frame("+shift");
    frame(...tap("tab"), "-shift");
    expect(focus()).toBe("A");
    frame();
    expect(focus()).toBe("A");
  });

  it("moves forward then back for Tab, then Shift+Tab in the next frame", async () => {
    const focus = await row();
    frame(...tap("tab"));
    expect(focus()).toBe("D");
    frame("+shift", ...tap("tab"), "-shift");
    frame();
    frame();
    expect(focus()).toBe("C");
  });

  it("moves for each d-pad tap in consecutive frames", async () => {
    const focus = await row();
    pad(5);
    frame();
    const dpadTap = () => {
      Input.inject.gamepadButton(5, DPAD.left, 1);
      Input.inject.gamepadButton(5, DPAD.left, 0);
    };
    dpadTap();
    frame();
    dpadTap();
    frame();
    frame();
    expect(focus()).toBe("A");
  });
});
