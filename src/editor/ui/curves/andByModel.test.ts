import { describe, expect, it } from "vitest";
import { byModes, labelRows, layersOf, layerView, previewValue, secondChoices, setBy, setByMode, setLabelValue, writeLayer, type SecondInput } from "./andByModel";
import { axisOf, createDraft, draftResult, laneOf, setLaneInput, type CurveEditorSpec } from "./curveEditorModel";

const speed: SecondInput = { id: "speed", name: "Speed", min: 0, max: 100 };
const surface: SecondInput = { id: "surface", name: "Surface", min: 0, max: 4, labels: ["Dirt", "Gravel", "Wood", "Metal", "Water"] };
const spec = (over: Partial<CurveEditorSpec> = {}): CurveEditorSpec => ({
  kind: "time",
  length: 2,
  lanes: [{ id: "gain", name: "Gain", unit: "dB", min: -24, max: 6, step: 0.1, base: 0, curve: [[0, -6], [2, 0]] }],
  secondInputs: [speed, surface],
  ...over,
});

describe("And by", () => {
  it("offers the second inputs, with Morph, Scale and (time only) Rate for a scalar one and per label for a labelled one", () => {
    const s = spec();
    expect(secondChoices(s, "time").map((i) => i.id)).toEqual(["speed", "surface"]);
    expect(byModes(s, speed, "time")).toEqual(["morph", "scale", "rate"]);
    expect(byModes({ ...s, kind: "parameter", inputs: [{ id: "rpm", name: "RPM", min: 0, max: 1 }] }, speed, "rpm")).toEqual(["morph", "scale"]);
    expect(byModes(s, surface, "time")).toEqual(["labels"]);
  });

  it("morphs between the curve (Low) and a High curve that starts as its copy", () => {
    const s = spec();
    let d = setBy(s, createDraft(s), "gain", "speed");
    expect(laneOf(s, d, "gain")!.state.by).toMatchObject({ input: "speed", mode: "morph" });
    expect(layersOf(s, laneOf(s, d, "gain")!.state.by).map((l) => l.label)).toEqual(["Low", "High"]);
    // Edit the High layer through its view: the plot writes it back.
    const v = layerView(s, d, "gain", "high")!;
    expect(laneOf(v.spec, v.draft, "gain")!.state.curve).toEqual([[0, -6], [2, 0]]);
    d = writeLayer(d, "gain", "high", [[0, 6], [2, 6]]);
    expect(previewValue(s, d, "gain", 0, 0)).toBeCloseTo(-6);
    expect(previewValue(s, d, "gain", 0, 50)).toBeCloseTo(0);
    expect(previewValue(s, d, "gain", 0, 100)).toBeCloseTo(6);
    expect(laneOf(s, d, "gain")!.state.curve).toEqual([[0, -6], [2, 0]]); // Low untouched
  });

  it("scales by a × curve over the second input (0..2×), on that input's axis", () => {
    const s = spec();
    const d0 = setByMode(s, setBy(s, createDraft(s), "gain", "speed"), "gain", "scale");
    const v = layerView(s, d0, "gain", "scale")!;
    const lane = laneOf(v.spec, v.draft, "gain")!;
    expect(lane.lane).toMatchObject({ unit: "×", min: 0, max: 2 });
    expect(axisOf(v.spec, lane.state.input)).toMatchObject({ id: "speed", min: 0, max: 100 });
    const d = writeLayer(d0, "gain", "scale", [[0, 1], [100, 0.5]]);
    expect(previewValue(s, d, "gain", 0, 100)).toBeCloseTo(-3);
  });

  it("runs the clock at a rate on time lanes", () => {
    const s = spec();
    const d = writeLayer(setByMode(s, setBy(s, createDraft(s), "gain", "speed"), "gain", "rate"), "gain", "rate", [[0, 2], [100, 2]]);
    expect(previewValue(s, d, "gain", 0.5, 50)).toBeCloseTo(-3); // 0.5 s at 2× reads the curve at 1 s
    expect(previewValue(s, d, "gain", 1.5, 50)).toBeCloseTo(0); // held at the end
  });

  it("gives each label its own curve, the first label being the lane's, with a Table of flat values", () => {
    const s = spec();
    let d = setBy(s, createDraft(s), "gain", "surface");
    expect(layersOf(s, laneOf(s, d, "gain")!.state.by).map((l) => l.id)).toEqual(["main", "label:Gravel", "label:Wood", "label:Metal", "label:Water"]);
    d = setLabelValue(s, d, "gain", "label:Metal", -12);
    const rows = labelRows(s, d, "gain");
    expect(rows.find((r) => r.label === "Metal")).toMatchObject({ value: -12, keys: 2 });
    expect(rows[0]).toMatchObject({ label: "Dirt", value: null, keys: 2 });
    expect(previewValue(s, d, "gain", 1, 3)).toBeCloseTo(-12);
    expect(previewValue(s, d, "gain", 1, 1)).toBeCloseTo(-3); // Gravel: the lane's curve
  });

  it("returns each lane's layer with Apply, drops it with Nothing or a new input, and keeps it on reopening", () => {
    const s = spec();
    const d = writeLayer(setBy(s, createDraft(s), "gain", "speed"), "gain", "high", [[0, 3], [2, 3]]);
    const r = draftResult(s, d);
    expect(r.lanes[0]!.by).toEqual({ input: "speed", mode: "morph", curve: [[0, 3], [2, 3]] });
    expect(laneOf(s, setBy(s, d, "gain", null), "gain")!.state.by).toBeUndefined();
    const withParam: CurveEditorSpec = { ...s, inputs: [{ id: "rpm", name: "RPM", min: 0, max: 1 }] };
    const moved = setLaneInput(withParam, d, "gain", "rpm");
    expect("next" in moved && laneOf(withParam, moved.next, "gain")!.state.by).toBeUndefined();
    const reopened = createDraft({ ...s, lanes: [{ ...s.lanes[0]!, by: r.lanes[0]!.by }] });
    expect(laneOf(s, reopened, "gain")!.state.by).toEqual(r.lanes[0]!.by);
  });
});
