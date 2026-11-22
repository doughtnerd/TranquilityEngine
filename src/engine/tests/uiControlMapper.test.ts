import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input, InputPlayers, button, defineActions, dpad, vec2 } from "../index";
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
    expect(texts(m.node)).toEqual(expect.arrayContaining(["Controls", "Keyboard", "Gamepad", "Reset to defaults", "Save"]));
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
    expect(m.selected).toEqual({ row: 6, column: 1 }); // Save
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
    expect(m.selected).toEqual({ row: 6, column: 1 });
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
});
