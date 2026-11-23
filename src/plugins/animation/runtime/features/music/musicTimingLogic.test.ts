// T72: the time maths of musical timing (which boundary, when a held action is due, how far into its clip a play starts).
import { describe, expect, it } from "vitest";
import { boundaryAtOrAfter, boundaryPeriod, hitLead, isDue, startShift } from "./musicTimingLogic";

describe("boundaryPeriod", () => {
  it("is a beat or a bar of beats at the tempo", () => {
    expect(boundaryPeriod("beat", 120, 4)).toBe(0.5);
    expect(boundaryPeriod("bar", 120, 4)).toBe(2);
    expect(boundaryPeriod("bar", 90, 3)).toBeCloseTo(2, 12);
  });
  it("is NaN without a tempo or a metre", () => {
    expect(boundaryPeriod("beat", 0, 4)).toBeNaN();
    expect(boundaryPeriod("bar", 120, 0)).toBeNaN();
    expect(boundaryPeriod("beat", Number.NaN, 4)).toBeNaN();
  });
});

describe("boundaryAtOrAfter", () => {
  it("is the next grid point when it is early enough", () => {
    expect(boundaryAtOrAfter(2, 2, 1.2)).toBe(2);
    expect(boundaryAtOrAfter(2, 2, 2)).toBe(2);
  });
  it("moves on by whole periods to the first point at or after the earliest", () => {
    expect(boundaryAtOrAfter(2, 2, 2.1)).toBe(4);
    expect(boundaryAtOrAfter(0.5, 0.5, 1.75)).toBe(2);
    expect(boundaryAtOrAfter(0.5, 0.5, 2)).toBe(2); // exactly on a point
  });
  it("is NaN without a next point, or without a period when the next point is too early", () => {
    expect(boundaryAtOrAfter(Number.NaN, 2, 0)).toBeNaN();
    expect(boundaryAtOrAfter(2, Number.NaN, 3)).toBeNaN();
    expect(boundaryAtOrAfter(2, 0, 3)).toBeNaN();
  });
});

describe("hitLead", () => {
  it("is the heard time from the start to the first hit at or after it, playing forward", () => {
    expect(hitLead([0.5, 1.2], 0, 1)).toBe(0.5);
    expect(hitLead([0.5, 1.2], 0.6, 1)).toBeCloseTo(0.6, 12);
    expect(hitLead([0.5], 0, 2)).toBe(0.25);
    expect(hitLead([0.5], 0.5, 1)).toBe(0);
  });
  it("is the time back to the last hit at or before the start, playing backward", () => {
    expect(hitLead([0.5, 1.2], 2, -1)).toBeCloseTo(0.8, 12);
    expect(hitLead([0.5, 1.2], 1, -2)).toBe(0.25);
  });
  it("is null when the play reaches no hit, or doesn't move", () => {
    expect(hitLead([], 0, 1)).toBeNull();
    expect(hitLead([0.5], 0.6, 1)).toBeNull();
    expect(hitLead([0.5], 0, 0)).toBeNull();
  });
});

describe("isDue", () => {
  it("is due once the clock reaches the boundary less the lead", () => {
    expect(isDue(1.9, 2, 0)).toBe(false);
    expect(isDue(2, 2, 0)).toBe(true);
    expect(isDue(1.49, 2, 0.5)).toBe(false);
    expect(isDue(1.5, 2, 0.5)).toBe(true);
  });
});

describe("startShift", () => {
  it("is the heard lateness in clip seconds at the play's speed", () => {
    expect(startShift(2.01, 2, 1)).toBeCloseTo(0.01, 12);
    expect(startShift(2.01, 2, 2)).toBeCloseTo(0.02, 12);
    expect(startShift(2.01, 2, -1)).toBeCloseTo(-0.01, 12);
  });
  it("is 0 when the play isn't late", () => {
    expect(startShift(1.99, 2, 1)).toBe(0);
    expect(startShift(Number.NaN, 2, 1)).toBe(0);
  });
  it("adds heard seconds skipped on purpose (a hit that couldn't be waited for)", () => {
    expect(startShift(2.01, 2, 1, 0.5)).toBeCloseTo(0.51, 12);
    expect(startShift(2.01, 2, 2, 0.5)).toBeCloseTo(1.02, 12);
  });
});
