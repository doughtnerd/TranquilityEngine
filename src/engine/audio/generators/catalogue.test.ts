import { describe, expect, it } from "vitest";
import {
  choiceIndex, clampGeneratorParam, defaultGeneratorParams, GENERATOR_CATALOGUE, GENERATOR_PARAM_LIMIT, generatorIsEndless, generatorKindIndex,
  generatorParamIndex, generatorParamSpec, generatorWireValues, isGeneratorKind,
} from "./catalogue";
import { GENERATOR_KINDS } from "./types";

describe("the generator catalogue", () => {
  it("declares every kind, in kind order, with unique parameters within the GEN mask's 32", () => {
    expect(Object.keys(GENERATOR_CATALOGUE)).toEqual([...GENERATOR_KINDS]);
    for (const kind of GENERATOR_KINDS) {
      const names = GENERATOR_CATALOGUE[kind].params.map((q) => q.name);
      expect(names.length).toBeLessThanOrEqual(GENERATOR_PARAM_LIMIT);
      expect(new Set(names).size).toBe(names.length);
      for (const q of GENERATOR_CATALOGUE[kind].params) {
        expect(q.min).toBeLessThan(q.max);
        expect(q.default).toBeGreaterThanOrEqual(q.min);
        expect(q.default).toBeLessThanOrEqual(q.max);
        if (q.choices) {
          expect(q.choiceIds).toHaveLength(q.choices.length);
          expect([q.min, q.max, q.step, q.smooth]).toEqual([0, q.choices.length - 1, 1, false]);
        }
        if (q.scale === "log") expect(q.min).toBeGreaterThan(0);
      }
    }
  });

  it("has exactly ADR 0360's parameters, in its order (the wire order)", () => {
    const names = (k: (typeof GENERATOR_KINDS)[number]) => GENERATOR_CATALOGUE[k].params.map((q) => q.name);
    expect(names("oscillator")).toEqual(["waveform", "noiseColour", "frequency", "pulseWidth", "level", "attack", "decay", "sustain", "release", "length"]);
    expect(names("synth")).toEqual([
      "osc1Wave", "osc2Wave", "osc2Semitones", "detune", "oscMix", "pulseWidth", "frequency", "filterType", "cutoff", "resonance", "filterEnvAmount",
      "filterAttack", "filterDecay", "filterSustain", "filterRelease", "attack", "decay", "sustain", "release", "lfoWave", "lfoRate", "lfoDepth", "lfoTarget",
      "level", "length",
    ]);
    expect(names("blip")).toEqual([
      "waveform", "attack", "sustain", "punch", "decay", "baseFrequency", "frequencyLimit", "slide", "deltaSlide", "vibratoDepth", "vibratoSpeed",
      "arpeggioAmount", "arpeggioSpeed", "duty", "dutySweep", "repeatSpeed", "phaserOffset", "phaserSweep", "lowpassCutoff", "lowpassSweep",
      "lowpassResonance", "highpassCutoff", "highpassSweep", "level",
    ]);
    expect(names("silence")).toEqual(["length", "lengthRandom"]);
    expect([names("synth").length, names("blip").length]).toEqual([25, 24]);
  });

  it("has the record's ranges and defaults", () => {
    expect(generatorParamSpec("oscillator", "frequency")).toMatchObject({ min: 20, max: 20000, default: 440, scale: "log", unit: "Hz" });
    expect(generatorParamSpec("oscillator", "attack")).toMatchObject({ default: 2, max: 5000 });
    expect(generatorParamSpec("oscillator", "release")).toMatchObject({ default: 10, max: 10000 });
    expect(generatorParamSpec("synth", "cutoff")).toMatchObject({ default: 2000, scale: "log" });
    expect(generatorParamSpec("synth", "lfoRate")).toMatchObject({ min: 0.05, max: 20, default: 5, scale: "log" });
    expect(generatorParamSpec("blip", "slide")).toMatchObject({ min: -1, max: 1, default: 0 });
    expect(generatorParamSpec("blip", "lowpassCutoff")?.default).toBe(1);
    expect(generatorParamSpec("silence", "length")?.default).toBe(1);
    expect(generatorParamSpec("blip", "waveform")?.choiceIds).toEqual(["square", "saw", "sine", "noise", "triangle"]);
  });

  it("answers wire indices, kind numbers and wire values", () => {
    expect(generatorParamIndex("oscillator", "frequency")).toBe(2);
    expect(generatorParamIndex("blip", "level")).toBe(23);
    expect(generatorParamIndex("blip", "nope")).toBe(-1);
    expect(GENERATOR_KINDS.map(generatorKindIndex)).toEqual([1, 2, 3, 4]);
    const values = generatorWireValues("oscillator", { frequency: 99999, waveform: 2.6 });
    expect(values).toHaveLength(10);
    expect(values[2]).toBe(20000);
    expect(values[0]).toBe(3);
    expect(values[4]).toBe(-12);
    expect(isGeneratorKind("blip")).toBe(true);
    expect(isGeneratorKind("granular")).toBe(false);
  });

  it("clamps, finds choices and knows endless generators", () => {
    const wave = generatorParamSpec("oscillator", "waveform")!;
    expect(clampGeneratorParam(wave, 9)).toBe(4);
    expect(choiceIndex(wave, "Saw")).toBe(2);
    expect(choiceIndex(wave, "wobble")).toBe(-1);
    expect(generatorIsEndless("oscillator", defaultGeneratorParams("oscillator"))).toBe(true);
    expect(generatorIsEndless("synth", { ...defaultGeneratorParams("synth"), length: 2 })).toBe(false);
    expect(generatorIsEndless("blip", defaultGeneratorParams("blip"))).toBe(false);
    expect(generatorIsEndless("silence", defaultGeneratorParams("silence"))).toBe(false);
  });
});
