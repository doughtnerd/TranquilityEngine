import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, Input, InputPlayers, RebindResults, button, chordOf, defineActions, type RebindResult } from "../index";

// ADR 0337: chord rebinding, driven through Input.inject and read through the player's results,
// prompts and actions.

defineActions("test.inputRebind.Actions", {
  dash: button(chordOf("<Keyboard>/shift", "<Keyboard>/b")),
  bomb: button("<Keyboard>/b"),
  jump: button("<Keyboard>/space", "<Gamepad>/buttonSouth"),
  menu: button(chordOf("<Gamepad>/leftShoulder", "<Gamepad>/buttonNorth")),
  quicksave: button(chordOf(["<Keyboard>/control", "<Keyboard>/shift"], "<Keyboard>/s")),
  crouch: button(chordOf("<Keyboard>/control", "<Keyboard>/c")),
});

const DT = 1 / 60;
let engine: Engine;
let padIds: number[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  engine.step(DT);
});

afterEach(() => {
  for (const id of padIds) Input.inject.gamepadDisconnected(id);
  padIds = [];
  engine.step(DT);
  Input.inject.releaseAll();
  engine.dispose();
});

const p0 = () => InputPlayers.get(0)!;
const step = (frames = 1) => {
  for (let i = 0; i < frames; i++) engine.step(DT);
};
const down = (...keys: string[]) => {
  for (const k of keys) Input.inject.keyDown(k);
  step();
};
const up = (...keys: string[]) => {
  for (const k of keys) Input.inject.keyUp(k);
  step();
};
/** Track whether a promise settled, without awaiting it. */
function track(p: Promise<RebindResult>): { result: RebindResult | null } {
  const box: { result: RebindResult | null } = { result: null };
  void p.then((r) => (box.result = r));
  return box;
}

describe("chord rebinding (ADR 0337)", () => {
  it("rebinds a chord to the keys pressed together, by default for a chord's main control", async () => {
    expect(p0().prompt("dash", "keyboard")!.label).toBe("Shift+B");
    const pending = p0().rebind("dash", { device: "keyboard" });
    down("control");
    down("n");
    up("n");
    const r = await pending;
    expect(r).toMatchObject({ canceled: false, reason: null, control: "<Keyboard>/n", chord: ["<Keyboard>/control", "<Keyboard>/n"], conflicts: [] });
    up("control");
    expect(p0().prompt("dash", "keyboard")).toMatchObject({ label: "Ctrl+N", parts: ["modifier0", "control"], controls: ["<Keyboard>/control", "<Keyboard>/n"] });

    down("n"); // the main key alone doesn't perform it
    expect(p0().held("dash")).toBe(false);
    up("n");
    down("control", "n");
    expect(p0().performed("dash")).toBe(true);
    up("control", "n");
    down("shift", "b"); // the old chord is gone
    expect(p0().held("dash")).toBe(false);
    up("shift", "b");
  });

  it("waits for the main key while modifier keys are held, and counts a modifier held before it started", async () => {
    down("alt");
    const pending = track(p0().rebind("dash", { device: "keyboard" }));
    down("k");
    expect(pending.result).toBeNull(); // completes on the first release
    up("k");
    await Promise.resolve();
    expect(pending.result).toMatchObject({ canceled: false, chord: ["<Keyboard>/alt", "<Keyboard>/k"] });
    up("alt");
    // Pressing the modifier first, then the key, then letting go of the modifier first, gives the same chord.
    const again = p0().rebind("dash", { device: "keyboard" });
    down("shift");
    down("j");
    up("shift");
    expect((await again).chord).toEqual(["<Keyboard>/shift", "<Keyboard>/j"]);
    up("j");
    expect(p0().prompt("dash", "keyboard")!.label).toBe("Shift+J");
  });

  it("changes a chord's size: the old mapping is removed and the new chord added (ADR 0339)", async () => {
    const two = p0().rebind("dash", { device: "keyboard" });
    down("control");
    down("alt");
    down("n");
    up("n");
    expect(await two).toMatchObject({ canceled: false, reason: null, control: "<Keyboard>/n", chord: ["<Keyboard>/control", "<Keyboard>/alt", "<Keyboard>/n"] });
    up("control", "alt");
    expect(p0().prompt("dash", "keyboard")).toMatchObject({ label: "Ctrl+Alt+N", parts: ["modifier0", "modifier1", "control"] });
    down("control", "alt", "n");
    expect(p0().performed("dash")).toBe(true);
    up("control", "alt", "n");
    down("shift", "b"); // the old chord is gone
    expect(p0().held("dash")).toBe(false);
    up("shift", "b");

    // Down to a lone key: the added chord is replaced in place.
    const lone = p0().rebind("dash", { device: "keyboard" });
    down("n");
    up("n");
    expect(await lone).toMatchObject({ canceled: false, control: "<Keyboard>/n", chord: ["<Keyboard>/n"] });
    expect(p0().prompt("dash", "keyboard")).toMatchObject({ label: "N", parts: ["control"] });
    down("n");
    expect(p0().performed("dash")).toBe(true);
    up("n");
    expect(RebindResults.read()).toEqual([]); // last frame's results are gone

    p0().resetBindings();
    step();
    expect(p0().prompt("dash", "keyboard")!.label).toBe("Shift+B");
  });

  it("rebinds a chord with several modifiers, in the order they were pressed", async () => {
    const pending = p0().rebind("quicksave", { device: "keyboard" });
    down("alt");
    down("shift");
    down("q");
    up("q");
    expect(await pending).toMatchObject({ canceled: false, chord: ["<Keyboard>/alt", "<Keyboard>/shift", "<Keyboard>/q"] });
    up("alt", "shift");
    expect(p0().prompt("quicksave", "keyboard")!.label).toBe("Alt+Shift+Q");
    down("shift", "alt", "q");
    expect(p0().performed("quicksave")).toBe(true);
    up("shift", "alt", "q");
  });

  it("reports a conflict with a mapping of the same chord, not with the main key's own mapping", async () => {
    const same = p0().rebind("dash", { device: "keyboard" });
    down("control");
    down("c");
    up("c");
    expect(await same).toMatchObject({ canceled: false, conflicts: ["default: crouch"] });
    up("control");
    const plain = p0().rebind("dash", { device: "keyboard" });
    down("shift");
    down("b");
    up("b");
    expect(await plain).toMatchObject({ canceled: false, conflicts: [] }); // bomb's plain B isn't one: the chord claims B
    up("shift");
  });

  it("rebinds one modifier of a chord with part: modifier0, as a single press", async () => {
    const pending = p0().rebind("dash", { device: "keyboard", part: "modifier0" });
    down("alt");
    const r = await pending;
    expect(r).toMatchObject({ canceled: false, control: "<Keyboard>/alt", chord: [] });
    up("alt");
    expect(p0().prompt("dash", "keyboard")!.label).toBe("Alt+B");
    down("alt", "b");
    expect(p0().performed("dash")).toBe(true);
    up("alt", "b");
  });

  it("refuses a part the mapping doesn't have, rather than saving an override that changes nothing (ADR 0458)", () => {
    expect(() => p0().rebind("dash", { device: "keyboard", part: "modifier" })).toThrow(/no "modifier" part; its parts are modifier0, control/);
    expect(() => p0().rebind("dash", { device: "keyboard", part: "modifier1" })).toThrow(/no "modifier1" part/);
    expect(() => p0().rebind("jump", { device: "keyboard", part: "up" })).toThrow(/single mapping has no "up" part/);
  });

  it("rebinds only a chord's main key with chord: false", async () => {
    const pending = p0().rebind("dash", { device: "keyboard", chord: false });
    down("g");
    expect(await pending).toMatchObject({ control: "<Keyboard>/g", chord: [] });
    up("g");
    expect(p0().prompt("dash", "keyboard")!.label).toBe("Shift+G");
  });

  it("captures a single control as a chord on request: alone it binds, with a modifier it becomes a chord", async () => {
    const alone = p0().rebind("jump", { device: "keyboard", chord: true });
    down("n");
    up("n");
    expect(await alone).toMatchObject({ canceled: false, control: "<Keyboard>/n", chord: ["<Keyboard>/n"] });
    expect(p0().prompt("jump", "keyboard")!.label).toBe("N");
    const withShift = p0().rebind("jump", { device: "keyboard", chord: true });
    down("shift");
    down("m");
    up("m");
    expect(await withShift).toMatchObject({ canceled: false, chord: ["<Keyboard>/shift", "<Keyboard>/m"] });
    up("shift");
    expect(p0().prompt("jump", "keyboard")!.label).toBe("Shift+M");
    expect(p0().prompt("jump", "xbox")!.label).toBe("A"); // the gamepad mapping is untouched
    expect(() => p0().rebind("dash", { device: "keyboard", part: "modifier0", chord: true })).toThrow(/chord rebind/);
  });

  it("rebinds a gamepad chord to the buttons held together, ignoring the button that was down when it started", async () => {
    padIds.push(7);
    Input.inject.gamepadConnected({ id: 7, name: "Pad", family: "xbox" });
    Input.inject.gamepadButton(7, 0, 1); // south, down as the rebind starts (the screen's confirm)
    step();
    expect(p0().prompt("menu", "xbox")!.label).toBe("LB+Y");
    const pending = track(p0().rebind("menu", { device: "gamepad" }));
    Input.inject.gamepadButton(7, 0, 0); // its release doesn't end the rebind
    step();
    expect(pending.result).toBeNull();
    Input.inject.gamepadButton(7, 5, 1); // right shoulder
    step();
    Input.inject.gamepadButton(7, 2, 1); // west
    step();
    expect(pending.result).toBeNull();
    Input.inject.gamepadButton(7, 2, 0);
    step();
    await Promise.resolve();
    expect(pending.result).toMatchObject({ canceled: false, chord: ["<Gamepad>/rightShoulder", "<Gamepad>/buttonWest"] });
    Input.inject.gamepadButton(7, 5, 0);
    step();
    expect(p0().prompt("menu", "xbox")!.label).toBe("RB+X");
  });

  it("is canceled by Escape and by a timeout, with the reason", async () => {
    const esc = p0().rebind("dash", { device: "keyboard" });
    down("shift");
    down("escape");
    expect(await esc).toMatchObject({ canceled: true, reason: "cancel", chord: [] });
    up("shift", "escape");
    const first = p0().rebind("dash", { device: "keyboard" });
    const second = p0().rebind("dash", { device: "keyboard", timeout: 2 * DT });
    expect(await first).toMatchObject({ canceled: true, reason: "replaced" });
    step(3);
    expect(await second).toMatchObject({ canceled: true, reason: "timeout" });
  });
});
