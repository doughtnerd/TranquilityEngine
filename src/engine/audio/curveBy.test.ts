import { describe, expect, it } from "vitest";
import { evalCurve, type Curve, type CurveKey } from "../core/curve";
import { curveByProblem, curveByToJson, evalCurveBy, parseCurveBy, secondValueOf, sliceCurveBy, MAX_SLICE_KEYS, type CurveBy } from "./curveBy";
import type { ParameterDef } from "./parameters";

const speed: ParameterDef = { name: "Speed", min: 0, max: 100, default: 0, seekSpeed: 0 };
const surface: ParameterDef = { name: "Surface", labels: ["Dirt", "Gravel", "Wood"], default: "Dirt" };
const at = (def: ParameterDef, v: number) => secondValueOf(def, v);
const low: Curve = [[0, -12], [2, 0]];

/** The slice agrees with the evaluator over the lane's input. */
function agrees(main: Curve, by: CurveBy, s: ReturnType<typeof at>, xs: number[]): void {
  const slice = sliceCurveBy(main, by, s);
  for (const x of xs) expect(evalCurve(slice, x)).toBeCloseTo(evalCurveBy(main, by, x, s), 3);
}

describe("evalCurveBy", () => {
  it("morph blends Low and High by where the second input sits in its range", () => {
    const by: CurveBy = { input: "Speed", mode: "morph", curve: [[0, 0], [2, 6]] };
    expect(evalCurveBy(low, by, 1, at(speed, 0))).toBeCloseTo(-6);
    expect(evalCurveBy(low, by, 1, at(speed, 100))).toBeCloseTo(3);
    expect(evalCurveBy(low, by, 1, at(speed, 50))).toBeCloseTo(-1.5);
    expect(evalCurveBy(low, by, 1, at(speed, 500))).toBeCloseTo(3); // held at the top
  });

  it("scale multiplies the lane by the × curve at the second input (1 without one)", () => {
    const by: CurveBy = { input: "Speed", mode: "scale", curve: [[0, 0.5], [100, 2]] };
    expect(evalCurveBy(low, by, 0, at(speed, 0))).toBeCloseTo(-6);
    expect(evalCurveBy(low, by, 0, at(speed, 100))).toBeCloseTo(-24);
    expect(evalCurveBy(low, { input: "Speed", mode: "scale" }, 0, at(speed, 100))).toBeCloseTo(-12);
  });

  it("rate reads the lane at its time × the rate", () => {
    const by: CurveBy = { input: "Speed", mode: "rate", curve: [[0, 1], [100, 2]] };
    expect(evalCurveBy(low, by, 0.5, at(speed, 0))).toBeCloseTo(-9);
    expect(evalCurveBy(low, by, 0.5, at(speed, 100))).toBeCloseTo(-6);
    expect(evalCurveBy(low, by, 1.5, at(speed, 100))).toBeCloseTo(0); // past the end: held
  });

  it("labels plays the label's curve, the first label (or one without a curve) the lane's", () => {
    const by: CurveBy = { input: "Surface", mode: "labels", labels: { Wood: [[0, 3]] } };
    expect(evalCurveBy(low, by, 0, at(surface, 0))).toBe(-12);
    expect(evalCurveBy(low, by, 0, at(surface, 1))).toBe(-12);
    expect(evalCurveBy(low, by, 0, at(surface, 2))).toBe(3);
    expect(evalCurveBy(low, by, 0, at(surface, 1.6))).toBe(3); // rounded to the nearest label
  });
});

describe("sliceCurveBy", () => {
  const xs = [0, 0.25, 0.5, 1, 1.3, 2, 3];

  it("is the lane itself where the second input changes nothing", () => {
    expect(sliceCurveBy(low, { input: "Speed", mode: "morph", curve: [[0, 0]] }, at(speed, 0))).toBe(low);
    expect(sliceCurveBy(low, { input: "Speed", mode: "scale", curve: [[0, 1]] }, at(speed, 40))).toBe(low);
    expect(sliceCurveBy(low, { input: "Surface", mode: "labels" }, at(surface, 0))).toBe(low);
  });

  it("matches the evaluator in every mode, shapes and Bézier handles included", () => {
    const shaped: Curve = [[0, -12, "smooth"], [1, -3, "bezier", { in: [-0.3, 1], out: [0.3, 2] }], [2, 0, "step"], [3, 4]];
    agrees(shaped, { input: "Speed", mode: "scale", curve: [[0, 0.5], [100, 2]] }, at(speed, 70), xs);
    agrees(shaped, { input: "Speed", mode: "rate", curve: [[0, 0.5], [100, 3]] }, at(speed, 30), xs);
    agrees(shaped, { input: "Surface", mode: "labels", labels: { Gravel: [[0, 1], [3, 2]] } }, at(surface, 1), xs);
    // High copied from Low and moved: blended key by key, exactly.
    const high: Curve = [[0, -6, "smooth"], [1, 0, "bezier", { in: [-0.3, -1], out: [0.3, 0] }], [2, 3, "step"], [3, 6]];
    agrees(shaped, { input: "Speed", mode: "morph", curve: high }, at(speed, 25), xs);
  });

  it("resamples a morph of differently keyed curves within the key limit, steps kept as jumps", () => {
    const main: Curve = [[0, 0, "step"], [1, 10], [4, 0]];
    const high: Curve = [[0, 5], [0.5, 2, "easeIn"], [3, 9]];
    const by: CurveBy = { input: "Speed", mode: "morph", curve: high };
    const slice = sliceCurveBy(main, by, at(speed, 40));
    expect(slice.length).toBeLessThanOrEqual(MAX_SLICE_KEYS);
    for (const x of [0, 0.2, 0.5, 0.9, 1.5, 2.2, 3, 4]) expect(evalCurve(slice, x)).toBeCloseTo(evalCurveBy(main, by, x, at(speed, 40)), 1);
    expect(evalCurve(slice, 0.999)).toBeCloseTo(evalCurveBy(main, by, 0.999, at(speed, 40)), 1);
  });

  it("a morph of two full curves keyed apart is thinned evenly over the whole span, its tail kept", () => {
    // 64 keys each, at different x: 128 distinct x, twice the slice's limit.
    const main: Curve = Array.from({ length: 64 }, (_, i): CurveKey => [i, Math.sin(i / 5) * 10]);
    const high: Curve = Array.from({ length: 64 }, (_, i): CurveKey => [i + 0.5, Math.cos(i / 5) * 10]);
    const by: CurveBy = { input: "Speed", mode: "morph", curve: high };
    const s = at(speed, 50);
    const slice = sliceCurveBy(main, by, s);
    expect(slice.length).toBe(MAX_SLICE_KEYS);
    expect(slice[slice.length - 1]![0]).toBe(63.5);
    // No gap between kept keys wider than a few of the original spacing (0.5): the tail isn't one long line.
    for (let i = 1; i < slice.length; i++) expect(slice[i]![0] - slice[i - 1]![0]).toBeLessThanOrEqual(1.5);
    for (const x of [10, 40, 50, 60]) expect(evalCurve(slice, x)).toBeCloseTo(evalCurveBy(main, by, x, s), 0);
  });
});

describe("the format", () => {
  const read = (raw: unknown, time = true) => {
    const problems: string[] = [];
    const by = parseCurveBy(raw, "by", { time }, (r, w) => (Array.isArray(r) ? (r as Curve) : (problems.push(`${w}: bad`), null)), (w, m) => problems.push(`${w}: ${m}`));
    return { by, problems };
  };

  it("round-trips every mode", () => {
    const all: CurveBy[] = [
      { input: "Speed", mode: "morph", curve: [[0, 1], [2, 3]] },
      { input: "Speed", mode: "scale", curve: [[0, 0.5]] },
      { input: "Speed", mode: "rate", curve: [[0, 2]] },
      { input: "Surface", mode: "labels", labels: { Wood: [[0, 3]] } },
      { input: "Surface", mode: "labels" },
    ];
    for (const by of all) {
      const back = read(JSON.parse(JSON.stringify(curveByToJson(by))));
      expect(back.problems).toEqual([]);
      expect(back.by).toEqual(by);
    }
  });

  it("drops what can't be read, with a problem", () => {
    expect(read("Speed").by).toBeUndefined();
    expect(read({ input: "", mode: "morph" }).by).toBeUndefined();
    expect(read({ input: "Speed", mode: "wobble" }).by).toBeUndefined();
    const rate = read({ input: "Speed", mode: "rate", curve: [[0, 2]] }, false);
    expect(rate.by).toBeUndefined();
    expect(rate.problems.join()).toMatch(/keyed on time/);
    const stray = read({ input: "Surface", mode: "labels", curve: [[0, 1]], labels: { Wood: [] } });
    expect(stray.by).toEqual({ input: "Surface", mode: "labels" });
    expect(stray.problems).toHaveLength(2);
  });

  it("names why a by can't run: an unknown input, labels on a scalar parameter, rate off time", () => {
    expect(curveByProblem({ input: "Nope", mode: "morph" }, undefined, { time: true })).toMatch(/no game parameter/);
    expect(curveByProblem({ input: "Speed", mode: "labels" }, speed, { time: true })).toMatch(/no labels/);
    expect(curveByProblem({ input: "Speed", mode: "rate" }, speed, { time: false })).toMatch(/keyed on time/);
    expect(curveByProblem({ input: "Surface", mode: "labels" }, surface, { time: false })).toBeNull();
  });
});
