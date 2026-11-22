import { describe, expect, it } from "vitest";
import { cutCurve, shiftKey } from "./curveCut";

describe("curve cutting", () => {
  it("cuts a curve with keys holding the value at each cut, keeping keys that sit on a cut", () => {
    expect(cutCurve([[0, 0], [2, 2]], 0.5, 1.5)).toEqual([[0, 0.5], [1, 1.5]]);
    expect(cutCurve([[0, 0], [1, 4, "smooth"], [2, 2]], 1, 2)).toEqual([[0, 4, "smooth"], [1, 2]]);
  });

  it("moves a key along x keeping its shape and handles", () => {
    expect(shiftKey([1, 2, "step"], 0.5)).toEqual([1.5, 2, "step"]);
    const h = { in: [-0.1, 0], out: [0.1, 0] } as const;
    expect(shiftKey([1, 2, "bezier", h], -1)).toEqual([0, 2, "bezier", h]);
  });
});
