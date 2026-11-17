// B3b: `seek()` on a clip voice, end to end on the loopback host (the SEEK record the core had parsed and skipped is
// applied now): the clip is a ramp (sample k = floor(k / 3) / 32767), so the output says which clip frame is playing.
// A seek fades the voice out over 5 ms, jumps, and fades in from the target; a loop wraps the time; a one-shot clamps
// it to the end (the voice then ends); a seek before the clip is on the core does nothing.
import { afterEach, describe, expect, it } from "vitest";
import { loopbackAudio, closeLoopbackAudio } from "../testing";

const STEP = 3;
const CLIP_FRAMES = 96_000;
const FADE = 240;
const TOL = 1e-6;

const clipAt = (k: number): number => Math.floor(k / STEP) / 32768;
const rampAt = (a: number, b: number, n: number, k: number): number => (k + 1 >= n ? b : a + ((b - a) * (k + 1)) / n);

async function rig() {
  // ADR 0221: the production assembly on the loopback, with its own mixer; no limiter look-ahead.
  const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => Math.floor(k / STEP) / 32767);
  const audio = await loopbackAudio({ mixer: "own", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 }, decode: () => ({ channelData: [ramp] }), dt: 0.003 });
  if (!audio) return null;
  const { backend, link } = audio;
  const out: number[] = [];
  /** `n` frames of 4 quanta; the left channel is appended to `out`. */
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) for (const s of (await audio.step()).left) out.push(s);
  };
  return { backend, step, out, link };
}

/** The clip frame the output is at index `j`, found from a run of three samples (a ramp is monotonic). */
function frameAt(out: number[], j: number): number {
  const v = out[j]!;
  return Math.floor(v * 32768 + 0.5) * STEP;
}

afterEach(closeLoopbackAudio);

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
