import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input, InputPlayers, button, chordOf, defineActions, dpad, vec2 } from "../index";
import { UICanvas, UIImage, UIText } from "../ui/components";
import { UIControlMapper } from "../ui/controlMapper";
import { World } from "../core/World";
import { UIPointer, stubDocument } from "./uiPointer";

// ADR 0337: the engine's rebinding screen, driven as a player does: clicks through a UI core, keys
// and pad buttons through Input, results read from what it shows and from the player's bindings.

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
  stubDocument();
});

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  for (const id of pads.splice(0)) Input.inject.gamepadDisconnected(id);
  engine.step(DT);
  Input.inject.releaseAll();
  vi.unstubAllGlobals();
  engine.dispose();
  Input.reset();
});

const step = (frames = 1) => {
  for (let i = 0; i < frames; i++) engine.step(DT);
};

/** Press and release a key, a frame each. */
function tap(key: string): void {
  Input.inject.keyDown(key);
  step();
  Input.inject.keyUp(key);
  step();
}

function mapper(init: Partial<UIControlMapper> = {}): UIControlMapper {
  const canvas = GameObject.create("Canvas").addBehavior(UICanvas);
  const m = GameObject.create("Controls", { parent: canvas.node }).addBehavior(UIControlMapper, { actions: "jump, move, bomb", ...init } as never);
  step();
  return m;
}

async function pointer(): Promise<UIPointer> {
  const p = await UIPointer.create(World.require());
  pointers.push(p);
  return p;
}

const row = (m: UIControlMapper, label: string) => {
  const r = m.rows.find((x) => x.label === label);
  if (!r) throw new Error(`No row "${label}" (rows: ${m.rows.map((x) => x.label).join(", ")}).`);
  return r;
};
/** The texts drawn inside a node. */
const texts = (node: GameObject): string[] => [...node.children.flatMap((c) => [...(c.getComponent(UIText) ? [c.getComponent(UIText)!.text] : []), ...texts(c)])];
const images = (node: GameObject): string[] => node.children.map((c) => c.getComponent(UIImage)).filter((i) => i && i.display !== "none").map((i) => i!.image);

describe("UIControlMapper (ADR 0337)", () => {
  it("lists the actions with their keyboard and gamepad bindings, glyphs and labels, a row per composite part", () => {
    const m = mapper();
    expect(m.rows.map((r) => r.label)).toEqual(["Jump", "Move Up", "Move Down", "Move Left", "Move Right", "Bomb"]);
    const jump = row(m, "Jump");
    expect(jump.keyboard).toMatchObject({ label: "Space", icons: ["keyboard/space"], part: "control" });
    expect(jump.gamepad).toMatchObject({ label: "South", icons: ["generic/buttonSouth"], part: "control" }); // no pad yet
    expect(texts(jump.keyboard!.button.node)).toEqual(["Space"]);
    expect(images(jump.keyboard!.button.node)).toEqual(["asset:@myco/glyphs/keyboard/space.svg"]);
    expect(row(m, "Move Left").keyboard).toMatchObject({ label: "A", part: "left" });
    expect(row(m, "Move Up").gamepad).toMatchObject({ label: "Left Stick", part: "control" });
    expect(row(m, "Move Down").gamepad).toMatchObject({ label: "—", part: null }); // the stick is one binding, on the first row
    expect(row(m, "Bomb").gamepad).toMatchObject({ label: "—", part: null });
    expect(texts(m.node)).toEqual(expect.arrayContaining(["Controls", "Keyboard", "Gamepad", "Unbind", "Reset to defaults", "Save"]));
  });

  it("names the gamepad column for the pad the player last used", () => {
    const m = mapper();
    pads.push(5);
    Input.inject.gamepadConnected({ id: 5, name: "Pad", family: "playstation" });
    step();
    expect(row(m, "Jump").gamepad!.label).toBe("Cross"); // a paired pad, before it's used
    Input.inject.gamepadButton(5, 0, 1);
    step();
    Input.inject.gamepadButton(5, 0, 0);
    step();
    expect(InputPlayers.get(0)!.lastFamily).toBe("playstation");
    expect(images(row(m, "Jump").gamepad!.button.node)).toEqual(["asset:@myco/glyphs/playstation/buttonSouth.svg"]);
  });

  it("rebinds the clicked cell to the next key, showing the wait and then the new binding", async () => {
    const m = mapper();
    const p = await pointer();
    p.click(row(m, "Jump").keyboard!.button);
    step(2);
    expect(m.rebinding).toEqual({ action: "jump", device: "keyboard" });
    expect(m.status).toBe("Press a key… (Esc to cancel)");
    expect(texts(row(m, "Jump").keyboard!.button.node)).toEqual(["Press a key…"]);
    Input.inject.keyDown("k");
    step();
    Input.inject.keyUp("k");
    step();
    expect(m.rebinding).toBeNull();
    expect(row(m, "Jump").keyboard).toMatchObject({ label: "K", icons: ["keyboard/k"] });
    expect(m.status).toBe("Jump: K");
    expect(InputPlayers.get(0)!.prompt("jump", "keyboard")!.label).toBe("K");
  });

  it("is driven by the keyboard: arrows select, Enter rebinds, Escape cancels, and conflicts are shown", () => {
    const m = mapper();
    expect(m.selected).toEqual({ row: 0, column: 0 });
    tap("arrowdown");
    tap("arrowdown");
    tap("arrowup");
    expect(m.selected).toEqual({ row: 1, column: 0 }); // Move Up, keyboard
    tap("enter");
    expect(m.rebinding).toEqual({ action: "move", device: "keyboard" });
    tap("escape");
    expect(m.rebinding).toBeNull();
    expect(m.status).toBe("Canceled.");
    expect(row(m, "Move Up").keyboard!.label).toBe("W");
    expect(m.selected).toEqual({ row: 1, column: 0 }); // Escape and the key that ends a wait don't move the selection

    tap("enter");
    tap("b"); // Bomb's key
    expect(row(m, "Move Up").keyboard!.label).toBe("B");
    expect(m.conflicts).toEqual(["default: bomb"]);
    expect(m.status).toBe("B is also bound to Bomb.");
    expect(row(m, "Move Up").keyboard!.conflict).toBe(true);
    expect(row(m, "Bomb").keyboard!.conflict).toBe(true);
    expect(row(m, "Jump").keyboard!.conflict).toBe(false);

    // Right moves to the gamepad column; past the last row is the button row.
    tap("arrowright");
    expect(m.selected).toEqual({ row: 1, column: 1 });
    for (let i = 0; i < 9; i++) tap("arrowdown");
    expect(m.selected).toEqual({ row: 6, column: 1 }); // Reset (the button row is Unbind, Reset, Save)
  });

  it("rebinds a gamepad cell to the next button, selected and confirmed with the pad", () => {
    const m = mapper();
    pads.push(3);
    Input.inject.gamepadConnected({ id: 3, name: "Pad", family: "xbox" });
    step();
    Input.inject.gamepadButton(3, 15, 1); // d-pad right: the gamepad column
    step();
    Input.inject.gamepadButton(3, 15, 0);
    step();
    expect(m.selected).toEqual({ row: 0, column: 1 });
    Input.inject.gamepadButton(3, 0, 1); // south: confirm
    step();
    Input.inject.gamepadButton(3, 0, 0);
    step();
    expect(m.rebinding).toEqual({ action: "jump", device: "gamepad" });
    expect(m.status).toBe("Press a button… (Esc to cancel)");
    Input.inject.keyDown("q"); // keys don't bind a gamepad cell
    step();
    Input.inject.keyUp("q");
    Input.inject.gamepadButton(3, 3, 1); // north
    step();
    Input.inject.gamepadButton(3, 3, 0);
    step();
    expect(row(m, "Jump").gamepad).toMatchObject({ label: "Y", icons: ["xbox/buttonNorth"] });
  });

  it("resets to the defaults and saves the bindings with the game's settings", async () => {
    const m = mapper();
    tap("enter");
    tap("j");
    expect(row(m, "Jump").keyboard!.label).toBe("J");
    for (let i = 0; i < 6; i++) tap("arrowdown");
    tap("arrowright");
    tap("arrowright");
    expect(m.selected).toEqual({ row: 6, column: 2 });
    tap("enter"); // Save
    await vi.waitFor(() => expect(m.status).toBe("Saved."));

    const p = await pointer();
    p.click(m.resetButton!);
    step(2);
    expect(m.status).toBe("Bindings reset to the defaults.");
    expect(row(m, "Jump").keyboard!.label).toBe("Space");

    expect(await InputPlayers.get(0)!.loadBindings()).toBe(true); // what Save wrote
    step();
    expect(row(m, "Jump").keyboard!.label).toBe("J");
  });

  it("shows only the columns asked for, and its own words", () => {
    const m = mapper({ gamepad: false });
    m.text.keyboard = "Tastatur";
    m.actionLabels = { jump: "Springen" };
    step();
    expect(row(m, "Springen").gamepad).toBeNull();
    expect(texts(m.node)).toContain("Tastatur");
    m.gamepad = true;
    step();
    expect(row(m, "Springen").gamepad!.label).toBe("South");
  });

  it("makes its own screen canvas when there's none above it, and removes what it built with it", () => {
    const node = GameObject.create("Menu");
    const m = node.addBehavior(UIControlMapper, { actions: "jump" } as never);
    step();
    const canvas = node.children.find((c) => c.getComponent(UICanvas));
    expect(canvas).toBeDefined();
    expect(m.rows).toHaveLength(1);
    node.removeBehavior(m);
    step();
    expect(canvas!.isValid).toBe(false);
  });

  it("shows a chord as one cell with every glyph, and rebinds it to the keys pressed together", async () => {
    const m = mapper({ actions: "dash" });
    const dash = row(m, "Dash");
    expect(dash.keyboard).toMatchObject({ label: "Shift + X", icons: ["keyboard/shift", "keyboard/x"], part: "control", chord: true });
    expect(images(dash.keyboard!.button.node)).toEqual(["asset:@myco/glyphs/keyboard/shift.svg", "asset:@myco/glyphs/keyboard/x.svg"]);
    expect(texts(dash.keyboard!.button.node)).toEqual(["Shift + X"]);
    expect(dash.gamepad).toMatchObject({ label: "L1 + West", icons: ["generic/leftShoulder", "generic/buttonWest"], chord: true });

    const p = await pointer();
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

    // A chord of another size replaces the binding (ADR 0339): a lone key.
    tap("enter");
    expect(m.rebinding).toEqual({ action: "dash", device: "keyboard" });
    tap("m");
    expect(m.rebinding).toBeNull();
    expect(m.status).toBe("Dash: M");
    expect(row(m, "Dash").keyboard).toMatchObject({ label: "M", chord: false });
  });

  it("rebinds a gamepad chord from the pad", () => {
    const m = mapper({ actions: "dash" });
    pads.push(6);
    Input.inject.gamepadConnected({ id: 6, name: "Pad", family: "xbox" });
    step();
    expect(row(m, "Dash").gamepad!.label).toBe("LB + X");
    const press = (button: number, value: number) => {
      Input.inject.gamepadButton(6, button, value);
      step();
    };
    press(15, 1); // d-pad right: the gamepad column
    press(15, 0);
    press(0, 1); // south: rebind (its release doesn't end the wait)
    press(0, 0);
    expect(m.status).toBe("Hold the buttons together, then let go… (Esc to cancel)");
    press(5, 1); // RB
    press(3, 1); // Y
    press(3, 0);
    press(5, 0);
    expect(row(m, "Dash").gamepad).toMatchObject({ label: "RB + Y", icons: ["xbox/rightShoulder", "xbox/buttonNorth"] });
  });

  describe("adding and unbinding (ADR 0339)", () => {
    it("adds a binding from an empty cell", () => {
      const m = mapper();
      expect(row(m, "Bomb").gamepad).toMatchObject({ label: "—", part: null, adds: true });
      expect(row(m, "Bomb").gamepad!.button.interactable).toBe(true);
      expect(row(m, "Move Down").gamepad).toMatchObject({ part: null, adds: false }); // the stick's binding is on Move Up's row
      pads.push(3);
      Input.inject.gamepadConnected({ id: 3, name: "Pad", family: "xbox" });
      step();
      for (let i = 0; i < 5; i++) tap("arrowdown");
      tap("arrowright");
      expect(m.selected).toEqual({ row: 5, column: 1 });
      tap("enter");
      expect(m.rebinding).toEqual({ action: "bomb", device: "gamepad" });
      expect(m.status).toBe("Press a button… (Esc to cancel)");
      Input.inject.gamepadButton(3, 5, 1); // right shoulder
      step();
      Input.inject.gamepadButton(3, 5, 0);
      step();
      expect(m.rebinding).toBeNull();
      expect(row(m, "Bomb").gamepad).toMatchObject({ label: "RB", part: "control", adds: false });
      expect(m.status).toBe("Bomb: RB");
      Input.inject.gamepadButton(3, 5, 1);
      step();
      expect(InputPlayers.get(0)!.performed("bomb")).toBe(true);
      Input.inject.gamepadButton(3, 5, 0);
      step();
    });

    it("unbinds the selected cell with Delete or Backspace, and with the Unbind button, and saves it", async () => {
      const m = mapper();
      tap("delete"); // Jump, keyboard
      expect(row(m, "Jump").keyboard).toMatchObject({ label: "—", part: null, adds: true });
      expect(m.status).toBe("Jump: unbound.");
      expect(InputPlayers.get(0)!.prompt("jump", "keyboard")).toBeNull();
      Input.inject.keyDown("space");
      step();
      expect(InputPlayers.get(0)!.held("jump")).toBe(false);
      Input.inject.keyUp("space");
      step();

      tap("arrowright");
      tap("backspace"); // Jump, gamepad
      expect(row(m, "Jump").gamepad).toMatchObject({ label: "—", adds: true });

      // The Unbind button acts on the binding cell last selected: Bomb's keyboard cell.
      for (let i = 0; i < 5; i++) tap("arrowdown");
      tap("arrowleft");
      expect(m.selected).toEqual({ row: 5, column: 0 });
      const p = await pointer();
      p.click(m.unbindButton!);
      step(2);
      expect(row(m, "Bomb").keyboard).toMatchObject({ label: "—", adds: true });
      expect(m.status).toBe("Bomb: unbound.");
      expect(m.unbindButton!.interactable).toBe(false); // nothing left to unbind there
      p.leave();

      // Unbinding a d-pad part removes the whole keyboard binding: Move's rows follow the stick.
      tap("arrowup");
      tap("arrowup");
      expect(m.selected).toEqual({ row: 4, column: 0 }); // Move Right
      tap("delete");
      expect(m.rows.map((r) => r.label)).toEqual(["Jump", "Move", "Bomb"]);

      // Save, reset, load: the unbinding comes back.
      const save = m.saveButton!;
      p.click(save);
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

    it("words the Unbind button through its text", () => {
      const m = mapper();
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

    it("is off unless asked for", () => {
      const m = mapper({ actions: "jump" });
      expect(m.settings).toEqual([]);
      expect(texts(m.node)).not.toContain("Accessibility");
    });

    it("lists toggles and steppers with the player's settings", () => {
      step();
      InputPlayers.get(0)!.accessibility = { sensitivity: { look: 1.5 }, deadzone: 0.25 };
      const m = mapper(options);
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
      const m = mapper(options);
      const p = await pointer();
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
      const m = mapper({ ...options, repeatActions: "jump" });
      // Rows: Jump, then the seven settings, then the buttons.
      tap("arrowdown");
      tap("arrowdown");
      tap("arrowdown");
      expect(m.selected).toEqual({ row: 3, column: 0 }); // Jump: Press to toggle
      tap("enter");
      expect(InputPlayers.get(0)!.accessibility.holdToToggle).toEqual(["jump"]);
      expect(m.rebinding).toBeNull();
      tap("arrowdown");
      tap("enter"); // repeat on
      expect(InputPlayers.get(0)!.accessibility.repeat).toEqual({ delay: 0.4, interval: 0.1, actions: ["jump"] });
      tap("arrowdown");
      tap("arrowdown");
      tap("arrowright");
      expect(m.selected).toEqual({ row: 6, column: 1 }); // Repeat interval, +
      tap("enter");
      expect(setting(m, "Repeat interval").value).toBe("0.15 s");

      pads.push(2);
      Input.inject.gamepadConnected({ id: 2, name: "Pad", family: "xbox" });
      step();
      const press = (button: number) => {
        Input.inject.gamepadButton(2, button, 1);
        step();
        Input.inject.gamepadButton(2, button, 0);
        step();
      };
      press(13); // d-pad down: the dead zone, +
      expect(m.selected).toEqual({ row: 7, column: 1 });
      press(0);
      expect(setting(m, "Stick dead zone").value).toBe("20%");
      press(14); // d-pad left: −
      press(0);
      press(0);
      expect(setting(m, "Stick dead zone").value).toBe("10%");
      expect(InputPlayers.get(0)!.accessibility.deadzone).toBe(0.1);

      press(13); // the button row
      press(15);
      press(15);
      expect(m.selected).toEqual({ row: 8, column: 2 }); // Save
      press(0);
      await vi.waitFor(() => expect(m.status).toBe("Saved."));
      InputPlayers.get(0)!.accessibility = {};
      step();
      expect(setting(m, "Stick dead zone").value).toBe("15%");
      expect(await InputPlayers.get(0)!.loadBindings()).toBe(true);
      step();
      expect(setting(m, "Stick dead zone").value).toBe("10%");
      expect(InputPlayers.get(0)!.accessibility).toMatchObject({ holdToToggle: ["jump"], repeat: { delay: 0.4, interval: 0.15, actions: ["jump"] }, deadzone: 0.1 });
    });

    it("shows its own words", () => {
      const m = mapper(options);
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
