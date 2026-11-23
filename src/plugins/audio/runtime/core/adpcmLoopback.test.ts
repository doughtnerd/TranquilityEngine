// ADR 0351 A4, A7 on the loopback host: the core backend as production assembles it, the real decoder handler in process
// (myco_audio_decode.wasm, ABI 1.5) and the real mixer (ABI 4.12).
//
// - an ADPCM sound held compressed in a `.mycopak` goes to the core as clip format 6 and plays with an SNR above 30 dB
//   against its source; it plays bit for bit as the same blocks decoded in the worker and sent as an int16 clip, in
//   about a quarter of the arena;
// - many ADPCM voices don't spike a quantum: the metered gate's ADPCM scenes (instruction counts, never wall time) have
//   their worst quantum within 1.25× their mean and cost about 23k instructions per voice over int16;
// - an Opus file decodes and plays (libopus, the pre-skip and the end trimming honoured), lined up with its source;
// - a `.mycopak`'s compressed Vorbis plays through a stream ring from the worker's copy (never fetched), exactly as the
//   same file streamed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QPF, rig } from "../../testing/streamRig";
import { closeLoopbackAudio } from "../testing";
import { decoderFixture, encodeAdpcm, makePack, snrDb } from "../decoder/packTestSupport";
import type { PackRef } from "../decoder/protocol";

const RATE = 48_000;
const FRAMES = 40_000;

/** A stereo source: two tones and a slow sweep, int16. */
function source(): Int16Array {
  const pcm = new Int16Array(FRAMES * 2);
  for (let f = 0; f < FRAMES; f++) {
    pcm[2 * f] = Math.round(Math.cos(f * 0.029) * 11_000 + Math.sin(f * 0.0009) * 7_000);
    pcm[2 * f + 1] = Math.round(Math.sin(f * 0.043) * 12_000);
  }
  return pcm;
}

const entry = (path: string, codec: "adpcm" | "vorbis", load: "decode" | "compressed", frames: number) => ({ path, codec, rate: RATE, channels: 2, frames, load, hash: "0", prefetch: null });

/** A rig whose decoder holds `pack` as package 1, with `paths` resolved to its entries. */
async function packRig(pack: ArrayBuffer, paths: readonly string[], files: Record<string, ArrayBuffer> = {}) {
  const refs = new Set(paths);
  const r = await rig(files, { clipFormat: 1, packRef: (path): PackRef | null => (refs.has(path) ? { pack: 1, path } : null) });
  if (!r) return null;
  await r.decoder.loadPack(1, pack);
  return r;
}

/** Plays `path` as a clip until it has sounded and finished; the output, from its first non-zero frame. */
async function playClip(r: NonNullable<Awaited<ReturnType<typeof packRig>>>, path: string) {
  const voice = r.backend.play({ path, url: path, loop: false, stream: false, bus: "SFX" })!;
  await vi.waitFor(
    async () => {
      await r.step(2);
      expect(r.left.some((s) => s !== 0)).toBe(true);
    },
    { timeout: 5_000, interval: 5 },
  );
  await r.step(Math.ceil(FRAMES / (QPF * 128)) + 4);
  expect(voice.playing).toBe(false);
  const first = r.left.findIndex((s) => s !== 0);
  return { left: r.left.slice(first), right: r.right.slice(first), arenaKB: r.link.lastStatus!.arenaUsedKB };
}

afterEach(closeLoopbackAudio);

describe("ADPCM, Opus and packages on the core (ADR 0351 A4, A7)", () => {
  it("an ADPCM sound held compressed plays above 30 dB SNR, bit for bit as its blocks decoded, in a quarter of the arena", async (ctx) => {
    const src = source();
    const blocks = encodeAdpcm(src, 2);
    const pack = makePack([
      { entry: entry("sfx/hit.wav", "adpcm", "compressed", FRAMES), data: blocks },
      { entry: entry("sfx/hit-decoded.wav", "adpcm", "decode", FRAMES), data: blocks },
    ]);
    const a = await packRig(pack, ["sfx/hit.wav", "sfx/hit-decoded.wav"]);
    if (!a) return ctx.skip();
    const compressed = await playClip(a, "sfx/hit.wav");
    await closeLoopbackAudio();
    const b = (await packRig(pack, ["sfx/hit.wav", "sfx/hit-decoded.wav"]))!;
    const decoded = await playClip(b, "sfx/hit-decoded.wav");

    // Against the source (the first sample of each block is exact, so the onset lines up at frame 0).
    const want = Float32Array.from(src, (s) => s / 32768);
    const got = new Float32Array(FRAMES * 2);
    for (let f = 0; f < FRAMES; f++) {
      got[2 * f] = compressed.left[f]!;
      got[2 * f + 1] = compressed.right[f]!;
    }
    const snr = snrDb(want, got, 0, want.length);
    console.log(`ADPCM on the core: SNR ${snr.toFixed(1)} dB against the source`);
    expect(snr).toBeGreaterThan(30);
    // The core's per-voice decode equals the worker's whole decode played as int16, sample for sample.
    for (let f = 0; f < FRAMES; f++) {
      if (compressed.left[f] !== decoded.left[f] || compressed.right[f] !== decoded.right[f]) expect.fail(`frame ${f}: ${compressed.left[f]} vs ${decoded.left[f]}`);
    }
    // 1,032 bytes per 1,024 stereo frames against 4,096: the clip's arena block is about a quarter.
    expect(compressed.arenaKB).toBeLessThan(decoded.arenaKB / 2);
  });

  it("many ADPCM voices don't spike a quantum (the metered gate's counts)", () => {
    const baseline = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../tools/audio-bench/metered/baseline.json", import.meta.url)), "utf8")) as { scenes: Record<string, { perQuantum: number; max: number }> };
    const { adpcm, "automation-base": int16, "adpcm-pitch4": pitch4, "adpcm-default": preset } = baseline.scenes;
    // 256 looping voices crossing every block in the same quantum: flat (the rejected block cache spiked 9.4×).
    expect(adpcm!.max / adpcm!.perQuantum).toBeLessThan(1.25);
    expect(pitch4!.max / pitch4!.perQuantum).toBeLessThan(1.25);
    expect(preset!.max / preset!.perQuantum).toBeLessThan(1.25);
    // About 23k instructions per voice per quantum over int16 at pitch 1 (0359 §5).
    const perVoice = (adpcm!.perQuantum - int16!.perQuantum) / 256;
    console.log(`ADPCM: ${Math.round(perVoice)} instructions per voice per quantum over int16; worst quantum ${(adpcm!.max / adpcm!.perQuantum).toFixed(3)}× the mean`);
    expect(perVoice).toBeLessThan(30_000);
  });

  it("an Opus file decodes and plays, lined up with its source", async (ctx) => {
    const r = await rig({}, { clipFormat: 1, clipFiles: { "vo/line.opus": decoderFixture("tone-48000-stereo.opus") } });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "vo/line.opus", url: "vo/line.opus", loop: false, stream: false, bus: "SFX" })!;
    await vi.waitFor(
      async () => {
        await r.step(2);
        expect(r.left.some((s) => s !== 0)).toBe(true);
      },
      { timeout: 5_000, interval: 5 },
    );
    await r.step(Math.ceil(RATE / (QPF * 128)) + 4);
    expect(voice.playing).toBe(false);
    const wav = new Uint8Array(decoderFixture("tone-48000-stereo.wav"));
    const pcm = new Int16Array(wav.buffer.slice(44, 44 + new DataView(wav.buffer).getUint32(40, true)));
    const want = Float32Array.from({ length: pcm.length / 2 }, (_, f) => pcm[2 * f]! / 32768);
    // The voice's frame 0: where the output best matches the source's start.
    let best = { lag: 0, snr: -Infinity };
    const start = r.left.findIndex((s) => s !== 0);
    for (let lag = Math.max(0, start - 64); lag <= start + 64; lag++) {
      const got = Float32Array.from({ length: want.length }, (_, f) => r.left[lag + f] ?? 0);
      const snr = snrDb(want, got, 4096, want.length - 4096);
      if (snr > best.snr) best = { lag, snr };
    }
    console.log(`Opus on the core: SNR ${best.snr.toFixed(1)} dB against the source`);
    expect(best.snr).toBeGreaterThan(15);
    // Its length is the source's: silence after it.
    expect(r.left.slice(best.lag + want.length + 2).every((s) => s === 0)).toBe(true);
  });

  it("a .mycopak's compressed Vorbis plays through a stream ring, exactly as the file streamed", async (ctx) => {
    const ogg = decoderFixture("tone-48000-stereo.ogg");
    const play = async (r: NonNullable<Awaited<ReturnType<typeof rig>>>, path: string) => {
      const voice = r.backend.play({ path, url: "", loop: false, stream: true, bus: "Music" })!;
      await r.step(2);
      await r.waitOpen(1);
      await r.step(Math.ceil(RATE / (QPF * 128)) + 20);
      expect(voice.playing).toBe(false);
      expect(r.backend.streams.stats.eos).toBe(1);
      expect(r.worklet().frames).toBe(RATE);
      const first = r.left.findIndex((s) => s !== 0);
      return r.left.slice(first);
    };
    const file = await rig({ "amb/wind.ogg": ogg });
    if (!file) return ctx.skip();
    const streamed = await play(file, "amb/wind.ogg");
    await closeLoopbackAudio();
    // No file to fetch: the stream must come from the package the worker holds.
    const packed = (await packRig(makePack([{ entry: entry("amb/wind.ogg", "vorbis", "compressed", RATE), data: new Uint8Array(ogg) }]), ["amb/wind.ogg"]))!;
    const fromPack = await play(packed, "amb/wind.ogg");
    expect(fromPack.length).toBeGreaterThan(RATE / 2);
    expect(fromPack.slice(0, RATE)).toEqual(streamed.slice(0, RATE));
  });
});
