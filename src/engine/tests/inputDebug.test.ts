import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, InputContext, InputPlayers, button, defineActions, defineInputContext, dpad, vec2 } from "../index";
import { canonicalControlPath, inputActionSets, inputContextNames, inputContextProblems, inputState, watchInput } from "../editor";

// The editor's view of the input system (ADR 0336, 0337): what the Input debugger panel and the context asset editor
// read through the editor SDK, driven through Input.inject as real adapters drive it.

defineActions("test.inputDebug.Player", {
  move: vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d")),
  fire: button("<Keyboard>/space"),
  honk: button(),
});

defineInputContext({ name: "test.inputDebug.vehicle", mappings: [{ action: "honk", control: "<Keyboard>/space" }] });

const DT = 1 / 60;
let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  Input.inject.releaseAll();
  engine.step(DT);
  engine.dispose();
});

const step = (frames = 1) => {
  for (let i = 0; i < frames; i++) engine.step(DT);
};
const action = (name: string) => inputState(engine.world).players[0].actions.find((a) => a.set === "test.inputDebug.Player" && a.action === name)!;

describe("inputState", () => {
  it("lists devices, players, contexts in priority order and actions with their source mapping", () => {
    Input.inject.keyDown("q"); // the keyboard and pointer exist once an adapter reports them
    Input.inject.keyUp("q");
    Input.inject.gamepadConnected({ id: 3, name: "Pad 3", family: "playstation" });
    step();
    const state = inputState(engine.world);
    expect(state.takesInput).toBe(true);
    expect(state.devices.map((d) => [d.name, d.kind, d.family, d.slot, d.player])).toEqual([
      ["Keyboard", "keyboard", "keyboard", 0, 0],
      ["Pointer", "pointer", "pointer", 0, 0],
      ["Pad 3", "gamepad", "playstation", 0, 0],
    ]);
    expect(state.players.map((p) => p.index)).toEqual([0]);
    expect(state.players[0].contexts.map((c) => c.name)).toEqual(["default"]);

    Input.inject.keyDown("d");
    step();
    const move = action("move");
    expect(move.value).toEqual([1, 0]);
    expect(move.phases).toEqual(expect.arrayContaining(["held", "triggered"]));
    expect(move.source).toMatchObject({ context: "default", composite: "dpad", controls: ["<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d"] });
    step(3);
    expect(action("move").elapsed).toBeGreaterThan(0.05);
    Input.inject.gamepadDisconnected(3);
  });

  it("shows which controls a higher-priority context consumed", () => {
    const car = GameObject.create("Car");
    car.addBehavior(InputContext, { context: "test.inputDebug.vehicle", priority: 10 });
    step();
    Input.inject.keyDown("space");
    step();
    const p = inputState(engine.world).players[0];
    expect(p.contexts.map((c) => [c.name, c.priority])).toEqual([["test.inputDebug.vehicle", 10], ["default", 0]]);
    expect(p.contexts[0].consumed).toEqual(["<Keyboard>/space"]);
    expect(action("honk").source).toMatchObject({ context: "test.inputDebug.vehicle", mapping: 0 });
    expect(action("fire").value).toEqual([0]);
    expect(action("fire").source).toBeNull();
  });

  it("names the pawns and a rebind in progress", () => {
    step();
    const result = InputPlayers.get(0)!.rebind("fire", { device: "keyboard" });
    step();
    expect(inputState(engine.world).players[0].rebind).toMatchObject({ action: "fire", context: "default", part: "control", device: "keyboard", cancel: "<Keyboard>/escape" });
    Input.inject.keyDown("escape");
    step();
    expect(inputState(engine.world).players[0].rebind).toBeNull();
    return result;
  });
});

describe("watchInput", () => {
  it("records every frame's action and device events until stopped", () => {
    step();
    const log = watchInput(engine.world);
    Input.inject.keyDown("space");
    step();
    Input.inject.keyUp("space");
    step();
    const seen = log.entries().map((e) => (e.kind === "action" ? `${e.action}:${e.phase}` : e.kind === "device" ? `${e.control}=${e.value}` : e.kind));
    expect(seen).toEqual(["<Keyboard>/space=1", "fire:started", "fire:performed", "<Keyboard>/space=0", "fire:completed"]);
    expect(log.version).toBeGreaterThan(0);
    log.stop();
    Input.inject.keyDown("space");
    step();
    expect(log.entries().length).toBe(5);
  });
});

describe("for the context asset editor", () => {
  it("lists action sets and registered contexts, canonicalizes control paths, and reports the evaluator's problems", () => {
    expect(inputActionSets().find((s) => s.id === "test.inputDebug.Player")?.actions).toEqual([
      { name: "move", kind: "vec2" },
      { name: "fire", kind: "button" },
      { name: "honk", kind: "button" },
    ]);
    expect(inputContextNames()).toEqual(expect.arrayContaining(["default", "test.inputDebug.vehicle"]));
    expect(canonicalControlPath("<keyboard>/Space")).toBe("<Keyboard>/space");
    expect(canonicalControlPath("<Gamepad>/nope")).toBeNull();
    const problems = inputContextProblems({
      name: "bad",
      mappings: [
        { action: "fire", control: "<Keyboard>/f" },
        { action: "nothing", control: "<Keyboard>/f" },
        { action: "fire", control: "<Gamepad>/nope" },
        { action: "fire", control: "<Keyboard>/g", triggers: [{ hold: { min: -1 } }] },
      ],
    });
    expect(problems.map((p) => p.mapping)).toEqual([1, 2, 3]);
    expect(problems[0].message).toContain('there\'s no action "nothing"');
    expect(problems[1].message).toContain("isn't a control path");
    expect(problems[2].message).toContain("hold.min");
  });
});
