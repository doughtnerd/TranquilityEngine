import { describe, expect, it } from "vitest";
import { evalCurve } from "../../core/curve";
import { combineCurves, gainToDb, mapCurve, ratioToSemitones, SILENT_DB, tidy } from "./units";

describe("migration units", () => {
  it("converts gains to dB and ratios to semitones", () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(2)).toBe(6.021);
    expect(gainToDb(0)).toBe(SILENT_DB);
    expect(gainToDb(1e-9)).toBe(SILENT_DB);
    expect(ratioToSemitones(2)).toBe(12);
    expect(ratioToSemitones(0.5)).toBe(-12);
    expect(ratioToSemitones(0)).toBe(0);
    expect(tidy(-0.0001)).toBe(0);
    expect(Object.is(tidy(-0.0001), 0)).toBe(true);
  });

  it("maps a curve's values, resampling non-step segments when the map isn't linear", () => {
    const curve = [[0, 0.5], [1, 1, "smooth"], [2, 0.25, "step"], [3, 1]] as const;
    const out = mapCurve(curve, gainToDb, true);
    // Every original key is kept; the step segment has no interior keys and keeps its interp.
    expect(out.filter((k) => [0, 1, 2, 3].includes(k[0]))).toEqual([[0, -6.021], [1, 0], [2, -12.041, "step"], [3, 0]]);
    // Interior samples follow the original shape (smoothstep), in dB.
    expect(out.find((k) => k[0] === 1.5)).toEqual([1.5, gainToDb(evalCurve(curve, 1.5))]);
    expect(out).toHaveLength(10);
    // A linear map keeps the keys and their interps as they are.
    expect(mapCurve(curve, (y) => y * 2, false)).toEqual([[0, 1], [1, 2, "smooth"], [2, 0.5, "step"], [3, 2]]);
  });

  it("caps the keys", () => {
    const long = Array.from({ length: 40 }, (_, i) => [i, 1] as const);
    expect(mapCurve(long, gainToDb, true, 64)).toHaveLength(40 + 0); // no room for interior samples (24 spare / 39 segments)
    expect(mapCurve(long, gainToDb, true, 32)).toHaveLength(32);
  });

  it("combines two curves on the union of their keys", () => {
    expect(combineCurves([[0, 0], [2, -6]], [[1, -3]], (a, b) => a + b)).toEqual([[0, -3], [1, -6], [2, -9]]);
  });
});
