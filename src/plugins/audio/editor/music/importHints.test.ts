// Tests for importHints.ts (leaf L-Ed9 un-skips and fills these). Fixtures are built from the documented layouts in
// importHintsFixtures.ts; each skipped case names what it must check.
import { describe, expect, it } from "vitest";
import { commentLoopPoints } from "../../runtime/loopPointsReader";
import {
  commentHints,
  readAcid,
  readAdtlLabels,
  readCuePoints,
  readImportHints,
  readOggHints,
  readSmplLoops,
  readWavHints,
} from "./importHints";
import { acidBody, adtlBody, chunk, concat, cueBody, dataChunk, fmtChunk, oggVorbis, smplBody, u32, wav } from "./importHintsFixtures";

const txt = (s: string): Uint8Array => new TextEncoder().encode(s);
const acidChunk = (bpm: number, beats = 16): Uint8Array =>
  chunk("acid", acidBody({ flags: 1, beats, numerator: 4, denominator: 4, bpm }));

describe("readAcid", () => {
  it("reads tempo 128 bpm, 16 beats, 4/4 and the one-shot flag from a 24-byte body", () => {
    const body = acidBody({ flags: 1, beats: 16, numerator: 4, denominator: 4, bpm: 128 });
    expect(body.length).toBe(24);
    expect(readAcid(body)).toEqual({ bpm: 128, beats: 16, meterNumerator: 4, meterDenominator: 4, oneShot: true });
  });

  it("reads a 3/4 metre (numerator 3, denominator 4) and a fractional tempo (f32 rounding to within 1e-4)", () => {
    const hint = readAcid(acidBody({ flags: 0, numerator: 3, denominator: 4, bpm: 127.3 }));
    expect(hint).not.toBeNull();
    expect(hint!.meterNumerator).toBe(3);
    expect(hint!.meterDenominator).toBe(4);
    expect(hint!.oneShot).toBe(false);
    expect(Math.abs(hint!.bpm - 127.3)).toBeLessThan(1e-4);
  });

  it("returns null for a body under 24 bytes, a zero, negative, NaN or infinite tempo", () => {
    expect(readAcid(acidBody({ bpm: 120 }).subarray(0, 23))).toBeNull();
    expect(readAcid(acidBody({ bpm: 0 }))).toBeNull();
    expect(readAcid(acidBody({ bpm: -120 }))).toBeNull();
    expect(readAcid(acidBody({ bpm: NaN }))).toBeNull();
    expect(readAcid(acidBody({ bpm: Infinity }))).toBeNull();
  });
});

describe("readCuePoints and readAdtlLabels", () => {
  it("reads ids and sample offsets of three cue records in file order", () => {
    const points = readCuePoints(
      cueBody([
        { id: 3, frame: 0 },
        { id: 1, frame: 44100 },
        { id: 2, frame: 88200 },
      ]),
    );
    expect(points).toEqual([
      { id: 3, frame: 0 },
      { id: 1, frame: 44100 },
      { id: 2, frame: 88200 },
    ]);
  });

  it("reads only whole records when the count overstates the body, and [] for a body under 4 bytes", () => {
    const record = cueBody([{ id: 7, frame: 99 }]).subarray(4);
    expect(readCuePoints(concat([u32(5), record, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]))).toEqual([{ id: 7, frame: 99 }]);
    expect(readCuePoints(concat([u32(5), record, record]))).toEqual([
      { id: 7, frame: 99 },
      { id: 7, frame: 99 },
    ]);
    expect(readCuePoints(new Uint8Array(3))).toEqual([]);
  });

  it("reads labl labels (NUL-terminated and not), falls back to note, first label of an id wins, skips ltxt", () => {
    const body = concat([
      txt("adtl"),
      chunk("labl", concat([u32(1), txt("Intro"), [0]])),
      chunk("labl", concat([u32(3), txt("Hook")])),
      chunk("note", concat([u32(2), txt("Drop"), [0]])),
      chunk("note", concat([u32(3), txt("Ignored")])),
      chunk("labl", concat([u32(1), txt("Again")])),
      chunk("ltxt", concat([u32(4), u32(100), txt("LTXT")])),
    ]);
    const labels = readAdtlLabels(body);
    expect([...labels.entries()]).toEqual([
      [1, "Intro"],
      [3, "Hook"],
      [2, "Drop"],
    ]);
  });

  it("returns what was read so far when a sub-chunk runs past the adtl body, and an empty map for a non-adtl body", () => {
    const body = concat([
      txt("adtl"),
      chunk("labl", concat([u32(1), txt("Ok"), [0]])),
      txt("labl"),
      u32(200),
      [1, 2],
    ]);
    expect([...readAdtlLabels(body).entries()]).toEqual([[1, "Ok"]]);
    const notAdtl = concat([txt("INFO"), chunk("labl", concat([u32(1), txt("Nope"), [0]]))]);
    expect(readAdtlLabels(notAdtl).size).toBe(0);
  });
});

describe("readSmplLoops", () => {
  it("returns every loop with end made exclusive, in file order, any type", () => {
    const loops = readSmplLoops(
      smplBody([
        { type: 0, start: 0, end: 99, playCount: 0 },
        { type: 1, start: 100, end: 199 },
        { type: 2, start: 200, end: 299, playCount: 3 },
      ]),
    );
    expect(loops).toEqual([
      { start: 0, end: 100, type: 0, playCount: 0 },
      { start: 100, end: 200, type: 1, playCount: 0 },
      { start: 200, end: 300, type: 2, playCount: 3 },
    ]);
  });

  it("skips end < start and end = 0xFFFFFFFF, reads at most numSampleLoops, whole records only", () => {
    const inverted = smplBody([
      { start: 50, end: 10 },
      { start: 0, end: 0xffffffff },
      { start: 5, end: 9 },
    ]);
    expect(readSmplLoops(inverted)).toEqual([{ start: 5, end: 10, type: 0, playCount: 0 }]);

    const overstated = smplBody([
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ]);
    overstated.set(u32(1), 28);
    expect(readSmplLoops(overstated)).toEqual([{ start: 0, end: 10, type: 0, playCount: 0 }]);

    const truncated = smplBody([
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ]);
    truncated.set(u32(5), 28);
    expect(readSmplLoops(truncated.subarray(0, truncated.length - 10))).toEqual([{ start: 0, end: 10, type: 0, playCount: 0 }]);
  });

  it("returns [] for a body under 36 bytes or a zero loop count", () => {
    expect(readSmplLoops(smplBody([{ start: 0, end: 9 }]).subarray(0, 35))).toEqual([]);
    expect(readSmplLoops(smplBody([]))).toEqual([]);
  });
});

describe("readWavHints", () => {
  it("reads rate and frames from fmt and data, and acid, cue with labels, and smpl from one file", () => {
    const file = wav([
      fmtChunk(44100),
      dataChunk(10),
      acidChunk(128, 16),
      chunk("cue ", cueBody([{ id: 1, frame: 0 }, { id: 2, frame: 44100 }])),
      chunk("LIST", adtlBody([{ id: 1, text: "Intro" }, { id: 2, text: "Drop", kind: "note" }])),
      chunk("smpl", smplBody([{ start: 0, end: 99 }])),
    ]);
    const hints = readWavHints(file);
    expect(hints.rate).toBe(44100);
    expect(hints.frames).toBe(10);
    expect(hints.acid).toEqual({ bpm: 128, beats: 16, meterNumerator: 4, meterDenominator: 4, oneShot: true });
    expect(hints.cues).toEqual([
      { id: 1, frame: 0, label: "Intro" },
      { id: 2, frame: 44100, label: "Drop" },
    ]);
    expect(hints.loops).toEqual([{ start: 0, end: 100, type: 0, playCount: 0 }]);
  });

  it("handles odd-sized chunks (pad byte) before the hint chunks", () => {
    const file = wav([chunk("junk", [1, 2, 3]), fmtChunk(48000), dataChunk(8), acidChunk(90)]);
    const hints = readWavHints(file);
    expect(hints.rate).toBe(48000);
    expect(hints.frames).toBe(8);
    expect(hints.acid?.bpm).toBe(90);
  });

  it("takes the first acid, cue and smpl when repeated", () => {
    const file = wav([
      acidChunk(120),
      acidChunk(90),
      chunk("cue ", cueBody([{ id: 1, frame: 5 }])),
      chunk("cue ", cueBody([{ id: 2, frame: 9 }])),
      chunk("smpl", smplBody([{ start: 0, end: 9 }])),
      chunk("smpl", smplBody([{ start: 20, end: 29 }])),
    ]);
    const hints = readWavHints(file);
    expect(hints.acid?.bpm).toBe(120);
    expect(hints.cues).toEqual([{ id: 1, frame: 5, label: "" }]);
    expect(hints.loops).toEqual([{ start: 0, end: 10, type: 0, playCount: 0 }]);
  });

  it("a chunk running past the end of the file ends the walk and keeps what came before", () => {
    const overrun = concat([txt("smpl"), u32(1000), [1, 2, 3]]);
    const file = wav([fmtChunk(44100), dataChunk(4), acidChunk(100), overrun]);
    const hints = readWavHints(file);
    expect(hints.rate).toBe(44100);
    expect(hints.frames).toBe(4);
    expect(hints.acid?.bpm).toBe(100);
    expect(hints.loops).toEqual([]);

    // A data chunk declaring more bytes than the file holds counts the frames it has.
    const shortData = wav([fmtChunk(44100), concat([txt("data"), u32(1000), new Uint8Array(40)])]);
    expect(readWavHints(shortData).frames).toBe(10);
  });

  it("returns empty cues and loops for a non-RIFF input, RIFX, and a RIFF that is not WAVE", () => {
    const valid = wav([fmtChunk(44100), chunk("smpl", smplBody([{ start: 0, end: 9 }]))]);
    const rifx = valid.slice();
    rifx.set(txt("RIFX"), 0);
    const notWave = valid.slice();
    notWave.set(txt("AVI "), 8);
    for (const bytes of [new Uint8Array([1, 2, 3]), rifx, notWave]) {
      expect(readWavHints(bytes)).toEqual({ cues: [], loops: [] });
    }
  });
});

describe("commentHints and readOggHints", () => {
  it("reads BPM, LOOPSTART and LOOPLENGTH from an Ogg Vorbis fixture (oggVorbis helper)", () => {
    const hints = readOggHints(oggVorbis(["BPM=128.5", "LOOPSTART=100", "LOOPLENGTH=50"]));
    expect(hints).toEqual({ bpm: 128.5, loop: { start: 100, end: 150 } });
  });

  it("matches keys case-insensitively, first key wins, trims whitespace, accepts a fractional BPM", () => {
    expect(commentHints([["bpm", " 120 "]])).toEqual({ bpm: 120 });
    expect(commentHints([["Bpm", "\t128.5\n"]])).toEqual({ bpm: 128.5 });
    expect(commentHints([["BPM", "90"], ["bpm", "120"]])).toEqual({ bpm: 90 });
    // The first BPM wins even when its value does not parse.
    expect(commentHints([["BPM", "abc"], ["BPM", "120"]])).toEqual({});
    expect(commentHints([["loopstart", " 4 "], ["LoopLength", "8"]])).toEqual({ loop: { start: 4, end: 12 } });
  });

  it("drops a bad BPM (0, negative, text, 1e3, NaN) and a bad loop (missing key, zero length, sum over u32, sign)", () => {
    for (const bad of ["0", "0.0", "-120", "abc", "1e3", "NaN", "+120", "128.", ".5", "9".repeat(400)]) {
      expect(commentHints([["BPM", bad]])).toEqual({});
    }
    expect(commentHints([["LOOPSTART", "0"]])).toEqual({});
    expect(commentHints([["LOOPSTART", "0"], ["LOOPLENGTH", "0"]])).toEqual({});
    expect(commentHints([["LOOPSTART", "4294967290"], ["LOOPLENGTH", "10"]])).toEqual({});
    expect(commentHints([["LOOPSTART", "-5"], ["LOOPLENGTH", "10"]])).toEqual({});
    expect(commentHints([["LOOPSTART", "+5"], ["LOOPLENGTH", "10"]])).toEqual({});
    expect(commentHints([["LOOPSTART", "1"], ["LOOPLENGTH", "4294967296"]])).toEqual({});
    // The exact top of u32 is allowed.
    expect(commentHints([["LOOPSTART", "4294967294"], ["LOOPLENGTH", "1"]])).toEqual({
      loop: { start: 4294967294, end: 4294967295 },
    });
  });

  it("loop equals commentLoopPoints of the same comments", () => {
    const lists: [string, string][][] = [
      [["LOOPSTART", "100"], ["LOOPLENGTH", "50"]],
      [["loopstart", " 7 "], ["LOOPLENGTH", "3"], ["LOOPSTART", "9"]],
      [["LOOPSTART", "0"], ["LOOPLENGTH", "0"]],
      [["LOOPSTART", "x"], ["LOOPLENGTH", "3"]],
      [["LOOPSTART", "4294967290"], ["LOOPLENGTH", "10"]],
      [["LOOPLENGTH", "3"]],
    ];
    for (const comments of lists) {
      expect(commentHints(comments).loop ?? null).toEqual(commentLoopPoints(comments));
    }
  });

  it("returns {} for an Ogg with no comment header or a truncated one", () => {
    const full = oggVorbis(["BPM=120"]);
    // The identification page alone: the comment page header is missing.
    expect(readOggHints(full.subarray(0, 58))).toEqual({});
    // The comment page starts but is cut short.
    expect(readOggHints(full.subarray(0, 58 + 20))).toEqual({});
    expect(readOggHints(new Uint8Array(0))).toEqual({});
    expect(readOggHints(txt("OggS garbage"))).toEqual({});
  });
});

describe("readImportHints", () => {
  it("dispatches RIFF to wav, OggS to ogg, and MP3 bytes, empty and garbage to none", () => {
    const wavHints = readImportHints(wav([fmtChunk(44100)]));
    expect(wavHints.container).toBe("wav");
    expect(wavHints.wav?.rate).toBe(44100);

    const oggHints = readImportHints(oggVorbis(["BPM=100"]));
    expect(oggHints).toEqual({ container: "ogg", ogg: { bpm: 100 } });

    expect(readImportHints(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00]))).toEqual({ container: "none" });
    expect(readImportHints(new Uint8Array(0))).toEqual({ container: "none" });
    expect(readImportHints(txt("garbage bytes"))).toEqual({ container: "none" });
    expect(readImportHints(txt("RIFF1234AVI "))).toEqual({ container: "none" });
  });

  it("never throws on any prefix of a valid WAV and a valid Ogg fixture", () => {
    const file = wav([
      fmtChunk(44100),
      dataChunk(4),
      acidChunk(120),
      chunk("cue ", cueBody([{ id: 1, frame: 3 }])),
      chunk("LIST", adtlBody([{ id: 1, text: "A" }])),
      chunk("smpl", smplBody([{ start: 0, end: 9 }])),
    ]);
    const ogg = oggVorbis(["BPM=120", "LOOPSTART=1", "LOOPLENGTH=2"]);
    for (const source of [file, ogg]) {
      for (let n = 0; n <= source.length; n++) {
        const prefix = source.subarray(0, n);
        expect(() => readImportHints(prefix)).not.toThrow();
        expect(() => readWavHints(prefix)).not.toThrow();
        expect(() => readOggHints(prefix)).not.toThrow();
      }
    }
  });
});
