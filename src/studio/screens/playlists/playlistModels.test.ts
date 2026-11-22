import { describe, expect, it } from "vitest";
import { emptyPlaylist, emptyPlaylistBody, defaultEntryUse } from "../../../engine/audio/playlist/format";
import type { Entry, PlaylistBody } from "../../../engine/audio/playlist/types";
import type { ParameterDef } from "../../../engine/audio/eventFormat";
import { place1D, place2D, spreadPositions, axisRange } from "./blendPlacement";
import {
  addEntries, addRule, duplicateEntry, moveEntry, removeEntry, setAxis, setClipSample, setClipSampleFields, setDimensions, setEntryUse, setLabelEntry,
  setOnChange, setPlayback, setRule, setSwitchParameter, unlinkEntry, linkEntry, setParameters,
} from "./playlistEdits";
import { bodyAt, breadcrumb, canonical, childPath, editAt, effectiveOutput, entryName, pathTarget, selectToIndices, indicesToSelect } from "./playlistPaths";
import { convertType, typeOptions } from "./typeConversion";

const params: ParameterDef[] = [
  { name: "speed", min: 0, max: 100, default: 0, seekSpeed: 0 },
  { name: "rpm", min: 0, max: 8000, default: 3200, seekSpeed: 0 },
  { name: "surface", labels: ["dirt", "metal", "grass"], default: "dirt" },
];
const ctx = { parameters: params };
const sample = (s: string): Entry => ({ kind: "sample", sample: s, trim: null, loop: "inherit", ...defaultEntryUse() });
const link = (p: string): Entry => ({ kind: "linked", playlist: p, ...defaultEntryUse() });
const clipOf = (s: string): Entry => ({ kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [sample(s)] }, ...defaultEntryUse() });
const queue = (...entries: Entry[]): PlaylistBody => ({ ...emptyPlaylistBody("queue"), entries });
const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const no = (r: { next: unknown } | { refused: string }): string => {
  if (!("refused" in r)) throw new Error("expected a refusal");
  return r.refused;
};

describe("playlist paths", () => {
  const inner = queue(clipOf("a.wav"), clipOf("b.wav"));
  const root = { ...emptyPlaylist("layer"), entries: [{ kind: "embedded", embedded: inner, ...defaultEntryUse() } as Entry, link("x.playlist.json")] };

  it("finds the target file and the indices after it", () => {
    expect(pathTarget([{ file: "r.playlist.json" }, { entry: 0 }, { entry: 1 }])).toEqual({ file: "r.playlist.json", indices: [0, 1] });
    expect(pathTarget([{ file: "r.playlist.json" }, { entry: 1 }, { file: "x.playlist.json" }, { entry: 2 }])).toEqual({ file: "x.playlist.json", indices: [2] });
  });

  it("reads and edits a body down a path, copying only what is on it", () => {
    expect(bodyAt(root, [0])).toBe(inner);
    expect(bodyAt(root, [1])).toBeNull();
    const next = ok(editAt(root, [0], (b) => removeEntry(b, 0)));
    expect(bodyAt(next, [0])!.entries).toHaveLength(1);
    expect(next.entries[1]).toBe(root.entries[1]);
    expect(ok(editAt(root, [0], (b) => ({ next: b })))).toBe(root);
    expect(no(editAt(root, [5], (b) => ({ next: b })))).toMatch(/isn't there/);
  });

  it("names entries and builds the breadcrumb through linked files", () => {
    expect(entryName(clipOf("audio/dirt_02.wav"), 0)).toBe("dirt_02");
    expect(entryName(link("audio/steps.playlist.json"), 0)).toBe("steps");
    expect(entryName({ kind: "embedded", embedded: queue(), ...defaultEntryUse() }, 2)).toBe("Queue 3");
    const load = (f: string) => (f === "r.playlist.json" ? root : f === "x.playlist.json" ? queue() : null);
    const crumbs = breadcrumb([{ file: "r.playlist.json" }, { entry: 0 }, { entry: 1 }], load);
    expect(crumbs.map((c) => c.name)).toEqual(["r", "Queue 1", "b"]);
    expect(childPath([{ file: "r.playlist.json" }], root, 1)).toEqual([{ file: "r.playlist.json" }, { file: "x.playlist.json" }]);
  });

  it("inherits the output from the nearest playlist up the path, else Master", () => {
    const withBus = { ...root, output: "SFX" };
    const load = (f: string) => (f === "r.playlist.json" ? withBus : null);
    expect(effectiveOutput([{ file: "r.playlist.json" }, { entry: 0 }], load)).toEqual({ bus: "SFX", own: false, from: "r" });
    expect(effectiveOutput([{ file: "r.playlist.json" }], load)).toEqual({ bus: "SFX", own: true, from: null });
    expect(effectiveOutput([{ file: "r.playlist.json" }], () => root).bus).toBe("Master");
  });

  it("round-trips the route's select", () => {
    expect(selectToIndices(indicesToSelect([2, 0]))).toEqual([2, 0]);
    expect(selectToIndices("x.1")).toEqual([]);
    expect(indicesToSelect([])).toBeUndefined();
  });

  it("canonicalises an edited playlist as the parse reads it", () => {
    const c = canonical({ ...emptyPlaylist("queue"), entries: [sample("a.wav")] });
    expect(c.entries[0]!.kind).toBe("embedded");
  });
});

describe("entry edits", () => {
  it("wraps a sample in an embedded Clip outside a Clip, and a Clip replaces its sample", () => {
    const b = ok(addEntries(queue(), [sample("a.wav")], ctx));
    expect(b.entries[0]!.kind).toBe("embedded");
    const c = ok(addEntries({ ...emptyPlaylistBody("clip"), entries: [sample("old.wav")] }, [sample("new.wav")], ctx));
    expect(c.entries).toHaveLength(1);
    expect((c.entries[0] as { sample: string }).sample).toBe("new.wav");
    expect(no(addEntries(emptyPlaylistBody("clip"), [link("x.playlist.json")], ctx))).toMatch(/sample/);
  });

  it("keeps a Switch's map on the same entries when entries are removed, moved or duplicated", () => {
    const sw: PlaylistBody = { ...queue(clipOf("a.wav"), clipOf("b.wav"), clipOf("c.wav")), type: "switch", switch: { parameter: "surface", map: { dirt: 0, metal: 1, grass: 2 }, labelGain: {}, onChange: { when: "now", how: "crossfade", length: { ms: 200 } }, rules: [] } };
    expect(ok(removeEntry(sw, 1)).switch!.map).toEqual({ dirt: 0, metal: null, grass: 1 });
    expect(ok(moveEntry(sw, 0, 2)).switch!.map).toEqual({ dirt: 2, metal: 0, grass: 1 });
    expect(ok(duplicateEntry(sw, 0, ctx)).switch!.map).toEqual({ dirt: 0, metal: 2, grass: 3 });
  });

  it("clamps use settings to the prototype's ranges", () => {
    const b = ok(setEntryUse(queue(clipOf("a.wav")), 0, { volume: 40, pitch: -99, weight: 3.6 }));
    expect([b.entries[0]!.volume, b.entries[0]!.pitch, b.entries[0]!.weight]).toEqual([12, -24, 4]);
  });

  it("places new Blend entries in the widest gap (1D) and the first free spot (2D)", () => {
    let b: PlaylistBody = { ...emptyPlaylistBody("blend"), blend: { ...emptyPlaylistBody("blend").blend!, axes: [{ parameter: "speed" }] } };
    b = ok(addEntries(b, [sample("a.wav")], ctx));
    b = ok(addEntries(b, [sample("b.wav")], ctx));
    b = ok(addEntries(b, [sample("c.wav")], ctx));
    expect(b.entries.map((e) => e.x)).toEqual([0, 100, 50]);
    const b2 = ok(setDimensions(b, 2, ctx));
    expect(b2.blend!.axes[1]).toEqual({ parameter: "rpm" });
    expect(b2.entries.every((e) => e.y !== undefined)).toBe(true);
    expect(ok(setDimensions(b2, 1, ctx)).entries.every((e) => e.y === undefined)).toBe(true);
  });

  it("keeps entries' relative places when an axis changes", () => {
    const b: PlaylistBody = { ...emptyPlaylistBody("blend"), entries: [{ ...clipOf("a.wav"), x: 25 }], blend: { ...emptyPlaylistBody("blend").blend!, axes: [{ parameter: "speed" }] } };
    expect(ok(setAxis(b, 0, { parameter: "rpm" }, ctx)).entries[0]!.x).toBe(2000);
    expect(no(setAxis(b, 0, { parameter: "surface" }, ctx))).toMatch(/numeric/);
  });

  it("edits Switch labels, rules and the default change, converting lengths between ms and beats", () => {
    let b = ok(convertType(queue(clipOf("a.wav"), clipOf("b.wav")), "switch", ctx));
    expect(b.switch!.parameter).toBe("surface");
    expect(b.switch!.map).toEqual({ dirt: 0, metal: 1, grass: 0 });
    b = ok(setLabelEntry(b, "grass", null));
    expect(b.switch!.map.grass).toBeNull();
    b = ok(addRule(b, ["dirt", "metal", "grass"]));
    expect(b.switch!.rules[0]).toMatchObject({ from: "*", to: "dirt", when: "now", length: { ms: 300 } });
    b = ok(setRule(b, 0, { when: "bar" }));
    expect(b.switch!.rules[0]!.length).toEqual({ beats: 0.5 });
    b = ok(setOnChange(b, { how: "cut" }));
    expect(b.switch!.onChange.how).toBe("cut");
    expect(no(setSwitchParameter(b, "speed", ctx))).toMatch(/labelled/);
  });

  it("unlinks and links entries keeping their use settings", () => {
    const b = queue({ ...link("x.playlist.json"), volume: -3 });
    const u = ok(unlinkEntry(b, 0, queue(clipOf("z.wav"))));
    expect(u.entries[0]).toMatchObject({ kind: "embedded", volume: -3 });
    const l = ok(linkEntry(u, 0, "y.playlist.json"));
    expect(l.entries[0]).toMatchObject({ kind: "linked", playlist: "y.playlist.json", volume: -3 });
  });

  it("edits a Clip's sample fields and the playback rules within range", () => {
    const c = ok(setClipSample(emptyPlaylistBody("clip"), "a.wav"));
    const t = ok(setClipSampleFields(c, { trim: [1, 1.001] }));
    expect((t.entries[0] as { trim: number[] }).trim).toEqual([1, 1.02]);
    expect(ok(setPlayback(c, { maxInstances: 99, chance: 2 })).playback).toMatchObject({ maxInstances: 32, chance: 1 });
    expect(no(setParameters(c, [params[0]!, params[0]!]))).toMatch(/share a name/);
  });
});

describe("type conversion", () => {
  it("unwraps embedded Clips into a Clip and refuses other entries", () => {
    const c = ok(convertType(queue(clipOf("a.wav")), "clip", ctx));
    expect(c.entries).toEqual([expect.objectContaining({ kind: "sample", sample: "a.wav" })]);
    expect(no(convertType(queue(clipOf("a.wav"), link("x.playlist.json")), "clip", ctx))).toMatch(/one entry isn't a sample/);
    expect(typeOptions(queue(link("x.playlist.json")))[0]).toMatchObject({ disabled: true });
  });

  it("wraps a Clip's sample when it becomes another type, keeping its use settings on the wrapper", () => {
    const c: PlaylistBody = { ...emptyPlaylistBody("clip"), entries: [{ ...sample("a.wav"), volume: -6 } as Entry] };
    const q = ok(convertType(c, "layer", ctx));
    expect(q.entries[0]).toMatchObject({ kind: "embedded", volume: -6 });
  });

  it("spreads entries over a new Blend and keeps an old Blend's settings when switching back", () => {
    const b = ok(convertType(queue(clipOf("a.wav"), clipOf("b.wav"), clipOf("c.wav")), "blend", ctx));
    expect(b.blend!.axes).toEqual([{ parameter: "speed" }]);
    expect(b.entries.map((e) => e.x)).toEqual([10, 50, 90]);
    const back = ok(convertType(ok(convertType(b, "queue", ctx)), "blend", ctx));
    expect(back.blend).toBe(b.blend);
  });

  it("makes one playlist track per entry, and entries from clips on the way back", () => {
    const s = ok(convertType(queue(clipOf("a.wav"), link("x.playlist.json")), "sequence", ctx));
    expect(s.sequence!.tracks.map((t) => t.kind)).toEqual(["playlist", "playlist"]);
    const emptied = { ...s, entries: [] };
    const q = ok(convertType(emptied, "queue", ctx));
    expect(q.entries.map((e) => e.kind)).toEqual(["embedded", "linked"]);
  });
});

describe("blend placement", () => {
  it("re-spaces evenly and puts the new entry in the widest gap", () => {
    expect(place1D([], [0, 1])).toEqual({ xs: [], x: 0 });
    expect(place1D([0], [0, 1])).toEqual({ xs: [0], x: 1 });
    expect(place1D([0, 1], [0, 1])).toEqual({ xs: [0, 1], x: 0.5 });
    expect(place1D([0, 0.5, 1], [0, 1]).x).toBeCloseTo(1 / 3);
  });

  it("tries edge middles, then corners, then the points between", () => {
    expect(place2D([], [0, 1], [0, 1])).toEqual({ x: 0.5, y: 1 });
    expect(place2D([{ x: 0.5, y: 1 }], [0, 1], [0, 1])).toEqual({ x: 1, y: 0.5 });
    const all = [[5, 10], [10, 5], [5, 0], [0, 5]].map(([x, y]) => ({ x, y }));
    expect(place2D(all, [0, 10], [0, 10])).toEqual({ x: 10, y: 10 });
  });

  it("spreads and reads ranges", () => {
    expect(spreadPositions(2, [0, 10], [0, 1])).toEqual([{ x: 1, y: 0.15 }, { x: 9, y: 0.85 }]);
    expect(axisRange({ voiceTime: 3 }, params)).toEqual([0, 3]);
    expect(axisRange({ parameter: "surface" }, params)).toEqual([0, 2]);
  });
});
