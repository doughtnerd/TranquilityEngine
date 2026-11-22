import { describe, expect, it } from "vitest";
import { applyBlipPreset, BLIP_PRESETS, blipPreset, mutateBlip, randomiseBlip } from "./blipPresets";
import { GENERATOR_CATALOGUE } from "./catalogue";
import { emptyGeneratorBody, generatorToJson, parseGenerator } from "./format";
import { applySynthPreset, SYNTH_PRESETS, synthPreset } from "./synthPresets";
import type { GeneratorBody } from "./types";

/** True when `params` is a valid, canonical patch of `kind`: re-parsing its file gives it back with no problem. */
function expectValid(body: GeneratorBody): void {
  const read = parseGenerator(generatorToJson(body));
  expect(read.problems).toEqual([]);
  expect(read.generator.params).toEqual(body.params);
  expect(Object.keys(body.params)).toEqual(GENERATOR_CATALOGUE[body.kind].params.map((q) => q.name));
}

describe("blip presets", () => {
  it("are the record's eight", () => {
    expect(BLIP_PRESETS.map((p) => p.label)).toEqual(["Coin", "Jump", "Laser", "Hit", "Power-up", "Blip", "Explosion", "Random"]);
  });

  it("produce valid patches over many seeds", () => {
    for (const { id } of BLIP_PRESETS) {
      for (let seed = 0; seed < 64; seed++) expectValid(applyBlipPreset(emptyGeneratorBody("blip"), id, seed * 7919));
    }
  });

  it("follow sfxr's shapes", () => {
    for (let seed = 1; seed < 40; seed++) {
      const coin = blipPreset("coin", seed);
      expect(coin.baseFrequency).toBeGreaterThanOrEqual(0.4);
      expect(coin.punch).toBeGreaterThanOrEqual(0.3);
      expect(blipPreset("explosion", seed).waveform).toBe(3); // noise
      expect(blipPreset("jump", seed).slide).toBeGreaterThan(0);
      expect(blipPreset("hit", seed).slide).toBeLessThan(0);
      expect(blipPreset("blip", seed).highpassCutoff).toBeCloseTo(0.1);
    }
  });

  it("give the same parameters for the same preset and seed, and others for another seed", () => {
    for (const { id } of BLIP_PRESETS) {
      expect(blipPreset(id, 1734)).toEqual(blipPreset(id, 1734));
    }
    expect(blipPreset("random", 1)).not.toEqual(blipPreset("random", 2));
    expect(blipPreset("laser", 1)).not.toEqual(blipPreset("laser", 2));
  });

  it("are stable across runs (golden)", () => {
    const coin = blipPreset("coin", 1734);
    expect(coin.waveform).toBe(0);
    expect(coin.attack).toBe(0);
    // Pinned values: a change here changes every saved patch's Randomise; it must be deliberate.
    expect([coin.baseFrequency, coin.sustain, coin.decay, coin.punch].map((v) => Number(v.toFixed(6)))).toEqual([0.511508, 0.005849, 0.403168, 0.448238]);
  });
});

describe("Randomise, Mutate and locks", () => {
  const coin = applyBlipPreset(emptyGeneratorBody("blip"), "coin", 1734);

  it("Randomise is deterministic per seed and moves to a new seed", () => {
    const a = randomiseBlip(coin), b = randomiseBlip(coin);
    expect(a).toEqual(b);
    expect(a.seed).not.toBe(coin.seed);
    expect(a.preset).toBe("coin");
    expect(a.params).toEqual(blipPreset("coin", a.seed!));
    expect(randomiseBlip({ ...coin, seed: 1 }).params).not.toEqual(randomiseBlip({ ...coin, seed: 2 }).params);
    expectValid(a);
  });

  it("Mutate is deterministic per seed, nudges by at most 0.05 and carries the next seed", () => {
    const a = mutateBlip(coin), b = mutateBlip(coin);
    expect(a).toEqual(b);
    expect(a.seed).not.toBe(coin.seed);
    expect(mutateBlip(a)).not.toEqual(a);
    let moved = 0;
    for (const q of GENERATOR_CATALOGUE.blip.params) {
      expect(Math.abs(a.params[q.name] - coin.params[q.name])).toBeLessThanOrEqual(0.05 + 1e-12);
      if (a.params[q.name] !== coin.params[q.name]) moved++;
    }
    expect(moved).toBeGreaterThan(0);
    expect(a.params.waveform).toBe(coin.params.waveform);
    expect(a.params.level).toBe(coin.params.level);
    expectValid(a);
  });

  it("locks keep chosen values and change no other parameter", () => {
    const tuned: GeneratorBody = { ...coin, params: { ...coin.params, baseFrequency: 0.9, decay: 0.05, level: -3 } };
    const free = randomiseBlip(tuned);
    const locked = randomiseBlip(tuned, ["baseFrequency", "decay"]);
    expect(locked.params.baseFrequency).toBe(0.9);
    expect(locked.params.decay).toBe(0.05);
    expect(locked.params.level).toBe(-3);
    expect({ ...locked.params, baseFrequency: 0, decay: 0 }).toEqual({ ...free.params, baseFrequency: 0, decay: 0 });

    const mFree = mutateBlip(tuned), mLocked = mutateBlip(tuned, ["baseFrequency"]);
    expect(mLocked.params.baseFrequency).toBe(0.9);
    expect({ ...mLocked.params, baseFrequency: 0 }).toEqual({ ...mFree.params, baseFrequency: 0 });
  });

  it("a non-blip body becomes a blip and keeps nothing", () => {
    const osc = emptyGeneratorBody("oscillator");
    const b = applyBlipPreset(osc, "jump", 5, ["frequency"]);
    expect(b.kind).toBe("blip");
    expect(b.params).toEqual(blipPreset("jump", 5));
    expect(mutateBlip(osc).kind).toBe("blip");
  });
});

describe("synth presets", () => {
  it("are the record's eight and produce valid patches", () => {
    expect(SYNTH_PRESETS.map((p) => p.label)).toEqual(["Beep", "Click", "Pluck", "Bass", "Lead", "Pad", "Drone", "Whoosh"]);
    for (const { id } of SYNTH_PRESETS) expectValid(applySynthPreset(emptyGeneratorBody("synth"), id));
    expect(synthPreset("whoosh")).toMatchObject({ osc1Wave: 4, oscMix: 0, filterType: 2 });
  });

  it("keep locked parameters and the level", () => {
    const pad = { ...applySynthPreset(emptyGeneratorBody("synth"), "pad"), params: { ...synthPreset("pad"), cutoff: 333, level: -6 } };
    const lead = applySynthPreset(pad, "lead", ["cutoff"]);
    expect(lead).toMatchObject({ preset: "lead", params: { cutoff: 333, level: -6, lfoTarget: 0 } });
  });
});
