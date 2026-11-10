// B4, the MS7 exit check "the loop golden is bit-exact across the seam": a looping clip and a looping stream of the
// same file, end to end on the loopback host (the real decoder handler and wasm in process, the real mixer wasm), for
// WAV, FLAC, MP3 (with its LAME tag), Ogg Vorbis and AAC in M4A (with the AAC build). The file is B1's loopable fixture
// (whole cycles, no fades, 48 kHz stereo, the context rate), so the core's output is the decoded samples themselves:
//
// - each voice's output, from its first frame through two and a half periods, equals the decode repeated: the source's
//   end followed by its start at every seam, bit for bit (the clip's decode is int16, as the registry loads it; the
//   stream's is f32, as the worker sends it);
// - the decode has exactly the source's 48,000 frames (no priming or padding to play at the seam);
// - the clip and the stream agree within int16 rounding (exactly, for the 16-bit lossless files).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { hintFromName } from "../decoder/protocol";
import { DecoderWasm } from "../decoder/wasm";
import { rig } from "./streamRig";

const FIXTURES = new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url);
const read = (path: string | URL): ArrayBuffer => {
  const b = readFileSync(fileURLToPath(path));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const DEFAULT_WASM = read(new URL("../wasm/myco_audio_decode.wasm", import.meta.url));
const AAC_WASM = read(new URL("../wasm/myco_audio_decode_aac.wasm", import.meta.url));
const FRAMES = 48_000;

/** The file's whole decode, interleaved stereo: int16 as the clip registry gets it (scaled to f32 as the core plays it), and f32 as a stream gets it. */
async function decode(name: string, wasm: ArrayBuffer): Promise<{ clip: Float32Array; stream: Float32Array }> {
  const w = await DecoderWasm.load(wasm.slice(0));
  const bytes = new Uint8Array(read(new URL(name, FIXTURES)));
  const whole = (f32: boolean): Float32Array => {
    const h = w.open(bytes, hintFromName(name));
    const info = w.info(h);
    expect(info.channels).toBe(2);
    expect(info.rate).toBe(48_000);
    expect(info.frames).toBe(FRAMES);
    const ptr = w.alloc(FRAMES * 2 * 4);
    const n = f32 ? w.readF32(h, ptr, FRAMES + 1) : w.readI16(h, ptr, FRAMES + 1);
    expect(n).toBe(FRAMES);
    const out = f32 ? Float32Array.from(w.f32(ptr, n * 2)) : Float32Array.from(w.i16(ptr, n * 2), (s) => s / 32768);
    w.free(ptr, FRAMES * 2 * 4);
    w.close(h);
    return out;
  };
  return { clip: whole(false), stream: whole(true) };
}

/** Plays `name` looping as a clip or a stream and returns the output from the voice's first frame, at least `frames` long. */
async function renderLoop(name: string, wasm: ArrayBuffer, aac: boolean, stream: boolean, src: Float32Array, frames: number) {
  const bytes = read(new URL(name, FIXTURES));
  const path = `music/${name}`;
  // Clips load as int16 (the default `clipFormat`), which the core scales by 1/32768.
  const r = await rig({ [path]: bytes }, { decoderWasm: wasm.slice(0), clipFiles: { [path]: bytes }, aac, clipFormat: 1 });
  if (!r) return null;
  const voice = r.backend.play({ path, url: "", loop: true, stream, bus: "Music" })!;
  await r.step(2);
  if (stream) await r.waitOpen(1);
  // Until it sounds (a clip decodes and uploads first).
  const sounding = () => r.left.some((s) => s !== 0) || r.right.some((s) => s !== 0);
  await vi.waitFor(
    async () => {
      await r.step(1);
      expect(sounding()).toBe(true);
    },
    { timeout: 10_000, interval: 1 },
  );
  // The onset: the first output frame that isn't silent, less the source's silent leading frames.
  let first = 0;
  while (r.left[first] === 0 && r.right[first] === 0) first++;
  let lead = 0;
  while (src[2 * lead] === 0 && src[2 * lead + 1] === 0) lead++;
  const at = first - lead;
  while (r.left.length < at + frames) await r.step(8);
  expect(voice.playing).toBe(true);
  expect(r.backend.mirror.underruns).toBe(0);
  if (stream) expect(r.backend.streams.stats.starves).toBe(0);
  const left = r.left.slice(at, at + frames);
  const right = r.right.slice(at, at + frames);
  r.backend.dispose();
  return { left, right };
}

/** The first frame where the output leaves the decode repeated, or -1. */
function firstMismatch(out: { left: number[]; right: number[] }, src: Float32Array): number {
  for (let k = 0; k < out.left.length; k++) {
    const f = k % FRAMES;
    if (out.left[k] !== src[2 * f] || out.right[k] !== src[2 * f + 1]) return k;
  }
  return -1;
}

const CASES: { name: string; aac: boolean; lossless: boolean }[] = [
  { name: "loop-48000-stereo.wav", aac: false, lossless: true },
  { name: "loop-48000-stereo.flac", aac: false, lossless: true },
  { name: "loop-48000-stereo.mp3", aac: false, lossless: false },
  { name: "loop-48000-stereo.ogg", aac: false, lossless: false },
  { name: "loop-48000-stereo.m4a", aac: true, lossless: false },
];

describe("gapless loops: a looping clip and a looping stream are bit-exact across the seam (B4)", () => {
  it.each(CASES)("$name", async ({ name, aac, lossless }, ctx) => {
    const wasm = aac ? AAC_WASM : DEFAULT_WASM;
    const src = await decode(name, wasm);
    const frames = Math.round(FRAMES * 2.5);
    const clip = await renderLoop(name, wasm, aac, false, src.clip, frames);
    if (!clip) return ctx.skip();
    const stream = (await renderLoop(name, wasm, aac, true, src.stream, frames))!;
    expect(firstMismatch(clip, src.clip), "clip loop").toBe(-1);
    expect(firstMismatch(stream, src.stream), "stream loop").toBe(-1);
    // Clip against stream: int16 rounding apart at most (identical for the 16-bit lossless files).
    let worst = 0;
    for (let k = 0; k < frames; k++) worst = Math.max(worst, Math.abs(clip.left[k]! - stream.left[k]!), Math.abs(clip.right[k]! - stream.right[k]!));
    if (lossless) expect(worst).toBe(0);
    else expect(worst).toBeLessThanOrEqual(0.5 / 32768 + 1e-9);
  });
});
