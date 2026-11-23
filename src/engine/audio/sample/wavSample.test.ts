import { describe, expect, it } from "vitest";
import { parseSampleEdits } from "./format";
import { readWavMetadata, writeWavMetadata, type WavMetadata } from "./wavChunks";
import { refreshFileSnapshots, sampleEditsFromWav, wavEditFromSample } from "./wavSample";

const meta = (over: Partial<WavMetadata>): WavMetadata => ({ sampleRate: 48000, frames: 48000 * 4, channels: 1, cues: [], regions: [], loops: [], root: null, tempo: null, bext: null, ...over });

/** A minimal WAV: 16-bit mono at 48 kHz, `frames` frames of silence. */
function bareWav(frames: number): Uint8Array {
  const dataBytes = frames * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 48000, true);
  v.setUint32(28, 96000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, dataBytes, true);
  return out;
}

describe("sampleEditsFromWav", () => {
  it("imports cues as notes, regions as ranges, smpl loops, tempo and root", () => {
    const parts = sampleEditsFromWav(meta({
      cues: [{ id: 2, frame: 72000, label: "", note: "late" }, { id: 1, frame: 24000, label: "Lock-up", note: "" }],
      regions: [{ id: 5, frame: 48000, length: 24000, label: "Creak", note: "", purpose: "rgn ", text: "" }],
      loops: [{ cueId: 0, type: 1, start: 96000, end: 144000, fraction: 0, playCount: 2 }, { cueId: 1, type: 0, start: 100000, end: 110000, fraction: 0, playCount: 0 }],
      root: { midiNote: 48, cents: 10 },
      tempo: { bpm: 120, beats: 8, meterNumerator: 6, meterDenominator: 8, oneShot: false, rootNote: null },
    }));
    expect(parts.markers.map((m) => [m.id, m.name, m.at, m.end])).toEqual([["m1", "Lock-up", 0.5, undefined], ["m2", "Creak", 1, 1.5], ["m3", "Cue 2", 1.5, undefined]]);
    expect(parts.markers[1].file).toEqual({ chunk: "ltxt", id: 5, at: 1, end: 1.5, name: "Creak" });
    expect(parts.markers[2].note).toBe("late");
    expect(parts.loops).toHaveLength(1);
    expect(parts.loops[0]).toMatchObject({ id: "l1", start: 2, end: 3, direction: "pingPong", count: 2, active: "always", file: { chunk: "smpl", index: 0, start: 2, end: 3 } });
    expect(parts.tempo).toEqual({ bpm: 120, meter: "6/8", map: [], source: "file" });
    expect(parts.root).toEqual({ note: "C3", cents: 10, source: "file" });
    // What it gives is a valid sample block.
    const problems: string[] = [];
    parseSampleEdits({ ...parts }, "sample", problems);
    expect(problems).toEqual([]);
  });

  it("falls back to acid's root and gives nothing without a sample rate", () => {
    expect(sampleEditsFromWav(meta({ tempo: { bpm: 90, beats: 0, meterNumerator: 0, meterDenominator: 0, oneShot: true, rootNote: 62 } })).root?.note).toBe("D4");
    expect(sampleEditsFromWav(meta({ sampleRate: null, cues: [{ id: 1, frame: 1, label: "", note: "" }] })).markers).toEqual([]);
  });
});

describe("writing a sample to its WAV", () => {
  it("writes notes, loops, root and tempo, keeps other markers out, and refreshes the snapshots", () => {
    const edits = parseSampleEdits({
      kind: "loop",
      loops: [{ id: "a", start: 0.5, end: 1.5, direction: "backward", count: 3 }],
      markers: [
        { id: "n", type: "note", name: "Hit it", at: 0.25, note: "accent" },
        { id: "r", type: "note", name: "Tail", at: 2, end: 3 },
        { id: "x", type: "exit", at: 1 },
      ],
      root: { note: "A4", cents: -12 },
      tempo: { bpm: 120, meter: "3/4" },
    }, "sample", []);
    const file = bareWav(48000 * 4);
    const out = writeWavMetadata(file, wavEditFromSample(edits, 48000, 48000 * 4));
    const read = readWavMetadata(out);
    expect(read.cues).toEqual([{ id: 1, frame: 12000, label: "Hit it", note: "accent" }]);
    expect(read.regions).toEqual([{ id: 2, frame: 96000, length: 48000, label: "Tail", note: "", purpose: "rgn ", text: "" }]);
    expect(read.loops).toEqual([{ cueId: 0, type: 2, start: 24000, end: 72000, fraction: 0, playCount: 3 }]);
    expect(read.root?.midiNote).toBe(69);
    expect(read.root?.cents).toBeCloseTo(-12, 1);
    expect(read.tempo).toMatchObject({ bpm: 120, beats: 8, meterNumerator: 3, meterDenominator: 4, oneShot: false });

    const refreshed = refreshFileSnapshots(edits, read);
    expect(refreshed.loops[0].file).toEqual({ chunk: "smpl", index: 0, start: 0.5, end: 1.5, direction: "backward", count: 3 });
    expect(refreshed.markers.map((m) => m.file)).toEqual([
      { chunk: "cue", id: 1, at: 0.25, name: "Hit it" },
      null,
      { chunk: "ltxt", id: 2, at: 2, end: 3, name: "Tail" },
    ]);

    // Importing what was written gives the same notes and loops back.
    const back = sampleEditsFromWav(read);
    expect(back.markers.map((m) => [m.name, m.at, m.end])).toEqual([["Hit it", 0.25, undefined], ["Tail", 2, 3]]);
    expect(back.loops.map((l) => [l.start, l.end, l.direction, l.count])).toEqual([[0.5, 1.5, "backward", 3]]);
  });

  it("keeps a marker's file id when rewriting", () => {
    const edits = parseSampleEdits({ markers: [{ id: "n", type: "note", name: "A", at: 0.1, file: { chunk: "cue", id: 9, at: 0.1, name: "A" } }] }, "s", []);
    expect(wavEditFromSample(edits, 48000).cues).toEqual([{ id: 9, frame: 4800, label: "A", note: "" }]);
    expect(wavEditFromSample(edits, 48000).tempo).toBeNull();
  });
});
