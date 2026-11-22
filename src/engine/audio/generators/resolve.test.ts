import { describe, expect, it } from "vitest";
import { applyBlipPreset } from "./blipPresets";
import { defaultGeneratorParams, generatorParamIndex, generatorWireValues, GENERATOR_CATALOGUE } from "./catalogue";
import { emptyGeneratorBody } from "./format";
import { mulberry32 } from "./random";
import { generatorPatchText, resolveGenerator, VARY_SPAN, varyGeneratorParams } from "./resolve";
import type { GeneratorBody } from "./types";

/** A draw that records how many times it was called. */
function counted(seed: number) {
  const draw = mulberry32(seed);
  const c = { n: 0, draw: () => (c.n++, draw()) };
  return c;
}

describe("vary", () => {
  const blip = applyBlipPreset(emptyGeneratorBody("blip"), "coin", 1734);

  it("plays the stored patch at 0, with no draws", () => {
    const c = counted(1);
    expect(varyGeneratorParams("blip", blip.params, 0, c.draw)).toEqual(blip.params);
    expect(c.n).toBe(0);
  });

  it("moves each number by up to vary × 5 % of its range, deterministically per seed", () => {
    const a = varyGeneratorParams("blip", blip.params, 1, mulberry32(9));
    expect(varyGeneratorParams("blip", blip.params, 1, mulberry32(9))).toEqual(a);
    expect(varyGeneratorParams("blip", blip.params, 1, mulberry32(10))).not.toEqual(a);
    for (const q of GENERATOR_CATALOGUE.blip.params) {
      if (q.choices) expect(a[q.name]).toBe(blip.params[q.name]);
      else expect(Math.abs(a[q.name] - blip.params[q.name])).toBeLessThanOrEqual(VARY_SPAN * (q.max - q.min) + 1e-9);
    }
  });

  it("moves a log parameter by a ratio, and never length", () => {
    const osc = { ...defaultGeneratorParams("oscillator"), frequency: 100, length: 2 };
    for (let s = 0; s < 20; s++) {
      const v = varyGeneratorParams("oscillator", osc, 1, mulberry32(s));
      expect(v.length).toBe(2);
      expect(Math.abs(Math.log(v.frequency / 100))).toBeLessThanOrEqual(VARY_SPAN * Math.log(1000) + 1e-9);
    }
  });

  it("locks keep values without moving any other parameter's draw", () => {
    const free = varyGeneratorParams("blip", blip.params, 1, mulberry32(3));
    const locked = varyGeneratorParams("blip", blip.params, 1, mulberry32(3), ["decay"]);
    expect(locked.decay).toBe(blip.params.decay);
    expect({ ...locked, decay: 0 }).toEqual({ ...free, decay: 0 });
  });
});

describe("resolveGenerator", () => {
  it("keeps a fixed seed and draws one when the seed is null", () => {
    const fixed: GeneratorBody = { ...emptyGeneratorBody("oscillator"), seed: 42 };
    const c = counted(5);
    expect(resolveGenerator(fixed, c.draw)).toEqual({ kind: "oscillator", seed: 42, values: generatorWireValues("oscillator", fixed.params) });
    expect(c.n).toBe(0);
    const drawn = resolveGenerator(emptyGeneratorBody("oscillator"), mulberry32(5));
    expect(drawn.seed).toBe(resolveGenerator(emptyGeneratorBody("oscillator"), mulberry32(5)).seed);
    expect(Number.isInteger(drawn.seed) && drawn.seed >= 0 && drawn.seed <= 0xffffffff).toBe(true);
  });

  it("draws a silence's length within ± lengthRandom and sends lengthRandom 0", () => {
    const silence: GeneratorBody = { ...emptyGeneratorBody("silence"), params: { length: 2, lengthRandom: 0.5 }, seed: 1 };
    const li = generatorParamIndex("silence", "length"), ri = generatorParamIndex("silence", "lengthRandom");
    const seen = new Set<number>();
    for (let s = 0; s < 30; s++) {
      const r = resolveGenerator(silence, mulberry32(s));
      expect(r.values[li]).toBeGreaterThanOrEqual(1.5);
      expect(r.values[li]).toBeLessThanOrEqual(2.5);
      expect(r.values[ri]).toBe(0);
      seen.add(r.values[li]);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("patch text follows the stored patch, not formatting or vary", () => {
    const a = applyBlipPreset(emptyGeneratorBody("blip"), "coin", 1);
    expect(generatorPatchText({ ...a, note: "x", vary: 0.5 })).toBe(generatorPatchText(a));
    expect(generatorPatchText({ ...a, params: { ...a.params, decay: 0.01 } })).not.toBe(generatorPatchText(a));
    expect(generatorPatchText({ ...a, seed: 2 })).not.toBe(generatorPatchText(a));
  });
});
