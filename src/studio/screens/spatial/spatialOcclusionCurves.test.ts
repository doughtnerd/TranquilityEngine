// ADR 0362 item 6: the Scene settings' occlusion curves — the Curves window's Occlusion mode, what Apply writes, the
// Fully blocked readout, which curves a scene hears, and the scene's own curves.
import { describe, expect, it } from "vitest";
import { draftResult, createDraft } from "../../../editor/ui/curves/curveEditorModel";
import { builtinMaterials } from "../../../engine/audio/occlusionMaterials";
import { audioProjectToJson, defaultAudioProject, parseAudioProject } from "../../../engine/audio/project/format";
import { audioTestSceneToJson, emptyAudioTestScene, parseAudioTestScene } from "../../../engine/audio/spatial/testScene";
import { DEFAULT_OCCLUSION_CURVES, effectiveOcclusionCurves, fullyBlockedText, occlusionDialog, occlusionFromResult, setProjectOcclusionCurves, setSceneOcclusionCurves } from "./occlusionCurvesModel";

const concrete = builtinMaterials().find((m) => m.name === "concrete");
const next = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("the Curves window's Occlusion mode", () => {
  it("runs over Blocked 0..1 with a Volume and a log Low-pass lane, starting from the prototype's curves", () => {
    const spec = occlusionDialog(undefined);
    expect(spec).toMatchObject({ kind: "parameter", parameter: { name: "Blocked", min: 0, max: 1 } });
    expect(spec.lanes.map((l) => [l.id, l.name, l.unit, l.scale ?? "linear"])).toEqual([["volume", "Volume", "dB", "linear"], ["lowpass", "Low-pass", "Hz", "log"]]);
    expect(spec.lanes.map((l) => l.curve)).toEqual([DEFAULT_OCCLUSION_CURVES.volume, DEFAULT_OCCLUSION_CURVES.lowpass]);
    // A set with one curve: the other lane is flat at its plain value.
    expect(occlusionDialog({ volume: [[0, 0], [1, -20]] }).lanes[1]!.curve).toEqual([[0, 20000], [1, 20000]]);
  });

  it("Apply writes each lane's keys, leaving flat and bypassed lanes to the materials; nothing said is null", () => {
    const spec = occlusionDialog(undefined);
    const result = draftResult(spec, createDraft(spec));
    expect(occlusionFromResult(result)).toEqual(DEFAULT_OCCLUSION_CURVES);
    const flat = { ...result, lanes: result.lanes.map((l) => (l.id === "lowpass" ? { ...l, curve: [[0, 20000], [1, 20000]] as never } : l)) };
    expect(occlusionFromResult(flat)).toEqual({ volume: DEFAULT_OCCLUSION_CURVES.volume });
    const off = { ...result, lanes: result.lanes.map((l) => ({ ...l, bypass: true })) };
    expect(occlusionFromResult(off)).toBeNull();
  });
});

describe("Fully blocked", () => {
  it("reads the curves' ends, else one obstacle of the default material", () => {
    expect(fullyBlockedText(undefined, concrete)).toBe("−30 dB · low-pass 800 Hz");
    expect(fullyBlockedText(DEFAULT_OCCLUSION_CURVES, concrete)).toBe("−9 dB · low-pass 1.2 kHz");
    expect(fullyBlockedText({ lowpass: [[0, 20000], [1, 500]] }, concrete)).toBe("−30 dB · low-pass 500 Hz");
  });
});

describe("where the curves live", () => {
  it("the project's are saved in audio.json; a scene's own stand in for them and are saved in the scene file", () => {
    const p = next(setProjectOcclusionCurves(defaultAudioProject(), DEFAULT_OCCLUSION_CURVES));
    expect(parseAudioProject(JSON.parse(JSON.stringify(audioProjectToJson(p)))).project.settings.occlusion.curves).toEqual(DEFAULT_OCCLUSION_CURVES);
    const blank = emptyAudioTestScene();
    expect(effectiveOcclusionCurves(p, blank)).toEqual(DEFAULT_OCCLUSION_CURVES);
    const own = next(setSceneOcclusionCurves(blank, { volume: [[0, 0], [1, -3]] }));
    expect(effectiveOcclusionCurves(p, own)).toEqual({ volume: [[0, 0], [1, -3]] });
    expect(parseAudioTestScene(JSON.parse(JSON.stringify(audioTestSceneToJson(own)))).scene.settings?.occlusion?.curves).toEqual({ volume: [[0, 0], [1, -3]] });
    const back = next(setSceneOcclusionCurves(own, null));
    expect(back.settings).toBeUndefined();
    expect(next(setProjectOcclusionCurves(p, null)).settings.occlusion.curves).toBeUndefined();
  });
});
