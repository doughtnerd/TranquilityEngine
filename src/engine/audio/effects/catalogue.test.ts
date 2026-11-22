import { describe, expect, it } from "vitest";
import {
  allowedAt, clampEffectParam, defaultEffect, EFFECT_CATALOGUE, EFFECT_LEVELS, effectParamValue, effectSpec, effectToJson, effectTypesAt,
  isEffectType, parseEffect, parseEffects,
} from "./catalogue";
import { EFFECT_TYPES } from "./types";

describe("the effect catalogue", () => {
  it("declares every type once, with sane parameter rows", () => {
    expect(Object.keys(EFFECT_CATALOGUE).sort()).toEqual([...EFFECT_TYPES].sort());
    for (const type of EFFECT_TYPES) {
      const s = effectSpec(type);
      expect(s.type).toBe(type);
      expect(s.levels.length).toBeGreaterThan(0);
      expect(s.version).toBe("1");
      const names = s.params.map((q) => q.name);
      expect(new Set(names).size).toBe(names.length);
      for (const q of s.params) {
        expect(q.min).toBeLessThan(q.max);
        expect(q.default).toBeGreaterThanOrEqual(q.min);
        expect(q.default).toBeLessThanOrEqual(q.max);
        expect(q.step).toBeGreaterThan(0);
        if (q.scale === "log") expect(q.min).toBeGreaterThan(0);
      }
    }
  });

  it("matches the ADR 0331 table's ranges and levels", () => {
    const eq = effectSpec("eq");
    expect(eq.params.map((q) => [q.name, q.min, q.max])).toEqual([["low", -18, 18], ["mid", -18, 18], ["high", -18, 18]]);
    expect(eq.levels).toEqual(EFFECT_LEVELS);
    expect(effectSpec("lowpass").params[0]).toMatchObject({ name: "cutoff", min: 20, max: 20000, unit: "Hz", scale: "log", default: 20000 });
    expect(effectSpec("compressor").params.map((q) => q.name)).toEqual(["threshold", "ratio", "attack", "release", "makeup"]);
    expect(effectSpec("sidechainCompressor")).toMatchObject({ levels: ["bus"], key: "bus" });
    expect(effectSpec("limiter").params[0]).toMatchObject({ name: "ceiling", min: -12, max: 0, unit: "dBTP" });
    expect(effectSpec("delay").params[1]).toMatchObject({ name: "feedback", max: 95 });
    expect(effectSpec("reverb").params[1]).toMatchObject({ name: "decay", min: 0.1, max: 20, unit: "s" });
    expect(effectSpec("reverse").params).toEqual([]);
  });

  it("says where each type may run", () => {
    expect(allowedAt("gain", "sample")).toBe(true);
    expect(allowedAt("gain", "bus")).toBe(false);
    expect(allowedAt("delay", "voice")).toBe(false);
    expect(allowedAt("delay", "instance")).toBe(true);
    expect(allowedAt("envelope", "voice")).toBe(true);
    expect(allowedAt("envelope", "instance")).toBe(false);
    expect(effectTypesAt("sample")).toEqual(["eq", "lowpass", "highpass", "bandpass", "compressor", "gain", "saturation", "distortion", "bitcrush", "formantShift", "pitchShift", "fades", "noiseReduction", "reverse"]);
    expect(effectTypesAt("bus")).toContain("limiter");
    expect(effectTypesAt("bus")).not.toContain("fades");
  });

  it("knows its type names", () => {
    expect(isEffectType("chorus")).toBe(true);
    expect(isEffectType("lpf")).toBe(false);
    expect(isEffectType(3)).toBe(false);
  });
});

describe("parseEffect", () => {
  it("fills missing parameters with defaults", () => {
    const problems: string[] = [];
    const fx = parseEffect({ id: "a", type: "lowpass", params: { cutoff: 800 } }, "voice", "fx", problems);
    expect(fx).toEqual({ id: "a", type: "lowpass", on: true, params: { cutoff: 800, resonance: 0.1, drive: 0 } });
    expect(problems).toEqual([]);
  });

  it("drops an unknown type with one problem", () => {
    const problems: string[] = [];
    expect(parseEffect({ type: "flanger" }, "bus", "fx[0]", problems)).toBeNull();
    expect(problems).toEqual(['fx[0]: unknown effect type "flanger"; dropped.']);
    expect(parseEffect("eq", "bus", "fx[1]", problems)).toBeNull();
    expect(problems).toHaveLength(2);
  });

  it("clamps out-of-range values, defaults bad ones and drops unknown params", () => {
    const problems: string[] = [];
    const fx = parseEffect({ id: "c", type: "compressor", on: "yes", params: { threshold: -90, ratio: "x", knee: 3 } }, "bus", "fx", problems)!;
    expect(fx.on).toBe(true);
    expect(fx.params.threshold).toBe(-60);
    expect(fx.params.ratio).toBe(3);
    expect(fx.params.knee).toBeUndefined();
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain('Compressor has no parameter "knee"');
  });

  it("keeps an effect at a level it can't run at, with a problem", () => {
    const problems: string[] = [];
    const fx = parseEffect({ id: "d", type: "delay" }, "voice", "clip.effects[0]", problems);
    expect(fx?.type).toBe("delay");
    expect(problems).toEqual(["clip.effects[0]: Delay can't run at the voice level (it runs at instance, bus); kept but it won't play there."]);
  });

  it("reads a sidechain key and refuses keys elsewhere", () => {
    const problems: string[] = [];
    expect(parseEffect({ id: "s", type: "sidechainCompressor", key: "Dialogue" }, "bus", "fx", problems)?.key).toBe("Dialogue");
    expect(parseEffect({ id: "s", type: "sidechainCompressor" }, "bus", "fx", problems)?.key).toBe("");
    expect(parseEffect({ id: "e", type: "eq", key: "Dialogue" }, "bus", "fx", problems)?.key).toBeUndefined();
    expect(problems).toEqual(["fx.key: EQ takes no key bus; dropped."]);
  });
});

describe("parseEffects", () => {
  it("makes ids unique and caps the chain", () => {
    const problems: string[] = [];
    const chain = parseEffects([{ id: "a", type: "eq" }, { id: "a", type: "gain" }, { type: "fades" }, { type: "nope" }, { type: "reverse" }], "sample", "effects", problems, 3);
    expect(chain.map((e) => e.id)).toEqual(["a", "fx1", "fx2"]);
    expect(problems).toHaveLength(4);
  });

  it("reads a non-list as empty", () => {
    const problems: string[] = [];
    expect(parseEffects({}, "bus", "effects", problems)).toEqual([]);
    expect(problems).toEqual(["effects: must be a list; ignored."]);
    expect(parseEffects(undefined, "bus", "effects", problems)).toEqual([]);
  });
});

describe("effectToJson", () => {
  it("writes only non-default parameters and round-trips", () => {
    for (const type of EFFECT_TYPES) {
      const fx = defaultEffect(type, "x");
      const json = effectToJson(fx);
      expect(json.params).toBeUndefined();
      expect(parseEffect(json, "sample", "fx", [])).toEqual(fx);
    }
    const fx = { id: "b", type: "bitcrush" as const, on: false, params: { bits: 8, downsample: 1, mix: 50 } };
    expect(effectToJson(fx)).toEqual({ id: "b", type: "bitcrush", on: false, params: { bits: 8, mix: 50 } });
    expect(parseEffect(effectToJson(fx), "bus", "fx", [])).toEqual(fx);
    const sc = { ...defaultEffect("sidechainCompressor", "k"), key: "Dialogue" };
    expect(effectToJson(sc).key).toBe("Dialogue");
    expect(parseEffect(effectToJson(sc), "bus", "fx", [])).toEqual(sc);
  });
});

describe("effectParamValue and clampEffectParam", () => {
  it("reads own values, falls back to defaults, and knows unknown names", () => {
    const fx = { id: "a", type: "delay" as const, on: true, params: { time: 500 } };
    expect(effectParamValue(fx, "time")).toBe(500);
    expect(effectParamValue(fx, "feedback")).toBe(30);
    expect(effectParamValue(fx, "cutoff")).toBeUndefined();
  });

  it("clamps and snaps switches", () => {
    const q = effectSpec("eq").params[0];
    expect(clampEffectParam(q, 40)).toBe(18);
    expect(clampEffectParam({ ...q, min: 0, max: 1, bool: true }, 0.7)).toBe(1);
  });
});
