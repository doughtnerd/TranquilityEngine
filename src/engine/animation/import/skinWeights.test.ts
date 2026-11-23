// ADR 0371: skin influences per vertex: 4 by default or 8, merged, the smallest dropped first, normalised.
import { describe, expect, it } from "vitest";
import { limitInfluences } from "./skinWeights";

const near = (a: ArrayLike<number>, b: readonly number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 6));

describe("limitInfluences", () => {
  it("keeps 4: normalises, sorts largest first and drops the smallest past the limit", () => {
    const sets = [
      { size: 4, joints: [0, 1, 2, 3], weights: [0.1, 0.4, 0.2, 0.05] },
      { size: 4, joints: [4, 5, 0, 0], weights: [0.3, 0.02, 0, 0] },
    ];
    const r = limitInfluences(1, sets, 4);
    expect(Array.from(r.joints)).toEqual([1, 4, 2, 0]);
    near(r.weights, [0.4 / 1.0, 0.3 / 1.0, 0.2 / 1.0, 0.1 / 1.0]);
    expect(r.truncated).toBe(1);
  });

  it("keeps 8 when asked", () => {
    const sets = [
      { size: 4, joints: [0, 1, 2, 3], weights: [1, 1, 1, 1] },
      { size: 4, joints: [4, 5, 6, 7], weights: [1, 1, 1, 1] },
    ];
    const r = limitInfluences(1, sets, 8);
    expect(r.influences).toBe(8);
    expect(Array.from(r.joints)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    near(r.weights, new Array(8).fill(0.125));
    expect(r.truncated).toBe(0);
  });

  it("merges a joint listed twice and binds a weightless vertex fully to its first joint", () => {
    const r = limitInfluences(2, [{ size: 2, joints: [3, 3, 7, 2], weights: [0.25, 0.25, 0, 0] }], 4);
    expect(Array.from(r.joints)).toEqual([3, 0, 0, 0, 7, 0, 0, 0]);
    near(r.weights, [1, 0, 0, 0, 1, 0, 0, 0]);
  });
});
