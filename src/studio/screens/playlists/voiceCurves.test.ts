// An entry's voice curves in the shared curve editor, through the model: the dialog an entry opens (a lane per target,
// driven by voice time or a parameter) and its result written back as the entry's curves with one undo label.
import { describe, expect, it } from "vitest";
import { createDraft, draftResult, setLaneInput, withLane, type CurveDraft } from "../../../editor/ui/curves/curveEditorModel";
import type { ParameterDef } from "../../../engine/audio/eventFormat";
import { curvesLabel, parameterInputs, parameterOfInput, setParameterHistogramSource } from "../curveInputs";
import { applyVoiceCurveResult, voiceCurveDialog, type VoiceCurves } from "./voiceCurves";

const params: ParameterDef[] = [
  { name: "speed", min: 0, max: 50, default: 0, seekSpeed: 0 },
  { name: "surface", labels: ["Dirt", "Grass", "Metal"], default: "Dirt" },
];
const curves: VoiceCurves = {
  gain: { input: "voiceTime", curve: [[0, 0], [3, -12, "easeOut"]], bypass: false },
  lowpass: { input: { parameter: "speed" }, curve: [[0, 2000], [50, 20000]], bypass: false },
};
const ok = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("voice curves in the curve editor", () => {
  it("opens a time dialog with a lane per target, each with its driver, units and scale", () => {
    const d = voiceCurveDialog("dirt_02", curves, params, { speed: 20 });
    expect(d.spec.kind).toBe("time");
    expect(d.spec.timeName).toBe("Voice time");
    expect(d.spec.length).toBe(3);
    expect(d.spec.lanes.map((l) => `${l.name} ${l.unit}`)).toEqual(["Gain dB", "Pitch st", "Pan %", "Low-pass Hz", "High-pass Hz"]);
    expect(d.spec.lanes.find((l) => l.id === "gain")).toMatchObject({ input: "time", bypass: false });
    expect(d.spec.lanes.find((l) => l.id === "lowpass")).toMatchObject({ input: "param:speed", scale: "log", base: 20000 });
    expect(d.spec.lanes.find((l) => l.id === "pitch")!.input).toBeUndefined();
    expect(d.spec.inputs!.map((i) => i.id)).toEqual(["param:speed", "param:surface"]);
    expect(d.spec.inputs![0]).toMatchObject({ now: 20, max: 50 });
    expect(voiceCurveDialog("x", {}, params).spec.length).toBe(2);
  });

  it("keeps a curve on a parameter the playlist doesn't define, over its keys' span", () => {
    const d = voiceCurveDialog("x", { pitch: { input: { parameter: "rpm" }, curve: [[1000, 0], [6000, 7]], bypass: false } }, params);
    expect(d.spec.inputs!.find((i) => i.id === "param:rpm")).toMatchObject({ min: 1000, max: 6000 });
    const draft = createDraft(d.spec);
    expect(draft.lanes.find((l) => l.id === "pitch")!.curve).toEqual([[1000, 0], [6000, 7]]);
    expect(applyVoiceCurveResult(d, draftResult(d.spec, draft))).toBeNull();
  });

  it("an untouched Apply changes nothing", () => {
    const d = voiceCurveDialog("dirt_02", curves, params);
    expect(applyVoiceCurveResult(d, draftResult(d.spec, createDraft(d.spec)))).toBeNull();
  });

  it("writes a changed lane, labelled by it", () => {
    const d = voiceCurveDialog("dirt_02", curves, params);
    const draft = withLane(createDraft(d.spec), "gain", { curve: [[0, 0], [1.5, -3], [3, -12]] });
    const r = applyVoiceCurveResult(d, draftResult(d.spec, draft))!;
    expect(r.label).toBe("Automate Gain · dirt_02");
    expect(r.curves.gain).toEqual({ input: "voiceTime", curve: [[0, 0], [1.5, -3], [3, -12]], bypass: false });
    expect(r.curves.lowpass).toBe(curves.lowpass);
  });

  it("adds a lane driven by a parameter, removes one left flat at its plain value, and labels many by the entry", () => {
    const d = voiceCurveDialog("dirt_02", curves, params);
    let draft: CurveDraft = createDraft(d.spec);
    draft = ok(setLaneInput(d.spec, draft, "pitch", "param:speed"));
    draft = withLane(draft, "pitch", { curve: [[0, 0], [50, 5]] });
    draft = withLane(draft, "lowpass", { curve: [[0, 20000], [50, 20000]] });
    const r = applyVoiceCurveResult(d, draftResult(d.spec, draft))!;
    expect(r.label).toBe("Edit dirt_02 curves");
    expect(r.curves.pitch).toEqual({ input: { parameter: "speed" }, curve: [[0, 0], [50, 5]], bypass: false });
    expect("lowpass" in r.curves).toBe(false);
    expect(r.curves.gain).toBe(curves.gain);
  });

  it("keeps a flat lane that's bypassed or off its plain value, and keeps clip time on a time curve that had it", () => {
    const d = voiceCurveDialog("e", { gain: { input: "clipTime", curve: [[0, 0], [2, -6]], bypass: false } }, params);
    let draft = withLane(createDraft(d.spec), "gain", { curve: [[0, -6], [2, -6]] });
    draft = withLane(draft, "pan", { curve: [[0, 0], [2, 0]], bypass: true });
    const r = applyVoiceCurveResult(d, draftResult(d.spec, draft))!;
    expect(r.curves.gain).toEqual({ input: "clipTime", curve: [[0, -6], [2, -6]], bypass: false });
    expect(r.curves.pan).toEqual({ input: "voiceTime", curve: [[0, 0], [2, 0]], bypass: true });
  });

  it("passes the histogram of the first curve's parameter while a take provides one", () => {
    const stop = setParameterHistogramSource((name) => (name === "speed" ? [1, 2, 3] : null));
    try {
      expect(voiceCurveDialog("e", { lowpass: curves.lowpass }, params).histogram).toEqual([1, 2, 3]);
      expect(voiceCurveDialog("e", curves, params).histogram).toBeUndefined();
    } finally {
      stop();
    }
  });
});

describe("curve inputs", () => {
  it("names parameter inputs apart from the time axis and reads them back", () => {
    const inputs = parameterInputs([{ name: "time", min: 0, max: 1, default: 0, seekSpeed: 0 }, ...params], { surface: 2 });
    expect(inputs.map((i) => i.id)).toEqual(["param:time", "param:speed", "param:surface"]);
    expect(inputs[2]).toMatchObject({ name: "surface (labels)", min: 0, max: 2, now: 2 });
    expect(parameterOfInput("param:time")).toBe("time");
    expect(parameterOfInput("time")).toBeNull();
  });

  it("labels an Apply by its one lane or by the owner", () => {
    expect(curvesLabel("Music", [])).toBeNull();
    expect(curvesLabel("Music", ["Low-pass cutoff"])).toBe("Automate Low-pass cutoff · Music");
    expect(curvesLabel("Music", ["Level", "Send to Reverb"])).toBe("Edit Music curves");
  });
});
