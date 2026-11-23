import { describe, expect, it } from "vitest";
import { applyBlipPreset } from "./blipPresets";
import { defaultGeneratorParams, generatorParamIndex } from "./catalogue";
import { emptyGenerator, emptyGeneratorBody, formatGenerator, generatorBodyToJson, generatorToJson, isGeneratorPath, parseGenerator, parseGeneratorBody } from "./format";
import { generatedProvenanceToJson, parseGeneratedProvenance } from "./provenance";
import { applySynthPreset } from "./synthPresets";
import { GENERATOR_FORMAT, GENERATOR_KINDS } from "./types";

const ADR_EXAMPLE = {
  format: "myco.generator@1",
  kind: "blip",
  params: { waveform: "square", baseFrequency: 0.42, slide: 0.18, decay: 0.31 },
  seed: 1734,
  preset: "coin",
  vary: 0,
  note: "Shop purchase",
};

describe("myco.generator@1", () => {
  it("reads the record's example: choices by name, missing parameters at their defaults", () => {
    const { generator, problems } = parseGenerator(ADR_EXAMPLE);
    expect(problems).toEqual([]);
    expect(generator).toMatchObject({ format: GENERATOR_FORMAT, kind: "blip", seed: 1734, preset: "coin", vary: 0, note: "Shop purchase" });
    expect(generator.params).toEqual({ ...defaultGeneratorParams("blip"), waveform: 0, baseFrequency: 0.42, slide: 0.18, decay: 0.31 });
    expect(generatorToJson(generator)).toEqual({ ...ADR_EXAMPLE, vary: undefined, params: { baseFrequency: 0.42, decay: 0.31, slide: 0.18 } });
  });

  it("round-trips every kind, presets and embedded bodies", () => {
    const samples = [
      ...GENERATOR_KINDS.map((k) => emptyGenerator(k)),
      { ...emptyGenerator("oscillator"), params: { ...defaultGeneratorParams("oscillator"), waveform: 4, noiseColour: 1, frequency: 123.5, length: 2 }, seed: 0, vary: 0.25 },
      { format: GENERATOR_FORMAT, ...applyBlipPreset(emptyGeneratorBody("blip"), "laser", 99) },
      { format: GENERATOR_FORMAT, ...applySynthPreset(emptyGeneratorBody("synth"), "whoosh"), note: "air" },
    ] as const;
    for (const g of samples) {
      const text = formatGenerator(g);
      const back = parseGenerator(JSON.parse(text));
      expect(back.problems).toEqual([]);
      expect(back.generator).toEqual(g);
      const problems: string[] = [];
      const { format: _format, ...body } = g;
      expect(parseGeneratorBody(generatorBodyToJson(g), "e", problems)).toEqual(body);
      expect(problems).toEqual([]);
    }
    expect(formatGenerator(emptyGenerator("silence"))).toBe('{\n  "format": "myco.generator@1",\n  "kind": "silence"\n}\n');
  });

  it("reports and repairs bad values without throwing", () => {
    const { generator, problems } = parseGenerator({
      kind: "oscillator", params: { waveform: "wobble", frequency: 5, level: "loud", gain: 3 }, seed: -4, preset: "coin", vary: 3, note: 7,
    }, "ui/a.generator.json");
    expect(generator.params.waveform).toBe(0);
    expect(generator.params.frequency).toBe(20);
    expect(generator.params.level).toBe(-12);
    expect(generator.seed).toBeNull();
    expect(generator.preset).toBeUndefined();
    expect(generator.vary).toBe(1);
    expect(generator.note).toBeUndefined();
    expect(problems.every((p) => p.startsWith("ui/a.generator.json: "))).toBe(true);
    expect(problems.join("\n")).toMatch(/format: expected/);
    for (const key of ["waveform", "frequency", "level", "gain", "seed", "preset", "vary", "note"]) expect(problems.join("\n")).toContain(key);
    expect(parseGenerator({ format: GENERATOR_FORMAT, kind: "granular" }).generator.kind).toBe("oscillator");
    expect(parseGenerator({ format: GENERATOR_FORMAT }).problems).toEqual(['kind: missing; using "oscillator".']);
    expect(parseGenerator("nope").problems).toHaveLength(1);
    expect(parseGenerator({ format: GENERATOR_FORMAT, kind: "blip", params: { waveform: 9 } }).generator.params.waveform).toBe(4);
    expect(parseGeneratorBody([], "entries[0].generator", []).kind).toBe("oscillator");
  });

  it("reads choices given as indices and names in any case", () => {
    const g = parseGenerator({ format: GENERATOR_FORMAT, kind: "synth", params: { filterType: "BandPass", lfoTarget: 3 } }).generator;
    expect(g.params.filterType).toBe(2);
    expect(g.params.lfoTarget).toBe(3);
    expect(generatorToJson(g).params).toEqual({ filterType: "bandpass", lfoTarget: "pulseWidth" });
  });

  it("saves `quality` by name, reads it by name or index, and leaves it out at standard (D67)", () => {
    for (const kind of ["oscillator", "synth", "blip"] as const) {
      const high = parseGenerator({ format: GENERATOR_FORMAT, kind, params: { quality: "High" } }).generator;
      expect(high.params.quality).toBe(1);
      expect(generatorToJson(high).params).toEqual({ quality: "high" });
      expect(parseGenerator(generatorToJson(high)).generator).toEqual(high);
      expect(parseGenerator({ format: GENERATOR_FORMAT, kind, params: { quality: 1 } }).generator.params.quality).toBe(1);
      const standard = parseGenerator({ format: GENERATOR_FORMAT, kind, params: {} }).generator;
      expect(standard.params.quality).toBe(0);
      expect(generatorToJson(standard).params ?? {}).toEqual({});
    }
    const bad = parseGenerator({ format: GENERATOR_FORMAT, kind: "blip", params: { quality: "ultra" } });
    expect(bad.generator.params.quality).toBe(0);
    expect(bad.problems.length).toBeGreaterThan(0);
  });

  it("names generator paths", () => {
    expect(isGeneratorPath("audio/ui/Coin.Generator.json")).toBe(true);
    expect(isGeneratorPath("audio/ui/coin.playlist.json")).toBe(false);
    expect(generatorParamIndex("blip", "waveform")).toBe(0);
  });
});

describe("the sidecar's generated block", () => {
  it("round-trips and repairs", () => {
    const block = { generator: "audio/ui/coin.generator.json", hash: "ab12", seed: 1734, variation: 2 };
    const problems: string[] = [];
    expect(parseGeneratedProvenance(generatedProvenanceToJson(block), "generated", problems)).toEqual(block);
    expect(problems).toEqual([]);
    expect(parseGeneratedProvenance(undefined, "generated", problems)).toBeNull();
    expect(parseGeneratedProvenance({ hash: "x" }, "generated", problems)).toBeNull();
    expect(parseGeneratedProvenance({ generator: "a.generator.json", seed: 1.5, variation: -1, hash: 4 }, "generated", problems)).toEqual({ generator: "a.generator.json", hash: "", seed: 0, variation: 0 });
    expect(problems).toHaveLength(4);
  });
});
