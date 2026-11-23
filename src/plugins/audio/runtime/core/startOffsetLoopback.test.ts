// `PlayRequest.offset` on the loopback host: a clip voice starts part-way, sample-exactly (its PLAY carries the frame),
// with no fade; a looping voice wraps an offset past the clip's end; a one-shot past the end ends at once. The clip is
// a ramp (sample k = floor(k / 3) / 32767), so the output says which clip frame is playing.
import { afterEach, describe, expect, it } from "vitest";
import { loopbackAudio, closeLoopbackAudio } from "../testing";

const STEP = 3;
const CLIP_FRAMES = 96_000;

/** The ramp as heard: written over 32767, decoded to 16 bits (as `clipSeekLoopback.test.ts` reads it). */
const clipAt = (k: number): number => Math.floor(k / STEP) / 32768;

async function rig() {
  const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => Math.floor(k / STEP) / 32767);
  const audio = await loopbackAudio({ mixer: "own", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 }, decode: () => ({ channelData: [ramp] }), dt: 0.003 });
  if (!audio) return null;
  const { backend } = audio;
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) for (const s of (await audio.step()).left) out.push(s);
  };
  return { backend, step, out };
}

afterEach(closeLoopbackAudio);

describe("a start offset on a clip voice (PlayRequest.offset)", () => {
  it("starts the voice that far in, exactly and without a fade", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const voice = backend.play({ path: "ramp.wav", url: "ramp.wav", loop: false, stream: false, bus: "SFX", offset: 1 })!;
    await step(6);
    const first = out.findIndex((s) => s !== 0);
    expect(first).toBeGreaterThanOrEqual(0);
    // Clip frame 48,000 (1 s at 48 kHz) is the first sample heard, at full level, and the ramp runs on from there.
    for (let k = 0; k < 600; k++) if (out[first + k] !== clipAt(48_000 + k)) expect.fail(`frame ${k}: ${out[first + k]} vs ${clipAt(48_000 + k)}`);
    expect(voice.playing).toBe(true);
    backend.dispose();
  });

  it("wraps a looping voice's offset into the clip; a one-shot past its end ends", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const looping = backend.play({ path: "ramp.wav", url: "ramp.wav", loop: true, stream: false, bus: "SFX", offset: 2.5 })!;
    await step(6);
    const first = out.findIndex((s) => s !== 0);
    expect(out[first]).toBe(clipAt(24_000)); // 2.5 s of a 2 s clip: 0.5 s
    expect(looping.playing).toBe(true);
    looping.stop();
    const once = backend.play({ path: "ramp.wav", url: "ramp.wav", loop: false, stream: false, bus: "SFX", offset: 5 })!;
    await step(8);
    expect(once.playing).toBe(false);
    backend.dispose();
  });
});
