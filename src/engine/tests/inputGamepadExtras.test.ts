import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceEvents, Engine, GamepadState, Input, InputPlayers, button, defineActions, defineSystem, vec2 } from "../index";

// ADR 0335: gamepad touchpad fingers and batteries, through Input.inject (the input end the SDL and
// WebHID adapters use) and read through device nodes, DeviceEvents, actions, prompts and players.

defineActions("test.inputGamepadExtras.Pad", {
  touch: button("<Gamepad>/touchpad0"),
  second: button("<Gamepad>/touchpad1"),
  point: vec2("<Gamepad>/touchpad0Position"),
});

const DT = 1 / 60;
let engine: Engine;
let padIds: number[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  for (const id of padIds) Input.inject.gamepadDisconnected(id);
  padIds = [];
  engine.step(DT);
  engine.dispose();
});

const step = (frames = 1) => {
  for (let i = 0; i < frames; i++) engine.step(DT);
};
const pad = (id: number) => {
  padIds.push(id);
  Input.inject.gamepadConnected({ id, name: `Pad ${id}`, family: "playstation" });
};
const p0 = () => InputPlayers.get(0)!;

describe("touchpad fingers", () => {
  it("reaches GamepadState, DeviceEvents and actions, in 0..1 of the touchpad", () => {
    const events: [string, number][] = [];
    defineSystem({ name: "test.inputGamepadExtras.events", phase: "update", run: () => { for (const e of DeviceEvents.read()) events.push([e.control, e.value]); } });
    pad(5);
    step();
    const node = engine.world.root.find("Input/Pad 5")!;

    Input.inject.gamepadTouch(5, 0, true, 0.25, 0.75);
    step();
    let s = node.getData(GamepadState)!;
    expect([s.tpHeld, s.tpDown, s.tpUp]).toEqual([1, 1, 0]);
    expect([s.tp0X, s.tp0Y]).toEqual([0.25, 0.75]);
    expect(events.splice(0)).toEqual([["<Gamepad>/touchpad0", 1]]);
    expect(p0().pressed("touch")).toBe(true);
    const v = p0().vector2("point");
    expect([v.x, v.y]).toEqual([0.25, 0.75]); // a position: +Y down, like the other positions

    // Moving reports the finger down again: no new event, the position follows.
    Input.inject.gamepadTouch(5, 0, true, 0.5, 0.5);
    Input.inject.gamepadTouch(5, 1, true, 2, -1); // clamped
    step();
    s = node.getData(GamepadState)!;
    expect([s.tpHeld, s.tpDown]).toEqual([3, 2]);
    expect([s.tp1X, s.tp1Y]).toEqual([1, 0]);
    expect(events.splice(0)).toEqual([["<Gamepad>/touchpad1", 1]]);
    expect(p0().held("touch") && p0().pressed("second")).toBe(true);
    expect(p0().vector2("point").x).toBe(0.5);

    Input.inject.gamepadTouch(5, 0, false, 0.5, 0.5);
    Input.inject.gamepadTouch(5, 2, true, 0.5, 0.5); // a third finger isn't tracked
    step();
    s = node.getData(GamepadState)!;
    expect([s.tpHeld, s.tpUp]).toEqual([2, 1]);
    expect(events.splice(0)).toEqual([["<Gamepad>/touchpad0", 0]]);
    expect(p0().released("touch")).toBe(true);
    step();
    // A lifted finger keeps its last position in GamepadState, but reads zero as a control.
    expect(node.getData(GamepadState)!.tp0X).toBe(0.5);
    expect(p0().vector2("point").length).toBe(0);
    expect(p0().held("point")).toBe(false);
  });

  it("names touchpad controls in prompts", () => {
    pad(5);
    step();
    expect(p0().prompt("touch", "playstation")!.label).toBe("Touchpad Finger 1");
    expect(p0().prompt("point", "playstation")!.label).toBe("Touchpad");
    expect(p0().prompt("point", "playstation")!.icons).toEqual(["playstation/touchpad0Position"]);
  });
});

describe("batteries", () => {
  it("reports the lowest known level of the player's gamepads, and null when none is known", () => {
    pad(5);
    pad(6);
    step();
    expect(p0().battery).toBeNull();
    expect(engine.world.root.find("Input/Pad 5")!.getData(GamepadState)!.battery).toBe(-1);

    Input.inject.gamepadBattery(5, 0.8, true);
    Input.inject.gamepadBattery(6, -1, false); // wired, no battery
    step();
    expect(p0().battery).toEqual({ level: expect.closeTo(0.8, 5), charging: true });
    const s = engine.world.root.find("Input/Pad 5")!.getData(GamepadState)!;
    expect([s.battery, s.charging]).toEqual([expect.closeTo(0.8, 5), 1]);

    Input.inject.gamepadBattery(6, 0.3, false);
    step();
    expect(p0().battery).toEqual({ level: expect.closeTo(0.3, 5), charging: false });

    Input.inject.gamepadBattery(6, Number.NaN, false); // unknown again
    step();
    expect(p0().battery!.level).toBeCloseTo(0.8);
  });
});
