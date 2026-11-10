import { describe, expect, it } from "vitest";
import { curveRange, curveShape, evalCurve, parseCurve, type Curve } from "../core/curve";
import { evalCurve as evalParticleCurve, type CurveKey as ParticleKey } from "../scene/particles";

describe("evalCurve", () => {
  it("is 0 when empty and flat beyond the ends", () => {
    expect(evalCurve([], 3)).toBe(0);
    const c: Curve = [[1, 2], [3, 6]];
    expect(evalCurve(c, -5)).toBe(2);
    expect(evalCurve(c, 9)).toBe(6);
    expect(evalCurve(c, NaN)).toBe(2);
  });

  it("interpolates linearly by default", () => {
    expect(evalCurve([[0, 0], [10, 1]], 2.5)).toBeCloseTo(0.25);
    expect(evalCurve([[0, 0], [1, 10], [2, 0]], 1.5)).toBeCloseTo(5);
  });

  it("holds a step until the next key", () => {
    const c: Curve = [[0, 1, "step"], [1, 5]];
    expect(evalCurve(c, 0.999)).toBe(1);
    expect(evalCurve(c, 1)).toBe(5);
  });

  it("shapes smooth, easeIn and easeOut segments", () => {
    expect(evalCurve([[0, 0, "smooth"], [1, 1]], 0.25)).toBeCloseTo(0.15625);
    expect(evalCurve([[0, 0, "easeIn"], [1, 1]], 0.5)).toBeCloseTo(0.25);
    expect(evalCurve([[0, 0, "easeOut"], [1, 1]], 0.5)).toBeCloseTo(0.75);
    for (const s of ["linear", "smooth", "easeIn", "easeOut"] as const) {
      expect(curveShape(s, 0)).toBe(0);
      expect(curveShape(s, 1)).toBe(1);
    }
  });

  it("jumps at keys with the same x", () => {
    const c: Curve = [[0, 0], [1, 1], [1, 4], [2, 4]];
    expect(evalCurve(c, 0.5)).toBeCloseTo(0.5);
    expect(evalCurve(c, 1)).toBe(4);
    expect(evalCurve(c, 1.5)).toBe(4);
  });

  it("matches the particle evaluator on particle curves", () => {
    const keys: ParticleKey[] = [[0, 1], [0.3, 0.2], [0.7, 0.9], [1, 0]];
    for (let t = -0.1; t <= 1.1; t += 0.05) expect(evalCurve(keys, t)).toBeCloseTo(evalParticleCurve(keys, t), 12);
  });

  it("finds the right segment in a long curve", () => {
    const c: [number, number][] = Array.from({ length: 100 }, (_, i) => [i, i * 2]);
    for (const x of [0.5, 17.25, 63.9, 98.5]) expect(evalCurve(c, x)).toBeCloseTo(x * 2);
  });
});

describe("curveRange", () => {
  it("gives the key extremes", () => {
    expect(curveRange([])).toEqual([0, 0]);
    expect(curveRange([[0, 3], [1, -2], [2, 7]])).toEqual([-2, 7]);
  });
});

describe("parseCurve", () => {
  it("keeps good keys and drops bad ones with problems", () => {
    const problems: string[] = [];
    const c = parseCurve([[0, 1], [1, "x"], [2, 3, "smooth"], [3, 4, "wobble"], "no"], "c", problems);
    expect(c).toEqual([[0, 1], [2, 3, "smooth"], [3, 4]]);
    expect(problems).toHaveLength(3);
  });

  it("sorts keys by x, stably", () => {
    const problems: string[] = [];
    expect(parseCurve([[2, 0], [1, 5], [1, 6]], "c", problems)).toEqual([[1, 5], [1, 6], [2, 0]]);
    expect(problems).toEqual(["c: keys were not in x order; sorted."]);
  });

  it("drops an explicit linear interp and refuses non-lists", () => {
    const problems: string[] = [];
    expect(parseCurve([[0, 0, "linear"]], "c", problems)).toEqual([[0, 0]]);
    expect(parseCurve({}, "c", problems)).toBeNull();
    expect(problems).toHaveLength(1);
  });
});
