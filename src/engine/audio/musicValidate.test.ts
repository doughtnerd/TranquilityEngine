/**
 * One case per lint row of `api-and-models.md` §2.6 (L-F3a fills these; the skeleton names and skips them). Each case
 * builds segments with `emptySegment` / `parseMusicSegment` and fixture clip facts (`__fixtures__/music/clips.ts`) and
 * asserts the `MusicLintIssue` it should raise (`code`, `severity`, `segment`, `track`) and, for a clean control, that
 * nothing is raised. Every row needs a passing control and a failing case. Tag: L-F3a.
 */
import { describe, expect, it } from "vitest";
import { emptySegment, type MusicRegion, type MusicTrack, type SegmentNode } from "./musicFormat";
import {
  MUSIC_VALIDATE_LIMITS, segmentRingNeed, stemMode, validateMusic, validateSegment,
  type MusicGraph, type MusicLintCode, type MusicLintIssue, type MusicValidation,
} from "./musicValidate";
import { FIXTURE_CLIPS, clip, lookup, secs } from "./__fixtures__/music/clips";

const MIB = 1024 * 1024;
const facts = lookup(FIXTURE_CLIPS);

const track = (name: string, path: string, over: Partial<MusicTrack> = {}): MusicTrack => ({
  name, clip: path, alternatives: [], pick: "sequence", volume: 1, bus: "", automation: [], ...over,
});
/** `n` stems of a 60 s (streamed) clip. */
const streamedTracks = (n: number, prefix = "s"): MusicTrack[] =>
  Array.from({ length: n }, (_, i) => track(`${prefix}${i}`, "music/long.ogg"));
/** `n` stems of a 10 s (decoded) clip. */
const decodedTracks = (n: number, prefix = "d"): MusicTrack[] =>
  Array.from({ length: n }, (_, i) => track(`${prefix}${i}`, "music/short.ogg"));
const seg = (id: string, tracks: MusicTrack[], over: Partial<SegmentNode> = {}): SegmentNode =>
  ({ ...emptySegment(id, tracks), ...over });
/** A loop region, bar 1 to bar 5 (16 beats in 4/4) by default. */
const loop = (over: Partial<MusicRegion> = {}): MusicRegion => ({ id: "loop", from: "1:1:0", to: "5:1:0", count: 0, ...over });
const rowsOf = (v: MusicValidation, code: MusicLintCode): MusicLintIssue[] => v.issues.filter((i) => i.code === code);
const seamsOf = (v: MusicValidation) => v.needs.filter((n) => n.kind === "seam");

describe("validateMusic: stems of a segment (L-F3a)", () => {
  it("L-F3a stems differing in length beyond 1,024 frames: stemLengthMismatch error, the segment is in `refused`", () => {
    const v = validateMusic({ segments: [seg("s", [track("a", "music/short.ogg"), track("b", "music/short-plus-1025.ogg")])] }, facts);
    const rows = rowsOf(v, "stemLengthMismatch");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "error", segment: "s" });
    expect(v.refused).toEqual(["s"]);
    expect(rowsOf(v, "stemLengthTrimmed")).toHaveLength(0);
  });

  it("L-F3a stems differing within 1,024 frames (and by exactly 1,024): stemLengthTrimmed warning, not refused", () => {
    for (const path of ["music/short-plus-1.ogg", "music/short-plus-1024.ogg"]) {
      const v = validateMusic({ segments: [seg("s", [track("a", "music/short.ogg"), track("b", path)])] }, facts);
      const rows = rowsOf(v, "stemLengthTrimmed");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ severity: "warn", segment: "s" });
      expect(v.refused).toEqual([]);
      expect(rowsOf(v, "stemLengthMismatch")).toHaveLength(0);
    }
  });

  it("L-F3a stems of one length: no length row", () => {
    const v = validateMusic({ segments: [seg("s", [track("a", "music/short.ogg"), track("b", "music/short-b.ogg")])] }, facts);
    expect(v.issues).toEqual([]);
    expect(v.refused).toEqual([]);
  });

  it("L-F3a stems of different rates: stemRateMismatch", () => {
    const v = validateMusic({ segments: [seg("s", [track("a", "music/short.ogg"), track("b", "music/short-44k.ogg")])] }, facts);
    const rows = rowsOf(v, "stemRateMismatch");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warn", segment: "s" });
    expect(["a", "b"]).toContain(rows[0].track);
  });

  it("L-F3a stems of different channel counts: stemChannelsMismatch", () => {
    const v = validateMusic({ segments: [seg("s", [track("a", "music/short.ogg"), track("b", "music/short-mono.ogg")])] }, facts);
    const rows = rowsOf(v, "stemChannelsMismatch");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warn", segment: "s" });
    expect(["a", "b"]).toContain(rows[0].track);
  });

  it("L-F3a a stem's alternatives of unequal length: alternativeLengthMismatch", () => {
    const same = validateMusic({ segments: [seg("s", [track("a", "music/short.ogg", { alternatives: ["music/short-b.ogg"] })])] }, facts);
    expect(rowsOf(same, "alternativeLengthMismatch")).toEqual([]);
    const unequal = validateMusic({ segments: [seg("s", [track("a", "music/short.ogg", { alternatives: ["music/alt-11s.ogg"] })])] }, facts);
    const rows = rowsOf(unequal, "alternativeLengthMismatch");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warn", segment: "s", track: "a" });
  });
});

describe("validateMusic: gapless and codecs (L-F3a)", () => {
  it("L-F3a an MP3 stem without a length header (gapless false): noGapless", () => {
    const v = validateMusic({ segments: [seg("s", [track("m", "music/mp3-nohdr.mp3")])] }, facts);
    const rows = rowsOf(v, "noGapless");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warn", segment: "s", track: "m", clip: "music/mp3-nohdr.mp3" });
  });

  it("L-F3a a gapless MP3, Vorbis and AAC stem: no noGapless", () => {
    const v = validateMusic({ segments: [seg("s", [track("m", "music/mp3.mp3"), track("v", "music/long.ogg"), track("a", "music/aac.m4a")])] }, facts);
    expect(rowsOf(v, "noGapless")).toEqual([]);
  });

  it("L-F3a a streamed FLAC or WAV stem on low: flacOnLow warning; none on default and high, none when decoded", () => {
    for (const [name, path] of [["f", "music/long.flac"], ["w", "music/long.wav"]] as const) {
      const s = seg("s", [track(name, path)]);
      const low = rowsOf(validateSegment(s, facts, { preset: "low" }), "flacOnLow");
      expect(low).toHaveLength(1);
      expect(low[0]).toMatchObject({ severity: "warn", segment: "s", track: name, clip: path });
      expect(rowsOf(validateSegment(s, facts, { preset: "default" }), "flacOnLow")).toEqual([]);
      expect(rowsOf(validateSegment(s, facts, { preset: "high" }), "flacOnLow")).toEqual([]);
    }
    const decoded = seg("s", [track("d", "music/short.flac")]);
    expect(rowsOf(validateSegment(decoded, facts, { preset: "low" }), "flacOnLow")).toEqual([]);
  });

  it("L-F3a encoded bytes of the streamed stems of a segment and its successors over the preset's budget: encodedOverBudget", () => {
    // A (2 x 30 MiB) to B (2 x 30 MiB): 120 MiB over the streams of the pair, over 48 and 96, under 160.
    const a = seg("A", [track("a0", "music/big-a.ogg"), track("a1", "music/big-b.ogg")]);
    const b = seg("B", [track("b0", "music/big-c.ogg"), track("b1", "music/big-d.ogg")]);
    const graph: MusicGraph = { segments: [a, b], edges: [{ from: "A", to: "B" }] };
    expect(MUSIC_VALIDATE_LIMITS.encodedBudgetBytes.default).toBe(96 * MIB);
    expect(rowsOf(validateMusic(graph, facts, { preset: "low" }), "encodedOverBudget").length).toBeGreaterThan(0);
    expect(rowsOf(validateMusic(graph, facts, { preset: "default" }), "encodedOverBudget").length).toBeGreaterThan(0);
    expect(rowsOf(validateMusic(graph, facts, { preset: "high" }), "encodedOverBudget")).toEqual([]);
    // Control: A alone is 60 MiB, under the default budget.
    expect(rowsOf(validateSegment(a, facts, { preset: "default" }), "encodedOverBudget")).toEqual([]);
  });
});

describe("validateMusic: stream or decode (L-F3a)", () => {
  it("L-F3a stemMode: 30 s decodes, one frame over streams; forceMode overrides", () => {
    expect(stemMode("music/edge-30s.ogg", clip(30))).toBe("decode");
    expect(stemMode("music/edge-30s.ogg", clip(30, { rate: 44_100 }))).toBe("decode");
    expect(stemMode("music/over-30s.ogg", { ...clip(30), frames: secs(30) + 1 })).toBe("stream");
    expect(stemMode("music/long.ogg", clip(60), { forceMode: () => "decode" })).toBe("decode");
    expect(stemMode("music/short.ogg", clip(10), { forceMode: () => "stream" })).toBe("stream");
    expect(stemMode("music/short.ogg", clip(10), { forceMode: () => undefined })).toBe("decode");
  });

  it("L-F3a a stem forced to decode over 30 s: decodedTooLong", () => {
    const s = seg("s", [track("l", "music/long.ogg")]);
    const forced = rowsOf(validateSegment(s, facts, { forceMode: () => "decode" }), "decodedTooLong");
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({ severity: "warn", segment: "s", track: "l", clip: "music/long.ogg" });
    // Control: not forced, the 60 s stem streams and nothing is decoded too long.
    expect(rowsOf(validateSegment(s, facts), "decodedTooLong")).toEqual([]);
    // Control: exactly 30 s forced to decode is within the limit.
    const at30 = seg("s", [track("e", "music/edge-30s.ogg")]);
    expect(rowsOf(validateSegment(at30, facts, { forceMode: () => "decode" }), "decodedTooLong")).toEqual([]);
  });

  it("L-F3a a silent stem: silentStem; unknown silence is never reported", () => {
    const silent = rowsOf(validateSegment(seg("s", [track("q", "music/silent.ogg")]), facts), "silentStem");
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ severity: "warn", segment: "s", track: "q" });
    expect(rowsOf(validateSegment(seg("s", [track("q", "music/audible.ogg")]), facts), "silentStem")).toEqual([]);
    // `silent` absent in the facts: unknown, never reported.
    expect(rowsOf(validateSegment(seg("s", [track("q", "music/short.ogg")]), facts), "silentStem")).toEqual([]);
  });
});

describe("validateMusic: peak ring need and never-fits (L-F3a)", () => {
  it("L-F3a a segment of decoded stems needs 0 rings on any preset, rings 0 included", () => {
    const s = seg("s", decodedTracks(3));
    for (const preset of ["low", "default", "high"] as const) {
      const v = validateSegment(s, facts, { preset });
      expect(v.peakRings).toBe(0);
      expect(v.neverFits).toEqual([]);
    }
    const zero = validateSegment(s, facts, { rings: 0 });
    expect(zero.peakRings).toBe(0);
    expect(zero.neverFits).toEqual([]);
  });

  it("L-F3a a streamed segment alone needs its streamed stems only (decoded stems of the same segment cost nothing)", () => {
    const s = seg("s", [...streamedTracks(2), track("d", "music/short.ogg")]);
    expect(segmentRingNeed(s, facts).rings).toBe(2);
    expect(validateSegment(s, facts).peakRings).toBe(2);
  });

  it("L-F3a A to B: the need is streamed(A) + streamed(B); a decoded B adds nothing", () => {
    const a = seg("A", streamedTracks(2, "a"));
    const b = seg("B", [...streamedTracks(1, "b"), ...decodedTracks(2, "d")]);
    const v = validateMusic({ segments: [a, b], edges: [{ from: "A", to: "B" }] }, facts);
    const seams = seamsOf(v);
    expect(seams).toHaveLength(1);
    expect(seams[0]).toMatchObject({ segments: ["A", "B"], rings: 3 });
    expect(v.peakRings).toBe(3);
  });

  it("L-F3a A to a decoded bridge to B: max(A, B) streamed, not their sum; a streamed bridge adds to both ends", () => {
    const a = seg("A", streamedTracks(3, "a"));
    const b = seg("B", streamedTracks(2, "b"));
    const edges = [{ from: "A", to: "B", bridge: "br" }];
    // Decoded bridge (20 s): max(3 + 0, 0 + 2) = 3, not 5.
    const decodedBridge = validateMusic({ segments: [a, b], library: [seg("br", [track("x", "music/bridge.ogg")])], edges }, facts);
    const dBridge = decodedBridge.needs.filter((n) => n.kind === "bridge");
    expect(dBridge).toHaveLength(1);
    expect(dBridge[0].rings).toBe(3);
    expect(decodedBridge.peakRings).toBe(3);
    // Streamed bridge (60 s): max(3 + 1, 1 + 2) = 4.
    const streamedBridge = validateMusic({ segments: [a, b], library: [seg("br", [track("x", "music/bridge-long.ogg")])], edges }, facts);
    const sBridge = streamedBridge.needs.filter((n) => n.kind === "bridge");
    expect(sBridge).toHaveLength(1);
    expect(sBridge[0].rings).toBe(4);
    expect(streamedBridge.peakRings).toBe(4);
  });

  it("L-F3a a loop tail on streamed stems doubles them at the wrap; a decoded tail costs nothing", () => {
    const withTail = seg("s", streamedTracks(2), { regions: [loop({ tailBeats: 4 })] });
    expect(segmentRingNeed(withTail, facts).rings).toBe(4);
    // Control: the same region without a tail.
    expect(segmentRingNeed(seg("s", streamedTracks(2), { regions: [loop()] }), facts).rings).toBe(2);
    const decodedTail = seg("s", decodedTracks(2), { regions: [loop({ tailBeats: 4 })] });
    expect(segmentRingNeed(decodedTail, facts).rings).toBe(0);
  });

  it("L-F3a a streamed stem with alternatives adds one ring at the wrap hand-over; a decoded one adds none", () => {
    const streamedAlt = [track("t", "music/long.ogg", { alternatives: ["music/long-b.ogg"] })];
    const decodedAlt = [track("t", "music/short.ogg", { alternatives: ["music/short-b.ogg"] })];
    // A looping region is the wrap: one stem's hand-over adds one ring.
    expect(segmentRingNeed(seg("s", streamedAlt, { regions: [loop()] }), facts).rings).toBe(2);
    // Control: no looping region, no hand-over at a wrap.
    expect(segmentRingNeed(seg("s", streamedAlt), facts).rings).toBe(1);
    expect(segmentRingNeed(seg("s", decodedAlt, { regions: [loop()] }), facts).rings).toBe(0);
  });

  it("L-F3a a stinger streamed over a playing segment adds its stems", () => {
    const a = seg("A", streamedTracks(2, "a"));
    const stinger = seg("S", streamedTracks(1, "x"));
    expect(validateMusic({ segments: [a], library: [stinger], stingers: ["S"] }, facts).peakRings).toBe(3);
    // Control: the stinger is in the library but not over the segment.
    expect(validateMusic({ segments: [a], library: [stinger] }, facts).peakRings).toBe(2);
  });

  it("L-F3a a need above the pool: neverFits warning 'needs N rings; this preset has M', the segments listed in `neverFits`", () => {
    const v = validateSegment(seg("big", streamedTracks(13)), facts);
    expect(v.neverFits).toEqual(["big"]);
    const rows = rowsOf(v, "neverFits");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warn" });
    expect(rows[0].message).toContain("needs 13 rings; this preset has 12");
    // A pair over the pool lists both segments.
    const a = seg("A", streamedTracks(2, "a"));
    const b = seg("B", streamedTracks(2, "b"));
    const pair = validateMusic({ segments: [a, b], edges: [{ from: "A", to: "B" }] }, facts, { rings: 3 });
    expect(pair.neverFits.slice().sort()).toEqual(["A", "B"]);
  });

  it("L-F3a the same graph fits on high (16) and not on low (8); rings 0 refuses any streamed stem", () => {
    const ten = seg("ten", streamedTracks(10));
    expect(validateSegment(ten, facts, { preset: "high" }).neverFits).toEqual([]);
    const low = validateSegment(ten, facts, { preset: "low" });
    expect(low.neverFits).toEqual(["ten"]);
    expect(rowsOf(low, "neverFits")[0].message).toContain("needs 10 rings; this preset has 8");
    const one = seg("one", streamedTracks(1));
    const none = validateSegment(one, facts, { rings: 0 });
    expect(none.neverFits).toEqual(["one"]);
    expect(rowsOf(none, "neverFits")[0].message).toContain("needs 1 rings; this preset has 0");
  });

  it("L-F3a edges absent: every ordered pair of segments is walked; edges given: only those", () => {
    const a = seg("A", streamedTracks(2, "a"));
    const b = seg("B", streamedTracks(2, "b"));
    const c = seg("C", streamedTracks(2, "c"));
    const all = validateMusic({ segments: [a, b, c] }, facts);
    const seams = seamsOf(all);
    expect(seams).toHaveLength(6);
    expect(seams.map((n) => n.segments.join(">")).sort()).toEqual(["A>B", "A>C", "B>A", "B>C", "C>A", "C>B"]);
    const some = validateMusic({ segments: [a, b, c], edges: [{ from: "A", to: "B" }] }, facts);
    expect(seamsOf(some).map((n) => n.segments)).toEqual([["A", "B"]]);
  });
});

describe("validateMusic: loops, tails and cues (L-F3a)", () => {
  it("L-F3a a region's tailBeats longer than its loop: tailLongerThanLoop; shorter or equal: none", () => {
    // The loop 1:1:0 to 2:1:0 is 4 beats in 4/4.
    const region = (tailBeats: number) =>
      seg("s", decodedTracks(1), { regions: [loop({ id: "r", to: "2:1:0", tailBeats })] });
    const over = rowsOf(validateSegment(region(8), facts), "tailLongerThanLoop");
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ severity: "warn", segment: "s", item: "r" });
    expect(rowsOf(validateSegment(region(4), facts), "tailLongerThanLoop")).toEqual([]);
    expect(rowsOf(validateSegment(region(3), facts), "tailLongerThanLoop")).toEqual([]);
  });

  it("L-F3a a cue past the audio (by more than one frame): cueBeyondAudio; `end` and a cue at the last frame: none", () => {
    // A 2 s clip: bar 3 beat 1 at 120 bpm is 4 s, past the end; bar 2 beat 1 is exactly 2 s, the last frame.
    const cue = (at: string) => seg("s", [track("t", "music/cue-2s.ogg")], { cues: [{ name: "hit", at }] });
    const past = rowsOf(validateSegment(cue("3:1:0"), facts), "cueBeyondAudio");
    expect(past).toHaveLength(1);
    expect(past[0]).toMatchObject({ severity: "warn", segment: "s", item: "hit" });
    expect(rowsOf(validateSegment(cue("2:1:0"), facts), "cueBeyondAudio")).toEqual([]);
    expect(rowsOf(validateSegment(cue("end"), facts), "cueBeyondAudio")).toEqual([]);
  });

  it("L-F3a a tempo change before the cue moves it in seconds (the cue is checked on the compiled time)", () => {
    // Bar 3 beat 1 with a 120 bpm bar and then 60 bpm from bar 2: 2 s + 4 beats at 60 bpm = 6 s, past a 5 s clip.
    const tempo = [
      { at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 },
      { at: "2:1:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 },
    ];
    const moved = seg("s", [track("t", "music/five-s.ogg")], { tempo, cues: [{ name: "hit", at: "3:1:0" }] });
    expect(rowsOf(validateSegment(moved, facts), "cueBeyondAudio")).toHaveLength(1);
    // Control: one tempo, bar 3 beat 1 is 4 s, inside the clip.
    const flat = seg("s", [track("t", "music/five-s.ogg")], { cues: [{ name: "hit", at: "3:1:0" }] });
    expect(rowsOf(validateSegment(flat, facts), "cueBeyondAudio")).toEqual([]);
  });
});

describe("validateMusic: facts and totality (L-F3a)", () => {
  it("L-F3a a clip with no facts: one unknownClip warning per clip, other rows of that stem skipped", () => {
    const s = seg("s", [
      track("m", "music/missing.ogg"),
      track("m2", "music/missing.ogg"),
      track("a", "music/short.ogg"),
      track("b", "music/short-b.ogg"),
    ]);
    const v = validateMusic({ segments: [s] }, facts);
    const rows = rowsOf(v, "unknownClip");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warn", clip: "music/missing.ogg" });
    // The unknown stem is skipped by the length rows: the other two are the same length.
    expect(rowsOf(v, "stemLengthMismatch")).toEqual([]);
    expect(rowsOf(v, "stemLengthTrimmed")).toEqual([]);
    expect(v.refused).toEqual([]);
  });

  it("L-F3a a segment with no tracks reports nothing; the input is not mutated; the result is deterministic", () => {
    const empty: MusicGraph = { segments: [emptySegment("empty")] };
    const emptySnap = JSON.parse(JSON.stringify(empty)) as MusicGraph;
    const v = validateMusic(empty, facts);
    expect(v.issues).toEqual([]);
    expect(v.refused).toEqual([]);
    expect(v.neverFits).toEqual([]);
    expect(v.peakRings).toBe(0);
    expect(empty).toEqual(emptySnap);

    const busy: MusicGraph = {
      segments: [seg("s", [track("a", "music/short.ogg"), track("b", "music/long.ogg"), track("m", "music/missing.ogg")])],
    };
    const busySnap = JSON.parse(JSON.stringify(busy)) as MusicGraph;
    expect(validateMusic(busy, facts)).toEqual(validateMusic(busy, facts));
    expect(busy).toEqual(busySnap);
  });
});
