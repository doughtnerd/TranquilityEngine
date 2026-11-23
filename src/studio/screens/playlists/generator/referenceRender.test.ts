// The preview's reference render (ADR 0360 §9) through its interface: lengths, key-off and envelopes per kind, the
// same picture for the same patch, and the waveform peaks it hands the kit.
import { describe, expect, it } from "vitest";
import { applyBlipPreset } from "../../../../engine/audio/generators/blipPresets";
import { emptyGeneratorBody } from "../../../../engine/audio/generators/format";
import { applySynthPreset } from "../../../../engine/audio/generators/synthPresets";
import { pictureOf } from "./previewClient";
import { PREVIEW_RATE, renderGeneratorPreview } from "./referenceRender";

const peak = (s: Float32Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe("the preview render", () => {
  it("renders a blip to the end of its envelope, the same every time", () => {
    const coin = applyBlipPreset(emptyGeneratorBody("blip"), "coin", 1734);
    const a = renderGeneratorPreview(coin);
    const env = (coin.params.attack! ** 2 + coin.params.sustain! ** 2 + coin.params.decay! ** 2) * 100000 / PREVIEW_RATE;
    expect(a.seconds).toBeCloseTo(Math.min(2, env), 3);
    expect(a.endless).toBe(false);
    expect(peak(a.samples)).toBeGreaterThan(0.01);
    expect(peak(a.samples)).toBeLessThanOrEqual(1);
    expect(renderGeneratorPreview(coin).samples).toEqual(a.samples);
    expect(a.envelope.length).toBeGreaterThan(2);
  });

  it("keys a finite oscillator off at its length and shows an endless one's first 2 s", () => {
    const g = emptyGeneratorBody("oscillator");
    const finite = renderGeneratorPreview({ ...g, params: { ...g.params, length: 0.5, release: 100 } });
    expect([finite.keyOff, finite.seconds, finite.endless]).toEqual([0.5, 0.6, false]);
    expect(finite.envelope[finite.envelope.length - 1]![1]).toBeCloseTo(0, 9);
    const endless = renderGeneratorPreview(g);
    expect([endless.keyOff, endless.seconds, endless.endless]).toEqual([null, 2, true]);
    expect(peak(endless.samples)).toBeCloseTo(10 ** (-12 / 20), 2);
  });

  it("renders a synth preset, and silence as silence", () => {
    const pluck = renderGeneratorPreview(applySynthPreset(emptyGeneratorBody("synth"), "pluck"));
    expect(pluck.keyOff).toBe(0.6);
    expect(peak(pluck.samples)).toBeGreaterThan(0.01);
    const quiet = renderGeneratorPreview({ ...emptyGeneratorBody("silence"), params: { length: 0.25, lengthRandom: 3 } });
    expect(quiet.seconds).toBe(0.25);
    expect(peak(quiet.samples)).toBe(0);
  });

  it("hands the kit peaks covering every frame", () => {
    const pic = pictureOf(applyBlipPreset(emptyGeneratorBody("blip"), "laser", 9));
    expect(pic.mips.frames).toBe(Math.round(pic.seconds * PREVIEW_RATE));
    expect(pic.mips.levels[0]!.bins).toBe(Math.ceil(pic.mips.frames / 32));
    expect(pic.mips.levels[pic.mips.levels.length - 1]!.bins).toBe(1);
  });
});
