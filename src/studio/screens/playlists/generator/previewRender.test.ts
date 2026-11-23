// The Generator editor's preview (ADR 0360 §9) through its interface: the samples are the offline render's (what a bake
// writes and the fallback plays), the length, key-off and envelope per kind, the same picture for the same patch, and
// the waveform peaks it hands the kit.
import { describe, expect, it } from "vitest";
import { applyBlipPreset } from "../../../../engine/audio/generators/blipPresets";
import { emptyGeneratorBody } from "../../../../engine/audio/generators/format";
import { GENERATOR_RENDER_RATE, renderGenerator } from "../../../../engine/audio/generators/generatorRender";
import { mulberry32 } from "../../../../engine/audio/generators/random";
import { applySynthPreset } from "../../../../engine/audio/generators/synthPresets";
import { pictureOf, requestPreview } from "./previewClient";
import { generatorSoundSeconds, renderGeneratorPreview } from "./previewRender";

const peak = (s: Float32Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe("the preview render", () => {
  it("is the offline render of the stored patch, sample for sample, the same every time", async () => {
    const coin = { ...applyBlipPreset(emptyGeneratorBody("blip"), "coin", 1734), vary: 0.4 };
    const a = await renderGeneratorPreview(coin);
    // What plays: the patch with `vary` off and its own seed, through the core's kernels.
    const real = await renderGenerator({ ...coin, vary: 0 }, mulberry32(0), { seconds: 2 });
    expect(a.rate).toBe(GENERATOR_RENDER_RATE);
    expect(Array.from(a.samples)).toEqual(Array.from(real.pcm.subarray(0, real.frames)));
    expect(a.endless).toBe(false);
    expect(a.seconds).toBeCloseTo(real.frames / real.rate, 9);
    expect(a.seconds).toBeLessThanOrEqual(generatorSoundSeconds(coin) + 0.01);
    expect(peak(a.samples)).toBeGreaterThan(0.01);
    expect(Array.from((await renderGeneratorPreview(coin)).samples)).toEqual(Array.from(a.samples));
    // The blip's sfxr envelope: up, the punch, down to nothing.
    expect(a.envelope[0]).toEqual([0, 0]);
    expect(Math.max(...a.envelope.map(([, v]) => v))).toBe(1);
  });

  it("keys a finite oscillator off at its length and shows an endless one's first 2 s", async () => {
    const g = emptyGeneratorBody("oscillator");
    const finite = await renderGeneratorPreview({ ...g, params: { ...g.params, length: 0.5, release: 100 } });
    expect([finite.keyOff, finite.endless]).toEqual([0.5, false]);
    // The core's release falls to −60 dB at 1.5 × its time; the module stops where the voice ended.
    expect(finite.seconds).toBeGreaterThan(0.6);
    expect(finite.seconds).toBeLessThan(0.66);
    expect(finite.envelope[finite.envelope.length - 1]![1]).toBeLessThan(0.002);
    const endless = await renderGeneratorPreview(g);
    expect([endless.keyOff, endless.seconds, endless.endless]).toEqual([null, 2, true]);
    // The signal before its gain stage: the oscillator's −12 dB level is in it.
    expect(peak(endless.samples)).toBeCloseTo(10 ** (-12 / 20), 2);
    expect(endless.envelope[endless.envelope.length - 1]![1]).toBeCloseTo(1, 6);
  });

  it("renders a synth preset, and silence as silence", async () => {
    const pluck = await renderGeneratorPreview(applySynthPreset(emptyGeneratorBody("synth"), "pluck"));
    expect(pluck.keyOff).toBe(0.6);
    expect(peak(pluck.samples)).toBeGreaterThan(0.01);
    const quiet = await renderGeneratorPreview({ ...emptyGeneratorBody("silence"), params: { length: 0.25, lengthRandom: 0 } });
    expect(quiet.seconds).toBeCloseTo(0.25, 3);
    expect(peak(quiet.samples)).toBe(0);
  });

  it("says how long a finite generator sounds", () => {
    const g = emptyGeneratorBody("oscillator");
    expect(generatorSoundSeconds({ ...g, params: { ...g.params, length: 0.5, release: 100 } })).toBeCloseTo(0.65, 9);
    expect(generatorSoundSeconds({ ...emptyGeneratorBody("silence"), params: { length: 0.75, lengthRandom: 0 } })).toBe(0.75);
  });

  it("hands the kit peaks covering every frame, through the client", async () => {
    const pic = await pictureOf(applyBlipPreset(emptyGeneratorBody("blip"), "laser", 9));
    expect(pic.mips.rate).toBe(GENERATOR_RENDER_RATE);
    expect(pic.mips.frames).toBe(Math.round(pic.seconds * GENERATOR_RENDER_RATE));
    expect(pic.mips.levels[0]!.bins).toBe(Math.ceil(pic.mips.frames / 32));
    expect(pic.mips.levels[pic.mips.levels.length - 1]!.bins).toBe(1);
    // Only the newest request for a key is answered.
    const body = emptyGeneratorBody("oscillator");
    const older = requestPreview("k", body);
    const newer = requestPreview("k", body);
    expect(await older).toBeNull();
    expect(await newer).toMatchObject({ endless: true, seconds: 2 });
  });
});
