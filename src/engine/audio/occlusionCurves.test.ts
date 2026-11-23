// ADR 0362 item 6: occlusion curves — how blocked a path is, the curves' parse and evaluation, and their place in
// `audio.occlusion` / `audio.json` `settings.occlusion`.
import { describe, expect, it } from "vitest";
import { blockedOfDb, occlusionCurvesToJson, occlusionCutoffHz, occlusionVolumeDb, parseOcclusionCurves, sameOcclusionCurves } from "./occlusionCurves";
import { parseAudioSettings } from "./settings";
import { audioProjectToJson, defaultAudioProject, parseAudioProject } from "./project/format";

describe("how blocked a path is", () => {
  it("is the ray's combined loss over the −60 dB floor, clamped to 0..1", () => {
    expect(blockedOfDb(0)).toBe(0);
    expect(blockedOfDb(-30)).toBe(0.5);
    expect(blockedOfDb(-60)).toBe(1);
    expect(blockedOfDb(-90)).toBe(1);
    expect(blockedOfDb(Number.NaN)).toBe(0);
  });
});

describe("the curves", () => {
  it("evaluate in dB and Hz, clamped to their ranges; NaN without the curve", () => {
    const c = { volume: [[0, 0], [1, -12]] as const, lowpass: [[0, 20000], [1, 1000]] as const };
    expect(occlusionVolumeDb(c, 0.5)).toBeCloseTo(-6, 9);
    expect(occlusionCutoffHz(c, 1)).toBe(1000);
    expect(occlusionVolumeDb({ lowpass: c.lowpass }, 0.5)).toBeNaN();
    expect(occlusionCutoffHz(undefined, 0.5)).toBeNaN();
  });

  it("parse leniently: absent is undefined, bad curves are dropped, keys clamped, each with a problem", () => {
    const problems: string[] = [];
    expect(parseOcclusionCurves(undefined, "k", problems)).toBeUndefined();
    expect(parseOcclusionCurves(5, "k", problems)).toBeUndefined();
    const c = parseOcclusionCurves({ volume: [[0, 3], [2, -100]], lowpass: "no", wet: [] }, "k", problems);
    expect(c).toEqual({ volume: [[0, 0], [1, -80]] });
    expect(problems).toEqual([
      expect.stringContaining("k must be an object"),
      expect.stringContaining("k.wet: unknown curve"),
      expect.stringContaining("k.volume: keys must lie in blocked 0..1"),
      expect.stringContaining("k.lowpass: a curve must be a list"),
    ]);
  });

  it("write back what they read, shapes included", () => {
    const raw = { volume: [[0, 0], [1, -9, "easeOut"]], lowpass: [[0, 20000], [1, 1200]] };
    const c = parseOcclusionCurves(raw, "k", [])!;
    expect(occlusionCurvesToJson(c)).toEqual(raw);
    expect(sameOcclusionCurves(c, parseOcclusionCurves(raw, "k", []))).toBe(true);
    expect(sameOcclusionCurves(undefined, {})).toBe(true);
    expect(sameOcclusionCurves(c, undefined)).toBe(false);
  });
});

describe("in the settings", () => {
  it("audio.occlusion.curves parses into the runtime settings; absent stays absent", () => {
    const { settings, problems } = parseAudioSettings({ occlusion: { curves: { volume: [[0, 0], [1, -9]] } } });
    expect(problems).toEqual([]);
    expect(settings.occlusion.curves).toEqual({ volume: [[0, 0], [1, -9]] });
    expect(parseAudioSettings({}).settings.occlusion.curves).toBeUndefined();
  });

  it("audio.json keeps the project's curves through a save and leaves them out when there are none", () => {
    const p = defaultAudioProject();
    expect(audioProjectToJson(p).settings).not.toHaveProperty("occlusion");
    const withCurves = { ...p, settings: { ...p.settings, occlusion: { ...p.settings.occlusion, curves: { lowpass: [[0, 20000], [1, 1200]] as const } } } };
    const json = audioProjectToJson(withCurves);
    expect(json.settings).toMatchObject({ occlusion: { curves: { lowpass: [[0, 20000], [1, 1200]] } } });
    expect(parseAudioProject(JSON.parse(JSON.stringify(json))).project.settings.occlusion.curves).toEqual({ lowpass: [[0, 20000], [1, 1200]] });
  });
});
