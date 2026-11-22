// Sample automation in the curve editor (D23): the dialog's lanes per effect parameter over sample time, Apply writing
// `fx:<id>:<param>` lanes on clipTime (a flat lane removed), removing an effect taking its lanes, and the render
// following an edited lane.
import { describe, expect, it } from "vitest";
import { defaultEffect } from "../../../engine/audio/effects/catalogue";
import { defaultSampleEdits } from "../../../engine/audio/sample/format";
import { renderSample } from "../../../engine/audio/sample/sampleRender";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import type { CurveEditorResult } from "../../../editor/ui/curves/curveEditorModel";
import { applyAutomationResult, automatedCount, automationDialog } from "./sampleAutomation";
import { effectEdits } from "./sampleEffects";

const edits = (): SampleEdits => ({
  ...defaultSampleEdits(),
  effects: [{ ...defaultEffect("gain", "fx1"), params: { gain: 0 } }, defaultEffect("gain", "fx2")],
  automation: [{ id: "a1", target: "fx:fx2:gain", input: "clipTime", curve: [[0, -3], [1, 0]], bypass: false }],
});
const result = (lanes: { id: string; curve: number[][]; bypass?: boolean }[]): CurveEditorResult => ({
  kind: "time", lanes: lanes.map((l) => ({ id: l.id, curve: l.curve as unknown as CurveEditorResult["lanes"][number]["curve"], input: "time", bypass: l.bypass ?? false })),
});

describe("sample automation", () => {
  it("offers one lane per parameter over sample time, flat at its value until automated", () => {
    const spec = automationDialog(edits(), "fx1", 2.5)!;
    expect(spec).toMatchObject({ kind: "time", timeName: "Sample time", length: 2.5 });
    expect(spec.lanes.map((l) => [l.id, l.curve])).toEqual([["fx:fx1:gain", [[0, 0]]]]);
    expect(automationDialog(edits(), "fx2", 2.5)!.lanes[0].curve).toEqual([[0, -3], [1, 0]]);
    expect(automationDialog(edits(), "nope", 1)).toBeNull();
  });

  it("writes an edited lane on clipTime, removes one left flat, and leaves other effects' lanes alone", () => {
    const r = applyAutomationResult(edits(), "fx1", result([{ id: "fx:fx1:gain", curve: [[0, -12], [2, 0]] }]));
    expect(r && "next" in r && r.label).toBe("Automate Gain");
    const next = (r as { next: SampleEdits }).next;
    expect(next.automation).toEqual([
      { id: "a1", target: "fx:fx2:gain", input: "clipTime", curve: [[0, -3], [1, 0]], bypass: false },
      { id: "a2", target: "fx:fx1:gain", input: "clipTime", curve: [[0, -12], [2, 0]], bypass: false },
    ]);
    expect(automatedCount(next, "fx1")).toBe(1);
    const flat = applyAutomationResult(next, "fx1", result([{ id: "fx:fx1:gain", curve: [[0, 0], [2, 0]] }]));
    expect((flat as { next: SampleEdits }).next.automation.map((a) => a.target)).toEqual(["fx:fx2:gain"]);
    expect(applyAutomationResult(edits(), "fx1", result([{ id: "fx:fx1:gain", curve: [[0, 0]] }]))).toBeNull();
    expect(effectEdits.remove(next, "fx2").next.automation.map((a) => a.target)).toEqual(["fx:fx1:gain"]);
  });

  it("the render follows the lane", async () => {
    const rate = 1000;
    const pcm = { pcm: new Float32Array(2000).fill(0.5), channels: 1, rate };
    const apply = (curve: number[][]) => (applyAutomationResult(edits(), "fx1", result([{ id: "fx:fx1:gain", curve }])) as { next: SampleEdits }).next;
    const level = async (e: SampleEdits, t: number) => (await renderSample(pcm, { ...e, effects: [e.effects[0]], automation: e.automation.filter((a) => a.target.startsWith("fx:fx1")) })).pcm[Math.round(t * rate)];
    const down = apply([[0, -6], [2, -6]]);
    expect(await level(down, 1)).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 3);
    const ramp = apply([[0, -20], [2, 0]]);
    expect(await level(ramp, 1)).toBeCloseTo(0.5 * Math.pow(10, -10 / 20), 2);
    expect(await level(ramp, 1.9)).toBeGreaterThan(await level(ramp, 1));
  });
});
