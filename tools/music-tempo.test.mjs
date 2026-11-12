// Tests for tools/music-tempo.mjs. Run: node --test tools/music-tempo.test.mjs
// (Vitest's include is src/**, so a tool test uses node:test; no config needed.)
import test from "node:test";
import assert from "node:assert/strict";
import { bpmFromLength, readWavLength, readTempoHint, parseArgs, run } from "./music-tempo.mjs";

/** A minimal PCM WAV: 16-bit mono, `frames` frames of silence, optional extra chunks before `data`. */
function wav({ rate = 44100, frames = 44100, extra = [] } = {}) {
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const tag = (s) => [...s].map((c) => c.charCodeAt(0));
  const fmt = [...tag("fmt "), ...u32(16), ...u16(1), ...u16(1), ...u32(rate), ...u32(rate * 2), ...u16(2), ...u16(16)];
  const data = [...tag("data"), ...u32(frames * 2), ...new Array(frames * 2).fill(0)];
  const body = [...tag("WAVE"), ...fmt, ...extra.flat(), ...data];
  return new Uint8Array([...tag("RIFF"), ...u32(body.length), ...body]);
}

test("skeleton exports exist", () => {
  for (const f of [bpmFromLength, readWavLength, readTempoHint, parseArgs, run]) assert.equal(typeof f, "function");
  assert.equal(wav().length, 12 + 24 + 8 + 88200);
});

test("bpmFromLength: 8 s, 4 bars of 4/4 is 120 bpm", { skip: "L-SM1a" }, () => {
  assert.equal(bpmFromLength(8, 4), 120);
  assert.equal(bpmFromLength(8, 4, 3), 90);
  assert.equal(bpmFromLength(0, 4), null);
  assert.equal(bpmFromLength(8, 0), null);
  assert.equal(bpmFromLength(NaN, 4), null);
});

test("readWavLength: frames, rate, seconds; garbage and truncation", { skip: "L-SM1a" }, () => {
  assert.deepEqual(readWavLength(wav({ rate: 44100, frames: 88200 })), { rate: 44100, frames: 88200, seconds: 2 });
  assert.equal(readWavLength(new Uint8Array([1, 2, 3])), null);
  assert.equal(readWavLength(wav().subarray(0, 30)), null);
});

test("readTempoHint: acid chunk and Ogg BPM tag", { skip: "L-SM1a" }, () => {
  const f32 = (x) => [...new Uint8Array(new Float32Array([x]).buffer)];
  const acid = [[...Buffer.from("acid"), 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, ...f32(120)].slice(0, 8 + 24)];
  // acid body offsets: tempo f32 at 20 (type, root, unk, unkf, beats, den, num, tempo)
  assert.equal(readTempoHint(wav({ extra: acid }))?.source, "acid");
  assert.equal(readTempoHint(Buffer.from("OggS....vorbis...BPM=96.5...")).bpm, 96.5);
  assert.equal(readTempoHint(wav()), null);
});

test("parseArgs and run: modes and errors", { skip: "L-SM1a" }, () => {
  assert.deepEqual(parseArgs(["--seconds", "8", "--bars", "4"]), { beatsPerBar: 4, seconds: 8, bars: 4, hints: false });
  assert.ok("error" in parseArgs(["--bogus"]));
  assert.ok("error" in parseArgs([]));
  assert.equal(run({ seconds: 8, bars: 4, beatsPerBar: 4, hints: false }).bpm, 120);
});
