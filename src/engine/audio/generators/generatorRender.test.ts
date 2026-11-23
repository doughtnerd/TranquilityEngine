// ADR 0360 §6, §8: a generator rendered through the committed offline module (`myco_offline_generate`, offline ABI 1.2):
// lengths (length then release, a blip's envelope, a silence, an endless render and its loops), levels, seeds as the
// runtime resolves them, pitch and lanes.
import { describe, expect, it } from "vitest";
import { defaultGeneratorParams, generatorWireValues } from "./catalogue";
import { emptyGeneratorBody } from "./format";
import { ENDLESS_RENDER_SECONDS, LOOP_CROSSFADE_SECONDS, renderGenerator, renderResolvedGenerator } from "./generatorRender";
import { mulberry32 } from "./random";
import { resolveGenerator } from "./resolve";
import type { GeneratorBody, GeneratorKind } from "./types";

const RATE = 48000;

const body = (kind: GeneratorKind, params: Record<string, number> = {}, over: Partial<GeneratorBody> = {}): GeneratorBody => ({
  ...emptyGeneratorBody(kind),
  params: { ...defaultGeneratorParams(kind), ...params },
  ...over,
});
const peak = (x: Float32Array, from = 0, to = x.length) => x.subarray(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: Float32Array, from = 0, to = x.length) => Math.sqrt(x.subarray(from, to).reduce((s, v) => s + v * v, 0) / Math.max(1, to - from));
const crossings = (x: Float32Array, from: number, to: number) => {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1]! < 0 && x[i]! >= 0) n++;
  return n;
};

describe("renderGenerator", () => {
  it("renders an oscillator at its level until its length, then through its release", async () => {
    // A sine at -6 dB keyed off at 0.25 s with a 100 ms release.
    const r = await renderGenerator(body("oscillator", { level: -6, length: 0.25, release: 100 }, { seed: 5 }));
    expect(r.rate).toBe(RATE);
    expect(r.endless).toBe(false);
    expect(r.loop).toBeNull();
    expect(r.pcm.length).toBe(r.frames);
    expect(peak(r.pcm, RATE * 0.1, RATE * 0.24)).toBeCloseTo(Math.pow(10, -6 / 20), 2);
    expect(rms(r.pcm, RATE * 0.1, RATE * 0.24)).toBeCloseTo(Math.pow(10, -6 / 20) / Math.SQRT2, 2);
    // It ends after its release (to -60 dB by 1.5 × 100 ms), not before.
    expect(r.frames).toBeGreaterThan(RATE * 0.25 + RATE * 0.1);
    expect(r.frames).toBeLessThan(RATE * 0.25 + RATE * 0.2);
    expect(peak(r.pcm, RATE * 0.25 + 4800)).toBeLessThan(0.02);
    expect(crossings(r.pcm, 0, RATE * 0.2)).toBeGreaterThanOrEqual(87);
    expect(crossings(r.pcm, 0, RATE * 0.2)).toBeLessThanOrEqual(89);
  });

  it("renders a blip to the end of its envelope and a silence as its length of zeros", async () => {
    // sfxr ticks: sustain 0.3 → 9,000, decay 0.4 → 16,000 (+3) at 44.1 kHz ≈ 0.567 s.
    const blip = await renderGenerator(body("blip", {}, { seed: 1 }));
    expect(blip.frames / RATE).toBeGreaterThan(0.5);
    expect(blip.frames / RATE).toBeLessThan(0.6);
    expect(peak(blip.pcm)).toBeGreaterThan(0.1);
    const silence = await renderGenerator(body("silence", { length: 0.5 }, { seed: 1 }));
    expect(silence.frames).toBe(RATE / 2);
    expect(peak(silence.pcm)).toBe(0);
  });

  it("renders an endless generator for its seconds, plain or as a loop crossfaded over 50 ms", async () => {
    const tone = body("oscillator", { waveform: 2, frequency: 220 }, { seed: 3 });
    const plain = await renderGenerator(tone);
    expect(plain.endless).toBe(true);
    expect(plain.frames).toBe(ENDLESS_RENDER_SECONDS * RATE);
    expect(plain.loop).toBeNull();
    const x = LOOP_CROSSFADE_SECONDS * RATE;
    const buffer = await renderGenerator(tone, undefined, { seconds: 1, loop: "buffer" });
    expect(buffer.frames).toBe(RATE);
    expect(buffer.loop).toEqual({ start: 0, end: RATE });
    const region = await renderGenerator(tone, undefined, { seconds: 1, loop: "region" });
    expect(region.frames).toBe(RATE + x);
    expect(region.loop).toEqual({ start: x, end: RATE + x });
    // Seamless: the step across the wrap is no bigger than the waveform's own steps.
    const maxStep = (p: Float32Array, from: number, to: number) => {
      let m = 0;
      for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(p[i]! - p[i - 1]!));
      return m;
    };
    const own = maxStep(plain.pcm, RATE / 2, RATE) + 1e-3;
    expect(Math.abs(buffer.pcm[0]! - buffer.pcm[RATE - 1]!)).toBeLessThan(own * 1.5);
    expect(Math.abs(region.pcm[x]! - region.pcm[RATE + x - 1]!)).toBeLessThan(own * 1.5);
    // A region loop keeps the start as rendered.
    expect(Array.from(region.pcm.subarray(0, x))).toEqual(Array.from(plain.pcm.subarray(0, x)));
  });

  it("draws the seed as resolveGenerator does, and the same seed renders the same noise", async () => {
    const noise = body("oscillator", { waveform: 4, length: 0.1 }, { seed: null });
    const a = await renderGenerator(noise, mulberry32(7));
    const want = resolveGenerator(noise, mulberry32(7));
    expect(a.seed).toBe(want.seed);
    expect(a.values).toEqual(want.values);
    const b = await renderGenerator(noise, mulberry32(7));
    expect(Array.from(b.pcm)).toEqual(Array.from(a.pcm));
    const c = await renderGenerator(noise, mulberry32(8));
    expect(c.seed).not.toBe(a.seed);
    expect(Array.from(c.pcm)).not.toEqual(Array.from(a.pcm));
  });

  it("transposes by pitch and follows a frequency lane in log space", async () => {
    const values = generatorWireValues("oscillator", { ...defaultGeneratorParams("oscillator"), frequency: 200, length: 1 });
    const resolved = { kind: "oscillator" as const, values, seed: 1 };
    const up = await renderResolvedGenerator(resolved, { pitch: 2 });
    expect(crossings(up.pcm, 0, RATE / 2)).toBeGreaterThanOrEqual(199);
    expect(crossings(up.pcm, 0, RATE / 2)).toBeLessThanOrEqual(201);
    const swept = await renderResolvedGenerator(resolved, { lanes: [{ target: "frequency", curve: [[0, 200], [1, 800]] }] });
    // Halfway in log space is 400 Hz, not 500.
    expect(crossings(swept.pcm, RATE * 0.45, RATE * 0.55)).toBeGreaterThanOrEqual(38);
    expect(crossings(swept.pcm, RATE * 0.45, RATE * 0.55)).toBeLessThanOrEqual(42);
    const unknown = await renderResolvedGenerator(resolved, { lanes: [{ target: "cutoff", curve: [[0, 1]] }] });
    expect(unknown.warnings).toEqual(['The oscillator generator has no parameter "cutoff"; its lane wasn\'t rendered.']);
  });
});
