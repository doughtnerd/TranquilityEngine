// T53 (ADR 0373): the Timeline window's logic through its modules' interfaces: rows grouped by bound node, blend regions
// where clips overlap, edits that round-trip through the timeline format's parse and write, trims and splits that clamp,
// bindings resolved against a node tree, the nested-timeline breadcrumb, and the refusals (refused-or-next, ADR 0307, 0313).
import { describe, expect, it } from "vitest";
import "../../../../myco"; // registers the engine's components (Transform, Light, Camera)
import { emptyTimeline, formatTimeline, parseTimeline, type Timeline } from "../../../../engine/animation/timeline";
import type { Track } from "../../../../engine/animation/tracks";
import {
  addCameraCut, addItem, assetDropKind, dragEdit, dragLabel, dropAssets, addPropertyTrack, addTrack, asClip, blendToOverlap, contentEnd, deleteItems, duplicateItems, keyProperty, moveItems, moveTrack, patchItem, rebindGroup, removeTrack, setBinding,
  setDuration, setEase, splitItem, trimItem,
} from "./timelineEditLogic";
import {
  bindingProblem, blendRegions, breadcrumbs, itemSpan, nestedRefs, nodeChoices, openNested, parseItemId, propertyTimes, timelineRows, trackLabel, whyBadNodePath, type NodeLike,
} from "./timelineModelLogic";

const NONE = { nodePath: "", component: "", field: "" };
const clipKey = (time: number, end: number, extra: Record<string, unknown> = {}) => ({ time, end, clip: "asset:clips/wave.anim.json", offset: 0, speed: 1, blendIn: 0, blendOut: 0, ...extra });

/** A timeline with a lamp intensity track, two overlapping clips on Hero, an audio key, camera cut, markers and an activation span. */
function timeline(): Timeline {
  const tracks: Track[] = [
    { kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0], [2, 1], [4, 0]]] },
    { kind: "subclip", target: { nodePath: "Hero", component: "", field: "" }, keys: [clipKey(0, 3, { blendOut: 1 }), clipKey(2, 6, { clip: "asset:clips/run.anim.json", blendIn: 1 })] },
    { kind: "subclip", target: NONE, keys: [clipKey(1, 3, { clip: "asset:animation/inner.timeline.json" })] },
    { kind: "audio", target: NONE, keys: [{ time: 1, audio: "asset:sfx/boom.playlist.json" }] },
    { kind: "control", target: NONE, keys: [{ time: 0, action: "cameraCut", target: "Cam1" }, { time: 4, action: "cameraCut", target: "Cam2" }] },
    { kind: "activation", target: { nodePath: "Hero/Trail", component: "", field: "" }, keys: [{ time: 1, end: 2 }] },
    { kind: "event", target: NONE, keys: [{ time: 2.5, method: "boom", threshold: 0.5, always: false }] },
    { kind: "marker", keys: [{ time: 0, kind: "sync", name: "L" }] },
  ];
  return { ...emptyTimeline(), name: "Intro", duration: 8, tracks };
}

/** The timeline written and parsed back: what the asset document would hold. */
const roundTrip = (t: Timeline) => {
  const read = parseTimeline(JSON.parse(formatTimeline(t)));
  expect(read.problems).toEqual([]);
  return read.value;
};
const ok = <T>(r: { next: T } | { refused: string }): T => {
  expect(r).toHaveProperty("next");
  return (r as { next: T }).next;
};
const why = (r: { next: unknown } | { refused: string }) => (r as { refused: string }).refused;
const subclips = (t: Timeline, track = 1) => (t.tracks[track] as Extract<Track, { kind: "subclip" }>).keys;

describe("rows", () => {
  it("groups tracks under a heading per bound node, markers first under Timeline", () => {
    const rows = timelineRows(timeline(), "Director");
    expect(rows.filter((r) => r.heading).map((r) => r.label)).toEqual(["Timeline", "Lamp", "Hero", "Director", "Hero/Trail"]);
    expect(rows.map((r) => r.label)).toEqual(["Timeline", "Markers", "Lamp", "Light.intensity", "Hero", "Animation", "Director", "Nested timelines", "Audio", "Camera cuts", "Signals", "Hero/Trail", "Activation"]);
  });

  it("makes clips bars and instant keys diamonds, with property keys at the union of their times", () => {
    const rows = timelineRows(timeline(), "Director");
    const anim = rows.find((r) => r.track === 1)!;
    expect(anim.items.map((i) => [i.id, i.bar, i.from, i.to])).toEqual([["1#0", true, 0, 3], ["1#1", true, 2, 6]]);
    expect(anim.items[0]!.label).toBe("wave.anim.json · 0.00 – 3.00 s");
    expect(rows.find((r) => r.track === 3)!.items[0]).toMatchObject({ bar: false, label: "boom.playlist.json at 1.00 s" });
    expect(rows.find((r) => r.track === 0)!.items.map((i) => [i.id, i.from])).toEqual([["0~0", 0], ["0~1", 2], ["0~2", 4]]);
  });

  it("labels a track of nested timelines and one mixing clips", () => {
    const t = timeline();
    expect(trackLabel(t.tracks[2]!)).toBe("Nested timelines");
    expect(trackLabel({ ...t.tracks[2]!, keys: [...subclips(t, 2), clipKey(5, 6)] } as Track)).toBe("Clips");
  });
});

describe("blend regions", () => {
  it("form where clips of one track overlap, from the later start to the earlier end", () => {
    const t = timeline();
    expect(blendRegions(t.tracks[1] as never, 1)).toEqual([{ id: "1:0+1", track: 1, a: 0, b: 1, from: 2, to: 3 }]);
    expect(timelineRows(t, "D").find((r) => r.track === 1)!.blends).toHaveLength(1);
  });

  it("end at the shorter clip when one lies inside the other, and don't form for clips that only touch", () => {
    const base = timeline();
    const inside = { ...base, tracks: [{ kind: "subclip", target: NONE, keys: [clipKey(0, 6), clipKey(1, 2)] } as Track] };
    expect(blendRegions(inside.tracks[0] as never, 0)[0]).toMatchObject({ from: 1, to: 2 });
    const touching = { ...base, tracks: [{ kind: "subclip", target: NONE, keys: [clipKey(0, 2), clipKey(2, 4)] } as Track] };
    expect(blendRegions(touching.tracks[0] as never, 0)).toEqual([]);
  });

  it("follow a move: dragging a clip over its neighbour creates the region, dragging it away removes it", () => {
    const t = timeline();
    const apart = ok(moveItems(t, ["1#1"], 1)).timeline;
    expect(blendRegions(apart.tracks[1] as never, 1)).toEqual([]);
    const over = ok(moveItems(apart, ["1#1"], -2)).timeline;
    expect(blendRegions(over.tracks[1] as never, 1)[0]).toMatchObject({ from: 1, to: 3 });
  });

  it("blendToOverlap sets the eases to the overlap; setEase clamps to the clip's length", () => {
    const t = timeline();
    const b = ok(blendToOverlap(t, 1, 0, 1)).timeline;
    expect(subclips(b)[0]).toMatchObject({ blendOut: 1 });
    expect(subclips(b)[1]).toMatchObject({ blendIn: 1 });
    expect(why(blendToOverlap(ok(moveItems(t, ["1#1"], 1)).timeline, 1, 0, 1))).toMatch(/don't overlap/);
    const eased = ok(setEase(t, "1#0", "in", 10)).timeline; // clip is 3 s with a 1 s ease-out: at most 2 s in
    expect(subclips(eased)[0]).toMatchObject({ blendIn: 2, blendOut: 1 });
    expect(ok(setEase(t, "1#0", "out", -5)).timeline).not.toBe(t);
    expect(subclips(ok(setEase(t, "1#0", "out", -5)).timeline)[0]!.blendOut).toBe(0);
    expect(why(setEase(t, "3#0", "in", 1))).toMatch(/point in time/);
    expect(why(setEase(timeline(), "5#0", "in", 1))).toMatch(/only animation clips/);
  });
});

describe("moving", () => {
  it("moves the group together, clamped to stay inside the timeline, and the result round-trips", () => {
    const t = timeline();
    const r = ok(moveItems(t, ["1#0", "1#1"], 5)); // clips span 0..6 in an 8 s timeline: at most 2
    expect(subclips(r.timeline).map((k) => [k.time, k.end])).toEqual([[2, 5], [4, 8]]);
    expect(r.selection).toEqual(["1#0", "1#1"]);
    expect(roundTrip(r.timeline)).toEqual(r.timeline);
    const back = ok(moveItems(r.timeline, r.selection, -9)).timeline;
    expect(subclips(back).map((k) => k.time)).toEqual([0, 2]);
  });

  it("keeps a track's keys in time order and selects the moved ones where they landed", () => {
    const t = timeline();
    const r = ok(moveItems(t, ["1#0"], 4)); // clip 0..3 moves to 4..7, past the second clip (2..6)
    expect(subclips(r.timeline).map((k) => k.time)).toEqual([2, 4]);
    expect(r.selection).toEqual(["1#1"]);
    expect(subclips(r.timeline)[1]!.end).toBe(7);
  });

  it("moves property keys on every channel at their time, and selects them", () => {
    const t = timeline();
    const r = ok(moveItems(t, ["0~1"], 1));
    expect(propertyTimes(r.timeline.tracks[0]!)).toEqual([0, 3, 4]);
    expect(r.selection).toEqual(["0~1"]);
  });

  it("leaves an unmoved selection alone (the same timeline) and refuses nothing selected or a missing item", () => {
    const t = timeline();
    expect(ok(moveItems(t, ["1#0"], 0)).timeline).toBe(t);
    expect(why(moveItems(t, [], 1))).toBe("nothing is selected");
    expect(why(moveItems(t, ["1#9"], 1))).toBe("an item is gone");
    expect(why(moveItems(t, ["1#0"], Number.NaN))).toMatch(/isn't a number/);
  });
});

describe("trimming", () => {
  it("trims the end into the clip and clamps it a frame after the start and at the timeline's end", () => {
    const t = timeline();
    expect(subclips(ok(trimItem(t, "1#1", "end", 5)).timeline)[1]!.end).toBe(5);
    expect(subclips(ok(trimItem(t, "1#1", "end", 0)).timeline)[1]!.end).toBeCloseTo(2 + 1 / 30, 5);
    expect(subclips(ok(trimItem(t, "1#1", "end", 99)).timeline)[1]!.end).toBe(8);
  });

  it("trims the start by moving the offset with it, never before the source's start or past the previous clip", () => {
    const t = timeline();
    const r = ok(trimItem(t, "1#1", "start", 3)).timeline;
    expect(subclips(r)[1]).toMatchObject({ time: 3, offset: 1 });
    // The source starts here (offset 0): the clip can't be pulled earlier.
    expect(subclips(ok(trimItem(t, "1#1", "start", 1)).timeline)[1]!.time).toBe(2);
    // With 1 s of source before it, it can: to 1 s, and offset 0 again.
    const inner = ok(trimItem(r, "1#1", "start", 0)).timeline;
    expect(subclips(inner)[1]).toMatchObject({ time: 2, offset: 0 });
    // The start doesn't pass the previous clip's start.
    const shifted = { ...t, tracks: t.tracks.map((x, i) => (i === 1 ? ({ ...x, keys: [clipKey(1, 3), clipKey(4, 7, { offset: 10 })] } as Track) : x)) };
    expect(subclips(ok(trimItem(shifted, "1#1", "start", 0)).timeline)[1]!.time).toBe(1);
  });

  it("keeps the eases inside the trimmed length and the result round-trips", () => {
    const t = timeline();
    const r = ok(trimItem(t, "1#0", "end", 1.5)).timeline; // 1.5 s long with a 1 s ease-out: still fits
    expect(subclips(r)[0]).toMatchObject({ end: 1.5, blendOut: 1 });
    const short = ok(trimItem(t, "1#0", "end", 0.5)).timeline;
    expect(subclips(short)[0]).toMatchObject({ end: 0.5, blendIn: 0, blendOut: 0.5 });
    expect(roundTrip(short)).toEqual(short);
  });

  it("trims activation spans and refuses points and property keys with the reason", () => {
    const t = timeline();
    expect((ok(trimItem(t, "5#0", "end", 4)).timeline.tracks[5] as unknown as { keys: { end: number }[] }).keys[0]!.end).toBe(4);
    expect(why(trimItem(t, "3#0", "end", 2))).toMatch(/no length/);
    expect(why(trimItem(t, "0~0", "end", 2))).toMatch(/point in time/);
    expect(why(trimItem(t, "1#7", "end", 2))).toMatch(/gone/);
  });
});

describe("splitting", () => {
  it("cuts a clip in two, the second half further into the source, the eases split between them", () => {
    const t = timeline();
    const r = ok(splitItem(t, "1#1", 4));
    expect(subclips(r.timeline).map((k) => [k.time, k.end, k.offset, k.blendIn, k.blendOut])).toEqual([[0, 3, 0, 0, 1], [2, 4, 0, 1, 0], [4, 6, 2, 0, 0]]);
    expect(r.selection).toEqual(["1#1", "1#2"]);
    expect(roundTrip(r.timeline)).toEqual(r.timeline);
  });

  it("scales the second half's offset by the clip's speed", () => {
    const t = { ...timeline(), tracks: [{ kind: "subclip", target: NONE, keys: [clipKey(0, 4, { speed: 2, offset: 1 })] } as Track] };
    expect(subclips(ok(splitItem(t, "0#0", 1)).timeline, 0)[1]).toMatchObject({ time: 1, offset: 3, speed: 2 });
  });

  it("splits an activation span, and refuses at the ends, outside, and for points", () => {
    const t = timeline();
    expect((ok(splitItem(t, "5#0", 1.5)).timeline.tracks[5] as unknown as { keys: unknown[] }).keys).toEqual([{ time: 1, end: 1.5 }, { time: 1.5, end: 2 }]);
    expect(why(splitItem(t, "1#1", 2))).toMatch(/outside the clip/);
    expect(why(splitItem(t, "1#1", 7))).toMatch(/outside the clip/);
    expect(why(splitItem(t, "1#1", 2 + 0.01))).toMatch(/at least one frame/);
    expect(why(splitItem(t, "3#0", 1))).toMatch(/no length/);
  });
});

describe("duplicating and deleting", () => {
  it("copies a clip right after itself and selects the copy; the copy fits or the edit is refused", () => {
    const t = timeline();
    const r = ok(duplicateItems(t, ["5#0"]));
    expect((r.timeline.tracks[5] as unknown as { keys: unknown[] }).keys).toEqual([{ time: 1, end: 2 }, { time: 2, end: 3 }]);
    expect(r.selection).toEqual(["5#1"]);
    expect(why(duplicateItems(t, ["1#1"]))).toMatch(/no room after the selection/);
    expect(roundTrip(r.timeline)).toEqual(r.timeline);
  });

  it("copies a property key one frame after it (a point has no length), a group after its span", () => {
    const one = ok(duplicateItems(timeline(), ["0~0"]));
    expect(propertyTimes(one.timeline.tracks[0]!).map((x) => Math.round(x * 30))).toEqual([0, 1, 60, 120]);
    expect(one.selection).toEqual(["0~1"]);
    const group = ok(duplicateItems(timeline(), ["0~0", "0~1"]));
    expect(propertyTimes(group.timeline.tracks[0]!)).toEqual([0, 2, 4]); // the copy of the key at 0 lands on 2 and replaces it; the other on 4
  });

  it("deletes keyed and property items", () => {
    const t = timeline();
    expect(subclips(ok(deleteItems(t, ["1#0"]))).map((k) => k.time)).toEqual([2]);
    expect(propertyTimes(ok(deleteItems(t, ["0~1"])).tracks[0]!)).toEqual([0, 4]);
    expect(why(deleteItems(t, []))).toBe("nothing is selected");
  });
});

describe("adding", () => {
  it("adds a clip at a time, cut short by the timeline's end, and selects it", () => {
    const t = timeline();
    const r = ok(addItem(t, 1, 7.5, { kind: "subclip", clip: "clips/jump.anim.json", length: 2 }));
    expect(subclips(r.timeline).at(-1)).toMatchObject({ time: 7.5, end: 8, clip: "asset:clips/jump.anim.json" });
    expect(r.selection).toEqual(["1#2"]);
    expect(roundTrip(r.timeline)).toEqual(r.timeline);
  });

  it("refuses with the reason: wrong kind, outside, no room, no clip, itself, bad method, missing camera", () => {
    const t = timeline();
    expect(why(addItem(t, 1, 1, { kind: "audio", audio: "a" }))).toMatch(/subclip track can't hold audio/);
    expect(why(addItem(t, 1, 9, { kind: "subclip", clip: "c.anim.json" }))).toMatch(/outside the timeline/);
    expect(why(addItem(t, 1, 8, { kind: "subclip", clip: "c.anim.json" }))).toMatch(/no room/);
    expect(why(addItem(t, 1, 1, { kind: "subclip", clip: " " }))).toMatch(/needs a clip/);
    expect(why(addItem(t, 1, 1, { kind: "subclip", clip: "animation/intro.timeline.json" }, "animation/intro.timeline.json"))).toMatch(/contain itself/);
    expect(why(addItem(t, 6, 1, { kind: "event", method: "1bad" }))).toMatch(/method name/);
    expect(why(addItem(t, 4, 1, { kind: "control", action: "cameraCut" }))).toMatch(/needs a target/);
    expect(why(addItem(t, 0, 1, { kind: "marker", markerKind: "cue" }))).toMatch(/holds no items/);
  });

  it("adds each kind of item", () => {
    let t = timeline();
    t = ok(addItem(t, 3, 2, { kind: "audio", audio: "sfx/hit.playlist.json" })).timeline;
    t = ok(addItem(t, 5, 3, { kind: "activation" })).timeline;
    t = ok(addItem(t, 6, 0.5, { kind: "event", method: "go" })).timeline;
    t = ok(addItem(t, 7, 1, { kind: "marker", markerKind: "hit", name: "H" })).timeline;
    t = ok(addItem(t, 4, 6, { kind: "control", action: "particlePlay", target: "Sparks" })).timeline;
    expect(roundTrip(t)).toEqual(t);
    expect(contentEnd(t)).toBe(6);
  });

  it("adds camera cuts to the camera-cut track, making it when there is none", () => {
    const t = timeline();
    const r = ok(addCameraCut(t, 2, "Cam3"));
    expect((r.timeline.tracks[4] as unknown as { keys: { time: number }[] }).keys.map((k) => k.time)).toEqual([0, 2, 4]);
    const none = { ...t, tracks: [] };
    const made = ok(addCameraCut(none, 1, "Cam1")).timeline;
    expect(made.tracks).toHaveLength(1);
    expect(trackLabel(made.tracks[0]!)).toBe("Camera cuts");
    expect(why(addCameraCut(t, 1, " "))).toMatch(/camera node/);
  });
});

describe("tracks and bindings", () => {
  it("adds tracks of each kind, one marker track at most, and refuses a bad path", () => {
    const t = { ...timeline(), tracks: [] };
    for (const kind of ["subclip", "audio", "activation", "control", "event", "marker"] as const) {
      const r = addTrack(t, { kind, nodePath: kind === "marker" ? "" : "Hero" });
      expect(roundTrip(ok(r))).toEqual(ok(r));
      expect(ok(r).tracks[0]!.kind).toBe(kind);
    }
    expect(why(addTrack(timeline(), { kind: "marker", nodePath: "" }))).toMatch(/marker track already/);
    expect(why(addTrack(t, { kind: "audio", nodePath: "../Up" }))).toMatch(/no \. or \.\./);
    expect(why(addTrack(t, { kind: "audio", nodePath: "A//B" }))).toMatch(/empty parts/);
  });

  it("adds property tracks and keys them at a time, through the Animation window's rules", () => {
    const t = emptyTimeline();
    const lamp = { nodePath: "Lamp", component: "engine.Light", field: "intensity" };
    const added = ok(addPropertyTrack(t, lamp, 1));
    expect(why(addPropertyTrack(added, lamp, 1))).toMatch(/already has a track/);
    const keyed = ok(keyProperty(added, lamp, 2, 3));
    expect(propertyTimes(keyed.tracks[0]!)).toEqual([3]);
    expect(why(keyProperty(added, lamp, 2, 99))).toMatch(/outside the clip/);
    expect(roundTrip(keyed)).toEqual(keyed);
    expect(asClip(keyed).tracks).toBe(keyed.tracks);
  });

  it("removes and reorders tracks", () => {
    const t = timeline();
    expect(ok(removeTrack(t, 0)).tracks).toHaveLength(7);
    expect(why(removeTrack(t, 40))).toMatch(/gone/);
    expect(ok(moveTrack(t, 0, 1)).tracks[1]!.kind).toBe("float");
    expect(why(moveTrack(t, 0, -1))).toMatch(/first track/);
    expect(why(moveTrack(t, 7, 1))).toMatch(/last track/);
  });

  it("binds a track or a whole group to another node", () => {
    const t = timeline();
    expect((ok(setBinding(t, 1, "Villain")).tracks[1] as { target: { nodePath: string } }).target.nodePath).toBe("Villain");
    expect(ok(setBinding(t, 1, "Hero"))).toBe(t);
    expect(why(setBinding(t, 7, "X"))).toMatch(/belong to the timeline/);
    expect(why(setBinding(t, 1, "/Abs"))).toMatch(/empty parts/);
    const g = ok(rebindGroup(t, "Hero", "Villain"));
    expect(g.tracks.filter((x) => (x as { target?: { nodePath: string } }).target?.nodePath === "Villain")).toHaveLength(1);
    expect(why(rebindGroup(t, "Nobody", "Villain"))).toMatch(/no track is bound/);
    expect(roundTrip(g)).toEqual(g);
  });
});

describe("item fields and the timeline's length", () => {
  it("patches a clip's source, offset, speed and eases, refusing what doesn't fit", () => {
    const t = timeline();
    const p = ok(patchItem(t, "1#0", { clip: "clips/other.anim.json", offset: 0.5, speed: 2, blendIn: 1 }));
    expect(subclips(p)[0]).toMatchObject({ clip: "asset:clips/other.anim.json", offset: 0.5, speed: 2, blendIn: 1, blendOut: 1 });
    expect(why(patchItem(t, "1#0", { offset: -1 }))).toMatch(/offset must be between/);
    expect(why(patchItem(t, "1#0", { speed: 500 }))).toMatch(/speed must be between/);
    expect(why(patchItem(t, "1#0", { blendIn: 2.5 }))).toMatch(/longer than the clip/);
    expect(why(patchItem(t, "1#0", { clip: "" }))).toMatch(/needs a clip/);
    expect(why(patchItem(t, "1#0", { clip: "animation/intro.timeline.json" }, "animation/intro.timeline.json"))).toMatch(/contain itself/);
    expect(why(patchItem(t, "3#0", {}))).toMatch(/own fields/);
  });

  it("patches a control's action and target, a camera cut always having a target", () => {
    const t = timeline();
    expect((ok(patchItem(t, "4#0", { target: "Cam9" })).tracks[4] as unknown as { keys: { target: string }[] }).keys[0]!.target).toBe("Cam9");
    expect((ok(patchItem(t, "4#0", { action: "particlePlay" })).tracks[4] as unknown as { keys: { action: string }[] }).keys[0]!.action).toBe("particlePlay");
    expect(why(patchItem(t, "4#0", { target: " " }))).toMatch(/needs a target/);
    expect(why(patchItem(t, "4#0", { action: "explode" as never }))).toMatch(/must be one of/);
    expect(ok(patchItem(t, "4#0", { action: "slotPlay", target: "" })).tracks[4]).toBeDefined();
  });

  it("sets the length, never cutting off an item", () => {
    const t = timeline();
    expect(contentEnd(t)).toBe(6);
    expect(ok(setDuration(t, 12)).duration).toBe(12);
    expect(ok(setDuration(t, 6)).duration).toBe(6);
    expect(why(setDuration(t, 5))).toMatch(/items run to 6/);
    expect(why(setDuration(t, 0))).toMatch(/more than 0/);
    expect(why(setDuration(t, 99999))).toMatch(/at most 3600/);
    expect(ok(setDuration(t, 8))).toBe(t);
  });
});

/** A node tree for the binding tests. */
interface N extends NodeLike<N> {
  name: string;
  parent: N | null;
  children: N[];
}
const node = (name: string, ...children: N[]): N => {
  const n: N = { name, parent: null, children };
  for (const c of children) c.parent = n;
  return n;
};

describe("bindings resolve against the director's node", () => {
  const trail = node("Trail");
  const hero = node("Hero", trail, node("Sword"));
  const director = node("Director", hero, node("Lamp"));

  it("says what is wrong with a binding, naming the missing node and ambiguous names", () => {
    expect(bindingProblem(director, "Hero/Trail")).toBeNull();
    expect(bindingProblem(director, "Hero/Wing")).toBe('no node "Wing" under Hero');
    expect(bindingProblem(director, "Boat")).toMatch(/no node "Boat" under Director \(the director's node\)/);
    const twice = node("Root", node("A"), node("A"));
    expect(bindingProblem(twice, "A")).toMatch(/2 children named "A"/);
    expect(bindingProblem(director, "../Hero")).toMatch(/no \. or \.\./);
    expect(whyBadNodePath("")).toBeNull();
  });

  it("lists the nodes a binding can pick, depth first", () => {
    expect(nodeChoices(director).map((c) => c.path)).toEqual(["", "Hero", "Hero/Trail", "Hero/Sword", "Lamp"]);
  });
});

describe("nested timelines", () => {
  const FILES = ["animation/a.timeline.json", "animation/b.timeline.json", "animation/c.timeline.json", "animation/d.timeline.json", "animation/wave.anim.json"];

  it("opens an inner timeline and leads back through the breadcrumb", () => {
    const one = ok(openNested(["animation/a.timeline.json"], "asset:animation/b.timeline.json", FILES));
    const two = ok(openNested(one, "animation/c.timeline.json", FILES));
    expect(breadcrumbs(two).map((c) => c.label)).toEqual(["a", "b", "c"]);
    expect(breadcrumbs(two)[1]!.stack).toEqual(["animation/a.timeline.json", "animation/b.timeline.json"]);
    expect(breadcrumbs(two)[0]!.stack).toEqual(["animation/a.timeline.json"]);
  });

  it("refuses with the reason: a clip, a missing file, itself, and deeper than the runtime plays", () => {
    const root = ["animation/a.timeline.json"];
    expect(why(openNested(root, "asset:animation/wave.anim.json", FILES))).toMatch(/not a timeline/);
    expect(why(openNested(root, "asset:animation/gone.timeline.json", FILES))).toMatch(/isn't in the project/);
    expect(why(openNested(["animation/a.timeline.json", "animation/b.timeline.json"], "animation/a.timeline.json", FILES))).toMatch(/can't nest itself/);
    const deep = ["animation/a.timeline.json", "animation/b.timeline.json", "animation/c.timeline.json"];
    expect(why(openNested(deep, "animation/d.timeline.json", FILES))).toMatch(/at most 3 levels/);
  });

  it("lists the timelines a timeline's clips open", () => {
    expect(nestedRefs(timeline())).toEqual(["animation/inner.timeline.json"]);
  });
});

describe("item ids", () => {
  it("read back and name spans", () => {
    expect(parseItemId("3#2")).toEqual({ kind: "key", track: 3, index: 2 });
    expect(parseItemId("0~1")).toEqual({ kind: "property", track: 0, n: 1 });
    expect(parseItemId("g:x")).toBeNull();
    expect(itemSpan(timeline(), "1#1")).toEqual([2, 6]);
    expect(itemSpan(timeline(), "0~2")).toEqual([4, 4]);
    expect(itemSpan(timeline(), "9#0")).toBeNull();
  });
});

describe("drags and drops", () => {
  it("a drag of each part makes the matching edit, from where the drag began", () => {
    const t = timeline();
    expect(subclips(ok(dragEdit(t, ["1#1"], "move", "1#1", 1)).timeline)[1]).toMatchObject({ time: 3, end: 7 });
    expect(subclips(ok(dragEdit(t, ["1#1"], "end", "1#1", -1)).timeline)[1]!.end).toBe(5);
    expect(subclips(ok(dragEdit(t, ["1#1"], "start", "1#1", 1)).timeline)[1]).toMatchObject({ time: 3, offset: 1 });
    expect(subclips(ok(dragEdit(t, ["1#0"], "easeIn", "1#0", 0.5)).timeline)[0]!.blendIn).toBe(0.5);
    expect(subclips(ok(dragEdit(t, ["1#0"], "easeOut", "1#0", 0.5)).timeline)[0]!.blendOut).toBe(0.5); // dragging the end handle later shortens the ease-out
    expect(why(dragEdit(t, ["9#0"], "end", "9#0", 1))).toMatch(/gone/);
    expect([dragLabel("move", 1), dragLabel("move", 3), dragLabel("start", 1), dragLabel("easeOut", 1)]).toEqual(["Move item", "Move items", "Trim start", "Set ease-out"]);
  });

  it("drops clips one after another on a clip track, audio on an audio track, and makes a track when none fits", () => {
    const t = timeline();
    expect([assetDropKind("a/b.anim.json"), assetDropKind("x.timeline.json"), assetDropKind("s.wav"), assetDropKind("s.playlist.json"), assetDropKind("m.png")]).toEqual(["subclip", "subclip", "audio", "audio", null]);
    const clips = ok(dropAssets(t, ["clips/a.anim.json", "clips/b.anim.json"], 2, "", 4, "animation/intro.timeline.json", () => 1.5));
    expect(subclips(clips.timeline, 2).slice(-2).map((k) => [k.time, k.end, k.clip])).toEqual([[4, 5.5, "asset:clips/a.anim.json"], [5.5, 7, "asset:clips/b.anim.json"]]);
    const onAudio = ok(dropAssets(t, ["sfx/x.wav"], 1, "Hero", 1));
    expect(onAudio.timeline.tracks).toHaveLength(9); // the picked track holds clips: a new audio track on Hero
    expect(onAudio.timeline.tracks[8]).toMatchObject({ kind: "audio", target: { nodePath: "Hero" } });
    expect(roundTrip(clips.timeline)).toEqual(clips.timeline);
  });

  it("refuses mixed kinds, other files and a clip dropped on its own timeline", () => {
    const t = timeline();
    expect(why(dropAssets(t, ["a.anim.json", "s.wav"], 1, "", 1))).toMatch(/not both/);
    expect(why(dropAssets(t, ["tex.png"], 1, "", 1))).toMatch(/only animation clips/);
    expect(why(dropAssets(t, ["animation/intro.timeline.json"], 1, "", 1, "animation/intro.timeline.json"))).toMatch(/contain itself/);
  });
});
