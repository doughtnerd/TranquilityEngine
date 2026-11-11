import { describe, expect, it } from "vitest";
import { emptySegment, musicNodeToJson, parseMusicSegment } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts, MusicFactsLookup } from "../../../../engine/audio/musicValidate";
import { hasDefaultGrid, importClips, importDropped, stemNameFor, type ImportFile } from "./import";
import type { ImportHints } from "./importHints";
import { acidBody, adtlBody, chunk, cueBody, dataChunk, fmtChunk, oggVorbis, smplBody, wav } from "./importHintsFixtures";

const RATE = 48000;
const clip = (seconds: number, extra: Partial<MusicClipFacts> = {}): MusicClipFacts => ({ frames: seconds * RATE, rate: RATE, channels: 2, gapless: true, codec: "pcm", ...extra });
const factsOf = (m: Record<string, MusicClipFacts>): MusicFactsLookup => (p) => m[p];

// 120 bpm 4/4: a beat is 0.5 s, a bar 2 s.
const wavHints = (over: Partial<NonNullable<ImportHints["wav"]>> = {}): ImportHints => ({ container: "wav", wav: { rate: RATE, cues: [], loops: [], ...over } });

describe("stems", () => {
  it("adds one stem per file with unique names and lints them", () => {
    const r = importClips(emptySegment("a"), [{ path: "m/drums.wav" }, { path: "m/bass.wav" }, { path: "x/drums.ogg" }], factsOf({ "m/drums.wav": clip(8), "m/bass.wav": clip(8), "x/drums.ogg": clip(8) }));
    expect(r.segment.tracks.map((t) => t.name)).toEqual(["drums", "bass", "drums 2"]);
    expect(r.segment.tracks.map((t) => t.clip)).toEqual(["m/drums.wav", "m/bass.wav", "x/drums.ogg"]);
    expect(r.validation.issues).toEqual([]);
    expect(parseMusicSegment(musicNodeToJson(r.segment)).problems).toEqual([]);
  });

  it("does not mutate the input segment", () => {
    const seg = emptySegment("a");
    const before = JSON.stringify(seg);
    importClips(seg, [{ path: "a.wav" }], factsOf({}));
    expect(JSON.stringify(seg)).toBe(before);
  });

  it("skips duplicates and stems past 16", () => {
    const files: ImportFile[] = Array.from({ length: 17 }, (_, i) => ({ path: `s${i}.wav` }));
    const r = importClips(emptySegment("a"), [...files, { path: "s0.wav" }], factsOf({}));
    expect(r.segment.tracks).toHaveLength(16);
    expect(r.applied.skipped.map((s) => s.path)).toEqual(["s16.wav", "s0.wav"]);
  });

  it("adds alternatives to a named stem, and reports a missing one", () => {
    const base = importClips(emptySegment("a"), [{ path: "d1.wav" }], factsOf({})).segment;
    const r = importClips(base, [{ path: "d2.wav" }], factsOf({ "d1.wav": clip(8), "d2.wav": clip(9) }), { mode: { alternativeOf: "d1" } });
    expect(r.segment.tracks[0]!.alternatives).toEqual(["d2.wav"]);
    expect(r.validation.issues.map((i) => i.code)).toContain("alternativeLengthMismatch");
    const bad = importClips(base, [{ path: "d3.wav" }], factsOf({}), { mode: { alternativeOf: "nope" } });
    expect(bad.applied.skipped).toHaveLength(1);
  });

  it("stemNameFor cleans the file name", () => {
    expect(stemNameFor("a/b/Lead Synth (v2).wav", new Set())).toBe("Lead Synth _v2_");
    expect(stemNameFor("a/.wav", new Set())).toBe("stem");
  });
});

describe("lint on import (rows of 2.6)", () => {
  it("reports stems of unequal length, a refusal beyond 1,024 frames", () => {
    const r = importClips(emptySegment("a"), [{ path: "a.wav" }, { path: "b.wav" }], factsOf({ "a.wav": clip(8), "b.wav": clip(7) }));
    expect(r.validation.refused).toEqual(["a"]);
    expect(r.validation.issues.map((i) => i.code)).toContain("stemLengthMismatch");
  });

  it("reports rate, channels, a missing length header, a silent stem and unknown clips", () => {
    const r = importClips(
      emptySegment("a"),
      [{ path: "a.wav" }, { path: "b.mp3" }, { path: "c.wav" }, { path: "gone.wav" }],
      factsOf({
        "a.wav": clip(8),
        "b.mp3": { ...clip(8), rate: 44100, frames: 44100 * 8, channels: 1, gapless: false, codec: "mp3" },
        "c.wav": clip(8, { silent: true }),
      }),
    );
    const codes = r.validation.issues.map((i) => i.code);
    for (const c of ["stemRateMismatch", "stemChannelsMismatch", "noGapless", "silentStem", "unknownClip"]) expect(codes).toContain(c);
  });

  it("lints a streamed WAV on the low preset", () => {
    const r = importClips(emptySegment("a"), [{ path: "long.wav" }], factsOf({ "long.wav": clip(120) }), { preset: "low" });
    expect(r.validation.issues.map((i) => i.code)).toContain("flacOnLow");
  });

  it("lints a cue written from a hint that lies past the audio", () => {
    const hints = wavHints({ cues: [{ id: 1, frame: 20 * RATE, label: "late" }] });
    const r = importClips(emptySegment("a"), [{ path: "a.wav", hints }], factsOf({ "a.wav": clip(8) }));
    expect(r.segment.cues).toEqual([{ name: "late", at: "11:1:0" }]);
    expect(r.validation.issues.map((i) => i.code)).toContain("cueBeyondAudio");
  });
});

describe("hints written once", () => {
  const facts = factsOf({ "a.wav": clip(16), "b.wav": clip(16) });

  it("writes acid tempo and metre, snapped cues with labels, and a forever loop region", () => {
    const hints = wavHints({
      acid: { bpm: 90, beats: 24, meterNumerator: 3, meterDenominator: 4, oneShot: false },
      cues: [{ id: 2, frame: 2 * RATE, label: "" }, { id: 1, frame: Math.round(RATE * (60 / 90) * 3), label: "verse" }],
      loops: [{ start: Math.round(RATE * (60 / 90) * 3), end: 16 * RATE, type: 0, playCount: 0 }],
    });
    const r = importClips(emptySegment("a"), [{ path: "a.wav", hints }], facts);
    expect(r.segment.tempo).toEqual([{ at: "1:1:0", bpm: 90, beatsPerBar: 3, beatUnit: 4 }]);
    // 3 beats at 3/4 is bar 2; 2 s at 90 bpm is 3 beats too.
    expect(r.segment.cues.map((c) => c.at)).toEqual(["2:1:0", "2:1:0"]);
    expect(r.segment.cues.map((c) => c.name).sort()).toEqual(["cue 1", "verse"]);
    expect(r.segment.regions).toEqual([{ id: "loop", from: "2:1:0", to: "end", count: 0 }]);
    expect(r.applied.tempo?.from).toBe("a.wav");
    expect(parseMusicSegment(musicNodeToJson(r.segment)).problems).toEqual([]);
  });

  it("takes an Ogg BPM and loop pair", () => {
    const hints: ImportHints = { container: "ogg", ogg: { bpm: 120, loop: { start: 0, end: 4 * RATE } } };
    const r = importClips(emptySegment("a"), [{ path: "a.wav", hints }], facts);
    expect(r.segment.tempo[0]!.bpm).toBe(120);
    expect(r.segment.regions).toEqual([{ id: "loop", from: "start", to: "3:1:0", count: 0 }]);
  });

  it("keeps the default metre when the acid metre is not one the format holds", () => {
    const hints = wavHints({ acid: { bpm: 100, beats: 0, meterNumerator: 0, meterDenominator: 3, oneShot: false } });
    const r = importClips(emptySegment("a"), [{ path: "a.wav", hints }], facts);
    expect(r.segment.tempo[0]).toMatchObject({ bpm: 100, beatsPerBar: 4, beatUnit: 4 });
  });

  it("uses the first file that has hints and ignores the rest", () => {
    const first = wavHints({ acid: { bpm: 100, beats: 0, meterNumerator: 4, meterDenominator: 4, oneShot: false } });
    const second = wavHints({ acid: { bpm: 140, beats: 0, meterNumerator: 4, meterDenominator: 4, oneShot: false } });
    const r = importClips(emptySegment("a"), [{ path: "a.wav", hints: { container: "none" } }, { path: "b.wav", hints: first }, { path: "c.wav", hints: second }], facts);
    expect(r.segment.tempo[0]!.bpm).toBe(100);
  });

  it("never overwrites a segment the author has shaped", () => {
    const seg = { ...emptySegment("a"), cues: [{ name: "mine", at: "2:1:0" }] };
    expect(hasDefaultGrid(seg)).toBe(false);
    const hints = wavHints({ acid: { bpm: 90, beats: 0, meterNumerator: 4, meterDenominator: 4, oneShot: false } });
    const r = importClips(seg, [{ path: "a.wav", hints }], facts);
    expect(r.segment.tempo[0]!.bpm).toBe(120);
    expect(r.segment.cues).toEqual(seg.cues);
  });

  it("writes nothing for a file that was skipped", () => {
    const seg = importClips(emptySegment("a"), [{ path: "a.wav" }], facts).segment;
    const hints = wavHints({ acid: { bpm: 90, beats: 0, meterNumerator: 4, meterDenominator: 4, oneShot: false } });
    const r = importClips(seg, [{ path: "a.wav", hints }], facts);
    expect(r.segment.tempo[0]!.bpm).toBe(120);
  });
});

describe("from real file bytes (needs the L-Ed9 readers)", () => {
  it("reads a WAV with acid, cue, labl and smpl, and an Ogg with comments", async () => {
    const file = wav([
      fmtChunk(RATE), dataChunk(RATE * 8),
      chunk("acid", acidBody({ bpm: 120, beats: 16, numerator: 4, denominator: 4 })),
      chunk("cue ", cueBody([{ id: 1, frame: RATE * 2 }])),
      chunk("LIST", adtlBody([{ id: 1, text: "drop" }])),
      chunk("smpl", smplBody([{ start: RATE * 2, end: RATE * 8 - 1 }])),
    ]);
    const ogg = oggVorbis(["BPM=100", "LOOPSTART=0", "LOOPLENGTH=96000"]);
    const files: Record<string, Uint8Array> = { "a.wav": file, "b.ogg": ogg };
    const facts = factsOf({ "a.wav": clip(8), "b.ogg": clip(8, { codec: "vorbis" }) });
    const r = await importDropped(emptySegment("a"), ["a.wav"], async (p) => files[p], facts);
    expect(r.segment.cues).toEqual([{ name: "drop", at: "2:1:0" }]);
    expect(r.segment.regions).toEqual([{ id: "loop", from: "2:1:0", to: "end", count: 0 }]);
    const o = await importDropped(emptySegment("a"), ["b.ogg"], async (p) => files[p], facts);
    expect(o.segment.tempo[0]!.bpm).toBe(100);
    expect(o.segment.regions).toEqual([{ id: "loop", from: "start", to: "2:2:0", count: 0 }]);
  });

  it("a failing read means no hints, not a failed import", async () => {
    const r = await importDropped(emptySegment("a"), ["a.wav"], async () => { throw new Error("nope"); }, factsOf({}));
    expect(r.segment.tracks).toHaveLength(1);
  });
});
