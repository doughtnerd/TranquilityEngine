import { describe, expect, it } from "vitest";
import { createDraft } from "./curveEditorModel";
import { FIELD_LANE, fieldDialogSpec } from "./curveFieldModel";

describe("the inline field's dialog", () => {
  it("is one lane over the field's x range, with the field's bounds as its value range", () => {
    const spec = fieldDialogSpec({ curve: [[0, 1], [10, 0.5, "smooth"]], xRange: [0, 10], yRange: [0, 2], interpolation: true, label: "Volume", xName: "Speed" });
    expect(spec.kind).toBe("parameter");
    expect(spec.parameter).toEqual({ name: "Speed", min: 0, max: 10 });
    expect(spec.lanes).toEqual([{ id: FIELD_LANE, name: "Volume", unit: "", min: 0, max: 2, step: 0.01, base: 1, curve: [[0, 1], [10, 0.5, "smooth"]] }]);
    expect(spec.linearOnly).toBe(false);
  });
  it("a field fitting its keys gets their range widened by half again on sides no bound pins; no shapes means linear only", () => {
    const spec = fieldDialogSpec({ curve: [[0, 2], [1, 4]], xRange: [0, 1], yRange: [0, Infinity], interpolation: false, fitY: true, label: "Size" });
    // fitYRange pins 0 and pads the top to 4.2; half the span (2.1) more above.
    expect(spec.lanes[0].min).toBe(0);
    expect(spec.lanes[0].max).toBeCloseTo(6.3);
    expect(spec.linearOnly).toBe(true);
    expect(spec.parameter?.name).toBe("X");
  });
  it("opens with end keys at the x range's ends", () => {
    const spec = fieldDialogSpec({ curve: [[0.25, 1]], xRange: [0, 1], yRange: [0, 2], interpolation: true, label: "Gain" });
    expect(createDraft(spec).lanes[0].curve).toEqual([[0, 1], [0.25, 1], [1, 1]]);
  });
  it("an empty x range still spans something", () => {
    expect(fieldDialogSpec({ curve: [], xRange: [3, 3], yRange: [0, 1], interpolation: true, label: "A" }).parameter).toEqual({ name: "X", min: 3, max: 4 });
  });
});
