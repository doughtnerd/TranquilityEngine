import { describe, expect, it } from "vitest";
import { CURVE_KEY_INTERPS, curveKeyInterpCode, curveRange, curveShape, curveToJson, evalCurve, parseCurve, type Curve, type CurveKey } from "../core/curve";
import type { CurveKey as ParticleKey } from "../scene/particles";

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

  it("evaluates particle curves (linear [t, v] keys): flat beyond the ends, linear between keys", () => {
    const keys: ParticleKey[] = [[0, 1], [0.3, 0.2], [0.7, 0.9], [1, 0]];
    expect(evalCurve(keys, -0.1)).toBe(1);
    expect(evalCurve(keys, 0.15)).toBeCloseTo(0.6, 12);
    expect(evalCurve(keys, 0.5)).toBeCloseTo(0.55, 12);
    expect(evalCurve(keys, 0.85)).toBeCloseTo(0.45, 12);
    expect(evalCurve(keys, 1.1)).toBe(0);
  });

  it("finds the right segment in a long curve", () => {
    const c: [number, number][] = Array.from({ length: 100 }, (_, i) => [i, i * 2]);
    for (const x of [0.5, 17.25, 63.9, 98.5]) expect(evalCurve(c, x)).toBeCloseTo(x * 2);
  });
});

describe("evalCurve with Bézier keys (ADR 0346)", () => {
  const third = 1 / 3;

  it("is smoothstep for a flat third-long out handle into a plain key (the next key's handle is the flat third)", () => {
    const c: Curve = [[0, 0, "bezier", { in: [0, 0], out: [third, 0] }], [1, 1]];
    for (const x of [0.1, 0.25, 0.5, 0.8]) expect(evalCurve(c, x)).toBeCloseTo(x * x * (3 - 2 * x), 7);
    expect(evalCurve(c, 0)).toBe(0);
    expect(evalCurve(c, 1)).toBe(1);
  });

  it("is linear when every control point lies on the line, whatever their spacing", () => {
    const c: Curve = [[0, 0, "bezier", { in: [0, 0], out: [0.5, 0.5] }], [3, 3, "bezier", { in: [-0.25, -0.25], out: [0, 0] }]];
    for (const x of [0.3, 1, 1.7, 2.9]) expect(evalCurve(c, x)).toBeCloseTo(x, 7);
  });

  it("uses the key's out handle and the next key's in handle, and ignores free", () => {
    const a: Curve = [[0, 0, "bezier", { in: [0, 0], out: [0.25, 0.75] }], [1, 1, "bezier", { in: [-0.25, 0.25], out: [0, 0] }]];
    const b: Curve = [[0, 0, "bezier", { in: [-5, 9], out: [0.25, 0.75], free: true }], [1, 1, "bezier", { in: [-0.25, 0.25], out: [7, 7] }]];
    expect(evalCurve(a, 0.4)).toBeGreaterThan(0.4); // pulled up by both handles
    expect(evalCurve(b, 0.4)).toBe(evalCurve(a, 0.4));
  });

  it("clamps control x into the segment, so the curve stays a function of x and can overshoot in y", () => {
    const c: Curve = [[0, 0, "bezier", { in: [0, 0], out: [9, 2] }], [1, 1, "bezier", { in: [-9, 2], out: [0, 0] }]];
    // Controls (1, 2) and (0, 3): t = 0.5 sits at x 0.5, y 2. x(t) is flat there (dx/dt = 0, the steepest the clamp
    // allows), so bisection on x pins t less tightly than elsewhere.
    expect(evalCurve(c, 0.5)).toBeCloseTo(2, 4);
    let last = -Infinity;
    for (let x = 0; x <= 1; x += 0.01) {
      const y = evalCurve(c, x);
      expect(Number.isFinite(y)).toBe(true);
      if (x > 0.6) { expect(y).toBeLessThanOrEqual(last + 1e-9); last = y; } else last = y;
    }
  });

  it("holds before the first key and after the last, and jumps at equal x", () => {
    const c: Curve = [[1, 2, "bezier", { in: [-1, 5], out: [1, 5] }], [2, 4, "bezier", { in: [-1, 5], out: [1, 5] }], [2, 9], [3, 9]];
    expect(evalCurve(c, 0)).toBe(2);
    expect(evalCurve(c, 2)).toBe(9);
    expect(evalCurve(c, 5)).toBe(9);
  });

  it("codes bezier as interp 5, after the shapes", () => {
    expect(CURVE_KEY_INTERPS.indexOf("bezier")).toBe(5);
    expect(curveKeyInterpCode([0, 0, "bezier", { in: [0, 0], out: [0, 0] }])).toBe(5);
    expect(curveKeyInterpCode([0, 0, "easeOut"])).toBe(4);
    expect(curveKeyInterpCode([0, 0])).toBe(0);
  });
});

describe("curveRange", () => {
  it("gives the key extremes", () => {
    expect(curveRange([])).toEqual([0, 0]);
    expect(curveRange([[0, 3], [1, -2], [2, 7]])).toEqual([-2, 7]);
  });

  it("covers a Bézier segment's control points (the curve stays inside them)", () => {
    expect(curveRange([[0, 0, "bezier", { in: [0, 0], out: [0.3, 2] }], [1, 1, "bezier", { in: [-0.3, -1.5], out: [0.3, 9] }]])).toEqual([-0.5, 2]);
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

  it("reads Bézier keys with their handles and free flag", () => {
    const problems: string[] = [];
    const c = parseCurve([[0, 0, "bezier", { in: [-1, 0], out: [1, 2], free: true }], [3, 1, "bezier", { in: [-1, -1], out: [1, 0] }]], "c", problems);
    expect(c).toEqual([[0, 0, "bezier", { in: [-1, 0], out: [1, 2], free: true }], [3, 1, "bezier", { in: [-1, -1], out: [1, 0] }]]);
    expect(problems).toEqual([]);
  });

  it("gives a Bézier key's missing or bad handles the flat third-of-segment default, after sorting, with a problem each", () => {
    const problems: string[] = [];
    const c = parseCurve([[6, 1], [3, 0, "bezier", { in: [1, "no"], out: [2, 1], free: "yes" }], [0, 2, "bezier"]], "c", problems);
    expect(c).toEqual([
      [0, 2, "bezier", { in: [0, 0], out: [1, 0] }],
      [3, 0, "bezier", { in: [-1, 0], out: [2, 1] }],
      [6, 1],
    ]);
    expect(problems).toEqual([
      "c[1].in: a handle must be [dx, dy] with finite numbers; using a flat handle.",
      "c[1].free: must be true or false; dropped.",
      "c[2]: a bezier key needs { in: [dx, dy], out: [dx, dy] }; using flat handles.",
      "c: keys were not in x order; sorted.",
    ]);
  });

  it("drops an explicit linear interp and refuses non-lists", () => {
    const problems: string[] = [];
    expect(parseCurve([[0, 0, "linear"]], "c", problems)).toEqual([[0, 0]]);
    expect(parseCurve({}, "c", problems)).toBeNull();
    expect(problems).toHaveLength(1);
  });
});

describe("curveToJson", () => {
  it("writes the canonical JSON form, which parseCurve reads back unchanged with no problems", () => {
    const c: CurveKey[] = [[0, 1], [1, 2, "smooth"], [2, 3, "bezier", { in: [-0.5, 0], out: [0.5, 1] }], [3, 0, "bezier", { in: [-0.2, 0.1], out: [0, 0], free: true }], [4, 4, "linear"]];
    const json = curveToJson(c);
    expect(json).toEqual([[0, 1], [1, 2, "smooth"], [2, 3, "bezier", { in: [-0.5, 0], out: [0.5, 1] }], [3, 0, "bezier", { in: [-0.2, 0.1], out: [0, 0], free: true }], [4, 4]]);
    const problems: string[] = [];
    expect(parseCurve(JSON.parse(JSON.stringify(json)), "c", problems)).toEqual(json);
    expect(problems).toEqual([]);
  });
});
