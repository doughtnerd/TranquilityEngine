// Ed4: the segment panel's forms. Each edit is a pure function of the segment; the acceptance is that what the forms
// write survives the writer: format the event, parse it back, no problems, the same segment.
import { describe, expect, it } from "vitest";
import { formatAudioEvent, parseAudioEvent, type AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import {
  addCue, addRegion, audibleStems, auditionKey, auditionOf, moveTrack, promoteAlternative, readCondition, removeAlternative, removeCue,
  removeRegion, removeTrack, renameCue, renameTrack, setCueAt, setEntry, setExit, setGridOffset, setTempo, setTrackBus, setTrackPick,
  setTrackVolume, stemAudition, toggleStem, updateRegion, type Edit,
} from "./SegmentPanel";
import { findSegment, replaceSegment } from "./segmentViewModel";

const RAW = {
  type: "segment", id: "main",
  tracks: [
    { name: "drums", clip: "audio/drums.ogg", alternatives: ["audio/drums b.ogg", "audio/drums c.ogg"], pick: "random" },
    { name: "bass", clip: "audio/bass.ogg" },
  ],
};

function load(raw: unknown = RAW): { event: AudioEventAsset; segment: SegmentNode } {
  const r = parseAudioEvent({ format: "myco.audioevent@1", root: raw });
  expect(r.problems).toEqual([]);
  return { event: r.value, segment: findSegment(r.value.musicRoot, "main")! };
}

/** Apply an edit the way the panel does and push the result through the writer. */
function roundTrip(event: AudioEventAsset, e: Edit): SegmentNode {
  if ("error" in e) throw new Error(e.error);
  const next: AudioEventAsset = { ...event, musicRoot: replaceSegment(event.musicRoot!, "main", e.segment) };
  const text = formatAudioEvent(next);
  const again = parseAudioEvent(JSON.parse(text));
  expect(again.problems).toEqual([]);
  expect(formatAudioEvent(again.value)).toBe(text);
  const read = findSegment(again.value.musicRoot, "main")!;
  expect(read).toEqual(e.segment);
  return read;
}

const err = (e: Edit): string => ("error" in e ? e.error : "");

describe("tempo form", () => {
  it("writes tempo, metre and grid offset into the first marker and round-trips", () => {
    const { event, segment } = load();
    const a = roundTrip(event, setTempo(segment, { bpm: 93.25, beatsPerBar: 6, beatUnit: 8 }));
    expect(a.tempo[0]).toEqual({ at: "1:1:0", bpm: 93.25, beatsPerBar: 6, beatUnit: 8 });
    const b = roundTrip(event, setGridOffset(a, 0.125));
    expect(b.gridOffset).toBe(0.125);
  });

  it("keeps later markers", () => {
    const { event, segment } = load({ ...RAW, tempo: [{ at: "1:1:0", bpm: 100 }, { at: "3:1:0", bpm: 80 }] });
    const a = roundTrip(event, setTempo(segment, { bpm: 110 }));
    expect(a.tempo.map((t) => t.bpm)).toEqual([110, 80]);
  });

  it("refuses values the format would clamp", () => {
    const { segment } = load();
    expect(err(setTempo(segment, { bpm: 0 }))).toMatch(/bpm/);
    expect(err(setTempo(segment, { bpm: NaN }))).toMatch(/bpm/);
    expect(err(setTempo(segment, { beatsPerBar: 2.5 }))).toMatch(/beats per bar/);
    expect(err(setTempo(segment, { beatsPerBar: 33 }))).toMatch(/beats per bar/);
    expect(err(setTempo(segment, { beatUnit: 3 }))).toMatch(/beat unit/);
    expect(err(setGridOffset(segment, -1))).toMatch(/grid offset/);
  });
});

describe("stem list", () => {
  it("renames, regains, repicks, rebuses, reorders and removes, round-tripping each", () => {
    const { event, segment } = load();
    let s = roundTrip(event, renameTrack(segment, "bass", "sub"));
    expect(s.tracks.map((t) => t.name)).toEqual(["drums", "sub"]);
    s = roundTrip(event, setTrackVolume(s, "sub", 0.5));
    expect(s.tracks[1]!.volume).toBe(0.5);
    s = roundTrip(event, setTrackPick(s, "drums", "sequence"));
    s = roundTrip(event, setTrackBus(s, "sub", "Music"));
    expect(s.tracks[1]!.bus).toBe("Music");
    s = roundTrip(event, moveTrack(s, "sub", -1));
    expect(s.tracks.map((t) => t.name)).toEqual(["sub", "drums"]);
    s = roundTrip(event, removeTrack(s, "sub"));
    expect(s.tracks.map((t) => t.name)).toEqual(["drums"]);
  });

  it("moving past either end changes nothing", () => {
    const { segment } = load();
    expect((moveTrack(segment, "drums", -1) as { segment: SegmentNode }).segment).toBe(segment);
  });

  it("refuses duplicate or empty names and out-of-range gain", () => {
    const { segment } = load();
    expect(err(renameTrack(segment, "bass", "drums"))).toMatch(/already named/);
    expect(err(renameTrack(segment, "bass", "  "))).toMatch(/needs a name/);
    expect(err(setTrackVolume(segment, "bass", 4.5))).toMatch(/gain/);
    expect(err(setTrackVolume(segment, "nope", 1))).toMatch(/no stem/);
  });

  it("removes and promotes alternatives", () => {
    const { event, segment } = load();
    let s = roundTrip(event, promoteAlternative(segment, "drums", "audio/drums b.ogg"));
    expect(s.tracks[0]!.clip).toBe("audio/drums b.ogg");
    expect(s.tracks[0]!.alternatives).toEqual(["audio/drums.ogg", "audio/drums c.ogg"]);
    s = roundTrip(event, removeAlternative(s, "drums", "audio/drums c.ogg"));
    expect(s.tracks[0]!.alternatives).toEqual(["audio/drums.ogg"]);
    expect(err(promoteAlternative(s, "drums", "audio/x.ogg"))).toMatch(/not an alternative/);
  });
});

describe("solo and mute are audition state, not asset state", () => {
  const { event, segment } = load();
  const key = auditionKey("e.audio.json", "main");

  it("solo narrows to the soloed stems, mute removes, mute beats solo", () => {
    expect(audibleStems(segment.tracks, { solo: [], mute: [] })).toEqual(["drums", "bass"]);
    expect(audibleStems(segment.tracks, { solo: ["bass"], mute: [] })).toEqual(["bass"]);
    expect(audibleStems(segment.tracks, { solo: [], mute: ["bass"] })).toEqual(["drums"]);
    expect(audibleStems(segment.tracks, { solo: ["bass"], mute: ["bass"] })).toEqual([]);
    expect(audibleStems(segment.tracks, { solo: ["gone"], mute: [] })).toEqual(["drums", "bass"]);
  });

  it("toggling changes the signal and leaves the written asset untouched", () => {
    const before = formatAudioEvent(event);
    toggleStem(key, "solo", "drums");
    toggleStem(key, "mute", "bass");
    expect(auditionOf(key)).toEqual({ solo: ["drums"], mute: ["bass"] });
    expect(formatAudioEvent(event)).toBe(before);
    expect(before).not.toMatch(/solo|mute/);
    toggleStem(key, "solo", "drums");
    expect(auditionOf(key).solo).toEqual([]);
    stemAudition.value = {};
  });
});

describe("cue forms", () => {
  it("adds, renames, moves and removes cues; entry and exit follow", () => {
    const { event, segment } = load();
    let s = roundTrip(event, addCue(segment, "2:1:0", "drop"));
    s = roundTrip(event, addCue(s, "start"));
    expect(s.cues.map((c) => c.name)).toEqual(["drop", "cue"]);
    s = roundTrip(event, setEntry(s, "drop"));
    s = roundTrip(event, setExit(s, "cue"));
    s = roundTrip(event, renameCue(s, "drop", "chorus"));
    expect(s.entry).toBe("chorus");
    s = roundTrip(event, setCueAt(s, "chorus", "03:2:480"));
    expect(s.cues[0]!.at).toBe("3:2:480");
    s = roundTrip(event, removeCue(s, "cue"));
    expect(s.exit).toBeUndefined();
    expect(s.entry).toBe("chorus");
    s = roundTrip(event, setEntry(s, undefined));
    expect(s.entry).toBeUndefined();
  });

  it("names new cues uniquely", () => {
    const { segment } = load();
    let s = (addCue(segment) as { segment: SegmentNode }).segment;
    s = (addCue(s) as { segment: SegmentNode }).segment;
    expect(s.cues.map((c) => c.name)).toEqual(["cue", "cue 2"]);
  });

  it("refuses a bad position, a beat past the bar, a duplicate name, an unknown entry", () => {
    const { segment } = load();
    expect(err(addCue(segment, "1:1"))).toMatch(/bar:beat:tick/);
    expect(err(addCue(segment, "1:5:0"))).toMatch(/past the end of its bar/);
    const s = (addCue(segment, "1:1:0", "a") as { segment: SegmentNode }).segment;
    expect(err(addCue(s, "1:1:0", "a"))).toMatch(/already named/);
    expect(err(setEntry(s, "zzz"))).toMatch(/no cue/);
    expect(err(setCueAt(s, "a", "1:1:960"))).toMatch(/tick/);
  });
});

describe("region forms", () => {
  it("adds a default loop region and edits every field, round-tripping", () => {
    const { event, segment } = load();
    let s = roundTrip(event, addRegion(segment));
    expect(s.regions).toEqual([{ id: "loop", from: "start", to: "end", count: 0 }]);
    s = roundTrip(event, updateRegion(s, "loop", { from: "2:1:0", to: "5:1:0", count: 4, tailBeats: 2 }));
    expect(s.regions[0]).toEqual({ id: "loop", from: "2:1:0", to: "5:1:0", count: 4, tailBeats: 2 });
    const c = readCondition("Intensity", "atLeast", "0.5");
    if (!("condition" in c)) throw new Error(c.error);
    s = roundTrip(event, updateRegion(s, "loop", { while: c.condition }));
    expect(s.regions[0]!.while).toEqual({ parameter: "Intensity", atLeast: 0.5 });
    s = roundTrip(event, updateRegion(s, "loop", { id: "verse", tailBeats: null, while: null }));
    expect(s.regions[0]).toEqual({ id: "verse", from: "2:1:0", to: "5:1:0", count: 4 });
    s = roundTrip(event, removeRegion(s, "verse"));
    expect(s.regions).toEqual([]);
  });

  it("round-trips the three condition forms", () => {
    const { event, segment } = load();
    const base = (addRegion(segment) as { segment: SegmentNode }).segment;
    for (const [form, value, expected] of [
      ["is", "boss", { parameter: "State", is: "boss" }],
      ["atLeast", "3", { parameter: "State", atLeast: 3 }],
      ["below", "-1", { parameter: "State", below: -1 }],
    ] as const) {
      const c = readCondition("State", form, value);
      if (!("condition" in c)) throw new Error(c.error);
      const s = roundTrip(event, updateRegion(base, "loop", { while: c.condition }));
      expect(s.regions[0]!.while).toEqual(expected);
    }
    expect(readCondition("", "is", "x")).toEqual({ error: "name the parameter" });
    expect(readCondition("P", "below", "abc")).toEqual({ error: "the value must be a number" });
  });

  it("refuses a region the parser would drop", () => {
    const { segment } = load();
    const s = (addRegion(segment, { from: "2:1:0", to: "4:1:0" }) as { segment: SegmentNode }).segment;
    expect(err(updateRegion(s, "loop", { to: "2:1:0" }))).toMatch(/not before/);
    expect(err(updateRegion(s, "loop", { to: "start" }))).toMatch(/to:/);
    expect(err(updateRegion(s, "loop", { from: "end" }))).toMatch(/from:/);
    expect(err(updateRegion(s, "loop", { count: 65 }))).toMatch(/passes/);
    expect(err(updateRegion(s, "loop", { tailBeats: 17 }))).toMatch(/tail/);
    expect(err(addRegion(s, { id: "loop" }))).toMatch(/already named/);
    expect(err(updateRegion(s, "nope", {}))).toMatch(/no region/);
  });
});
