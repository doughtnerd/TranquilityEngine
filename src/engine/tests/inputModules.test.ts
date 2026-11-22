import { describe, expect, it } from "vitest";
import { compileModifier, deadzone } from "../input/modifiers";
import { combineTriggers, compileTrigger, defineTrigger } from "../input/triggers";
import type { TriggerSpec } from "../input/contextTypes";
import { applyNativeBatch } from "../input/tauriGamepads";
import { webGamepads } from "../input/webGamepads";
import { loadInputMapping } from "../input/mapping";
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, control } from "../input/controls";
import type { DeviceEventSink, GamepadInfo } from "../input/devices";

// The input system's library modules (ADR 0335, 0336), through their own interfaces.

const none = { triggered: () => false, performed: () => false };
const DT = 0.1;

describe("modifiers", () => {
  it("applies radial and axial dead zones, rescaling what's left", () => {
    const v = [0.1, 0.05, 0];
    deadzone(v, 2, 0.2, 1, "radial");
    expect(v).toEqual([0, 0, 0]);
    const w = [0.6, 0, 0];
    deadzone(w, 2, 0.2, 1, "radial");
    expect(w[0]).toBeCloseTo(0.5);
    const a = [0.1, -0.6, 0];
    deadzone(a, 2, 0.2, 1, "axial");
    expect(a[0]).toBe(0);
    expect(a[1]).toBeCloseTo(-0.5);
  });

  it("negates, swizzles, scales, curves and smooths", () => {
    const v = [1, 2, 3];
    compileModifier({ negate: { y: true } })(v, 3, 0);
    expect(v).toEqual([1, -2, 3]);
    compileModifier({ swizzle: "yx" })(v, 3, 0);
    expect(v).toEqual([-2, 1, 0]);
    compileModifier({ scale: { x: 2 } })(v, 2, 0);
    expect(v).toEqual([-4, 1, 0]);
    const c = [0.5, -0.5, 0];
    compileModifier({ curve: { exponent: 2 } })(c, 2, 0);
    expect(c).toEqual([0.25, -0.25, 0]);
    const smooth = compileModifier({ smooth: { rate: 10 } });
    const s = [1, 0, 0];
    smooth(s, 1, 0.1);
    expect(s[0]).toBeCloseTo(1 - Math.exp(-1));
  });

  it("rejects bad specs with a readable message", () => {
    expect(() => compileModifier({ deadzone: { min: 0.5, max: 0.2 } })).toThrow(/below max/);
    expect(() => compileModifier({ swizzle: "xq" })).toThrow(/x, y and z/);
  });
});

describe("triggers", () => {
  const run = (spec: Parameters<typeof compileTrigger>[0], inputs: boolean[]) => {
    const t = [compileTrigger(spec)];
    return inputs.map((a) => combineTriggers(t, a, DT, none).state);
  };

  it("hold: ongoing until min, then triggered; released early it stops", () => {
    expect(run({ hold: { min: 0.25 } }, [true, true, true, false])).toEqual([1, 1, 2, 0]);
    expect(run({ hold: { min: 0.2, oneShot: true } }, [true, true, true])).toEqual([1, 2, 1]);
  });

  it("tap: triggered on a quick release, nothing on a slow one", () => {
    expect(run({ tap: { max: 0.15 } }, [true, false])).toEqual([1, 2]);
    expect(run({ tap: { max: 0.15 } }, [true, true, true, false])).toEqual([1, 1, 0, 0]);
  });

  it("pressed, released, holdAndRelease, multiTap", () => {
    expect(run({ pressed: true }, [true, true, false])).toEqual([2, 0, 0]);
    expect(run({ released: true }, [true, false])).toEqual([1, 2]);
    expect(run({ holdAndRelease: { min: 0.2 } }, [true, true, false])).toEqual([1, 1, 2]);
    expect(run({ multiTap: { count: 2, spacing: 0.3 } }, [true, false, true, false])).toEqual([1, 1, 1, 2]);
  });

  it("pulse: fires at once and every interval while held, each a pulse", () => {
    const t = [compileTrigger({ pulse: { interval: 0.2 } })];
    const out = [true, true, true, true, true].map((a) => combineTriggers(t, a, DT, none));
    expect(out.map((o) => o.state)).toEqual([2, 1, 2, 1, 2]);
    expect(out.map((o) => o.pulse)).toEqual([true, false, true, false, true]);
  });

  it("chord is implicit: needs the other action and actuation; a blocker blocks", () => {
    const chord = [compileTrigger({ chord: { action: "mod" } })];
    expect(combineTriggers(chord, true, DT, { ...none, triggered: (a) => a === "mod" }).state).toBe(2);
    expect(combineTriggers(chord, true, DT, none).state).toBe(0);
    expect(combineTriggers(chord, false, DT, { ...none, triggered: () => true }).state).toBe(0);
    const blocked = [compileTrigger({ down: true }), compileTrigger({ chord: { action: "mod" }, type: "blocker" })];
    expect(combineTriggers(blocked, true, DT, { ...none, triggered: () => true }).state).toBe(0);
  });

  it("combo: steps performed in order within their windows", () => {
    let performed = "";
    const others = { triggered: () => false, performed: (a: string) => a === performed };
    const t = [compileTrigger({ combo: { steps: [{ action: "a" }, { action: "b", within: 0.25 }] } })];
    const frame = (p: string) => ((performed = p), combineTriggers(t, false, DT, others).state);
    expect([frame("a"), frame(""), frame("b")]).toEqual([1, 1, 2]);
    expect([frame("a"), frame(""), frame(""), frame(""), frame("b")]).toEqual([1, 1, 1, 0, 0]); // too slow
  });

  it("custom triggers: each mapping gets its own instance; booleans, pulses, types and reads", () => {
    defineTrigger<{ every: number }>("test.modules.pulseEvery", ({ every }) => {
      let n = 0;
      const t = {
        pulsed: false,
        reads: ["mod"],
        update(actuated: boolean) {
          n = actuated ? n + 1 : 0;
          t.pulsed = actuated && n % every === 0;
          return actuated;
        },
      };
      return t;
    });
    const spec = { "test.modules.pulseEvery": { every: 2 } } as TriggerSpec;
    const a = [compileTrigger(spec)];
    const b = compileTrigger({ ...spec, type: "blocker" } as TriggerSpec);
    expect(a[0].reads).toEqual(["mod"]);
    expect(b.type).toBe("blocker");
    expect([1, 2, 3, 4].map(() => combineTriggers(a, true, DT, none).pulse)).toEqual([false, true, false, true]);
    defineTrigger("test.modules.bad", () => ({ update: () => 7 as never }));
    expect(() => compileTrigger({ "test.modules.bad": {} } as TriggerSpec).update(true, DT, none)).toThrow(/returned 7/);
    expect(() => compileTrigger({ "test.modules.nope": {} } as TriggerSpec)).toThrow(/Unknown trigger "test.modules.nope"/);
  });
});

describe("control paths", () => {
  it("interns paths and names gamepad positions", () => {
    expect(control("<Keyboard>/Space")).toBe(control("<Keyboard>/space"));
    expect(control("<Gamepad>/buttonSouth")!.source).toEqual({ device: "gamepad", read: "button", index: 0 });
    expect(control("<Mouse>/leftButton")!.path).toBe("<Pointer>/button0");
    expect(control("<Pointer>/delta")!.additive).toBe(true);
    expect(control("<Gamepad>/nope")).toBeNull();
  });
});

/** A sink that records what an adapter reports. */
function recorder() {
  const log: unknown[][] = [];
  const sink: DeviceEventSink = {
    keyDown: () => {},
    keyUp: () => {},
    buttonDown: () => {},
    buttonUp: () => {},
    pointerAt: () => {},
    move: () => {},
    scroll: () => {},
    releaseAll: () => {},
    gamepadConnected: (info: GamepadInfo) => log.push(["connect", info.id, info.family]),
    gamepadDisconnected: (id) => log.push(["disconnect", id]),
    gamepadButton: (id, i, v) => log.push(["button", id, i, v]),
    gamepadAxis: (id, i, v) => log.push(["axis", id, i, v]),
    gamepadSensor: (id, kind) => log.push(["sensor", id, kind]),
  };
  return { sink, log };
}

describe("the Tauri adapter (native SDL3 batches)", () => {
  it("reports each native event to the snapshot", () => {
    const { sink, log } = recorder();
    applyNativeBatch(sink, [
      { t: "connect", id: 3, name: "DualSense", vendor: 0x054c, product: 0x0ce6, family: 2, sensors: true, rumble: true, triggerRumble: true, led: true },
      { t: "button", id: 3, index: 7, value: 0.5, time: 1 },
      { t: "axis", id: 3, index: 1, value: -1, time: 1 },
      { t: "sensor", id: 3, kind: "gyro", x: 0, y: 1, z: 0, time: 1 },
      { t: "disconnect", id: 3 },
    ]);
    expect(log).toEqual([["connect", 3, "playstation"], ["button", 3, 7, 0.5], ["axis", 3, 1, -1], ["sensor", 3, "gyro"], ["disconnect", 3]]);
  });
});

describe("the mapping module (native/input as wasm)", () => {
  it("names the wire's controls as the engine does", async () => {
    const m = await loadInputMapping();
    expect(m.controlNames()).toEqual([...GAMEPAD_BUTTONS, ...GAMEPAD_AXES]);
  });

  it("reads web gamepad ids and families", async () => {
    const m = await loadInputMapping();
    expect(m.parseWebGamepadId("Xbox 360 Controller (XInput STANDARD GAMEPAD Vendor: 045e Product: 028e)")).toEqual({ vendor: 0x045e, product: 0x028e });
    expect(m.parseWebGamepadId("054c-0ce6-DualSense Wireless Controller")).toEqual({ vendor: 0x054c, product: 0x0ce6 });
    expect(m.parseWebGamepadId("mystery")).toBeNull();
    expect(m.familyOf(0x054c, 0x0ce6, "")).toBe(2);
    expect(m.familyOf(0, 0, "Pro Controller")).toBe(3);
  });
});

describe("the browser adapter (Gamepad API)", () => {
  it("polls standard pads into wire indices, and reports unplugging", async () => {
    const { sink, log } = recorder();
    const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false }));
    let pads: (Gamepad | null)[] = [{ index: 0, id: "045e-028e-Xbox 360 Controller", mapping: "standard", connected: true, buttons, axes: [0, 0, 0, 0], timestamp: 0 } as unknown as Gamepad];
    const web = webGamepads(sink, { getGamepads: () => pads, userAgent: "Linux" } as unknown as Navigator)!;
    web.poll(); // starts loading the mapping module
    await loadInputMapping();
    await new Promise((r) => setTimeout(r, 0));
    web.poll();
    expect(log.shift()).toEqual(["connect", 0, "xbox"]);
    buttons[0].value = 1;
    (pads[0]!.axes as number[])[1] = -0.5;
    log.length = 0;
    web.poll();
    expect(log).toEqual([["button", 0, 0, 1], ["axis", 0, 1, -0.5]]);
    pads = [];
    log.length = 0;
    web.poll();
    expect(log).toEqual([["disconnect", 0]]);
  });
});
