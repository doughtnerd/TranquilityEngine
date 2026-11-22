import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input, InputContext, InputPlayers, Storage, button, defineActions, defineInputContext, type InputContextSpec } from "../index";

// ADR 0339: player input profiles that add and remove mappings and name the action each change is
// for. Driven through Input.inject and PlayerInput, read through prompts, actions, rebind results
// and the files saveBindings writes.

defineActions("test.inputProfiles.Actions", {
  jump: button(),
  crouch: button(),
  fire: button(),
  honk: button(),
  bomb: button("<Keyboard>/b"),
});

const ON_FOOT = "test.inputProfiles.onFoot";
const onFoot: InputContextSpec = {
  name: ON_FOOT,
  mappings: [
    { action: "crouch", control: "<Keyboard>/c" },
    { action: "jump", control: "<Keyboard>/space" },
    { action: "fire", control: "<Keyboard>/f" },
  ],
};
defineInputContext(onFoot);

const DT = 1 / 60;
let engine: Engine;
let padIds: number[] = [];

beforeEach(async () => {
  Input.reset();
  defineInputContext(onFoot);
  engine = await Engine.create({ headless: true });
  GameObject.create("OnFoot").addBehavior(InputContext, { context: ON_FOOT, priority: 10, player: 0 });
  engine.step(DT);
});

afterEach(() => {
  for (const id of padIds) Input.inject.gamepadDisconnected(id);
  padIds = [];
  engine.step(DT);
  Input.inject.releaseAll();
  engine.dispose();
  vi.restoreAllMocks();
});

const p0 = () => InputPlayers.get(0)!;
const step = (frames = 1) => {
  for (let i = 0; i < frames; i++) engine.step(DT);
};
/** Press and release keys, a frame each. */
const tap = (...keys: string[]) => {
  for (const k of keys) Input.inject.keyDown(k);
  step();
  for (const k of keys) Input.inject.keyUp(k);
  step();
};
/** Whether keys pressed together perform an action. */
const performs = (action: string, ...keys: string[]): boolean => {
  for (const k of keys) Input.inject.keyDown(k);
  step();
  const performed = p0().performed(action);
  for (const k of keys) Input.inject.keyUp(k);
  step();
  return performed;
};
const pad = (id: number) => {
  padIds.push(id);
  Input.inject.gamepadConnected({ id, name: `Pad ${id}`, family: "xbox" });
  step();
};
const saved = (profile: string) => Storage.load<Record<string, unknown>>(`input.${profile}.json`, "settings");
const staleWarnings = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("no longer matches"));

describe("adding mappings (ADR 0339)", () => {
  it("adds a mapping for a device the action has none for, in the context that holds the action", async () => {
    pad(3);
    expect(p0().prompt("jump", "xbox")).toBeNull();
    expect(() => p0().rebind("jump", { device: "gamepad" })).toThrow(/add one with \{ add: true \}/);
    const pending = p0().rebind("jump", { add: true, device: "gamepad" });
    Input.inject.keyDown("k"); // another device group: ignored
    step();
    Input.inject.keyUp("k");
    Input.inject.gamepadButton(3, 3, 1); // north
    step();
    expect(await pending).toMatchObject({ canceled: false, control: "<Gamepad>/buttonNorth", conflicts: [] });
    Input.inject.gamepadButton(3, 3, 0);
    step();
    expect(p0().prompt("jump", "xbox")).toMatchObject({ label: "Y", context: ON_FOOT });
    Input.inject.gamepadButton(3, 3, 1);
    step();
    expect(p0().performed("jump")).toBe(true);
    Input.inject.gamepadButton(3, 3, 0);
    step();
    expect(p0().prompt("jump", "keyboard")!.label).toBe("Space"); // the keyboard mapping is untouched

    await p0().saveBindings("added");
    expect(await saved("added")).toEqual({
      format: 2,
      overrides: {},
      additions: { [ON_FOOT]: [{ action: "test.inputProfiles.Actions:jump", control: "<Gamepad>/buttonNorth" }] },
      removals: {},
      accessibility: {},
    });
  });

  it("adds a second key, puts an action with no mappings in the default context, and reports conflicts with added mappings", async () => {
    const second = p0().rebind("fire", { add: true, device: "keyboard" });
    tap("g");
    expect(await second).toMatchObject({ canceled: false, control: "<Keyboard>/g" });
    expect(p0().prompt("fire", "keyboard")!.label).toBe("F"); // the first mapping still names it
    expect(performs("fire", "g")).toBe(true);
    expect(performs("fire", "f")).toBe(true);

    const honk = p0().rebind("honk", { add: true, device: "keyboard" });
    tap("h");
    await honk;
    expect(p0().prompt("honk", "keyboard")).toMatchObject({ label: "H", context: "default" });

    const clash = p0().rebind("jump", { device: "keyboard" });
    tap("g");
    expect((await clash).conflicts).toEqual([`${ON_FOOT}: fire`]);
  });

  it("rebinds an added mapping in place, and adds a chord when asked", async () => {
    const add = p0().rebind("honk", { add: true, device: "keyboard" });
    tap("h");
    await add;
    const change = p0().rebind("honk", { device: "keyboard" });
    tap("j");
    await change;
    expect(p0().prompt("honk", "keyboard")!.label).toBe("J");
    const chord = p0().rebind("crouch", { add: true, device: "keyboard", chord: true, context: ON_FOOT });
    Input.inject.keyDown("control");
    step();
    tap("x");
    Input.inject.keyUp("control");
    step();
    expect(await chord).toMatchObject({ canceled: false, chord: ["<Keyboard>/control", "<Keyboard>/x"] });
    expect(performs("crouch", "control", "x")).toBe(true);
    await p0().saveBindings("chord");
    expect((await saved("chord"))!.additions).toEqual({
      default: [{ action: "test.inputProfiles.Actions:honk", control: "<Keyboard>/j" }],
      [ON_FOOT]: [{ action: "test.inputProfiles.Actions:crouch", composite: "modifier", modifier: ["<Keyboard>/control"], control: "<Keyboard>/x" }],
    });
  });
});

describe("unbinding (ADR 0339)", () => {
  it("removes a context's mapping into removals and deletes an added one outright", async () => {
    pad(4);
    const add = p0().rebind("jump", { add: true, device: "gamepad" });
    Input.inject.gamepadButton(4, 0, 1);
    step();
    await add;
    Input.inject.gamepadButton(4, 0, 0);
    step();

    expect(p0().unbind("jump", { device: "keyboard" })).toBe(true);
    expect(p0().prompt("jump", "keyboard")).toBeNull();
    expect(performs("jump", "space")).toBe(false);
    expect(p0().unbind("jump", { device: "keyboard" })).toBe(false); // nothing left
    expect(p0().prompt("jump", "xbox")!.label).toBe("A");
    await p0().saveBindings("unbound");
    expect(await saved("unbound")).toMatchObject({ additions: { [ON_FOOT]: [{ control: "<Gamepad>/buttonSouth" }] }, removals: { [ON_FOOT]: [{ index: 1, action: "jump" }] } });

    expect(p0().unbind("jump", { device: "gamepad" })).toBe(true);
    expect(p0().prompt("jump", "xbox")).toBeNull();
    await p0().saveBindings("unbound");
    expect(await saved("unbound")).toMatchObject({ additions: {}, removals: { [ON_FOOT]: [{ index: 1, action: "jump" }] } });

    p0().resetBindings();
    step();
    expect(p0().prompt("jump", "keyboard")!.label).toBe("Space");
    await p0().saveBindings("unbound");
    expect(await saved("unbound")).toMatchObject({ overrides: {}, additions: {}, removals: {} });
  });

  it("skips removed mappings in conflict checks, and unbinds in a named context", async () => {
    expect(p0().unbind("bomb", { device: "keyboard", context: ON_FOOT })).toBe(false); // bomb is only in the default context
    expect(p0().unbind("bomb", { device: "keyboard", context: "default" })).toBe(true);
    const r = p0().rebind("jump", { device: "keyboard" });
    tap("b");
    expect((await r).conflicts).toEqual([]);
    expect(() => p0().unbind("nope", { device: "keyboard" })).toThrow(/no action "nope"/);
  });

  it("round-trips additions, removals and overrides through save and load", async () => {
    const add = p0().rebind("fire", { add: true, device: "keyboard" });
    tap("g");
    await add;
    p0().unbind("crouch", { device: "keyboard" });
    const change = p0().rebind("jump", { device: "keyboard" });
    tap("k");
    await change;
    await p0().saveBindings("trip");
    expect(await saved("trip")).toMatchObject({
      format: 2,
      overrides: { [`${ON_FOOT}/1/jump/control`]: "<Keyboard>/k" },
      additions: { [ON_FOOT]: [{ action: "test.inputProfiles.Actions:fire", control: "<Keyboard>/g" }] },
      removals: { [ON_FOOT]: [{ index: 0, action: "crouch" }] },
    });
    p0().resetBindings();
    step();
    expect(p0().prompt("crouch", "keyboard")!.label).toBe("C");
    expect(await p0().loadBindings("trip")).toBe(true);
    step();
    expect(p0().prompt("crouch", "keyboard")).toBeNull();
    expect(p0().prompt("jump", "keyboard")!.label).toBe("K");
    expect(performs("fire", "g")).toBe(true);
  });
});

describe("saved profile formats (ADR 0339)", () => {
  it("upgrades a format 1 file on load, giving each override its mapping's action, and saves format 2", async () => {
    await Storage.save("input.legacy.json", { format: 1, overrides: { [`${ON_FOOT}/1/control`]: "<Keyboard>/k", [`${ON_FOOT}/9/control`]: "<Keyboard>/z" }, accessibility: { invertY: ["look"] } }, "settings");
    expect(await p0().loadBindings("legacy")).toBe(true);
    step();
    expect(p0().prompt("jump", "keyboard")!.label).toBe("K");
    expect(performs("jump", "k")).toBe(true);
    await p0().saveBindings("legacy");
    expect(await saved("legacy")).toEqual({
      format: 2,
      overrides: { [`${ON_FOOT}/1/jump/control`]: "<Keyboard>/k" }, // the override past the context's end is dropped
      additions: {},
      removals: {},
      accessibility: { invertY: ["look"] },
    });
  });

  it("resets saved changes whose mapping no longer targets their action, with one warning per context", async () => {
    await Storage.save(
      "input.stale.json",
      {
        format: 2,
        overrides: { [`${ON_FOOT}/1/jump/control`]: "<Keyboard>/k", [`${ON_FOOT}/2/fire/control`]: "<Keyboard>/g" },
        additions: {},
        removals: { [ON_FOOT]: [{ index: 0, action: "crouch" }] },
        accessibility: {},
      },
      "settings",
    );
    // A game update reorders the context: jump first, then crouch, then fire.
    defineInputContext({ ...onFoot, mappings: [onFoot.mappings[1], onFoot.mappings[0], onFoot.mappings[2]] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await p0().loadBindings("stale")).toBe(true);
    step();
    expect(staleWarnings(warn)).toEqual([`[myco] Saved binding for "crouch" in "${ON_FOOT}" no longer matches the context; it was reset.`]);
    expect(p0().prompt("jump", "keyboard")!.label).toBe("Space"); // not K on crouch's mapping
    expect(p0().prompt("crouch", "keyboard")!.label).toBe("C"); // the removal was for index 0, now jump: dropped too
    expect(p0().prompt("fire", "keyboard")!.label).toBe("G"); // fire is still at index 2
    step(3);
    expect(staleWarnings(warn)).toHaveLength(1);
    await p0().saveBindings("stale");
    expect(await saved("stale")).toMatchObject({ overrides: { [`${ON_FOOT}/2/fire/control`]: "<Keyboard>/g" }, removals: {} });
  });
});
