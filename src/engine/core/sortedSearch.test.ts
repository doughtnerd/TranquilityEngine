import { describe, expect, it } from "vitest";
import { firstAfter, firstAtOrAfter, lastAtOrBefore } from "./sortedSearch";

describe("sortedSearch", () => {
  const a = Float64Array.of(1, 2, 2, 2.5, 3, 4);

  it("lastAtOrBefore is the value in force at t, -1 before the first", () => {
    expect([0.5, 1, 1.9, 2, 2.5, 3.9, 9].map((t) => lastAtOrBefore(a, t))).toEqual([-1, 0, 0, 2, 3, 4, 5]);
    expect(lastAtOrBefore(new Float64Array(0), 1)).toBe(-1);
  });

  it("firstAtOrAfter and firstAfter bound equal runs from either side; n when none", () => {
    expect([0, 2, 2.2, 4, 5].map((t) => firstAtOrAfter(a, t))).toEqual([0, 1, 3, 5, 6]);
    expect([0, 2, 2.2, 4, 5].map((t) => firstAfter(a, t))).toEqual([0, 3, 3, 6, 6]);
  });

  it("searches only the first n values when n is given", () => {
    expect(lastAtOrBefore(a, 9, 3)).toBe(2);
    expect(firstAtOrAfter(a, 3, 3)).toBe(3);
    expect(firstAfter([5, 6], 0, 0)).toBe(0);
  });
});
