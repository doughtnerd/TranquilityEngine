// B3b: `seek()` on a clip voice, end to end on the loopback host (the SEEK record the core had parsed and skipped is
// applied now): the clip is a ramp (sample k = floor(k / 3) / 32767), so the output says which clip frame is playing.
// A seek fades the voice out over 5 ms, jumps, and fades in from the target; a loop wraps the time; a one-shot clamps
// it to the end (the voice then ends); a seek before the clip is on the core does nothing.
import { fakeDecoder } from "./fakeDecoder";
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";

const STEP = 3;
const CLIP_FRAMES = 96_000;
const FADE = 240;
const TOL = 1e-6;

const clipAt = (k: number): number => Math.floor(k / STEP) / 32768;
const rampAt = (a: number, b: number, n: number, k: number): number => (k + 1 >= n ? b : a + ((b - a) * (k + 1)) / n);

async function rig() {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => Math.floor(k / STEP) / 32767);
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: 48_000, channelData: [ramp] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, maxMixed: 8 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      const { left } = loop.renderQuanta(4);
      for (const s of left) out.push(s);
      await Promise.resolve();
    }
  };
  return { backend, step, out };
}

/** The clip frame the output is at index `j`, found from a run of three samples (a ramp is monotonic). */
function frameAt(out: number[], j: number): number {
  const v = out[j]!;
  return Math.floor(v * 32768 + 0.5) * STEP;
}

describe("seek on a clip voice on the loopback host (B3b)", () => {
  it("fades out over 5 ms, jumps to the target and fades in from it", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const voice = backend.play({ path: "ramp.wav", url: "ramp.wav", loop: false, stream: false, bus: "SFX" })!;
    await step(6);
    const first = out.findIndex((s) => s !== 0);
    const start = first - STEP; // output index of clip frame 0
    const mark = out.length;
    voice.seek!(1.0);
    await step(8);
    // Playing straight up to the fade, then 240 frames fading out the old audio.
    let f = mark;
    while (out[f] === clipAt(f - start)) f++;
    expect(f - mark).toBeLessThan(1_024);
    for (let k = 0; k < FADE; k++) {
      if (Math.abs(out[f + k]! - clipAt(f - start + k) * rampAt(1, 0, FADE, k)) > TOL) expect.fail(`fade-out frame ${k}`);
    }
    // Then silence to the quantum boundary, and the target fading in.
    let g = f + FADE;
    while (out[g] === 0) g++;
    expect(g - (f + FADE)).toBeLessThan(128 + STEP);
    // The ramp at the target (clip frame 48,000) is not zero, so frame 0 of the new audio is at `g`.
    for (let k = 0; k < FADE + 500; k++) {
      const gain = k < FADE ? rampAt(0, 1, FADE, k) : 1;
      if (Math.abs(out[g + k]! - clipAt(48_000 + k) * gain) > TOL) expect.fail(`new audio frame ${k}: ${out[g + k]} vs ${clipAt(48_000 + k) * gain}`);
    }
    expect(voice.playing).toBe(true);
    backend.dispose();
  });

  it("a loop wraps the target; a one-shot clamps it to the end and ends", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const looping = backend.play({ path: "ramp.wav", url: "ramp.wav", loop: true, stream: false, bus: "SFX" })!;
    await step(6);
    const mark = out.length;
    looping.seek!(2.5); // 2.5 s of a 2 s clip: 0.5 s
    await step(8);
    expect(out.slice(mark).some((s) => s !== 0)).toBe(true);
    const tail = out.slice(-600);
    const t0 = frameAt(tail, 0);
    expect(t0).toBeGreaterThanOrEqual(24_000);
    expect(t0).toBeLessThan(24_000 + 20_000);
    expect(looping.playing).toBe(true);
    looping.stop();

    const once = backend.play({ path: "ramp.wav", url: "ramp.wav", loop: false, stream: false, bus: "SFX" })!;
    await step(6);
    once.seek!(5);
    await step(8);
    expect(once.playing).toBe(false);
    backend.dispose();
  });
});
