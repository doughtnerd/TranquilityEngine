import { describe, expect, it } from "vitest";
import { evalCurve } from "../../core/curve";
import {
  applyAttenuationPreset, ATTENUATION_FLOOR_DB, attenuationAssetToJson, attenuationPresetCurve, attenuationToJson, defaultAttenuation,
  parseAttenuation, parseAttenuationAsset, PRESET_KEYS, stretchAttenuation,
} from "./format";
import { ATTENUATION_FORMAT } from "./types";

const ADR_EXAMPLE = {
  format: "myco.attenuation@1", minDistance: 2, maxDistance: 40,
  curves: { volume: [[0, 0], [2, 0], [40, -60, "easeOut"]], lowpass: [[0, 20000], [40, 2000]], reverbSend: [[0, 0], [40, -6]], spread: [[0, 180], [40, 20]] },
};

describe("parseAttenuationAsset", () => {
  it("reads the ADR 0347 example without problems and writes it back unchanged", () => {
    const { attenuation, problems } = parseAttenuationAsset(ADR_EXAMPLE);
    expect(problems).toEqual([]);
    expect(attenuation.minDistance).toBe(2);
    expect(attenuation.curves.volume).toEqual([[0, 0], [2, 0], [40, -60, "easeOut"]]);
    expect(attenuationAssetToJson(attenuation)).toEqual(ADR_EXAMPLE);
  });

  it("flags a wrong format but reads on", () => {
    const { attenuation, problems } = parseAttenuationAsset({ ...ADR_EXAMPLE, format: "myco.attenuation@9" }, "a.attenuation.json");
    expect(problems).toEqual(['a.attenuation.json: format: expected "myco.attenuation@1", found "myco.attenuation@9"; reading it anyway.']);
    expect(attenuation.format).toBe(ATTENUATION_FORMAT);
    expect(attenuation.maxDistance).toBe(40);
  });

  it("falls back to flat attenuation for a non-object", () => {
    const { attenuation, problems } = parseAttenuationAsset(7);
    expect(attenuation).toEqual({ format: ATTENUATION_FORMAT, ...defaultAttenuation() });
    expect(problems).toHaveLength(1);
  });
});

describe("parseAttenuation", () => {
  it("fixes distances, clamps keys, drops unknown curves", () => {
    const problems: string[] = [];
    const att = parseAttenuation({ minDistance: 10, maxDistance: 5, curves: { volume: [[-1, 0], [20, -200]], loudness: [[0, 1]], spread: "wide" } }, "spatial.attenuation", problems);
    expect(att.minDistance).toBe(10);
    expect(att.maxDistance).toBe(20);
    expect(att.curves.volume).toEqual([[0, 0], [20, -144]]);
    expect(att.curves.spread).toBeUndefined();
    expect(problems).toHaveLength(4);
  });

  it("drops empty curves and treats missing ones as flat", () => {
    const att = parseAttenuation({ curves: { volume: [] } }, "a", []);
    expect(att.curves).toEqual({});
    expect(att).toEqual(defaultAttenuation());
  });

  it("caps curves at 64 keys", () => {
    const problems: string[] = [];
    const keys = Array.from({ length: 70 }, (_, i) => [i, -i / 2]);
    expect(parseAttenuation({ curves: { volume: keys } }, "a", problems).curves.volume).toHaveLength(64);
    expect(problems).toEqual(["a.curves.volume: at most 64 keys; the rest are dropped."]);
  });

  it("round-trips through attenuationToJson", () => {
    const att = parseAttenuation(ADR_EXAMPLE, "a", []);
    expect(parseAttenuation(attenuationToJson(att), "a", [])).toEqual(att);
  });
});

describe("presets", () => {
  it("inverse square writes 6 keys of −20·log10(d/min) tapered to the floor at max", () => {
    const c = attenuationPresetCurve("inverseSquare", 2, 40);
    expect(c).toHaveLength(PRESET_KEYS);
    expect(c[0]).toEqual([2, 0]);
    expect(c[c.length - 1]).toEqual([40, ATTENUATION_FLOOR_DB]);
    for (const k of c.slice(1, -1)) expect(k[1]).toBeCloseTo(-20 * Math.log10(k[0] / 2), 2);
    expect(c.every((k, i) => i === 0 || k[0] > c[i - 1][0])).toBe(true);
  });

  it("inverse holds the law's value at max and clamps at the floor", () => {
    const c = attenuationPresetCurve("inverse", 1, 2000);
    expect(c[c.length - 1]).toEqual([2000, ATTENUATION_FLOOR_DB]);
    const d = attenuationPresetCurve("inverse", 2, 40);
    expect(d[d.length - 1][1]).toBeCloseTo(-26.021, 2);
  });

  it("linear follows the engine's linear gain law", () => {
    const c = attenuationPresetCurve("linear", 0, 10);
    expect(c[0]).toEqual([0, 0]);
    expect(c[1][0]).toBe(2);
    expect(c[1][1]).toBeCloseTo(20 * Math.log10(0.8), 2);
    expect(c[c.length - 1]).toEqual([10, ATTENUATION_FLOOR_DB]);
  });

  it("exponential is a straight dB line", () => {
    expect(attenuationPresetCurve("exponential", 1, 30)).toEqual([[1, 0], [30, ATTENUATION_FLOOR_DB]]);
  });

  it("logarithmic presets with min 0 still write finite keys", () => {
    const c = attenuationPresetCurve("inverse", 0, 10);
    expect(c.every((k) => Number.isFinite(k[0]) && Number.isFinite(k[1]))).toBe(true);
  });

  it("applyAttenuationPreset replaces only the volume curve", () => {
    const att = parseAttenuation(ADR_EXAMPLE, "a", []);
    const next = applyAttenuationPreset(att, "linear");
    expect(next.curves.lowpass).toBe(att.curves.lowpass);
    expect(next.curves.volume).toEqual(attenuationPresetCurve("linear", 2, 40));
  });
});

describe("stretchAttenuation", () => {
  it("moves keys with the Min and Max handles", () => {
    const att = parseAttenuation(ADR_EXAMPLE, "a", []);
    const s = stretchAttenuation(att, 4, 80);
    expect(s.minDistance).toBe(4);
    expect(s.maxDistance).toBe(80);
    expect(s.curves.volume).toEqual([[0, 0], [4, 0], [80, -60, "easeOut"]]);
    expect(s.curves.lowpass).toEqual([[0, 20000], [80, 2000]]);
    // The shape between Min and Max is kept: halfway stays halfway.
    expect(evalCurve(s.curves.lowpass!, 40)).toBeCloseTo(evalCurve(att.curves.lowpass!, 20), 6);
  });

  it("shifts keys beyond Max and scales keys inside Min", () => {
    const att = { minDistance: 2, maxDistance: 10, curves: { volume: [[1, 0], [6, -10], [20, -40]] as const } };
    const s = stretchAttenuation(att, 4, 20);
    expect(s.curves.volume).toEqual([[2, 0], [12, -10], [30, -40]]);
  });

  it("keeps Max beyond Min and Min non-negative", () => {
    const s = stretchAttenuation(defaultAttenuation(), -5, -10);
    expect(s.minDistance).toBe(0);
    expect(s.maxDistance).toBeGreaterThan(0);
  });
});
