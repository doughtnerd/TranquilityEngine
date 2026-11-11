// Tests for importHints.ts (leaf L-Ed9 un-skips and fills these). Fixtures are built from the documented layouts in
// importHintsFixtures.ts; each skipped case names what it must check.
import { describe, it } from "vitest";
// import { ... } from "./importHints";
// import { acidBody, adtlBody, chunk, cueBody, dataChunk, fmtChunk, oggVorbis, smplBody, wav } from "./importHintsFixtures";

describe("readAcid", () => {
  it.skip("reads tempo 128 bpm, 16 beats, 4/4 and the one-shot flag from a 24-byte body", () => {});
  it.skip("reads a 3/4 metre (numerator 3, denominator 4) and a fractional tempo (f32 rounding to within 1e-4)", () => {});
  it.skip("returns null for a body under 24 bytes, a zero, negative, NaN or infinite tempo", () => {});
});

describe("readCuePoints and readAdtlLabels", () => {
  it.skip("reads ids and sample offsets of three cue records in file order", () => {});
  it.skip("reads only whole records when the count overstates the body, and [] for a body under 4 bytes", () => {});
  it.skip("reads labl labels (NUL-terminated and not), falls back to note, first label of an id wins, skips ltxt", () => {});
  it.skip("returns what was read so far when a sub-chunk runs past the adtl body, and an empty map for a non-adtl body", () => {});
});

describe("readSmplLoops", () => {
  it.skip("returns every loop with end made exclusive, in file order, any type", () => {});
  it.skip("skips end < start and end = 0xFFFFFFFF, reads at most numSampleLoops, whole records only", () => {});
  it.skip("returns [] for a body under 36 bytes or a zero loop count", () => {});
});

describe("readWavHints", () => {
  it.skip("reads rate and frames from fmt and data, and acid, cue with labels, and smpl from one file", () => {});
  it.skip("handles odd-sized chunks (pad byte) before the hint chunks", () => {});
  it.skip("takes the first acid, cue and smpl when repeated", () => {});
  it.skip("a chunk running past the end of the file ends the walk and keeps what came before", () => {});
  it.skip("returns empty cues and loops for a non-RIFF input, RIFX, and a RIFF that is not WAVE", () => {});
});

describe("commentHints and readOggHints", () => {
  it.skip("reads BPM, LOOPSTART and LOOPLENGTH from an Ogg Vorbis fixture (oggVorbis helper)", () => {});
  it.skip("matches keys case-insensitively, first key wins, trims whitespace, accepts a fractional BPM", () => {});
  it.skip("drops a bad BPM (0, negative, text, 1e3, NaN) and a bad loop (missing key, zero length, sum over u32, sign)", () => {});
  it.skip("loop equals commentLoopPoints of the same comments", () => {});
  it.skip("returns {} for an Ogg with no comment header or a truncated one", () => {});
});

describe("readImportHints", () => {
  it.skip("dispatches RIFF to wav, OggS to ogg, and MP3 bytes, empty and garbage to none", () => {});
  it.skip("never throws on any prefix of a valid WAV and a valid Ogg fixture", () => {});
});
