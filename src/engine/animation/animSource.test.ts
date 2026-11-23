// Authored clips (`myco.anim-source@1`, ADR 0371) through their parse and write: every track kind round-trips, defaults
// stay out of the file, bad values fall back with one problem each, and the track and key limits hold.
import { describe, expect, it } from "vitest";
import { animSourceReferences, animSourceToJson, emptyAnimSource, formatAnimSource, parseAnimSource, type AnimSource } from "./animSource";
import { TRACK_KINDS, TRACK_LIMITS, type Track } from "./tracks";

const T = { nodePath: "Body/Sword", component: "engine.MeshRenderer", field: "material.emissive" };

/** One track of every kind, with every member set away from its default somewhere. */
function everyKind(): Track[] {
  return [
    { kind: "bone", bone: "Hips", translation: [[0, 0, 1, 0], [0.5, 0, 1.1, 0]], rotation: [[0, 0, 0, 0, 1]], scale: [] },
    { kind: "float", target: { ...T, field: "intensity" }, name: "", curves: [[[0, 0], [1, 2, "smooth"]]] },
    { kind: "vec2", target: { ...T, field: "uvOffset" }, name: "", curves: [[[0, 0]], []] },
    { kind: "vec3", target: { nodePath: "", component: "engine.Transform", field: "position" }, name: "", curves: [[[0, 0, "bezier", { in: [0, 0], out: [0.2, 1] }], [1, 1]], [], [[0, 1]]] },
    { kind: "vec4", target: { ...T, field: "spring.targetPosition" }, name: "", curves: [[], [], [], [[0, 1]]] },
    { kind: "color", target: T, name: "", curves: [[[0, 1]], [[0, 0.5]], [[0, 0]], [[0, 1], [1, 0, "easeOut"]]] },
    { kind: "quat", target: { nodePath: "Head", component: "engine.Transform", field: "rotation" }, interp: "slerp", keys: [[0, 0, 0, 0, 1], [1, 0, 0.7071, 0, 0.7071]] },
    { kind: "discrete", target: { nodePath: "", component: "engine.SpriteRenderer", field: "sprite" }, valueType: "asset", keys: [[0, "asset:sheet.png#run_0"], [0.1, "asset:sheet.png#run_1"]] },
    { kind: "discrete", target: { nodePath: "", component: "engine.Light", field: "enabled" }, valueType: "bool", keys: [[0, true], [0.5, false]] },
    { kind: "morph", target: { nodePath: "Face", component: "", field: "Smile" }, name: "", curves: [[[0, 0], [0.5, 1]]] },
    { kind: "event", target: { nodePath: "", component: "", field: "" }, keys: [{ time: 0.3, method: "footstep", args: ["L", { loud: true }], threshold: 0.5, always: false }, { time: 0.4, end: 0.7, method: "swing", threshold: 0.8, always: true }] },
    { kind: "audio", target: { nodePath: "Feet", component: "", field: "" }, keys: [{ time: 0.3, audio: "asset:sfx/step.playlist.json", params: { surface: 2 } }, { time: 0.5, end: 0.8, audio: "sfx/whoosh.wav" }] },
    { kind: "activation", target: { nodePath: "Trail", component: "", field: "" }, keys: [{ time: 0.2, end: 0.6 }] },
    { kind: "subclip", target: { nodePath: "", component: "", field: "" }, keys: [{ time: 0, end: 0.5, clip: "asset:clips/wave.anim.json", offset: 0.1, speed: 2, blendIn: 0.1, blendOut: 0 }] },
    { kind: "control", target: { nodePath: "", component: "", field: "" }, keys: [{ time: 0.5, action: "particlePlay", target: "Sparks", payload: { burst: 10 } }, { time: 0.9, action: "particleStop", target: "Sparks" }] },
    { kind: "marker", keys: [{ time: 0, kind: "sync", name: "L" }, { time: 0.4, kind: "sync", name: "R" }, { time: 0.6, kind: "hit" }, { time: 0.8, kind: "exit" }, { time: 0.8, kind: "cue", name: "loopBack" }] },
    { kind: "curve", target: { nodePath: "", component: "", field: "" }, name: "FootIK", curves: [[[0, 1], [1, 0]]] },
  ];
}

function clip(): AnimSource {
  return { ...emptyAnimSource(), name: "Run", rate: 60, duration: 1, loop: true, additive: true, rotation: "slerp", rootMotion: { bone: "Root", axes: ["x", "y", "yaw"], bakeIntoPose: true }, tracks: everyKind() };
}

const reparse = (text: string) => parseAnimSource(JSON.parse(text));

describe("authored clips (myco.anim-source@1)", () => {
  it("cover every track kind of ADR 0371", () => {
    expect(new Set(everyKind().map((t) => t.kind))).toEqual(new Set(TRACK_KINDS));
  });

  it("round-trip every track kind and setting", () => {
    const x = clip();
    const read = reparse(formatAnimSource(x));
    expect(read.problems).toEqual([]);
    expect(read.value).toEqual(x);
    expect(formatAnimSource(read.value)).toBe(formatAnimSource(x));
  });

  it("write only what differs from the defaults", () => {
    expect(animSourceToJson(emptyAnimSource())).toEqual({ format: "myco.anim-source@1", duration: 1, tracks: [] });
    expect(parseAnimSource(animSourceToJson(emptyAnimSource()))).toEqual({ value: emptyAnimSource(), problems: [] });
    const rm = animSourceToJson({ ...emptyAnimSource(), rootMotion: { bone: "Root", axes: ["x", "z", "yaw"], bakeIntoPose: false } });
    expect(rm.rootMotion).toEqual({ bone: "Root" });
    const json = animSourceToJson(clip()).tracks as Record<string, unknown>[];
    expect(json.find((t) => t.kind === "event")).toEqual({
      kind: "event",
      keys: [{ time: 0.3, method: "footstep", args: ["L", { loud: true }] }, { time: 0.4, end: 0.7, method: "swing", threshold: 0.8, always: true }],
    });
    expect(json.find((t) => t.kind === "subclip")).toEqual({ kind: "subclip", keys: [{ time: 0, end: 0.5, clip: "asset:clips/wave.anim.json", offset: 0.1, speed: 2, blendIn: 0.1 }] });
  });

  it("name their path in problems and read a wrong format anyway", () => {
    const read = parseAnimSource({ format: "myco.anim@1", duration: 2 }, "clips/a.anim.json");
    expect(read.problems).toEqual(['clips/a.anim.json: format: expected "myco.anim-source@1", found "myco.anim@1"; reading it anyway.']);
    expect(read.value.duration).toBe(2);
    expect(parseAnimSource("nope").problems).toEqual(["a clip must be a JSON object; using an empty one."]);
    expect(parseAnimSource(undefined).value).toEqual(emptyAnimSource());
  });

  const base = { format: "myco.anim-source@1", duration: 1 };
  const one = (extra: Record<string, unknown>) => parseAnimSource({ ...base, ...extra });
  const track = (t: Record<string, unknown>) => parseAnimSource({ ...base, tracks: [t] });

  it.each<[string, Record<string, unknown>, string]>([
    ["rate out of range", { rate: 1000 }, "rate: 1000 is outside 1..240; using 240."],
    ["negative duration", { duration: -1 }, "duration: -1 is outside 0..3600; using 0."],
    ["loop not a boolean", { loop: "yes" }, "loop: must be true or false; using false."],
    ["unknown rotation", { rotation: "cubic" }, 'rotation: must be one of nlerp, slerp; using "nlerp".'],
    ["root motion without a bone", { rootMotion: {} }, "rootMotion.bone: root motion must name a bone; none is extracted."],
    ["unknown root-motion axis", { rootMotion: { bone: "Root", axes: ["x", "w"] } }, 'rootMotion.axes: each axis must be one of x, y, z, yaw; "w" dropped.'],
    ["tracks not a list", { tracks: {} }, "tracks: must be a list; ignored."],
  ])("fall back on a bad clip value: %s", (_label, extra, problem) => {
    expect(one(extra).problems).toEqual([problem]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["unknown kind", { kind: "spline" }, `tracks[0].kind: must be one of ${TRACK_KINDS.join(", ")}; the track is dropped.`],
    ["bone track without a bone", { kind: "bone", target: {} }, "tracks[0].target.bone: a bone track must name a bone; dropped."],
    ["property track without a field", { kind: "float", target: { component: "engine.Light" } }, "tracks[0].target: must name a component and a field; the track is dropped."],
    ["morph track without a target", { kind: "morph", target: { nodePath: "Face" } }, "tracks[0].target: a morph track must name its morph target (field); dropped."],
    ["curve track without a name", { kind: "curve", curves: [[]] }, "tracks[0].name: a curve track must have a name; dropped."],
  ])("drop a track that can't bind: %s", (_label, t, problem) => {
    const read = track(t);
    expect(read.problems).toEqual([problem]);
    expect(read.value.tracks).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string, unknown]>([
    ["a key past the end", { kind: "marker", keys: [{ time: 2, kind: "exit" }] }, "tracks[0].keys[0].time: 2 is outside 0..1 (the duration); using 1.", [{ time: 1, kind: "exit" }]],
    ["keys out of order", { kind: "activation", target: { nodePath: "A" }, keys: [{ time: 0.5, end: 0.6 }, { time: 0.1, end: 0.2 }] }, "tracks[0].keys: keys were not in time order; sorted.", [{ time: 0.1, end: 0.2 }, { time: 0.5, end: 0.6 }]],
    ["an end before the start", { kind: "activation", target: { nodePath: "A" }, keys: [{ time: 0.5, end: 0.2 }] }, "tracks[0].keys[0].end: 0.2 is outside 0.5..1; using 0.5.", [{ time: 0.5, end: 0.5 }]],
    ["a zero quaternion", { kind: "quat", target: { component: "engine.Transform", field: "rotation" }, keys: [[0, 0, 0, 0, 0]] }, "tracks[0].keys[0]: a zero quaternion isn't a rotation; using the identity.", [[0, 0, 0, 0, 1]]],
    ["a short bone key", { kind: "bone", target: { bone: "Hips" }, translation: [[0, 1, 2]] }, "tracks[0].translation[0]: a key must be [time, 3 numbers]; dropped.", undefined],
    ["a discrete key of the wrong type", { kind: "discrete", target: { component: "engine.Light", field: "enabled" }, valueType: "bool", keys: [[0, 1]] }, "tracks[0].keys[0]: a key must be [time, true or false]; dropped.", []],
    ["a notify without a method", { kind: "event", keys: [{ time: 0 }] }, "tracks[0].keys[0].method: a notify must name a method; dropped.", []],
    ["a notify threshold out of range", { kind: "event", keys: [{ time: 0, method: "f", threshold: 2 }] }, "tracks[0].keys[0].threshold: 2 is outside 0..1; using 1.", [{ time: 0, method: "f", threshold: 1, always: false }]],
    ["an unknown marker kind", { kind: "marker", keys: [{ time: 0, kind: "beat" }] }, 'tracks[0].keys[0].kind: must be one of sync, exit, hit, cue; using "cue".', [{ time: 0, kind: "cue" }]],
    ["an unknown control action", { kind: "control", keys: [{ time: 0, action: "explode" }] }, 'tracks[0].keys[0].action: must be one of particlePlay, particleStop, cameraCut, slotPlay; using "particlePlay".', [{ time: 0, action: "particlePlay" }]],
    ["an audio key without audio", { kind: "audio", keys: [{ time: 0 }] }, "tracks[0].keys[0].audio: an audio key must name an audio event or clip; dropped.", []],
    ["a subclip without a clip", { kind: "subclip", keys: [{ time: 0, end: 1 }] }, "tracks[0].keys[0].clip: a subclip key must name a clip or timeline; dropped.", []],
    ["too few curves", { kind: "vec3", target: { component: "engine.Transform", field: "position" }, curves: [[[0, 1]]] }, "tracks[0].curves: needs 3 curves (one per component); the missing ones are empty.", undefined],
  ])("fall back on a bad key: %s", (_label, t, problem, keys) => {
    const read = track(t);
    expect(read.problems).toEqual([problem]);
    if (keys !== undefined) expect((read.value.tracks[0] as { keys: unknown }).keys).toEqual(keys);
  });

  it("refuse bone tracks only in timelines, not clips", () => {
    expect(track({ kind: "bone", target: { bone: "Hips" } }).value.tracks).toHaveLength(1);
  });

  it("hold the track and key limits", () => {
    const tracks = Array.from({ length: TRACK_LIMITS.tracks + 1 }, () => ({ kind: "marker", keys: [] }));
    const many = parseAnimSource({ ...base, tracks });
    expect(many.value.tracks).toHaveLength(TRACK_LIMITS.tracks);
    expect(many.problems).toEqual([`tracks: at most ${TRACK_LIMITS.tracks} tracks; the rest are dropped.`]);
    const keys = Array.from({ length: TRACK_LIMITS.keys + 1 }, () => ({ time: 0, kind: "cue" }));
    const longTrack = track({ kind: "marker", keys });
    expect((longTrack.value.tracks[0] as { keys: unknown[] }).keys).toHaveLength(TRACK_LIMITS.keys);
    expect(longTrack.problems).toEqual([`tracks[0].keys: at most ${TRACK_LIMITS.keys} keys; the rest are dropped.`]);
    const curve = Array.from({ length: TRACK_LIMITS.keys + 1 }, (_, i) => [i / 100000, 0]);
    const longCurve = track({ kind: "float", target: { component: "c", field: "f" }, curves: [curve] });
    expect((longCurve.value.tracks[0] as { curves: unknown[][] }).curves[0]).toHaveLength(TRACK_LIMITS.keys);
    expect(longCurve.problems).toEqual([`tracks[0].curves[0]: at most ${TRACK_LIMITS.keys} keys; the rest are dropped.`]);
  });

  it("name the files they reference, once each, without sub-assets", () => {
    expect(animSourceReferences(clip())).toEqual(["sheet.png", "sfx/step.playlist.json", "sfx/whoosh.wav", "clips/wave.anim.json"]);
  });
});
