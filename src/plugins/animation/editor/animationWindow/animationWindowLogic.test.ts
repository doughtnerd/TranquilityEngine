// T50 (ADR 0373): the Animation window's logic through its modules' interfaces — rows from a clip, key edits that
// round-trip through the clip format's parse and write, record mode, key button state, ripple, copy and paste across
// tracks, the row editors, curve lanes, onion skin frames, and the refusals (refused-or-next, ADR 0307, 0313).
import { describe, expect, it } from "vitest";
import "../../../../myco"; // registers the engine's components (Transform, Light, SpriteRenderer, the joints)
import { emptyAnimSource, formatAnimSource, parseAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import type { Track } from "../../../../engine/animation/tracks";
import { createDraft, draftResult, withLane } from "../../../../editor/ui/curves/curveEditorModel";
import { addKeyedTrack, addPropertyTrack, copyKeys, deleteKeys, keyField, keyState, moveKeys, pasteClipboard, readKeyClipboard, removeTrack, ripple, scaleSelectedKeys, unkeyField } from "./clipEditLogic";
import { applyCurveLanes, curveLanes } from "./curveLanesLogic";
import { fieldTrackShape, keyValueOf } from "./fieldTracksLogic";
import { discreteAt, onionFrames, onionSprites } from "./onionSkinLogic";
import { recordWrite } from "./recordLogic";
import { addRowKey, setActivationRange, setAudioKey, setEventKey, setMarkerKey } from "./rowEditorsLogic";
import { keyId, leafKeysOf, rowId, summarySelected, trackRows } from "./trackRowsLogic";

const POS = { nodePath: "Body", component: "engine.Transform", field: "position" };
const LAMP = { nodePath: "Body/Lamp", component: "engine.Light", field: "intensity" };

/** A clip with a position, a lamp intensity, a bone, events, markers and an activation span. */
function clip(): AnimSource {
  const tracks: Track[] = [
    { kind: "vec3", target: POS, name: "", curves: [[[0, 0], [0.5, 1, "smooth"], [1, 0]], [[0, 0], [1, 2]], []] },
    { kind: "float", target: LAMP, name: "", curves: [[[0, 1], [0.5, 3]]] },
    { kind: "bone", bone: "Hips", translation: [[0, 0, 1, 0]], rotation: [[0.25, 0, 0, 0, 1]], scale: [] },
    { kind: "event", target: { nodePath: "", component: "", field: "" }, keys: [{ time: 0.25, method: "footstep", args: ["L"], threshold: 0.5, always: false }] },
    { kind: "marker", keys: [{ time: 0, kind: "sync", name: "L" }] },
    { kind: "activation", target: { nodePath: "Trail", component: "", field: "" }, keys: [{ time: 0.2, end: 0.6 }] },
  ];
  return { ...emptyAnimSource(), name: "Run", duration: 1, tracks };
}

/** The clip written and parsed back: what the asset document would hold. */
const roundTrip = (c: AnimSource) => {
  const read = parseAnimSource(JSON.parse(formatAnimSource(c)));
  expect(read.problems).toEqual([]);
  return read.value;
};
const next = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refusal = (r: { next: unknown } | { refused: string }) => ("refused" in r ? r.refused : null);

describe("track rows (ADR 0373)", () => {
  it("groups a clip's tracks by node, component and field, bones by bone and channel, then the clip-wide rows", () => {
    const rows = trackRows(clip().tracks, { rootName: "Hero" });
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.label}${r.heading ? "/" : ""}`)).toEqual([
      "Hero/",
      "  Events",
      "Body/",
      "  Transform/",
      "    position",
      "      position.x",
      "      position.y",
      "      position.z",
      "Body/Lamp/",
      "  Light/",
      "    intensity",
      "Trail/",
      "  Active",
      "Bones/",
      "  Hips/",
      "    Position",
      "    Rotation",
      "    Scale",
      "Clip/",
      "  Markers",
    ]);
    const x = rows.find((r) => r.id === rowId(0, { kind: "curve", component: 0 }))!;
    expect(x.keys.map((k) => k.t)).toEqual([0, 0.5, 1]);
    // The position row sums its components: one diamond per keyed time, standing for every key there.
    const summary = rows.find((r) => r.label === "position")!;
    expect(summary.keys.map((k) => k.t)).toEqual([0, 0.5, 1]);
    expect(leafKeysOf(rows, summary.keys[0]!.id)).toEqual([keyId("0:c0", 0), keyId("0:c1", 0)]);
    expect(summarySelected(rows, new Set([keyId("0:c0", 0), keyId("0:c1", 0)]))).toEqual([summary.keys[0]!.id]);
    // Ranged keys draw their span.
    expect(rows.find((r) => r.label === "Active")!.spans).toEqual([{ id: "5:k~0", from: 0.2, to: 0.6, label: "Active 0.20 s – 0.60 s" }]);
  });
});

describe("key edits round-trip through the clip format", () => {
  it("moves a selection together, kept inside the clip, and reports where the keys landed", () => {
    const sel = [keyId("0:c0", 1), keyId("1:c0", 1)];
    const r = next(moveKeys(clip(), sel, 0.25));
    const back = roundTrip(r.clip);
    expect(back.tracks[0]).toMatchObject({ curves: [[[0, 0], [0.75, 1, "smooth"], [1, 0]], [[0, 0], [1, 2]], []] });
    expect(back.tracks[1]).toMatchObject({ curves: [[[0, 1], [0.75, 3]]] });
    expect(r.selection).toEqual(sel);
    // Clamped: the lamp key stops at the clip's end, so the position key moves by as much.
    const far = next(moveKeys(clip(), sel, 5));
    expect((far.clip.tracks[1] as { curves: number[][][] }).curves[0]![1]![0]).toBe(1);
    expect(refusal(moveKeys(clip(), [], 0.1))).toBe("no keys are selected");
  });
  it("moves ranged keys with their ends and bone keys with their values", () => {
    const r = next(moveKeys(clip(), [keyId("5:k", 0), keyId("2:r", 0)], 0.25));
    const back = roundTrip(r.clip);
    expect(back.tracks[5]).toMatchObject({ keys: [{ time: 0.45, end: 0.85 }] });
    expect(back.tracks[2]).toMatchObject({ rotation: [[0.5, 0, 0, 0, 1]] });
  });
  it("scales about a pivot and deletes; a scale that isn't positive is refused", () => {
    const r = next(scaleSelectedKeys(clip(), [keyId("0:c0", 1)], 0, 0.5));
    expect(roundTrip(r.clip).tracks[0]).toMatchObject({ curves: [[[0, 0], [0.25, 1, "smooth"], [1, 0]], [[0, 0], [1, 2]], []] });
    expect(refusal(scaleSelectedKeys(clip(), [keyId("0:c0", 1)], 0, 0))).toBe("the scale must be a positive number");
    const d = roundTrip(next(deleteKeys(clip(), [keyId("0:c0", 0), keyId("3:k", 0)])));
    expect(d.tracks[0]).toMatchObject({ curves: [[[0.5, 1, "smooth"], [1, 0]], [[0, 0], [1, 2]], []] });
    expect(d.tracks[3]).toMatchObject({ keys: [] });
  });
  it("ripples: inserting time lengthens the clip and moves later keys; removing time cuts them", () => {
    const ins = roundTrip(next(ripple(clip(), 0.5, 0.5)));
    expect(ins.duration).toBe(1.5);
    expect(ins.tracks[1]).toMatchObject({ curves: [[[0, 1], [1, 3]]] });
    expect(ins.tracks[5]).toMatchObject({ keys: [{ time: 0.2, end: 0.6 }] });
    const cut = roundTrip(next(ripple(clip(), 0.5, -0.25)));
    expect(cut.duration).toBe(0.75);
    expect(cut.tracks[3]).toMatchObject({ keys: [] }); // the footstep at 0.25 was inside the cut span
    expect(cut.tracks[0]).toMatchObject({ curves: [[[0, 0], [0.25, 1, "smooth"], [0.75, 0]], [[0, 0], [0.75, 2]], []] });
    expect(refusal(ripple(clip(), 0.25, -0.5))).toBe("there are only 0.25 s before 0.25 s to remove");
    expect(refusal(ripple(clip(), 2, 0.5))).toBe("2 s is outside the clip (0 – 1 s)");
  });
  it("copies keys and pastes them across tracks at the playhead; keys that don't fit a track are refused", () => {
    const board = copyKeys(clip(), [keyId("0:c0", 1), keyId("0:c0", 2)])!;
    expect(readKeyClipboard(JSON.parse(JSON.stringify(board)))).toEqual(board);
    // position.x's keys onto the lamp's intensity, at 0.25.
    const r = next(pasteClipboard(clip(), board, ["1:c0"], 0.25));
    expect(roundTrip(r.clip).tracks[1]).toMatchObject({ curves: [[[0, 1], [0.25, 1, "smooth"], [0.5, 3], [0.75, 0]]] });
    expect(r.selection).toEqual([keyId("1:c0", 1), keyId("1:c0", 3)]);
    // An event's key onto a curve, and too few target rows.
    const events = copyKeys(clip(), [keyId("3:k", 0)])!;
    expect(refusal(pasteClipboard(clip(), events, ["1:c0"], 0))).toBe("event keys don't fit a float track");
    expect(refusal(pasteClipboard(clip(), board, [], 0))).toBe("1 rows were copied; pick as many rows to paste on");
    // Onto another event track: it fits.
    const withSecond = next(addKeyedTrack(clip(), "event", "Body"));
    expect(roundTrip(next(pasteClipboard(withSecond, events, ["6:k"], 0.5)).clip).tracks[6]).toMatchObject({ keys: [{ time: 0.5, method: "footstep", args: ["L"] }] });
  });
});

describe("tracks and keys at the playhead", () => {
  it("adds a track only for an animatable field it doesn't animate yet, and removes one", () => {
    const added = next(addPropertyTrack(emptyAnimSource(), { nodePath: "", component: "engine.Light", field: "color" }));
    expect(added.tracks[0]).toEqual({ kind: "color", target: { nodePath: "", component: "engine.Light", field: "color" }, name: "", curves: [[], [], [], []] });
    expect(refusal(addPropertyTrack(added, { nodePath: "", component: "engine.Light", field: "color" }))).toBe("color already has a track");
    expect(refusal(addPropertyTrack(added, { nodePath: "", component: "engine.HingeJoint", field: "axis" }))).toBe("HingeJoint.axis isn't animatable");
    expect(refusal(addPropertyTrack(added, { nodePath: "", component: "engine.Nope", field: "x" }))).toBe("engine.Nope isn't a registered component");
    expect(next(removeTrack(added, 0)).tracks).toEqual([]);
  });
  it("keys a field's value at the playhead (adding its track), shows it on the key button, and removes it", () => {
    const c = emptyAnimSource();
    expect(keyState(c, POS, 0.5)).toBe("none");
    const k = next(keyField(c, POS, [1, 2, 3], 0.5));
    expect(roundTrip(k).tracks[0]).toEqual({ kind: "vec3", target: POS, name: "", curves: [[[0.5, 1]], [[0.5, 2]], [[0.5, 3]]] });
    expect(keyState(k, POS, 0.5)).toBe("key");
    expect(keyState(k, POS, 0.25)).toBe("animated");
    // Keying again at the same time replaces the value and keeps the key's shape.
    const smooth: AnimSource = { ...k, tracks: [{ ...(k.tracks[0] as Extract<Track, { kind: "vec3" }>), curves: [[[0.5, 1, "smooth"]], [[0.5, 2]], [[0.5, 3]]] }] };
    expect((next(keyField(smooth, POS, [4, 2, 3], 0.5)).tracks[0] as { curves: unknown[][] }).curves[0]).toEqual([[0.5, 4, "smooth"]]);
    expect(next(unkeyField(k, POS, 0.5)).tracks[0]).toMatchObject({ curves: [[], [], []] });
    expect(refusal(unkeyField(k, POS, 0.25))).toBe("position has no key at 0.25 s");
  });
  it("keys every kind a field can be: rotations, colours, enums by index, booleans and asset references", () => {
    const at = (b: Partial<typeof POS>, v: unknown) => roundTrip(next(keyField(emptyAnimSource(), { ...POS, ...b }, v, 0))).tracks[0];
    expect(at({ field: "rotation" }, [0, 0, 0, 2])).toMatchObject({ kind: "quat", keys: [[0, 0, 0, 0, 1]] });
    expect(at({ component: "engine.Light", field: "color" }, "#ff000080")).toMatchObject({ kind: "color", curves: [[[0, 1]], [[0, 0]], [[0, 0]], [[0, 128 / 255]]] });
    expect(at({ component: "engine.Light", field: "type" }, "spot")).toMatchObject({ kind: "discrete", valueType: "enum", keys: [[0, 2]] });
    expect(at({ component: "engine.Light", field: "castShadows" }, true)).toMatchObject({ kind: "discrete", valueType: "bool", keys: [[0, true]] });
    expect(at({ component: "engine.SpriteRenderer", field: "sprite" }, "asset:sheet.png#run_0")).toMatchObject({ kind: "discrete", valueType: "asset", keys: [[0, "asset:sheet.png#run_0"]] });
  });
  it("refuses a key on a field that isn't animatable, a value that doesn't fit, and a time outside the clip", () => {
    expect(refusal(keyField(emptyAnimSource(), { ...POS, component: "engine.HingeJoint", field: "axis" }, [1, 0, 0], 0))).toBe("HingeJoint.axis isn't animatable");
    expect(refusal(keyField(emptyAnimSource(), LAMP, "bright", 0))).toBe("the value isn't a number");
    expect(refusal(keyField(emptyAnimSource(), LAMP, 2, 1.5))).toBe("the playhead (1.5 s) is outside the clip (0 – 1 s)");
    expect(refusal(keyValueOf({ kind: "discrete", valueType: "enum", choices: ["a"] }, "b"))).toBe('"b" isn\'t one of the choices');
    expect(refusal(fieldTrackShape("engine.Transform", "parent"))).toBe("Transform.parent isn't animatable");
  });
});

describe("record mode", () => {
  it("keys an animatable field written under the Animator at the playhead", () => {
    const r = recordWrite(emptyAnimSource(), { nodePath: "Body", type: "engine.Transform", field: "position", value: [1, 2, 3], stored: [0, 0, 0] }, 0.4)!;
    expect(r.label).toBe("Record position");
    expect(next(r.result).tracks[0]).toEqual({ kind: "vec3", target: POS, name: "", curves: [[[0.4, 1]], [[0.4, 2]], [[0.4, 3]]] });
  });
  it("keys a changed animatable sub-path (D86) by its field path", () => {
    const r = recordWrite(emptyAnimSource(), { nodePath: "Door", type: "engine.HingeJoint", field: "spring", value: { spring: 10, damper: 1, targetPosition: 0.5 }, stored: { spring: 10, damper: 1, targetPosition: 0 } }, 0.2)!;
    expect(r.label).toBe("Record spring.targetPosition");
    expect(next(r.result).tracks[0]).toEqual({ kind: "float", target: { nodePath: "Door", component: "engine.HingeJoint", field: "spring.targetPosition" }, name: "", curves: [[[0.2, 0.5]]] });
  });
  it("leaves to the scene a field no track drives, a write that also changes other parts, and a node outside the Animator", () => {
    expect(recordWrite(emptyAnimSource(), { nodePath: "Door", type: "engine.HingeJoint", field: "axis", value: [0, 1, 0], stored: [1, 0, 0] }, 0)).toBeNull();
    expect(recordWrite(emptyAnimSource(), { nodePath: "Door", type: "engine.HingeJoint", field: "spring", value: { spring: 20, damper: 1, targetPosition: 0.5 }, stored: { spring: 10, damper: 1, targetPosition: 0 } }, 0)).toBeNull();
    expect(recordWrite(emptyAnimSource(), { nodePath: null, type: "engine.Transform", field: "position", value: [1, 2, 3], stored: [0, 0, 0] }, 0)).toBeNull();
  });
  it("comes back refused when the playhead is outside the clip", () => {
    const r = recordWrite(emptyAnimSource(), { nodePath: "", type: "engine.Light", field: "intensity", value: 2, stored: 1 }, 3)!;
    expect(refusal(r.result)).toBe("the playhead (3 s) is outside the clip (0 – 1 s)");
  });
});

describe("row editors", () => {
  it("add and change event keys: a method name, JSON args, a threshold and a notify state's end", () => {
    let c = next(addRowKey(clip(), 3, 0.5, { method: "swing" }));
    expect(refusal(addRowKey(clip(), 3, 0.5, { method: "" }))).toBe("a notify needs a method name (letters, digits and _)");
    c = next(setEventKey(c, 3, 1, { args: '{"hand":"R"}', threshold: 0.25, end: 0.75 }));
    expect(roundTrip(c).tracks[3]).toMatchObject({ keys: [{ time: 0.25, method: "footstep" }, { time: 0.5, end: 0.75, method: "swing", args: { hand: "R" }, threshold: 0.25 }] });
    expect(refusal(setEventKey(c, 3, 1, { args: "{nope" }))).toBe("that isn't valid JSON");
    expect(refusal(setEventKey(c, 3, 1, { end: 0.25 }))).toBe("a notify state ends after it starts (0.5 s) and inside the clip");
  });
  it.each(["sync", "exit", "hit", "cue"])("set a marker's kind to %s", (kind) => {
    const c = next(setMarkerKey(clip(), 4, 0, { kind, name: "R" }));
    expect(roundTrip(c).tracks[4]).toMatchObject({ keys: [{ time: 0, kind, name: "R" }] });
  });
  it("refuses a marker kind outside the vocabulary and a second marker at one time", () => {
    expect(refusal(setMarkerKey(clip(), 4, 0, { kind: "beat" }))).toBe("a marker is one of sync, exit, hit, cue");
    expect(refusal(addRowKey(clip(), 4, 0))).toBe("a marker is already there");
  });
  it("add and change audio keys: an asset and a params object", () => {
    let c = next(addKeyedTrack(clip(), "audio"));
    c = next(addRowKey(c, 6, 0.3, { audio: "sfx/step.playlist.json" }));
    c = next(setAudioKey(c, 6, 0, { params: '{"surface":2}' }));
    expect(roundTrip(c).tracks[6]).toMatchObject({ kind: "audio", keys: [{ time: 0.3, audio: "asset:sfx/step.playlist.json", params: { surface: 2 } }] });
    expect(refusal(setAudioKey(c, 6, 0, { params: "[1]" }))).toBe("params are an object of parameter values");
    expect(refusal(setAudioKey(c, 6, 0, { audio: " " }))).toBe("an audio key must name an audio event or clip");
  });
  it("add and change activation spans, inside the clip", () => {
    let c = next(addRowKey(clip(), 5, 0.7));
    expect(roundTrip(c).tracks[5]).toMatchObject({ keys: [{ time: 0.2, end: 0.6 }, { time: 0.7, end: 1 }] });
    expect(refusal(addRowKey(clip(), 5, 0.4))).toBe("the node is already on there");
    c = next(setActivationRange(c, 5, 0, { end: 0.5 }));
    expect(roundTrip(c).tracks[5]).toMatchObject({ keys: [{ time: 0.2, end: 0.5 }, { time: 0.7, end: 1 }] });
    expect(refusal(setActivationRange(c, 5, 0, { end: 0.1 }))).toBe("the span must end after it starts");
    expect(refusal(setActivationRange(c, 5, 0, { end: 2 }))).toBe("the span must lie inside the clip (0 – 1 s)");
  });
});

describe("curve lanes", () => {
  it("are time lanes of the shared curve editor, one per bound field component, applied back to their tracks", () => {
    const c = clip();
    const spec = curveLanes(c)!;
    expect(spec.kind).toBe("time");
    expect(spec.length).toBe(1);
    expect(spec.lanes.map((l) => l.name)).toEqual(["Body · position.x", "Body · position.y", "Body · position.z", "Body/Lamp · intensity"]);
    // Untouched: nothing changes (no end keys added).
    const draft = createDraft(spec);
    expect(next(applyCurveLanes(c, spec, draftResult(spec, draft)))).toBe(c);
    // A Bézier key on the lamp lane is written back to the lamp's track only.
    const bez = withLane(draft, "1:c0", { curve: [[0, 1], [0.5, 3, "bezier", { in: [-0.1, 0], out: [0.1, 0] }], [1, 3]] });
    const out = roundTrip(next(applyCurveLanes(c, spec, draftResult(spec, bez))));
    expect(out.tracks[1]).toMatchObject({ curves: [[[0, 1], [0.5, 3, "bezier", { in: [-0.1, 0], out: [0.1, 0] }], [1, 3]]] });
    expect(out.tracks[0]).toEqual(c.tracks[0]);
  });
});

describe("onion skin", () => {
  it("gives the frames around the playhead, wrapping a looping clip and stopping at the ends of another", () => {
    const c = { rate: 10, duration: 1, loop: false };
    expect(onionFrames(0.5, c, { before: 2, after: 1, step: 1 }).map((f) => [f.offset, +f.t.toFixed(3)])).toEqual([[-1, 0.4], [-2, 0.3], [1, 0.6]]);
    expect(onionFrames(0.05, c, { before: 2, after: 0, step: 1 })).toEqual([]);
    expect(onionFrames(0.05, { ...c, loop: true }, { before: 1, after: 0, step: 2 }).map((f) => +f.t.toFixed(3))).toEqual([0.85]);
  });
  it("shows what each sprite track holds at the playhead and each ghost", () => {
    const sprite: Track = { kind: "discrete", target: { nodePath: "", component: "engine.SpriteRenderer", field: "sprite" }, valueType: "asset", keys: [[0, "a"], [0.5, "b"]] };
    expect(discreteAt([[0, "a"], [0.5, "b"]], 0.49)).toBe("a");
    const c = { ...emptyAnimSource(), rate: 10, tracks: [sprite] };
    expect(onionSprites(c, 0.5, onionFrames(0.5, c, { before: 1, after: 1, step: 1 }))[0]!.frames.map((f) => f.sprite)).toEqual(["b", "a", "b"]);
  });
});
