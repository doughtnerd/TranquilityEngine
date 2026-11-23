import { describe, expect, it, vi } from "vitest";
import type { DeviceEventSink } from "../input/devices";
import { EFFECTS_BLOCK_LENGTH, encodeTriggerEffect, triggerEffectBlock } from "../input/dualSenseEffects";
import { tauriGamepads, type NativeGamepadEvent } from "../input/tauriGamepads";

// The desktop adapter (ADR 0335) against a stand-in for Tauri's IPC: the commands it invokes, and
// the batches the native side streams to its channel.

const tauri = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown>][],
  channel: null as { onmessage: (batch: NativeGamepadEvent[]) => void } | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (batch: NativeGamepadEvent[]) => void = () => {};
    constructor() {
      tauri.channel = this;
    }
  },
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    tauri.calls.push([cmd, args]);
  },
}));

const connect = (id: number, vendor: number, product: number): NativeGamepadEvent => ({ t: "connect", id, name: "Pad", vendor, product, family: 2, sensors: true, rumble: true, triggerRumble: false, led: true });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("DualSense effect blocks", () => {
  it("set one trigger's effect and nothing else", () => {
    const right = triggerEffectBlock("right", { mode: "weapon", start: 0.3, end: 0.6, strength: 1 });
    expect(right.length).toBe(EFFECTS_BLOCK_LENGTH);
    expect(right[0]).toBe(0x04); // only the right trigger's enable bit: motors and lights untouched
    expect([...right.subarray(10, 21)]).toEqual([0x25, 0x28, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    expect(right.subarray(21).every((b) => b === 0)).toBe(true);
    const left = triggerEffectBlock("left", { mode: "off" });
    expect(left[0]).toBe(0x08);
    expect([...left.subarray(21, 32)]).toEqual([...encodeTriggerEffect({ mode: "off" })]);
  });
});

describe("the Tauri adapter", () => {
  it("sends trigger effects to DualSense pads only, as effect blocks", async () => {
    const sink = { gamepadConnected: () => {}, gamepadDisconnected: () => {} } as unknown as DeviceEventSink;
    const { output, stop } = tauriGamepads(sink);
    await settle();
    expect(tauri.calls.map((c) => c[0])).toEqual(["myco_gamepad_listen"]);
    tauri.channel!.onmessage([connect(1, 0x054c, 0x0ce6), connect(2, 0x054c, 0x05c4), connect(3, 0x054c, 0x0df2)]);
    tauri.calls.length = 0;

    output.triggerEffect!(1, "right", { mode: "resistance", start: 0, strength: 0.5 });
    output.triggerEffect!(2, "right", { mode: "resistance" }); // a DualShock 4: no adaptive triggers
    output.triggerEffect!(3, "left", { mode: "off" }); // DualSense Edge
    await settle();
    expect(tauri.calls).toEqual([
      ["myco_gamepad_trigger_effect", { id: 1, bytes: [...triggerEffectBlock("right", { mode: "resistance", start: 0, strength: 0.5 })] }],
      ["myco_gamepad_trigger_effect", { id: 3, bytes: [...triggerEffectBlock("left", { mode: "off" })] }],
    ]);

    tauri.channel!.onmessage([{ t: "disconnect", id: 1 }]);
    tauri.calls.length = 0;
    output.triggerEffect!(1, "right", { mode: "off" });
    await settle();
    expect(tauri.calls).toEqual([]);
    stop();
  });
});
