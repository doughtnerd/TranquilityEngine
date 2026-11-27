import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, InputContext, InputPlayers, button, defineActions, defineInputContext, dpad, vec2 } from "../index";
import { canonicalControlPath, inputActionSets, inputContextNames, inputContextProblems, inputControlInfo, inputState, traceInputModifiers, watchInput, watchRawPresses, unregisterScripts, withScriptRegistrations, type RawPress } from "../editor";

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
  it("forgets a script's action sets when its registrations go, putting back a build set it replaced", async () => {
    const registered = await withScriptRegistrations(async () => {
      defineActions("test.inputDebug.Scripted", { warp: button("<Keyboard>/q") });
      defineActions("test.inputDebug.Player", { fire: button("<Keyboard>/f") });
    });
    expect(inputActionSets().map((s) => s.id)).toContain("test.inputDebug.Scripted");
    expect(inputContextProblems({ name: "c", mappings: [{ action: "warp", control: "<Keyboard>/q" }] })).toEqual([]);
    unregisterScripts(registered);
    expect(inputActionSets().map((s) => s.id)).not.toContain("test.inputDebug.Scripted");
    // A bare name the forgotten set had resolves to nothing now.
    expect(inputContextProblems({ name: "c", mappings: [{ action: "warp", control: "<Keyboard>/q" }] }).map((p) => p.mapping)).toEqual([0]);
    expect(inputActionSets().find((s) => s.id === "test.inputDebug.Player")?.actions.map((a) => a.name)).toEqual(["move", "fire", "honk"]);
  });

  it("lists action sets and registered contexts, canonicalizes control paths, and reports the evaluator's problems", () => {
    const player = inputActionSets().find((s) => s.id === "test.inputDebug.Player")!;
    expect(player.source).toBe("code");
    // Each action with its inline defaults as mappings naming it (ADR 0417: the default context's "from a script" rows).
    expect(player.actions).toEqual([
      { name: "move", kind: "vec2", defaults: [{ action: "test.inputDebug.Player:move", composite: "dpad", up: "<Keyboard>/w", down: "<Keyboard>/s", left: "<Keyboard>/a", right: "<Keyboard>/d" }] },
      { name: "fire", kind: "button", defaults: [{ action: "test.inputDebug.Player:fire", control: "<Keyboard>/space" }] },
      { name: "honk", kind: "button", defaults: [] },
    ]);
    expect(inputControlInfo("<Gamepad>/leftStickX")).toEqual({ dimensions: 1, axis: true });
    expect(inputControlInfo("<Keyboard>/k")).toEqual({ dimensions: 1, axis: false });
    expect(inputControlInfo("<Gamepad>/rightStick")).toEqual({ dimensions: 2, axis: false });
    expect(inputControlInfo("<Gamepad>/nope")).toBeNull();
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

describe("a mapping's note (ADR 0417)", () => {
  it("is editor-only: the evaluator reports the same problems with or without it", () => {
    const mappings = [
      { action: "fire", control: "<Keyboard>/f" },
      { action: "fire", control: "<Gamepad>/nope" },
    ];
    expect(inputContextProblems({ name: "n", mappings: mappings.map((m) => ({ ...m, note: "why it's here" })) })).toEqual(inputContextProblems({ name: "n", mappings }));
    expect(inputContextProblems({ name: "n", mappings: [{ action: "fire", control: "<Keyboard>/f", note: "Space is taken by the menu" }] })).toEqual([]);
  });
});

describe("traceInputModifiers", () => {
  it("passes a value through the stack top to bottom with the engine's modifiers, each step's output beside it", () => {
    const t = traceInputModifiers([{ deadzone: { min: 0.2, shape: "axial" } }, { scale: 2 }, { negate: { y: true } }], [0.1, 0.6], { kind: "vec2" });
    expect(t.dims).toBe(2);
    expect(t.steps.map((s) => s.value)).toEqual([
      [0, 0.5],
      [0, 1],
      [0, -1],
    ]);
    expect(t.out).toEqual([0, -1]);
  });

  it("skips a turned-off modifier, and a turned-off dead zone brings back a stick's default one (ADR 0417)", () => {
    const t = traceInputModifiers([{ scale: 3, off: true }, { scale: 2 }], [0.25], { kind: "axis" });
    expect(t.steps.map((s) => [s.value, s.off])).toEqual([
      [[0.25], true],
      [[0.5], false],
    ]);
    const stick = traceInputModifiers([{ deadzone: { min: 0.5 }, off: true }], [0.1, 0], { kind: "vec2", controls: ["<Gamepad>/leftStick"] });
    expect(stick.steps[0].implicit).toBe(true);
  });

  it("keeps the order: the same modifiers in another order give another value", () => {
    const a = traceInputModifiers([{ scale: 0.5 }, { deadzone: { min: 0.3 } }], [0.5]).out;
    const b = traceInputModifiers([{ deadzone: { min: 0.3 } }, { scale: 0.5 }], [0.5]).out;
    expect(a).toEqual([0]);
    expect(b[0]).toBeCloseTo(((0.5 - 0.3) / 0.7) * 0.5, 5);
  });

  it("passes the value through smooth (time-based) and a modifier with bad parameters, saying why", () => {
    const t = traceInputModifiers([{ smooth: { rate: 10 } }, { curve: { exponent: 0 } }, { curve: { exponent: 2 } }], [-0.5]);
    expect(t.steps[0]).toMatchObject({ value: [-0.5], timeBased: true, error: null });
    expect(t.steps[1].value).toEqual([-0.5]);
    expect(t.steps[1].error).toContain("exponent");
    expect(t.steps[2].value).toEqual([-0.25]);
  });

  it("runs the engine's stick dead zone first when a stick's mapping has none, and reads a button's magnitude", () => {
    const t = traceInputModifiers([], [0.1, 0.05], { kind: "vec2", controls: ["<Gamepad>/leftStick"] });
    expect(t.steps).toEqual([{ value: [0, 0], error: null, timeBased: false, implicit: true, off: false }]);
    expect(traceInputModifiers([{ deadzone: { min: 0.05 } }], [0.5], { controls: ["<Gamepad>/leftStickX"] }).steps).toHaveLength(1);
    expect(traceInputModifiers([], [0.6, 0.8], { kind: "button" }).out).toEqual([1]);
    expect(traceInputModifiers([{ swizzle: "yx" }], [0.7], { kind: "vec2" }).out).toEqual([0, expect.closeTo(0.7, 5)]);
  });
});

describe("watchRawPresses", () => {
  it("reports every device's presses from the snapshot, not releases or presses from before it started", () => {
    Input.inject.keyDown("q"); // before watching
    step();
    const presses: RawPress[] = [];
    const stop = watchRawPresses((p) => presses.push(p));
    Input.inject.keyUp("q");
    Input.inject.keyDown("k");
    Input.inject.gamepadConnected({ id: 0x4001, name: "HID pad", family: "playstation" });
    Input.inject.gamepadButton(0x4001, 0, 1);
    Input.inject.gamepadAxis(0x4001, 1, -0.2); // inside the press point: not a press
    Input.inject.touchStart(5, 10, 10);
    Input.inject.penButtonDown(1);
    step(2); // read at the start of the frame after
    Input.inject.gamepadAxis(0x4001, 1, -0.9);
    Input.inject.gamepadButton(0x4001, 0, 0);
    step(2);
    expect(presses).toEqual([
      { device: "keyboard", control: "<Keyboard>/k", value: 1 },
      { device: "gamepad", control: "<Gamepad>/buttonSouth", value: 1 },
      { device: "touch", control: "<Touch>/touch0", value: 1 },
      { device: "pen", control: "<Pen>/barrel", value: 1 },
      { device: "gamepad", control: "<Gamepad>/leftStickY", value: expect.closeTo(-0.9, 5) },
    ]);
    stop();
    Input.inject.keyDown("j");
    step(2);
    expect(presses.length).toBe(5);
    Input.inject.touchEnd(5, 10, 10);
    Input.inject.penButtonUp(1);
  });

  it("takes snapshots itself while no Engine steps (play paused, nothing running)", async () => {
    const presses: RawPress[] = [];
    const stop = watchRawPresses((p) => presses.push(p));
    Input.inject.gamepadConnected({ id: 9, name: "SDL pad", family: "xbox" });
    Input.inject.gamepadButton(9, 3, 1);
    await new Promise((r) => setTimeout(r, 400));
    stop();
    expect(presses).toEqual([{ device: "gamepad", control: "<Gamepad>/buttonNorth", value: 1 }]);
  });
});
