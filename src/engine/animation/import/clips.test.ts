// ADR 0371: the model sidecar's `animation` section (lenient parse, limits once, only non-default values written, a
// round trip through `myco.import@1`) and the clips it cuts from takes.
import { describe, expect, it } from "vitest";
import { formatImportSettings, parseImportSettings } from "../../scene/importSettings";
import type { ImportedTake } from "./channels";
import { ANIMATION_IMPORT_LIMITS, clipsFromTakes, defaultModelAnimationSettings, modelAnimationToJson, parseModelAnimation } from "./clips";

const FULL = {
  influences: 8,
  profile: "asset:rigs/biped.skelprofile.json",
  boneMap: { Hips: "mixamorig:Hips", Head: "mixamorig:Head" },
  retargetSource: "tpose",
  clips: {
    "Take 001": [
      {
        name: "Walk", from: 0.5, to: 1.5, loop: true,
        rootMotion: { bone: "Hips", axes: ["x", "z"], bakeIntoPose: true },
        additive: { reference: "Idle#0" },
        compression: { error: 0.5, maxRate: 60 },
        markers: [{ time: 0.3, kind: "sync", name: "L" }],
        events: [{ time: 0.2, method: "footstep", args: ["L"] }],
        curves: [{ name: "FootIK", curve: [[0, 1], [1, 0]] }],
        mirror: true,
      },
      { name: "Idle" },
    ],
  },
};

describe("the sidecar animation section", () => {
  it("reads every setting and writes it back unchanged", () => {
    const problems: string[] = [];
    const a = parseModelAnimation(FULL, "animation", problems);
    expect(problems).toEqual([]);
    expect(a.influences).toBe(8);
    expect(a.clips["Take 001"][0]).toMatchObject({ name: "Walk", from: 0.5, to: 1.5, loop: true, rootMotion: { bone: "Hips", axes: ["x", "z"], bakeIntoPose: true }, additive: { reference: "Idle#0" }, compression: { error: 0.5, maxRate: 60 }, mirror: true });
    expect(modelAnimationToJson(a)).toEqual(FULL);
    expect(parseModelAnimation(modelAnimationToJson(a), "animation", [])).toEqual(a);
  });

  it("writes only non-default values, and nothing for an all-default section", () => {
    expect(modelAnimationToJson(defaultModelAnimationSettings())).toBeUndefined();
    const a = parseModelAnimation({ influences: 4, clips: { T: [{ name: "A", from: 0, loop: false, compression: {}, rootMotion: { bone: "Root", axes: ["x", "z", "yaw"] } }] } }, "animation", []);
    expect(modelAnimationToJson(a)).toEqual({ clips: { T: [{ name: "A", rootMotion: { bone: "Root" } }] } });
  });

  it("keeps only the compression values an entry sets, so the rest inherits (T19)", () => {
    const a = parseModelAnimation({ clips: { T: [{ name: "A", compression: { error: 0.1, platforms: { web: { maxRate: 15 } } } }, { name: "B" }] } }, "animation", []);
    expect(a.clips.T[0].compression).toEqual({ error: 0.1, platforms: { web: { maxRate: 15 } } });
    expect(a.clips.T[1].compression).toEqual({});
    expect(modelAnimationToJson(a)).toEqual({ clips: { T: [{ name: "A", compression: { error: 0.1, platforms: { web: { maxRate: 15 } } } }, { name: "B" }] } });
  });

  it("falls back leniently, one problem per bad value", () => {
    const problems: string[] = [];
    const a = parseModelAnimation({ influences: 6, boneMap: { Hips: 3 }, profile: 2, clips: { T: [{ name: "a#b" }, { name: "X", from: 2, to: 1 }, { name: "X" }, { name: "Y", compression: { error: -1 } }] } }, "animation", problems);
    expect(a.influences).toBe(4);
    expect(a.boneMap).toEqual({});
    expect(a.profile).toBeNull();
    expect(a.clips.T.map((c) => [c.name, c.to])).toEqual([["X", null], ["Y", null]]);
    expect(a.clips.T[1].compression.error).toBe(0.001);
    expect(problems).toEqual([
      "animation.influences: must be 4 or 8; using 4.",
      "animation.boneMap.Hips: must name a bone; dropped.",
      "animation.clips.T[0].name: a clip needs a name without # / \\ or quotes; the clip is dropped.",
      "animation.clips.T[1].to: must be after from (2); using the take's end.",
      'animation.clips.T[2].name: "X" is already a clip of this take; dropped.',
      "animation.clips.T[3].compression.error: -1 is outside 0.001..1000; using 0.001.",
      'animation.profile: must be a string or null; using null.',
    ]);
    expect(parseModelAnimation("nope", "animation", problems)).toEqual(defaultModelAnimationSettings());
  });

  it("declares its limits once", () => {
    const problems: string[] = [];
    const many = Array.from({ length: ANIMATION_IMPORT_LIMITS.clipsPerTake + 1 }, (_, i) => ({ name: `c${i}` }));
    expect(parseModelAnimation({ clips: { T: many } }, "animation", problems).clips.T).toHaveLength(ANIMATION_IMPORT_LIMITS.clipsPerTake);
    expect(problems).toEqual([`animation.clips.T: at most ${ANIMATION_IMPORT_LIMITS.clipsPerTake} clips; the rest are dropped.`]);
  });

  it("round-trips through a model's import settings (myco.import@1)", () => {
    const { settings, problems } = parseImportSettings({ format: "myco.import@1", scale: 0.01, animation: FULL });
    expect(problems).toEqual([]);
    const text = formatImportSettings(settings);
    expect(JSON.parse(text).animation).toEqual(FULL);
    expect(parseImportSettings(JSON.parse(text)).settings).toEqual(settings);
    // An all-default section reads as none and isn't written.
    const plain = parseImportSettings({ format: "myco.import@1", animation: { influences: 4 } }).settings;
    expect(plain.animation).toBeNull();
    expect(JSON.parse(formatImportSettings(plain)).animation).toBeUndefined();
  });
});

describe("clips from takes", () => {
  const take: ImportedTake = {
    name: "Take 001",
    duration: 2,
    tracks: [
      { kind: "bone", bone: "Hips", translation: [[0, 0, 0, 0], [2, 2, 0, 0]], rotation: [], scale: [] },
      { kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0, "step"], [1, 5]]] },
    ],
  };

  it("makes one whole clip per take without settings", () => {
    const [clip] = clipsFromTakes([take], defaultModelAnimationSettings(), []);
    expect(clip.name).toBe("Take 001");
    expect(clip.source).toMatchObject({ format: "myco.anim-source@1", duration: 2, loop: false, additive: false, rootMotion: null });
    expect(clip.source.tracks).toEqual(take.tracks);
  });

  it("cuts and shifts each clip, with keys at both ends, and adds its markers, events and curves", () => {
    const settings = parseModelAnimation(FULL, "animation", []);
    const problems: string[] = [];
    const [walk, idle] = clipsFromTakes([take], settings, problems);
    expect(problems).toEqual([]);
    expect([walk.name, walk.source.duration, walk.source.loop, walk.source.additive]).toEqual(["Walk", 1, true, true]);
    expect(walk.source.rootMotion).toEqual({ bone: "Hips", axes: ["x", "z"], bakeIntoPose: true });
    expect(walk.settings).toEqual({ additiveReference: "Idle#0", compression: { error: 0.5, maxRate: 60 }, mirror: true });
    const hips = walk.source.tracks[0];
    expect(hips.kind === "bone" && hips.translation).toEqual([[0, 0.5, 0, 0], [1, 1.5, 0, 0]]);
    const lamp = walk.source.tracks[1];
    // From 0.5 (inside a step segment, value 0) to 1.5 (after the last key, 5).
    expect(lamp.kind === "float" && lamp.curves[0]).toEqual([[0, 0, "step"], [0.5, 5], [1, 5]]);
    expect(walk.source.tracks.slice(2).map((t) => t.kind)).toEqual(["marker", "event", "curve"]);
    expect(idle.source.duration).toBe(2);
  });

  it("says when a take is missing or a clip is outside its take, and keeps names unique", () => {
    const problems: string[] = [];
    const settings = parseModelAnimation({ clips: { "Take 001": [{ name: "Late", from: 5 }], Missing: [{ name: "X" }] } }, "animation", []);
    const clips = clipsFromTakes([take, { ...take, name: "Late" }], settings, problems);
    expect(clips.map((c) => [c.name, c.source.duration])).toEqual([["Late", 2], ["Late 2", 2]]);
    expect(problems).toEqual([
      'animation.clips: the model has no take named "Missing"; its clips are skipped.',
      'animation.clips.Take 001: "Late" (5..end) is outside the take\'s 2 s; using the whole take.',
      'animation: two clips are named "Late"; the one from take "Late" is "Late 2".',
    ]);
  });
});
