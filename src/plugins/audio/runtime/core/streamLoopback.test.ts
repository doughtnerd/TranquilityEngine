// B3 end to end on the loopback host: the core backend plays `stream: true` through the real decoder handler (in
// process, myco_audio_decode.wasm), a stream port straight from the "worker" to the shell (never through main), the real
// mixer wasm and the shell's credits. The file is a 16-bit WAV at the context rate, so the output must equal the
// decoded samples exactly once the voice sounds.
//
// - a stream plays to its end, matching a straight decode, and its ring is freed;
// - a 300 ms main-thread stall (no frame, no `onmessage` on main) while the worker→worklet port keeps flowing:
//   no starve, the output is still exact, no underrun;
// - starvation (the worker stalled past the 0.68 s ring): a 5 ms fade to silence, `reason === "waitingForData"`, then a
//   clean 5 ms fade-in from the held frame when the worker resumes, and the reason clears;
// - a decoder error: STOP with a 50 ms fade and one warning naming the asset;
// - two streams at once, mono and stereo, then cleanup on stop;
// - a decoder worker crash: each open stream stops once (one warning each), the worklet closes the dead worker's
//   rings when the next worker connects, and a new stream plays on it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWav, signal } from "../decoder/testWav";
import { FADE, FRAME_MS, QPF, RATE, rig } from "../../testing/streamRig";


const WAV_FRAMES = 96_000; // 2 s
const stereo = () => makeWav(WAV_FRAMES, 2, RATE, signal);
const want = (k: number, c: number) => signal(k, c) / 32768;

/** The output index where the stream's frame 0 sounds: the first non-zero sample, less the leading zero frames. */
function onsetOf(out: number[]): number {
  let first = 0;
  while (first < out.length && out[first] === 0) first++;
  let lead = 0;
  while (want(lead, 0) === 0) lead++;
  return first - lead;
}

afterEach(() => vi.restoreAllMocks());

describe("streaming on the loopback host (B3)", () => {
  it("a stream plays to its end matching a straight decode; its voice ends and its ring is freed", async (ctx) => {
    const r = await rig({ "music/a.wav": stereo() });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/a.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    expect(voice.reason).toBe("waitingForData");
    await r.step(2);
    await r.waitOpen(1);
    await r.step(Math.ceil(WAV_FRAMES / (QPF * 128)) + 20);
    const at = onsetOf(r.left);
    expect(at).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < WAV_FRAMES; k++) {
      if (r.left[at + k] !== want(k, 0) || r.right[at + k] !== want(k, 1)) expect.fail(`frame ${k}: ${r.left[at + k]}, ${r.right[at + k]} vs ${want(k, 0)}, ${want(k, 1)}`);
    }
    expect(r.left.slice(at + WAV_FRAMES).every((s) => s === 0)).toBe(true);
    expect(voice.playing).toBe(false);
    expect(r.backend.mirror.underruns).toBe(0);
    expect(r.backend.streams.stats.starves).toBe(0);
    expect(r.backend.streams.stats.eos).toBe(1);
    expect(r.backend.streams.size).toBe(0);
    await r.settle();
    await r.step(2);
    expect(r.loop.driver.openStreams).toBe(0);
    expect(r.loop.driver.stats.streamFrames).toBe(WAV_FRAMES);
    r.backend.dispose();
  });

  it("a 300 ms main-thread stall: the worker keeps the worklet fed, no starve, no underrun, the output exact", async (ctx) => {
    const r = await rig({ "music/a.wav": stereo() });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/a.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await r.step(20);
    expect(voice.reason).toBeNull();
    const stallFrames = Math.ceil(300 / FRAME_MS); // 300 ms with no main thread at all
    const before = r.left.length;
    const chunksBefore = r.handler.streamStats.chunks;
    const stall = await r.step(stallFrames, { mainStalled: true });
    const stalledMs = ((r.left.length - before) / RATE) * 1000;
    expect(stalledMs).toBeGreaterThanOrEqual(300);
    // Main saw nothing during the stall, while the worker kept sending chunks on credits from the worklet.
    expect(stall.applied).toBe(0);
    expect(stall.held).toBeGreaterThan(0);
    expect(r.handler.streamStats.chunks - chunksBefore).toBeGreaterThanOrEqual(Math.floor((0.3 * RATE) / 4096));
    await r.step(40);
    const at = onsetOf(r.left);
    for (let k = 0; at + k < r.left.length && k < WAV_FRAMES; k++) {
      if (r.left[at + k] !== want(k, 0) || r.right[at + k] !== want(k, 1)) expect.fail(`frame ${k}: ${r.left[at + k]} vs ${want(k, 0)}`);
    }
    expect(r.backend.mirror.underruns).toBe(0);
    expect(r.backend.streams.stats.starves).toBe(0);
    expect(voice.reason).toBeNull();
    // The chunk buffers circulated: the worker allocated about a window of them (8 chunks), not one per chunk.
    expect(r.handler.streamStats.chunks).toBeGreaterThan(15);
    expect(r.handler.streamStats.allocated).toBeLessThanOrEqual(10);
    r.backend.dispose();
  });

  it("starvation fades to silence with waitingForData, then fades back in from the held frame when data returns", async (ctx) => {
    const long = makeWav(4 * RATE, 2, RATE, signal);
    const r = await rig({ "music/long.wav": long });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/long.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await r.step(10);
    expect(voice.reason).toBeNull();
    // The worker stalls for 1.2 s: longer than the ring (0.68 s).
    const stallStart = r.left.length;
    await r.step(Math.ceil(1200 / FRAME_MS), { workerStalled: true });
    const at = onsetOf(r.left);
    let faded = stallStart;
    while (faded < r.left.length && r.left[faded] === want(faded - at, 0)) faded++;
    expect(faded).toBeLessThan(r.left.length);
    for (let k = 0; k < FADE; k++) {
      const g = 1 - (k + 1) / FADE;
      expect(Math.abs(r.left[faded + k]! - want(faded - at + k, 0) * g)).toBeLessThan(1e-6);
    }
    expect(r.left.slice(faded + FADE).every((s) => s === 0)).toBe(true);
    expect(voice.reason).toBe("waitingForData");
    expect(voice.playing).toBe(true);
    expect(r.backend.streams.stats.starves).toBe(1);
    const held = faded - at + FADE;
    // The worker resumes: a 5 ms fade-in from the held frame, then the stream as decoded.
    const resumeAt = r.left.length;
    await r.step(20);
    let on = resumeAt;
    while (r.left[on] === 0) on++;
    // The fade-in's first frame may be 0 only if the signal is; it starts at gain 1/240.
    for (let k = 0; k < 2000; k++) {
      const g = k < FADE ? (k + 1) / FADE : 1;
      const got: number = r.left[on + k]!;
      if (Math.abs(got - want(held + k, 0) * g) > 1e-6) expect.fail(`resumed frame ${k}: ${got} vs ${want(held + k, 0) * g}`);
    }
    expect(voice.reason).toBeNull();
    r.backend.dispose();
  });

  it("a decoder error stops the voice with a 50 ms fade and warns once, naming the asset", async (ctx) => {
    const r = await rig({ "music/a.wav": stereo() });
    if (!r) return ctx.skip();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const voice = r.backend.play({ path: "music/a.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await r.step(10);
    const streamId = r.backend.table.clip[voice.id & 0xffff]!;
    // The worker reports a decode error for the stream (as on a truncated or corrupt frame).
    const worker = r.worker();
    worker.onmessage?.({ data: { type: "error", streamId, asset: "music/a.wav", message: "decode error at frame 12345" } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("music/a.wav");
    expect(voice.playing).toBe(false);
    const from = r.left.length;
    await r.step(10);
    const out = r.left.slice(from);
    // A 50 ms (2,400-frame) fade from the frame's batch on: the last sound is within it (plus a frame of latency), and
    // its tail is quiet (no cut).
    let last = out.length - 1;
    while (last > 0 && out[last] === 0) last--;
    expect(last).toBeGreaterThan(2_000);
    expect(last).toBeLessThan(2_400 + 2 * QPF * 128);
    expect(Math.max(...out.slice(last - 24, last + 1).map(Math.abs))).toBeLessThan(0.01);
    expect(out.slice(last + 1).length).toBeGreaterThan(QPF * 128);
    expect(r.backend.streams.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    r.backend.dispose();
  });

  it("two streams at once (stereo and mono) mix, and stopping both frees their rings", async (ctx) => {
    const mono = makeWav(WAV_FRAMES, 1, RATE, (k) => Math.round(3000 * Math.sin(k * 0.05)));
    const r = await rig({ "music/a.wav": stereo(), "sfx/b.wav": mono });
    if (!r) return ctx.skip();
    const a = r.backend.play({ path: "music/a.wav", url: "", loop: true, stream: true, bus: "Music" })!;
    const b = r.backend.play({ path: "sfx/b.wav", url: "", loop: false, stream: true, bus: "SFX" })!;
    await r.step(2);
    await r.waitOpen(2);
    await r.step(30);
    expect(a.reason).toBeNull();
    expect(b.reason).toBeNull();
    expect(r.loop.driver.openStreams).toBe(2);
    expect(r.backend.mirror.liveVoices).toBe(2);
    a.stop(0.01);
    b.stop();
    await r.step(10);
    await r.settle();
    await r.step(2);
    expect(r.backend.mirror.liveVoices).toBe(0);
    expect(r.loop.driver.openStreams).toBe(0);
    expect(r.backend.streams.size).toBe(0);
    expect(r.left.slice(-512).every((s) => s === 0)).toBe(true);
    r.backend.dispose();
  });

  it("a decoder worker crash stops each open stream once with one warning; a new stream plays on the next worker (B3, B6)", async (ctx) => {
    const r = await rig({ "music/a.wav": stereo(), "sfx/b.wav": stereo() });
    if (!r) return ctx.skip();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = r.backend.play({ path: "music/a.wav", url: "", loop: true, stream: true, bus: "Music" })!;
    const b = r.backend.play({ path: "sfx/b.wav", url: "", loop: true, stream: true, bus: "SFX" })!;
    await r.step(2);
    await r.waitOpen(2);
    await r.step(10);
    expect(r.spawned()).toBe(1);
    r.worker().onerror?.({ message: "boom" });
    // Both voices stop (50 ms fade), each with one warning naming its asset.
    expect(a.playing).toBe(false);
    expect(b.playing).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    const warned = warn.mock.calls.map((c) => String(c[0])).sort();
    expect(warned[0]).toContain("music/a.wav");
    expect(warned[1]).toContain("sfx/b.wav");
    // The dead worker's rings are still open in the worklet: nobody sent their STREAM_CLOSE.
    expect(r.loop.driver.openStreams).toBe(2);
    // The next stream spawns a worker and connects it; the worklet closes the old rings, and the new stream plays.
    const c = r.backend.play({ path: "music/a.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    expect(r.spawned()).toBe(2);
    const from = r.left.length;
    await r.step(20);
    expect(c.playing).toBe(true);
    expect(c.reason).toBeNull();
    expect(r.left.slice(from).some((s) => s !== 0)).toBe(true);
    expect(r.backend.streams.size).toBe(1);
    // Nothing more about the old streams (their rings closing early in the core is not reported again).
    expect(warn).toHaveBeenCalledTimes(2);
    r.backend.dispose();
  });
});

// B3b: seeks. The loopback's output must hold, in order: the old audio until the seek, a 5 ms fade-out of it, silence
// while the new epoch decodes, a 5 ms fade-in at the target, then a straight decode from the target; nothing of the
// old position after the fade. The credits and chunk buffers keep circulating, and the ring is freed at the end.
describe("stream seeks on the loopback host (B3b)", () => {
  /** The first output index at or after `from` where the left channel stops following the straight decode (the fade-out starts). */
  function fadeStart(out: number[], from: number, at: number): number {
    let f = from;
    while (f < out.length && out[f] === want(f - at, 0)) f++;
    return f;
  }

  /**
   * Checks the seek that began at output index `f` (`at` = where stream frame 0 sounded before): a fade-out of the old
   * audio, silence, then the stream from `target` (a fade-in, then exact) for `len` frames. Returns the output index of
   * the target's first frame.
   */
  function expectSeek(r: { left: number[]; right: number[] }, f: number, at: number, target: number, len: number): number {
    const out = r.left;
    for (let k = 0; k < FADE; k++) {
      const g = 1 - (k + 1) / FADE;
      if (Math.abs(out[f + k]! - want(f - at + k, 0) * g) > 1e-6) expect.fail(`fade-out frame ${k}: ${out[f + k]} vs ${want(f - at + k, 0) * g}`);
    }
    let g = f + FADE;
    while (g < out.length && out[g] === 0) g++;
    expect(g).toBeLessThan(out.length);
    let lead = 0;
    while (want(target + lead, 0) === 0) lead++;
    const s0 = g - lead; // the output index of stream frame `target`
    for (let k = 0; k < len; k++) {
      const gain = k < FADE ? (k + 1) / FADE : 1;
      const wl = want(target + k, 0) * gain;
      const wr = want(target + k, 1) * gain;
      if (Math.abs(out[s0 + k]! - wl) > 1e-6 || Math.abs(r.right[s0 + k]! - wr) > 1e-6) expect.fail(`new audio frame ${k}: ${out[s0 + k]} vs ${wl}`);
    }
    return s0;
  }

  async function playing(frames = 60, extra: { loop?: boolean; file?: ArrayBuffer } = {}) {
    const r = await rig({ "music/a.wav": extra.file ?? stereo() });
    if (!r) return null;
    const voice = r.backend.play({ path: "music/a.wav", url: "", loop: extra.loop === true, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await r.step(frames);
    return { r, voice };
  }

  const cases: { name: string; frames: number; seconds: number }[] = [
    { name: "forward", frames: 40, seconds: 1.0 },
    { name: "backward", frames: 100, seconds: 0.1 },
    { name: "to 0 (reopening from the kept bytes)", frames: 80, seconds: 0 },
  ];
  for (const c of cases) {
    it(`seeking ${c.name} flushes the old audio: fade-out, silence, fade-in, then a straight decode from the target`, async (ctx) => {
      const p = await playing(c.frames);
      if (!p) return ctx.skip();
      const { r, voice } = p;
      const at = onsetOf(r.left);
      expect(voice.reason).toBeNull();
      const mark = r.left.length;
      const chunksBefore = r.handler.streamStats.chunks;
      voice.seek!(c.seconds);
      expect(voice.reason).toBe("waitingForData");
      await r.step(60);
      const f = fadeStart(r.left, mark, at);
      expect(f - mark).toBeLessThan(2 * QPF * 128 + 256); // the fade starts within a couple of frames
      const target = Math.round(c.seconds * RATE);
      const s0 = expectSeek(r, f, at, target, 8_000);
      expect(s0 - (f + FADE)).toBeLessThan(RATE / 10); // the new audio sounds within 100 ms
      expect(voice.playing).toBe(true);
      expect(voice.reason).toBeNull();
      expect(r.backend.mirror.underruns).toBe(0);
      // Credits and buffers keep flowing: more chunks, from the pool.
      expect(r.handler.streamStats.chunks).toBeGreaterThan(chunksBefore);
      expect(r.handler.streamStats.allocated).toBeLessThanOrEqual(20);
      expect(r.backend.streams.stats.seeks).toBe(1);
      voice.stop();
      await r.step(4);
      await r.settle();
      await r.step(2);
      expect(r.loop.driver.openStreams).toBe(0);
      r.backend.dispose();
    });
  }

  it("no sample from before the seek is heard after its fade-out: the next 20,000 frames are only the target's audio", async (ctx) => {
    const p = await playing(40);
    if (!p) return ctx.skip();
    const { r, voice } = p;
    const at = onsetOf(r.left);
    const mark = r.left.length;
    voice.seek!(1.5);
    await r.step(80);
    const f = fadeStart(r.left, mark, at);
    const target = Math.round(1.5 * RATE);
    const s0 = expectSeek(r, f, at, target, 20_000);
    for (let j = f + FADE; j < s0; j++) expect(r.left[j]).toBe(0);
    for (let j = s0 + FADE; j < s0 + 20_000; j++) {
      expect(r.left[j]! + 0).toBe(want(target + (j - s0), 0) + 0);
      expect(r.right[j]! + 0).toBe(want(target + (j - s0), 1) + 0);
    }
    r.backend.dispose();
  });

  it("a seek past the end of a one-shot ends it after the fade, with no more sound", async (ctx) => {
    const p = await playing(30);
    if (!p) return ctx.skip();
    const { r, voice } = p;
    const at = onsetOf(r.left);
    const mark = r.left.length;
    voice.seek!(5);
    await r.step(40);
    const f = fadeStart(r.left, mark, at);
    for (let k = 0; k < FADE; k++) expect(Math.abs(r.left[f + k]! - want(f - at + k, 0) * (1 - (k + 1) / FADE))).toBeLessThan(1e-6);
    expect(r.left.slice(f + FADE).every((s) => s === 0)).toBe(true);
    expect(voice.playing).toBe(false);
    expect(r.backend.streams.stats.eos).toBe(1);
    await r.settle();
    await r.step(2);
    expect(r.loop.driver.openStreams).toBe(0);
    r.backend.dispose();
  });

  it("a seek past the end of a loop wraps into the file", async (ctx) => {
    const p = await playing(30, { loop: true });
    if (!p) return ctx.skip();
    const { r, voice } = p;
    const at = onsetOf(r.left);
    const mark = r.left.length;
    voice.seek!(WAV_FRAMES / RATE + 0.5); // 2.5 s of a 2 s file: 0.5 s
    await r.step(60);
    const f = fadeStart(r.left, mark, at);
    expectSeek(r, f, at, Math.round(0.5 * RATE), 8_000);
    expect(voice.playing).toBe(true);
    r.backend.dispose();
  });

  it("a seek during starvation (the worker stalled past the ring) restarts from the target and the voice recovers", async (ctx) => {
    const long = makeWav(4 * RATE, 2, RATE, signal);
    const p = await playing(10, { file: long });
    if (!p) return ctx.skip();
    const { r, voice } = p;
    await r.step(Math.ceil(1200 / FRAME_MS), { workerStalled: true });
    expect(voice.reason).toBe("waitingForData");
    expect(r.backend.streams.stats.starves).toBe(1);
    const silent = r.left.length;
    voice.seek!(2.0);
    await r.step(40);
    let on = silent;
    while (on < r.left.length && r.left[on] === 0) on++;
    expect(on).toBeLessThan(r.left.length);
    const target = 2 * RATE;
    let lead = 0;
    while (want(target + lead, 0) === 0) lead++;
    const s0 = on - lead;
    for (let k = 0; k < 6_000; k++) {
      const gain = k < FADE ? (k + 1) / FADE : 1;
      if (Math.abs(r.left[s0 + k]! - want(target + k, 0) * gain) > 1e-6) expect.fail(`frame ${k}: ${r.left[s0 + k]} vs ${want(target + k, 0) * gain}`);
    }
    expect(voice.reason).toBeNull();
    expect(voice.playing).toBe(true);
    expect(r.backend.streams.stats.starves).toBe(1); // the seek is not a second starve
    r.backend.dispose();
  });

  it("two seeks in a row end on the second target, with one continuous fade-out and no leak", async (ctx) => {
    const p = await playing(40);
    if (!p) return ctx.skip();
    const { r, voice } = p;
    const at = onsetOf(r.left);
    const mark = r.left.length;
    voice.seek!(1.2);
    voice.seek!(0.3);
    await r.step(80);
    const f = fadeStart(r.left, mark, at);
    expectSeek(r, f, at, Math.round(0.3 * RATE), 10_000);
    expect(r.backend.streams.stats.seeks).toBe(2);
    voice.stop();
    await r.step(4);
    await r.settle();
    await r.step(2);
    expect(r.loop.driver.openStreams).toBe(0);
    r.backend.dispose();
  });

  it("a seek asked for before the stream opened is applied once the file's rate is known", async (ctx) => {
    const r = await rig({ "music/a.wav": stereo() });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/a.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    voice.seek!(1.0);
    expect(r.backend.streams.stats.seeks).toBe(0);
    await r.step(2);
    await r.waitOpen(1);
    await r.step(40);
    expect(r.backend.streams.stats.seeks).toBe(1);
    // The output ends on the stream from 1.0 s on: find where the last 1,000 frames sit in the file.
    const n = r.left.length;
    let m = -1;
    for (let k = 48_000; k < WAV_FRAMES; k++) if (want(k, 0) === r.left[n - 1000] && want(k + 1, 0) === r.left[n - 999] && want(k + 2, 0) === r.left[n - 998]) m = k;
    expect(m).toBeGreaterThanOrEqual(48_000);
    for (let k = 0; k < 1000 && m + k < WAV_FRAMES; k++) expect(r.left[n - 1000 + k]! + 0).toBe(want(m + k, 0) + 0);
    expect(voice.playing).toBe(true);
    r.backend.dispose();
  });
});
