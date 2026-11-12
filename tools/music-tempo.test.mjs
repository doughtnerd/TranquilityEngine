// Tests for tools/music-tempo.mjs. Run: node --test tools/music-tempo.test.mjs
// (Vitest's include is src/**, so a tool test uses node:test; no config needed.)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bpmFromLength, readWavLength, readTempoHint, parseArgs, run } from "./music-tempo.mjs";

const SCRIPT = fileURLToPath(new URL("./music-tempo.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "music-tempo-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** An `acid` chunk (header and 24-byte body) with the given tempo and numBeats. */
function acidChunk(tempo, beats = 8) {
  const f32 = (x) => [...new Uint8Array(new Float32Array([x]).buffer)];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const body = [...u32(1), 0, 0, 0, 0, 0, 0, 0, 0, ...u32(beats), 4, 0, 4, 0, ...f32(tempo)];
  return [...Buffer.from("acid"), 24, 0, 0, 0, ...body];
}

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

test("bpmFromLength: 8 s, 4 bars of 4/4 is 120 bpm", () => {
  assert.equal(bpmFromLength(8, 4), 120);
  assert.equal(bpmFromLength(8, 4, 3), 90);
  assert.equal(bpmFromLength(0, 4), null);
  assert.equal(bpmFromLength(8, 0), null);
  assert.equal(bpmFromLength(NaN, 4), null);
});

test("readWavLength: frames, rate, seconds; garbage and truncation", () => {
  assert.deepEqual(readWavLength(wav({ rate: 44100, frames: 88200 })), { rate: 44100, frames: 88200, seconds: 2 });
  assert.equal(readWavLength(new Uint8Array([1, 2, 3])), null);
  assert.equal(readWavLength(wav().subarray(0, 30)), null);
});

test("readTempoHint: acid chunk and Ogg BPM tag", () => {
  const f32 = (x) => [...new Uint8Array(new Float32Array([x]).buffer)];
  // acid chunk, 24-byte body: type u32, root u16, unk u16, unk f32, numBeats u32, meterDen u16, meterNum u16, tempo f32
  const acid = [[...Buffer.from("acid"), 24, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 4, 0, 4, 0, ...f32(120)]];
  assert.equal(readTempoHint(wav({ extra: acid }))?.source, "acid");
  assert.equal(readTempoHint(Buffer.from("OggS....vorbis...BPM=96.5...")).bpm, 96.5);
  assert.equal(readTempoHint(wav()), null);
});

test("parseArgs and run: modes and errors", () => {
  assert.deepEqual(parseArgs(["--seconds", "8", "--bars", "4"]), { beatsPerBar: 4, seconds: 8, bars: 4, hints: false });
  assert.ok("error" in parseArgs(["--bogus"]));
  assert.ok("error" in parseArgs([]));
  assert.equal(run({ seconds: 8, bars: 4, beatsPerBar: 4, hints: false }).bpm, 120);
});

test("bpmFromLength: no rounding; null when the result is not finite", () => {
  assert.equal(bpmFromLength(7, 3), (3 * 4 * 60) / 7);
  assert.equal(bpmFromLength(1e-320, 4), null);
  assert.equal(bpmFromLength(8, 4, 0), null);
});

test("readWavLength: odd chunks are padded; truncated data counts present bytes", () => {
  const full = wav({ frames: 44100 });
  // an odd-sized chunk before `data` is followed by one pad byte
  assert.equal(readWavLength(wav({ frames: 44100, extra: [[...Buffer.from("junk"), 3, 0, 0, 0, 1, 2, 3, 0]] }))?.frames, 44100);
  assert.deepEqual(readWavLength(full.subarray(0, full.length - 1000)), { rate: 44100, frames: 43600, seconds: 43600 / 44100 });
  assert.equal(readWavLength(full.subarray(0, full.length - 1))?.frames, 44099);
  assert.equal(readWavLength(full.subarray(0, 36)), null, "no data chunk");
  assert.equal(readWavLength(wav({ rate: 0, frames: 10 })), null, "rate 0");
  const notWave = wav();
  notWave[8] = 0x58;
  assert.equal(readWavLength(notWave), null, "RIFF but not WAVE");
});

test("readTempoHint: acid fields, unusable tempo, truncated acid, BPM tag rules", () => {
  assert.deepEqual(readTempoHint(wav({ extra: [acidChunk(120, 8)] })), { bpm: 120, source: "acid", beats: 8 });
  assert.deepEqual(readTempoHint(wav({ extra: [acidChunk(90, 0)] })), { bpm: 90, source: "acid" });
  assert.equal(readTempoHint(wav({ extra: [acidChunk(0)] })), null, "tempo 0");
  assert.equal(readTempoHint(wav({ extra: [acidChunk(NaN)] })), null, "tempo NaN");
  const full = wav({ extra: [acidChunk(120)] });
  assert.equal(readTempoHint(full.subarray(0, 50)), null, "acid cut off by the end of the file");
  assert.equal(readTempoHint(Buffer.from("OggS bpm=128.5 junk"))?.bpm, 128.5, "key is case-insensitive");
  assert.equal(readTempoHint(Buffer.from("OggS XBPM=140")), null, "key must start a word");
  assert.equal(readTempoHint(Buffer.from("OggS BPM=0")), null, "BPM must be above 0");
  assert.equal(readTempoHint(new Uint8Array(0)), null);
  assert.equal(readTempoHint(undefined), null, "never throws");
});

test("parseArgs: accepted modes and rejected combinations", () => {
  assert.deepEqual(parseArgs(["a.wav", "--beats-per-bar", "3", "--bars", "2"]), { file: "a.wav", bars: 2, beatsPerBar: 3, hints: false });
  assert.deepEqual(parseArgs(["a.wav", "--hints"]), { file: "a.wav", beatsPerBar: 4, hints: true });
  for (const argv of [
    ["a.wav", "--bars"],
    ["a.wav", "--bars", "x"],
    ["a.wav", "--bars", "4.5"],
    ["a.wav", "--bars", "--hints"],
    ["--seconds", "8", "--bars", "4", "a.wav"],
    ["a.wav", "b.wav", "--bars", "4"],
    ["a.wav", "--hints", "--bars", "4"],
    ["--seconds", "8"],
    ["a.wav"],
  ]) {
    assert.ok("error" in parseArgs(argv), argv.join(" "));
  }
});

test("run: WAV length, hints from a file, and file errors", () => {
  const two = join(dir, "two-seconds.wav");
  writeFileSync(two, wav({ frames: 88200 }));
  assert.deepEqual(run({ file: two, bars: 1, beatsPerBar: 4, hints: false }), { bpm: 120, source: "length", seconds: 2, bars: 1, beatsPerBar: 4 });

  const acid = join(dir, "acid.wav");
  writeFileSync(acid, wav({ extra: [acidChunk(96.5)] }));
  assert.deepEqual(run({ file: acid, beatsPerBar: 4, hints: true }), { bpm: 96.5, source: "acid", beats: 8 });

  const plain = join(dir, "plain.wav");
  writeFileSync(plain, wav());
  assert.equal(run({ file: plain, beatsPerBar: 4, hints: true }).error, `no tempo hint in ${plain}`);

  const text = join(dir, "notes.txt");
  writeFileSync(text, "hello");
  assert.match(run({ file: text, bars: 4, beatsPerBar: 4, hints: false }).error, /not a readable WAV/);
  assert.match(run({ file: join(dir, "missing.wav"), bars: 4, beatsPerBar: 4, hints: false }).error, /cannot read/);
});

test("run: an Ogg file with --bars errors and asks for --seconds", () => {
  const ogg = join(dir, "clip.ogg");
  writeFileSync(ogg, Buffer.from("OggS....vorbis"));
  assert.match(run({ file: ogg, bars: 4, beatsPerBar: 4, hints: false }).error, /--seconds/);
});

test("main: CLI prints one JSON line; a bad invocation exits 1", () => {
  const ok = spawnSync(process.execPath, [SCRIPT, "--seconds", "8", "--bars", "4"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { bpm: 120, source: "length", seconds: 8, bars: 4, beatsPerBar: 4 });
  const bad = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no usable mode/);
});
