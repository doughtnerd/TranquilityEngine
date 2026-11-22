import { describe, expect, it } from "vitest";
import type { SequenceSettings } from "../../../../engine/audio/playlist/types";
import type { EditResult } from "../../../../plugins/audio/editor/editResult";
import { addAutomation, addPoint, addVolumeEnvelope, deletePoints, movePoints, removeAutomation, setAutomation, setPointShape, targetSpecs, writeAutomation } from "./automationEdits";
import { addLoop, addMarker, clearLoopOverride, deleteLoops, makeHoldPoint, moveLoop, nudgeLoopsAndMarkers, renameMarker, setLoopBehaviour, setLoopEdge, setLoopOverride, setMarkerHidden, setMarkerType } from "./loopMarkerEdits";
import { copySelection, paste, pasteLabel } from "./sequenceClipboard";
import {
  addPlaylistClip, addSampleClip, addSampleOnNewTrack, addTrack, cutCurve, deleteClips, duplicateClips, duplicateTrack, moveClips, moveClipsToAdjacentTrack, moveTrack, nudgeClipEdge,
  removeTracks, setClip, setClipEffects, setClipLength, setMeter, setSequenceLength, setTempo, setTrack, splitClip, toggleClipsEnabled, trackNameFor, trimClipStart, trimToPlayhead,
} from "./sequenceEdits";
import { FIXTURE_SELF, fixtureSequence, fixtureSource, loadFixturePlaylist } from "./sequenceFixture";
import { findClip } from "./sequenceModel";
import { clickClip, clickPoint, EMPTY_SELECTION, selectLoop, selectMarker } from "./sequenceSelection";

const seq = fixtureSequence();
const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const why = <T>(r: EditResult<T>): string => ("refused" in r ? r.refused : "accepted");
const clip = (s: SequenceSettings, id: string) => findClip(s, id)!;

describe("tracks", () => {
  it("adds audio and playlist tracks with the next series colour", () => {
    const s = ok(addTrack(seq, "playlist"));
    expect(s.tracks[4]).toMatchObject({ id: "t5", kind: "playlist", name: "Playlist 2", color: 4 });
    expect(ok(addTrack(seq, "audio", 0)).tracks[1]!.name).toBe("Audio 4");
  });

  it("duplicates a track with fresh clip ids, reorders, renames, mutes and removes", () => {
    const d = ok(duplicateTrack(seq, "t1"));
    expect(d.tracks[1]).toMatchObject({ name: "Skid copy" });
    expect(d.tracks[1]!.clips[0]!.id).toBe("c5");
    expect(ok(moveTrack(seq, "t4", 0)).tracks.map((t) => t.id)).toEqual(["t4", "t1", "t2", "t3"]);
    expect(ok(setTrack(seq, "t1", { name: " Tyres ", mute: true })).tracks[0]).toMatchObject({ name: "Tyres", mute: true });
    expect(why(setTrack(seq, "t1", { name: "  " }))).toBe("a track needs a name");
    expect(ok(removeTracks(seq, ["t2", "t3"])).tracks.map((t) => t.id)).toEqual(["t1", "t4"]);
  });
});

describe("adding clips", () => {
  it("adds a sample clip on an audio track, its length the sample's, a music sample as sync", () => {
    const s = ok(addSampleClip(seq, "t2", "audio/music_loop.wav", 5, fixtureSource({ ...clip(seq, "c2").clip })));
    expect(s.tracks[1]!.clips[1]).toMatchObject({ id: "c5", at: 5, length: 4, sync: true, sample: "audio/music_loop.wav" });
  });

  it("refuses a sample on a playlist track and a playlist on an audio track", () => {
    expect(why(addSampleClip(seq, "t4", "audio/hit.wav", 0, null))).toBe("Playlist tracks take a playlist, not samples");
    expect(why(addPlaylistClip(seq, "t1", "audio/stingers.playlist.json", 0, FIXTURE_SELF, loadFixturePlaylist))).toBe("Audio tracks take samples; drop playlists on a Playlist track");
  });

  it("adds a 2 s playlist clip, refusing one that contains this sequence", () => {
    const s = ok(addPlaylistClip(seq, "t4", "audio/stingers.playlist.json", 1, FIXTURE_SELF, loadFixturePlaylist));
    expect(s.tracks[3]!.clips[1]).toMatchObject({ playlist: "audio/stingers.playlist.json", at: 1, length: 2 });
    expect(why(addPlaylistClip(seq, "t4", "audio/loop.playlist.json", 1, FIXTURE_SELF, loadFixturePlaylist))).toBe("it contains this sequence");
    expect(why(addPlaylistClip(seq, "t4", FIXTURE_SELF, 1, FIXTURE_SELF, loadFixturePlaylist))).toBe("it contains this sequence");
  });

  it("makes a new audio track named after the sample when dropped below the tracks", () => {
    const s = ok(addSampleOnNewTrack(seq, "audio/brake_skid_02.wav", 1, { length: 2, loops: [], markers: [] }));
    expect(s.tracks[4]).toMatchObject({ name: "Brake", kind: "audio" });
    expect(s.tracks[4]!.clips[0]).toMatchObject({ at: 1, length: 2 });
    expect(trackNameFor("x/hit-metal.sample.json")).toBe("Hit");
  });
});

describe("moving, trimming, splitting", () => {
  it("moves a group, clamped at 0, and between tracks of their kind only", () => {
    const s = ok(moveClips(seq, ["c2", "c3"], -5));
    expect([clip(s, "c2").clip.at, clip(s, "c3").clip.at]).toEqual([0, 1.5]);
    const down = ok(moveClips(seq, ["c2"], 0.5, 1));
    expect(clip(down, "c2")).toMatchObject({ ti: 2 });
    expect(clip(down, "c2").clip.at).toBe(1);
    // Onto the playlist track: time only.
    const wrong = ok(moveClips(seq, ["c3"], 0.25, 1));
    expect(clip(wrong, "c3").ti).toBe(2);
    expect(clip(wrong, "c3").clip.at).toBe(2.25);
    expect(ok(moveClips(seq, ["c1"], 0))).toBe(seq);
  });

  it("moves clips to the nearest track of their kind with ↑/↓", () => {
    expect(clip(ok(moveClipsToAdjacentTrack(seq, ["c1"], 1)), "c1").ti).toBe(1);
    expect(why(moveClipsToAdjacentTrack(seq, ["c1"], -1))).toBe("there's no track of its kind above");
    expect(why(moveClipsToAdjacentTrack(seq, ["c4"], -1))).toBe("there's no track of its kind above");
  });

  it("trims the start (keeping the end, never before the sample start, at least 0.02 s) and sets the length past the sample", () => {
    const s = ok(trimClipStart(seq, "c2", 1, fixtureSource));
    expect(clip(s, "c2").clip).toMatchObject({ at: 1, offset: 0.5, length: 3.5 });
    expect(clip(ok(trimClipStart(seq, "c2", 0, fixtureSource)), "c2").clip).toMatchObject({ at: 0.5, offset: 0 });
    expect(clip(ok(trimClipStart(seq, "c2", 9, fixtureSource)), "c2").clip.length).toBe(0.02);
    expect(clip(ok(setClipLength(seq, "c1", 7)), "c1").clip.length).toBe(7);
    expect(clip(ok(setClipLength(seq, "c1", 0)), "c1").clip.length).toBe(0.02);
  });

  it("trims to the playhead and moves edges with Alt+arrows", () => {
    expect(clip(ok(trimToPlayhead(seq, "c2", 2, "end", fixtureSource)), "c2").clip.length).toBe(1.5);
    expect(clip(ok(trimToPlayhead(seq, "c2", 2, "start", fixtureSource)), "c2").clip).toMatchObject({ at: 2, offset: 1.5 });
    expect(why(trimToPlayhead(seq, "c2", 0.1, "end", fixtureSource))).toBe("the playhead isn't inside the clip");
    expect(clip(ok(nudgeClipEdge(seq, ["c2"], "end", 0.5, fixtureSource)), "c2").clip.length).toBe(4.5);
    expect(clip(ok(nudgeClipEdge(seq, ["c2"], "start", 0.5, fixtureSource)), "c2").clip.at).toBe(1);
  });

  it("splits inside the clip, following the loop passes and shifting the right half's automation", () => {
    const s = ok(splitClip(seq, "c1", 1.2, fixtureSource));
    const [left, right] = s.tracks[0]!.clips;
    expect(left).toMatchObject({ id: "c1", length: 1.2 });
    expect(right).toMatchObject({ id: "c5", at: 1.2, length: 1.8 });
    expect(right!.offset).toBeCloseTo(0.7);
    expect(right!.automation[0]!.curve).toEqual([[0, 0], [1.3, 0], [1.8, -24]]);
    expect(left!.automation[0]!.curve).toEqual([[0, -12], [0.5, 0], [1.2, 0]]);
    expect(why(splitClip(seq, "c1", 0.005, fixtureSource))).toBe("Split point must be inside the clip");
    expect(why(splitClip(seq, "c1", 2.995, fixtureSource))).toBe("Split point must be inside the clip");
  });

  it("cuts a curve with keys holding the value at each cut", () => {
    expect(cutCurve([[0, 0], [2, 2]], 0.5, 1.5)).toEqual([[0, 0.5], [1, 1.5]]);
  });
});

describe("clip lists and fields", () => {
  it("deletes, duplicates after the selection and toggles enabled", () => {
    expect(ok(deleteClips(seq, ["c1"])).tracks[0]!.clips).toEqual([]);
    const d = ok(duplicateClips(seq, ["c2", "c3"], fixtureSource));
    expect(d.ids).toEqual(["c5", "c6"]);
    expect(clip(d.seq, "c5").clip.at).toBe(4.5);
    expect(clip(d.seq, "c6").clip.at).toBe(6);
    const off = ok(toggleClipsEnabled(seq, ["c1", "c2"]));
    expect(off.enabled).toBe(false);
    expect(ok(toggleClipsEnabled(off.seq, ["c1"])).enabled).toBe(true);
  });

  it("sets clip fields (length 0 = to the end) and drops a removed effect's automation", () => {
    const s = ok(setClip(seq, "c1", { gain: 40, length: 0, reverse: true }));
    expect(clip(s, "c1").clip).toMatchObject({ gain: 24, length: 0, reverse: true });
    const withFx = ok(addAutomation(seq, { clip: "c1" }, "fx:fx1:cutoff", 3)).seq;
    expect(clip(withFx, "c1").clip.automation).toHaveLength(2);
    expect(clip(ok(setClipEffects(withFx, "c1", [])), "c1").clip.automation).toHaveLength(1);
  });

  it("sets the sequence's length, tempo and meter", () => {
    expect(ok(setSequenceLength(seq, -1)).length).toBe(0);
    expect(ok(setTempo(seq, 500)).tempo).toEqual({ bpm: 400, meter: "4/4" });
    expect(ok(setTempo(seq, null)).tempo).toBeNull();
    expect(ok(setMeter({ ...seq, tempo: null }, "6/8")).tempo).toEqual({ bpm: 120, meter: "6/8" });
    expect(why(setMeter(seq, "4/0"))).toBe('"4/0" isn\'t a meter like 4/4');
  });
});

describe("loops and markers", () => {
  it("adds loops and hold points, moves, resizes, makes a hold point and stretches it back", () => {
    const a = ok(addLoop(seq, 3, 2));
    expect(a.seq.loops[1]).toMatchObject({ id: "l2", start: 2, end: 3, active: "always", exit: "finish" });
    const h = ok(addLoop(seq, 1, 1));
    expect(h.seq.loops[1]).toMatchObject({ start: 1, end: 1, active: "held", exit: "jump" });
    expect(ok(moveLoop(a.seq, "l2", -5)).loops[1]).toMatchObject({ start: 0, end: 1 });
    expect(ok(setLoopEdge(a.seq, "l2", "end", 1)).loops[1]).toMatchObject({ start: 1, end: 2 });
    expect(ok(makeHoldPoint(a.seq, "l2")).loops[1]).toMatchObject({ start: 2, end: 2 });
    expect(ok(setLoopEdge(seq, "l1", "end", 2.4)).loops[0]).toMatchObject({ start: 1.6, end: 2.4 });
    expect(ok(deleteLoops(seq, ["l1"])).loops).toEqual([]);
  });

  it("sets activation with a binding, exit and fade (binding dropped off parameter)", () => {
    const p = ok(setLoopBehaviour(seq, "l1", { active: "parameter", binding: { parameter: "brake", op: ">", value: 0.1 }, exitFadeMs: 5000 }));
    expect(p.loops[0]).toMatchObject({ active: "parameter", binding: { parameter: "brake" }, exitFadeMs: 2000 });
    expect(ok(setLoopBehaviour(p, "l1", { active: "always" })).loops[0]!.binding).toBeUndefined();
  });

  it("adds, renames, types and nudges markers", () => {
    const m = ok(addMarker(seq, 1.25));
    expect(m.seq.markers[3]).toEqual({ id: "m4", name: "Marker 4", at: 1.25 });
    expect(ok(renameMarker(seq, "m1", "Start")).markers[0]!.name).toBe("Start");
    expect(why(renameMarker(seq, "m1", " "))).toBe("a marker needs a name");
    expect(ok(setMarkerType(seq, "m2", "note")).markers[1]).toEqual({ id: "m2", name: "Drop", at: 2 });
    expect(ok(setMarkerType(seq, "m1", "exit")).markers[0]!.type).toBe("exit");
    const n = ok(nudgeLoopsAndMarkers(seq, ["l1"], ["m1"], 0.5));
    expect([n.loops[0]!.start, n.markers[0]!.at]).toEqual([2.1, 1]);
  });

  it("overrides a sample loop per clip, uses the sample's again, and hides a sample marker", () => {
    const o = ok(setLoopOverride(seq, "c2", "L1", { active: "held" }));
    expect(clip(o, "c2").clip.loops).toEqual({ L1: { active: "held" } });
    expect(clip(ok(clearLoopOverride(o, "c2", "L1")), "c2").clip.loops).toEqual({});
    expect(clip(ok(setLoopOverride(seq, "c1", "L1", { active: "always" })), "c1").clip.loops.L1!.binding).toBeUndefined();
    const hid = ok(setMarkerHidden(seq, "c2", "e1", true));
    expect(clip(hid, "c2").clip.hiddenMarkers).toEqual(["e1"]);
    expect(clip(ok(setMarkerHidden(hid, "c2", "e1", false)), "c2").clip.hiddenMarkers).toEqual([]);
  });
});

describe("automation", () => {
  it("lists the targets: base ones and each effect's on and parameters", () => {
    const ts = targetSpecs([{ id: "fx1", type: "lowpass", on: true, params: {} }]).map((t) => t.target);
    expect(ts.slice(0, 4)).toEqual(["volume", "pitch", "pan", "enabled"]);
    expect(ts).toContain("fx:fx1:on");
    expect(ts.some((t) => t.startsWith("fx:fx1:") && t !== "fx:fx1:on")).toBe(true);
  });

  it("automates a target with a flat curve, and adds a volume envelope with the clicked point", () => {
    const a = ok(addAutomation(seq, { track: "t2" }, "volume", 6));
    expect(a.seq.tracks[1]!.automation[0]).toMatchObject({ id: "a1", target: "volume", input: "sequenceTime", curve: [[0, 0], [6, 0]] });
    const e = ok(addVolumeEnvelope(seq, "c2", 1, -6, 4));
    expect(clip(e.seq, "c2").clip.automation[0]!.curve).toEqual([[0, 0], [1, -6], [4, 0]]);
    expect(why(addVolumeEnvelope(seq, "c1", 1, -6, 3))).toBe("this clip already has a volume envelope");
  });

  it("adds, moves (clamped between neighbours and to the range), shapes and deletes points", () => {
    const o = { clip: "c1" };
    const p = ok(addPoint(seq, o, "a1", 1, -100));
    expect(p.index).toBe(2);
    expect(clip(p.seq, "c1").clip.automation[0]!.curve[2]).toEqual([1, -60]);
    const m = ok(movePoints(seq, o, "a1", [1], 5, 50));
    expect(clip(m, "c1").clip.automation[0]!.curve[1]).toEqual([2.4999, 12]);
    const sh = ok(setPointShape(seq, o, "a1", [0], "smooth"));
    expect(clip(sh, "c1").clip.automation[0]!.curve[0]).toEqual([0, -12, "smooth"]);
    expect(clip(ok(deletePoints(seq, o, "a1", [0, 1])), "c1").clip.automation[0]!.curve).toHaveLength(2);
    expect(clip(ok(deletePoints(seq, o, "a1", [0, 1, 2, 3])), "c1").clip.automation).toEqual([]);
    expect(clip(ok(setAutomation(seq, o, "a1", { input: { parameter: "speed" } })), "c1").clip.automation[0]!.input).toEqual({ parameter: "speed" });
    expect(ok(removeAutomation(seq, { track: "t1" }, "a1")).tracks[0]!.automation).toEqual([]);
  });

  it("writes touch automation over the passed range, keeping what is outside, never over a parameter curve", () => {
    const w = ok(writeAutomation(seq, { track: "t1" }, "pan", [[1, 0.9], [1.03, 0.9], [1.1, 0.8], [2, 0.2]]));
    const curve = w.seq.tracks[0]!.automation[0]!.curve;
    expect(curve[0]).toEqual([0, -0.5]);
    expect(curve.slice(1, 4)).toEqual([[1, 0.9], [1.1, 0.8], [2, 0.2]]);
    expect(curve[curve.length - 1]).toEqual([4, 0.5]);
    const fresh = ok(writeAutomation(seq, { track: "t2" }, "volume", [[0.5, -3]]));
    expect(fresh.seq.tracks[1]!.automation[0]).toMatchObject({ target: "volume", curve: [[0.5, -3]] });
    const param = ok(setAutomation(seq, { track: "t1" }, "a1", { input: { parameter: "speed" } }));
    expect(why(writeAutomation(param, { track: "t1" }, "pan", [[1, 0]]))).toBe("it is driven by a parameter; parameter curves are never overwritten");
  });
});

describe("clipboard", () => {
  it("copies clips and pastes them at the playhead on the focused track, keeping track offsets", () => {
    const cb = copySelection(seq, clickClip(clickClip(EMPTY_SELECTION, "c2", "t2"), "c3", "t3", { shift: true }))!;
    expect(pasteLabel(cb)).toBe("Paste clips");
    const r = ok(paste(seq, cb, { playhead: 5, track: "t1", lane: null }));
    expect(r.clips).toEqual(["c5", "c6"]);
    expect(clip(r.seq, "c5")).toMatchObject({ ti: 0 });
    expect(clip(r.seq, "c5").clip.at).toBe(5);
    expect(clip(r.seq, "c6")).toMatchObject({ ti: 1 });
    expect(clip(r.seq, "c6").clip.at).toBe(6.5);
    expect(why(paste(seq, cb, { playhead: 5, track: "t3", lane: null }))).toBe("sample clips don't paste onto playlist tracks");
    expect(why(paste(seq, cb, { playhead: 5, track: "t4", lane: null }))).toBe("sample clips don't paste onto playlist tracks");
  });

  it("copies and pastes loops and markers at the playhead", () => {
    const l = ok(paste(seq, copySelection(seq, selectLoop(EMPTY_SELECTION, "l1"))!, { playhead: 3, track: null, lane: null }));
    expect(l.seq.loops[1]).toMatchObject({ id: "l2", start: 3, end: 3 });
    const m = ok(paste(seq, copySelection(seq, selectMarker(EMPTY_SELECTION, "m2"))!, { playhead: 4, track: null, lane: null }));
    expect(m.seq.markers[3]).toMatchObject({ id: "m4", name: "Drop", at: 4, type: "exit" });
  });

  it("pastes points at the playhead in clip time, replacing those in the span, and refuses time into parameter", () => {
    const cb = copySelection(seq, clickPoint(clickPoint(EMPTY_SELECTION, { clip: "c1" }, "a1", 0), { clip: "c1" }, "a1", 1, { shift: true }))!;
    expect(cb).toEqual({ kind: "points", time: true, keys: [[0, -12], [0.5, 0]] });
    const r = ok(paste(seq, cb, { playhead: 2.4, track: null, lane: { owner: { clip: "c1" }, automation: "a1" } }));
    expect(clip(r.seq, "c1").clip.automation[0]!.curve).toEqual([[0, -12], [0.5, 0], [2.4, -12], [2.9, 0], [3, -24]]);
    const param = ok(setAutomation(seq, { clip: "c1" }, "a1", { input: { parameter: "speed" } }));
    expect(why(paste(param, cb, { playhead: 0, track: null, lane: { owner: { clip: "c1" }, automation: "a1" } }))).toBe("time curve points don't go into a parameter curve");
  });
});
