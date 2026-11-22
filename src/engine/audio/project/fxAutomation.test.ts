// ADR 0330 / 0331 (ABI 4.8): an effect-parameter automation as the audio core evaluates it: the catalogue parameter's
// index and scale, and a log-scale parameter's curve as its log2 (and back), Bézier handles kept in shape.
import { describe, expect, it } from "vitest";
import { evalCurve, type Curve } from "../../core/curve";
import { applyOpToSettings } from "../mixOps";
import { defaultAudioSettings } from "../settings";
import { fromLog2Curve, fxParamName, fxParamSlot, log2Curve } from "./fxAutomation";

describe("fxAutomation", () => {
  it("finds a catalogue parameter's index and scale, and its name back", () => {
    expect(fxParamSlot("lowpass", "cutoff")).toEqual({ index: 0, log: true });
    expect(fxParamSlot("delay", "feedback")).toEqual({ index: 1, log: false });
    expect(fxParamSlot("eq", "high")).toEqual({ index: 2, log: false });
    expect(fxParamSlot("delay", "nope")).toBeNull();
    expect(fxParamSlot("nope", "cutoff")).toBeNull();
    expect(fxParamName("delay", 1)).toBe("feedback");
    expect(fxParamName("delay", 9)).toBeNull();
  });

  it("turns a frequency curve into log2 and back; 2^curve interpolates in log scale", () => {
    const hz: Curve = [[0, 200], [1, 3200, "smooth"], [2, 800]];
    const l = log2Curve(hz);
    expect(l).toEqual([[0, Math.log2(200)], [1, Math.log2(3200), "smooth"], [2, Math.log2(800)]]);
    expect(Math.pow(2, evalCurve(l, 0.5))).toBeCloseTo(Math.sqrt(200 * 3200), 6); // the geometric midpoint
    expect(fromLog2Curve(l)).toEqual(hz);
    // A key at 0 Hz or below reads as 0.001 Hz (log2 of it is finite).
    expect(log2Curve([[0, 0]])[0]![1]).toBeCloseTo(Math.log2(0.001), 9);
  });

  it("keeps a Bézier key's handles in shape: each re-measured in log2 from its key", () => {
    const hz: Curve = [[0, 1000, "bezier", { in: [0, 0], out: [0.25, 1000] }], [1, 4000]];
    const l = log2Curve(hz);
    const k = l[0]! as readonly [number, number, "bezier", { in: readonly [number, number]; out: readonly [number, number] }];
    expect(k[3].out).toEqual([0.25, Math.log2(2000) - Math.log2(1000)]);
    expect(fromLog2Curve(l)).toEqual(hz);
  });

  it("a rename or removal of a return follows a send automation's `to` in the runtime's ops", () => {
    const a = defaultAudioSettings();
    a.buses.push({ name: "Echo", parent: "Master", volume: 1, mute: false, effects: [] });
    a.parameters = [{ name: "p", min: 0, max: 1, default: 0, seekSpeed: 0 }];
    a.automation = [{ bus: "SFX", parameter: "p", target: "send", to: "Echo", curve: [[0, 0]] }];
    expect(applyOpToSettings(a, { op: "renameBus", from: "Echo", to: "Delay" }).automation[0]!.to).toBe("Delay");
    expect(applyOpToSettings(a, { op: "removeBus", bus: "Echo" }).automation).toEqual([]);
  });
});
