import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Input, InputPlayers, button, chordOf, defineActions, dpad, vec2 } from "../index";
import { UIButton, UICanvas, UIImage, UIText } from "../ui/components";
import { UIControlMapper } from "../ui/controlMapper";
import { World } from "../core/World";
import { UIPointer, stubDocument } from "./uiPointer";
import { loadUIDocumentSupport } from "../ui/UIDocument";
import { buildUI, byId } from "./uiMarkup";

// ADR 0337, 0339 and 0340: the engine's rebinding screen, driven as a player does: clicks through a UI
// core, keys and pad buttons through Input (focus navigation moves between its buttons and `submit`
// clicks them), results read from what it shows, which button has focus, and the player's bindings.

defineActions("test.uiControlMapper.Actions", {
  jump: button("<Keyboard>/space", "<Gamepad>/buttonSouth"),
  move: vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d"), "<Gamepad>/leftStick"),
  bomb: button("<Keyboard>/b"),
  dash: button(chordOf("<Keyboard>/shift", "<Keyboard>/x"), chordOf("<Gamepad>/leftShoulder", "<Gamepad>/buttonWest")),
  look: vec2("<Pointer>/delta"),
});

const DT = 1 / 60;
let engine: Engine;
let pointers: UIPointer[] = [];
let pads: number[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
  stubDocument();
});

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  for (const id of pads.splice(0)) Input.inject.gamepadDisconnected(id);
  engine.step(DT);
  Input.inject.releaseAll();
  vi.unstubAllGlobals();
  engine.dispose();
  Assets.clearSources();
  Input.reset();
});

/** Step the World, then lay its UI out again, as the renderer does every frame: navigation searches that layout. */
const step = (frames = 1) => {
  for (let i = 0; i < frames; i++) {
    engine.step(DT);
    for (const p of pointers) p.sync();
  }
};

/** Press and release a key, a frame each. */
function tap(key: string): void {
  Input.inject.keyDown(key);
  step();
  Input.inject.keyUp(key);
  step();
}

/** A UI core laying the World's UI out and routing the pointer (tall enough for every row). */
async function pointer(height = 1400): Promise<UIPointer> {
  const p = await UIPointer.create(World.require(), 1280, height);
  pointers.push(p);
  return p;
}

/** A mapper under a game's canvas (a UI document's), with a UI core laying it out. */
async function mapper(init: Partial<UIControlMapper> = {}): Promise<UIControlMapper> {
  const canvas = byId(buildUI(`<Canvas id="Canvas"/>`), "Canvas", UICanvas);
  const m = GameObject.create("Controls", { parent: canvas.node }).addBehavior(UIControlMapper, { actions: "jump, move, bomb", ...init } as never);
  step();
  await pointer();
  step();
  return m;
}

function pad(id: number, family: "xbox" | "playstation" = "xbox"): void {
  pads.push(id);
  Input.inject.gamepadConnected({ id, name: "Pad", family });
  step();
}

/** Press and release a pad button, a frame each. */
function padPress(id: number, buttonIndex: number): void {
  Input.inject.gamepadButton(id, buttonIndex, 1);
  step();
  Input.inject.gamepadButton(id, buttonIndex, 0);
  step();
}

const DPAD = { up: 12, down: 13, left: 14, right: 15 } as const;
const SOUTH = 0;

const row = (m: UIControlMapper, label: string) => {
  const r = m.rows.find((x) => x.label === label);
  if (!r) throw new Error(`No row "${label}" (rows: ${m.rows.map((x) => x.label).join(", ")}).`);
  return r;
};

/** Which of the screen's buttons has focus: `"<row>/<device>"` for a cell, `"<setting>/<toggle|decrease|increase>"`, `"Unbind"`, `"Reset"`, `"Save"`, or null. */
function focused(m: UIControlMapper): string | null {
  for (const r of m.rows) for (const c of [r.keyboard, r.gamepad]) if (c?.button.focused) return `${r.label}/${c.device}`;
  for (const s of m.settings) for (const op of ["toggle", "decrease", "increase"] as const) if (s[op]?.focused) return `${s.label}/${op}`;
  const buttons: [string, UIButton | null][] = [
    ["Unbind", m.unbindButton],
    ["Reset", m.resetButton],
    ["Save", m.saveButton],
  ];
  return buttons.find(([, b]) => b?.focused)?.[0] ?? null;
}

/** The texts drawn inside a node. */
const texts = (node: GameObject): string[] => [...node.children.flatMap((c) => [...(c.getComponent(UIText) ? [c.getComponent(UIText)!.text] : []), ...texts(c)])];
const images = (node: GameObject): string[] => node.children.map((c) => c.getComponent(UIImage)).filter((i) => i && i.display !== "none").map((i) => i!.image);

describe("UIControlMapper (ADR 0337)", () => {
  it("lists the actions with their keyboard and gamepad bindings, glyphs and labels, a row per composite part", async () => {
    const m = await mapper();
    expect(m.rows.map((r) => r.label)).toEqual(["Jump", "Move Up", "Move Down", "Move Left", "Move Right", "Bomb"]);
    const jump = row(m, "Jump");
    expect(jump.keyboard).toMatchObject({ action: "jump", label: "Space", icons: ["keyboard/space"], part: "control" });
    expect(jump.gamepad).toMatchObject({ label: "South", icons: ["generic/buttonSouth"], part: "control" }); // no pad yet
    expect(texts(jump.keyboard!.button.node)).toEqual(["Space"]);
    expect(images(jump.keyboard!.button.node)).toEqual(["asset:@myco/glyphs/keyboard/space.svg"]);
    expect(row(m, "Move Left").keyboard).toMatchObject({ action: "move", label: "A", part: "left" });
    expect(row(m, "Move Up").gamepad).toMatchObject({ label: "Left Stick", part: "control" });
    expect(row(m, "Move Down").gamepad).toMatchObject({ label: "—", part: null }); // the stick is one binding, on the first row
    expect(row(m, "Bomb").gamepad).toMatchObject({ label: "—", part: null });
    expect(texts(m.node)).toEqual(expect.arrayContaining(["Controls", "Keyboard", "Gamepad", "Unbind", "Reset to defaults", "Save"]));
  });

  it("lists every action set but the engine's UI actions when `actions` is empty, and those only when named", async () => {
    const all = await mapper({ actions: "" });
    expect(all.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["jump", "move", "bomb", "dash", "look"]));
    expect(all.rows.some((r) => r.action.includes("UIActions"))).toBe(false);
    all.actions = "engine.UIActions:submit";
    step();
    expect(all.rows.map((r) => r.action)).toEqual(["engine.UIActions:submit"]);
  });

  it("names the gamepad column for the pad the player last used", async () => {
    const m = await mapper();
    pad(5, "playstation");
    expect(row(m, "Jump").gamepad!.label).toBe("Cross"); // a paired pad, before it's used
    m.rows[0].keyboard!.button.focused = false; // nothing focused: the pad's press is the game's, not a click
    step();
    padPress(5, 0);
    expect(InputPlayers.get(0)!.lastFamily).toBe("playstation");
    expect(images(row(m, "Jump").gamepad!.button.node)).toEqual(["asset:@myco/glyphs/playstation/buttonSouth.svg"]);
  });

  it("rebinds the clicked cell to the next key, showing the wait and then the new binding", async () => {
    const m = await mapper();
    const p = pointers[0];
    p.click(row(m, "Jump").keyboard!.button);
    step(2);
    expect(m.rebinding).toEqual({ action: "jump", device: "keyboard" });
    expect(m.status).toBe("Press a key… (Esc to cancel)");
    expect(texts(row(m, "Jump").keyboard!.button.node)).toEqual(["Press a key…"]);
    tap("k");
    expect(m.rebinding).toBeNull();
    expect(row(m, "Jump").keyboard).toMatchObject({ label: "K", icons: ["keyboard/k"] });
    expect(m.status).toBe("Jump: K");
    expect(InputPlayers.get(0)!.prompt("jump", "keyboard")!.label).toBe("K");
  });

  it("gives its first cell focus under a game's canvas, unless something on that canvas has it", async () => {
    const m = await mapper();
    expect(focused(m)).toBe("Jump/keyboard");
    expect(m.focusedCell).toMatchObject({ action: "jump", device: "keyboard", label: "Space" });
    // The focused button has the accent border, after mouse use too (Delete and Unbind act on it).
    expect(row(m, "Jump").keyboard!.button.borderColor).toEqual(m.accentColor);
    expect(row(m, "Jump").gamepad!.button.borderColor).toEqual(m.cellColor);
    pointers[0].click(row(m, "Jump").gamepad!.button);
    step(2);
    tap("escape"); // the click started a rebind
    expect(focused(m)).toBe("Jump/gamepad");
    expect(row(m, "Jump").gamepad!.button.borderColor).toEqual(m.accentColor);
    expect(row(m, "Jump").keyboard!.button.borderColor).toEqual(m.cellColor);

    const menu = buildUI(`<Canvas id="Menu"><Button id="Play"/></Canvas>`);
    const canvas = byId(menu, "Menu", UICanvas);
    const play = byId(menu, "Play", UIButton);
    play.focused = true;
    const other = GameObject.create("Controls", { parent: canvas.node }).addBehavior(UIControlMapper, { actions: "jump" } as never);
    step(2);
    expect(play.focused).toBe(true);
    expect(other.focusedCell).toBeNull();
  });

  it("is driven by the keyboard: the arrows move focus, Enter rebinds, Escape cancels, and conflicts are shown", async () => {
    const m = await mapper();
    tap("arrowdown");
    tap("arrowdown");
    tap("arrowup");
    expect(focused(m)).toBe("Move Up/keyboard");
    tap("enter");
    expect(m.rebinding).toEqual({ action: "move", device: "keyboard" });
    tap("arrowdown"); // captured by the rebind: focus doesn't move
    expect(m.rebinding).toBeNull();
    expect(row(m, "Move Up").keyboard!.label).toBe("↓");
    expect(focused(m)).toBe("Move Up/keyboard");

    tap("enter");
    tap("escape");
    expect(m.rebinding).toBeNull();
    expect(m.status).toBe("Canceled.");
    expect(focused(m)).toBe("Move Up/keyboard"); // Escape and the key that ends a wait don't move focus

    tap("enter");
    tap("b"); // Bomb's key
    expect(row(m, "Move Up").keyboard!.label).toBe("B");
    expect(m.conflicts).toEqual(["default: bomb"]);
    expect(m.status).toBe("B is also bound to Bomb.");
    expect(row(m, "Move Up").keyboard!.conflict).toBe(true);
    expect(row(m, "Bomb").keyboard!.conflict).toBe(true);
    expect(row(m, "Jump").keyboard!.conflict).toBe(false);

    // Right moves to the gamepad column; Move Down's empty gamepad cell is skipped (nothing to rebind there).
    tap("arrowright");
    expect(focused(m)).toBe("Move Up/gamepad");
    expect(row(m, "Move Down").gamepad!.button.interactable).toBe(false);
    tap("arrowdown");
    expect(focused(m)).toBe("Bomb/gamepad"); // its empty cell adds a binding
    // Past the last row are the buttons.
    tap("arrowdown");
    expect(focused(m)).toMatch(/^(Unbind|Reset|Save)$/);
  });

  it("rebinds a gamepad cell to the next button, focused with the d-pad and clicked with the south button", async () => {
    const m = await mapper();
    pad(3);
    padPress(3, DPAD.right); // the gamepad column
    expect(focused(m)).toBe("Jump/gamepad");
    padPress(3, SOUTH);
    expect(m.rebinding).toEqual({ action: "jump", device: "gamepad" });
    expect(m.status).toBe("Press a button… (Esc to cancel)");
    tap("q"); // keys don't bind a gamepad cell
    padPress(3, 3); // north
    expect(row(m, "Jump").gamepad).toMatchObject({ label: "Y", icons: ["xbox/buttonNorth"] });
    expect(focused(m)).toBe("Jump/gamepad");
  });

  it("moves focus with the left stick", async () => {
    const m = await mapper();
    pad(4);
    Input.inject.gamepadAxis(4, 1, 0.9); // left stick down (+Y down on the wire)
    step();
    Input.inject.gamepadAxis(4, 1, 0);
    step();
    expect(focused(m)).toBe("Move Up/keyboard");
    Input.inject.gamepadAxis(4, 0, 0.9); // right
    step();
    Input.inject.gamepadAxis(4, 0, 0);
    step();
    expect(focused(m)).toBe("Move Up/gamepad");
  });

  it("resets to the defaults and saves the bindings with the game's settings", async () => {
    const m = await mapper();
    tap("enter");
    tap("j");
    expect(row(m, "Jump").keyboard!.label).toBe("J");
    m.saveButton!.focused = true;
    step();
    tap("enter"); // Save
    await vi.waitFor(() => expect(m.status).toBe("Saved."));

    const p = pointers[0];
    p.click(m.resetButton!);
    step(2);
    expect(m.status).toBe("Bindings reset to the defaults.");
    expect(row(m, "Jump").keyboard!.label).toBe("Space");

    expect(await InputPlayers.get(0)!.loadBindings()).toBe(true); // what Save wrote
    step();
    expect(row(m, "Jump").keyboard!.label).toBe("J");
  });

  it("shows only the columns asked for, and its own words", async () => {
    const m = await mapper({ gamepad: false });
    m.text.keyboard = "Tastatur";
    m.actionLabels = { jump: "Springen" };
    step();
    expect(row(m, "Springen").gamepad).toBeNull();
    expect(texts(m.node)).toContain("Tastatur");
    m.gamepad = true;
    step();
    expect(row(m, "Springen").gamepad!.label).toBe("South");
  });

  it("makes its own screen canvas when there's none above it, which takes focus for its player, and removes what it built with it", async () => {
    const node = GameObject.create("Menu");
    const m = node.addBehavior(UIControlMapper, { actions: "jump", player: 0, modal: true } as never);
    step();
    await pointer();
    step();
    const canvas = node.getComponentInChildren(UICanvas)?.node; // its built-in document's root
    expect(canvas).toBeDefined();
    expect(canvas!.getComponent(UICanvas)).toMatchObject({ autoFocus: true, player: 0, modal: true });
    expect(m.rows).toHaveLength(1);
    expect(focused(m)).toBe("Jump/keyboard"); // autoFocus: a d-pad player has focus without clicking
    tap("arrowright");
    expect(focused(m)).toBe("Jump/gamepad");
    node.removeBehavior(m);
    step();
    expect(canvas!.isValid).toBe(false);
  });

  it("shows a chord as one cell with every glyph, and rebinds it to the keys pressed together", async () => {
    const m = await mapper({ actions: "dash" });
    const dash = row(m, "Dash");
    expect(dash.keyboard).toMatchObject({ label: "Shift + X", icons: ["keyboard/shift", "keyboard/x"], part: "control", chord: true });
    expect(images(dash.keyboard!.button.node)).toEqual(["asset:@myco/glyphs/keyboard/shift.svg", "asset:@myco/glyphs/keyboard/x.svg"]);
    expect(texts(dash.keyboard!.button.node)).toEqual(["Shift + X"]);
    expect(dash.gamepad).toMatchObject({ label: "L1 + West", icons: ["generic/leftShoulder", "generic/buttonWest"], chord: true });

    const p = pointers[0];
    p.click(dash.keyboard!.button);
    step(2);
    expect(m.rebinding).toEqual({ action: "dash", device: "keyboard" });
    expect(m.status).toBe("Hold the keys together, then let go… (Esc to cancel)");
    expect(texts(row(m, "Dash").keyboard!.button.node)).toEqual(["Press the keys…"]);
    Input.inject.keyDown("control");
    step();
    Input.inject.keyDown("n");
    step();
    expect(m.rebinding).not.toBeNull(); // still held: it finishes when a key is let go
    Input.inject.keyUp("n");
    step();
    Input.inject.keyUp("control");
    step();
    expect(m.rebinding).toBeNull();
    expect(row(m, "Dash").keyboard).toMatchObject({ label: "Ctrl + N", icons: ["keyboard/control", "keyboard/n"] });
    expect(m.status).toBe("Dash: Ctrl + N");
    expect(InputPlayers.get(0)!.prompt("dash", "keyboard")!.label).toBe("Ctrl+N");

    // A chord of another size replaces the binding (ADR 0339): a lone key. The click focused the cell, so Enter clicks it.
    tap("enter");
    expect(m.rebinding).toEqual({ action: "dash", device: "keyboard" });
    tap("m");
    expect(m.rebinding).toBeNull();
    expect(m.status).toBe("Dash: M");
    expect(row(m, "Dash").keyboard).toMatchObject({ label: "M", chord: false });
  });

  it("rebinds a gamepad chord from the pad", async () => {
    const m = await mapper({ actions: "dash" });
    pad(6);
    expect(row(m, "Dash").gamepad!.label).toBe("LB + X");
    const press = (button: number, value: number) => {
      Input.inject.gamepadButton(6, button, value);
      step();
    };
    press(DPAD.right, 1); // the gamepad column
    press(DPAD.right, 0);
    press(SOUTH, 1); // rebind (its release doesn't end the wait)
    press(SOUTH, 0);
    expect(m.status).toBe("Hold the buttons together, then let go… (Esc to cancel)");
    press(5, 1); // RB
    press(3, 1); // Y
    press(3, 0);
    press(5, 0);
    expect(row(m, "Dash").gamepad).toMatchObject({ label: "RB + Y", icons: ["xbox/rightShoulder", "xbox/buttonNorth"] });
  });

  describe("adding and unbinding (ADR 0339)", () => {
    it("adds a binding from an empty cell", async () => {
      const m = await mapper();
      expect(row(m, "Bomb").gamepad).toMatchObject({ label: "—", part: null, adds: true });
      expect(row(m, "Bomb").gamepad!.button.interactable).toBe(true);
      expect(row(m, "Move Down").gamepad).toMatchObject({ part: null, adds: false }); // the stick's binding is on Move Up's row
      pad(3);
      for (let i = 0; i < 5; i++) tap("arrowdown");
      tap("arrowright");
      expect(focused(m)).toBe("Bomb/gamepad");
      tap("enter");
      expect(m.rebinding).toEqual({ action: "bomb", device: "gamepad" });
      expect(m.status).toBe("Press a button… (Esc to cancel)");
      padPress(3, 5); // right shoulder
      expect(m.rebinding).toBeNull();
      expect(row(m, "Bomb").gamepad).toMatchObject({ label: "RB", part: "control", adds: false });
      expect(m.status).toBe("Bomb: RB");
      Input.inject.gamepadButton(3, 5, 1);
      step();
      expect(InputPlayers.get(0)!.performed("bomb")).toBe(true);
      Input.inject.gamepadButton(3, 5, 0);
      step();
    });

    it("unbinds the focused cell with Delete or Backspace, and the last focused one with the Unbind button, and saves it", async () => {
      const m = await mapper();
      tap("delete"); // Jump, keyboard
      expect(row(m, "Jump").keyboard).toMatchObject({ label: "—", part: null, adds: true });
      expect(m.status).toBe("Jump: unbound.");
      expect(InputPlayers.get(0)!.prompt("jump", "keyboard")).toBeNull();
      expect(focused(m)).toBe("Jump/keyboard"); // an empty first-row cell adds, so it keeps focus
      m.rows[0].keyboard!.button.focused = false; // nothing focused: Space is the game's again
      step();
      Input.inject.keyDown("space");
      step();
      expect(InputPlayers.get(0)!.held("jump")).toBe(false);
      Input.inject.keyUp("space");
      step();

      row(m, "Jump").gamepad!.button.focused = true;
      step();
      tap("backspace"); // Jump, gamepad
      expect(row(m, "Jump").gamepad).toMatchObject({ label: "—", adds: true });

      // The Unbind button acts on the binding cell last focused: Bomb's keyboard cell.
      tap("arrowdown");
      expect(focused(m)).toBe("Move Up/gamepad");
      tap("arrowdown"); // Move Down to Move Right have no gamepad binding of their own: skipped
      expect(focused(m)).toBe("Bomb/gamepad");
      tap("arrowleft");
      expect(focused(m)).toBe("Bomb/keyboard");
      expect(m.focusedCell).toMatchObject({ action: "bomb", device: "keyboard" });
      const p = pointers[0];
      p.click(m.unbindButton!);
      step(2);
      expect(row(m, "Bomb").keyboard).toMatchObject({ label: "—", adds: true });
      expect(m.status).toBe("Bomb: unbound.");
      expect(m.unbindButton!.interactable).toBe(false); // nothing left to unbind there
      expect(focused(m)).toBe("Bomb/keyboard"); // the button lost focus with interactable: it went back to the cell
      p.leave();

      // Unbinding a d-pad part removes the whole keyboard binding: Move's rows follow the stick, and focus stays near.
      tap("arrowup");
      expect(focused(m)).toBe("Move Right/keyboard");
      tap("delete");
      expect(m.rows.map((r) => r.label)).toEqual(["Jump", "Move", "Bomb"]);
      step();
      expect(focused(m)).toBe("Bomb/keyboard");

      // Save, reset, load: the unbinding comes back.
      p.click(m.saveButton!);
      step(2);
      await vi.waitFor(() => expect(m.status).toBe("Saved."));
      InputPlayers.get(0)!.resetBindings();
      step();
      expect(row(m, "Jump").keyboard!.label).toBe("Space");
      expect(await InputPlayers.get(0)!.loadBindings()).toBe(true);
      step();
      expect(row(m, "Jump").keyboard!.label).toBe("—");
      expect(row(m, "Bomb").keyboard!.label).toBe("—");
    });

    it("unbinds with the Unbind button reached by navigation", async () => {
      const m = await mapper();
      for (let i = 0; i < 5; i++) tap("arrowdown");
      expect(focused(m)).toBe("Bomb/keyboard");
      m.unbindButton!.focused = true;
      step();
      tap("enter");
      expect(row(m, "Bomb").keyboard).toMatchObject({ label: "—", adds: true });
      expect(m.focusedCell).toMatchObject({ action: "bomb", device: "keyboard" });
    });

    it("words the Unbind button through its text", async () => {
      const m = await mapper();
      m.text.unbind = "Entfernen";
      step();
      expect(texts(m.unbindButton!.node)).toEqual(["Entfernen"]);
    });
  });

  describe("accessibility", () => {
    const options = { actions: "jump", showAccessibility: true, invertYActions: "look", sensitivityActions: "look", holdToToggleActions: "jump" };
    const setting = (m: UIControlMapper, label: string) => {
      const s = m.settings.find((x) => x.label === label);
      if (!s) throw new Error(`No setting "${label}" (settings: ${m.settings.map((x) => x.label).join(", ")}).`);
      return s;
    };

    it("is off unless asked for", async () => {
      const m = await mapper({ actions: "jump" });
      expect(m.settings).toEqual([]);
      expect(texts(m.node)).not.toContain("Accessibility");
    });

    it("lists toggles and steppers with the player's settings", async () => {
      step();
      InputPlayers.get(0)!.accessibility = { sensitivity: { look: 1.5 }, deadzone: 0.25 };
      const m = await mapper(options);
      expect(m.settings.map((s) => [s.label, s.value, s.enabled])).toEqual([
        ["Look: Invert Y", "Off", true],
        ["Look: Sensitivity", "1.5×", true],
        ["Jump: Press to toggle", "Off", true],
        ["Repeat held buttons", "Off", true],
        ["Repeat delay", "0.4 s", false],
        ["Repeat interval", "0.1 s", false],
        ["Stick dead zone", "25%", true],
      ]);
      expect(setting(m, "Look: Invert Y").toggle).not.toBeNull();
      expect(setting(m, "Look: Sensitivity")).toMatchObject({ toggle: null });
      expect(texts(m.node)).toEqual(expect.arrayContaining(["Accessibility", "Look: Sensitivity", "1.5×", "−", "+"]));
    });

    it("changes settings by mouse, and the evaluator applies them", async () => {
      const m = await mapper(options);
      const p = pointers[0];
      p.click(setting(m, "Look: Invert Y").toggle!);
      step(2);
      expect(setting(m, "Look: Invert Y").value).toBe("On");
      expect(InputPlayers.get(0)!.accessibility.invertY).toEqual(["look"]);
      Input.inject.move(0, 5);
      step();
      expect(InputPlayers.get(0)!.vector2("look").y).toBe(5); // inverted: the mouse moved down, look's +Y is up

      p.click(setting(m, "Look: Sensitivity").increase!);
      step(2);
      p.click(setting(m, "Look: Sensitivity").increase!);
      step(2);
      expect(setting(m, "Look: Sensitivity").value).toBe("1.2×");
      expect(InputPlayers.get(0)!.accessibility.sensitivity).toEqual({ look: 1.2 });

      // The repeat steppers do nothing while repeat is off.
      expect(setting(m, "Repeat delay").increase!.interactable).toBe(false);
      p.click(setting(m, "Repeat held buttons").toggle!);
      step(2);
      expect(InputPlayers.get(0)!.accessibility.repeat).toEqual({ delay: 0.4, interval: 0.1 });
      expect(setting(m, "Repeat delay").enabled).toBe(true);
      p.click(setting(m, "Repeat delay").decrease!);
      step(2);
      expect(setting(m, "Repeat delay").value).toBe("0.35 s");
      // Off and on again keeps the times.
      p.click(setting(m, "Repeat held buttons").toggle!);
      step(2);
      expect(InputPlayers.get(0)!.accessibility.repeat).toBeUndefined();
      p.click(setting(m, "Repeat held buttons").toggle!);
      step(2);
      expect(InputPlayers.get(0)!.accessibility.repeat).toEqual({ delay: 0.35, interval: 0.1 });
    });

    it("is driven by the keyboard and d-pad like the bindings, and Save writes it", async () => {
      const m = await mapper({ ...options, repeatActions: "jump" });
      // Jump's cells, then the seven settings, then the buttons.
      tap("arrowdown");
      expect(focused(m)).toBe("Look: Invert Y/toggle");
      tap("arrowdown"); // row by row: a stepper's −, then the next toggle
      expect(focused(m)).toBe("Look: Sensitivity/decrease");
      tap("arrowdown");
      expect(focused(m)).toBe("Jump: Press to toggle/toggle");
      tap("enter");
      expect(InputPlayers.get(0)!.accessibility.holdToToggle).toEqual(["jump"]);
      expect(m.rebinding).toBeNull();
      tap("arrowdown");
      tap("enter"); // repeat on
      expect(InputPlayers.get(0)!.accessibility.repeat).toEqual({ delay: 0.4, interval: 0.1, actions: ["jump"] });
      tap("arrowdown");
      expect(focused(m)).toBe("Repeat delay/decrease"); // turned on: the repeat steppers take focus now
      tap("arrowdown");
      tap("arrowright");
      expect(focused(m)).toBe("Repeat interval/increase");
      tap("enter");
      expect(setting(m, "Repeat interval").value).toBe("0.15 s");

      pad(2);
      padPress(2, DPAD.down); // the dead zone, +
      expect(focused(m)).toBe("Stick dead zone/increase");
      padPress(2, SOUTH);
      expect(setting(m, "Stick dead zone").value).toBe("20%");
      padPress(2, DPAD.left);
      expect(focused(m)).toBe("Stick dead zone/decrease");
      padPress(2, SOUTH);
      padPress(2, SOUTH);
      expect(setting(m, "Stick dead zone").value).toBe("10%");
      expect(InputPlayers.get(0)!.accessibility.deadzone).toBe(0.1);

      padPress(2, DPAD.down); // the buttons, after the rows
      expect(focused(m)).toBe("Reset");
      padPress(2, DPAD.right);
      expect(focused(m)).toBe("Save");
      padPress(2, SOUTH);
      await vi.waitFor(() => expect(m.status).toBe("Saved."));
      InputPlayers.get(0)!.accessibility = {};
      step();
      expect(setting(m, "Stick dead zone").value).toBe("15%");
      expect(await InputPlayers.get(0)!.loadBindings()).toBe(true);
      step();
      expect(setting(m, "Stick dead zone").value).toBe("10%");
      expect(InputPlayers.get(0)!.accessibility).toMatchObject({ holdToToggle: ["jump"], repeat: { delay: 0.4, interval: 0.15, actions: ["jump"] }, deadzone: 0.1 });
    });

    it("shows its own words", async () => {
      const m = await mapper(options);
      Object.assign(m.text, { accessibility: "Barrierefreiheit", invertY: "{action}: Y umkehren", on: "An", off: "Aus", seconds: "{value} Sek.", percent: "{value} %" });
      m.actionLabels = { look: "Umsehen" };
      step();
      expect(setting(m, "Umsehen: Y umkehren").value).toBe("Aus");
      expect(setting(m, "Repeat delay").value).toBe("0.4 Sek.");
      expect(setting(m, "Stick dead zone").value).toBe("15 %");
      expect(texts(m.node)).toEqual(expect.arrayContaining(["Barrierefreiheit", "Aus"]));
    });
  });
});
