// ADR 0162 D2a: the occlusion pass's pure math (S1 smoothing, ruling D5 wet folding, [ARCH §3.2] lateral rays).
import { describe, expect, it } from "vitest";
import { LATERAL_OFFSET_M, hitWetFactor, lateralAxis, lateralOffset, onePoleCoef, smoothStep, smoothingTau } from "./occlusionMath";

const FRAME_MS = 1000 / 60;

describe("one-pole smoothing (S1)", () => {
  it("has the coefficient 1 − exp(−dt/τ), instant at τ 0, still at dt 0", () => {
    expect(onePoleCoef(FRAME_MS, 100)).toBeCloseTo(0.153518275109386, 12);
    expect(onePoleCoef(FRAME_MS, 50)).toBeCloseTo(0.283468689426211, 12);
    expect(onePoleCoef(FRAME_MS, 400)).toBeCloseTo(0.040810542890862, 12);
    expect(onePoleCoef(FRAME_MS, 0)).toBe(1);
    expect(onePoleCoef(FRAME_MS, NaN)).toBe(1);
    expect(onePoleCoef(0, 100)).toBe(0);
  });

  it("reaches 1 − 1/e of a step after τ (6 frames at 60 Hz, τ 100 ms)", () => {
    const target = Math.pow(10, -30 / 20); // concrete, -30 dB
    let g = 1;
    for (let f = 0; f < 6; f++) g = smoothStep(g, target, FRAME_MS, NaN, NaN, 100, 0);
    expect(g).toBeCloseTo(target + (1 - target) * Math.exp(-1), 9); // 0.387868848
    for (let f = 0; f < 6; f++) g = smoothStep(g, target, FRAME_MS, NaN, NaN, 100, 0);
    expect(g).toBeCloseTo(target + (1 - target) * Math.exp(-2), 9); // 0.162678382
  });

  it("closes on the attack and opens on the release; absent ones take smoothingMs", () => {
    expect(smoothingTau(1, 0.1, 50, 400, 100)).toBe(50);
    expect(smoothingTau(0.1, 1, 50, 400, 100)).toBe(400);
    expect(smoothingTau(1, 0.1, NaN, 400, 100)).toBe(100);
    expect(smoothingTau(0.1, 1, 50, NaN, 100)).toBe(100);
    // One frame each way.
    expect(smoothStep(1, 0, FRAME_MS, 50, 400, 100, 0)).toBeCloseTo(1 - 0.283468689426211, 12);
    expect(smoothStep(0, 1, FRAME_MS, 50, 400, 100, 0)).toBeCloseTo(0.040810542890862, 12);
  });

  it("lands on the target within the snap, and doesn't move with no time", () => {
    expect(smoothStep(0.50005, 0.5, FRAME_MS, NaN, NaN, 100, 1e-4)).toBe(0.5);
    expect(smoothStep(0.9, 0.5, 0, NaN, NaN, 100, 1e-4)).toBe(0.9);
    expect(smoothStep(0.9, 0.5, FRAME_MS, 0, 0, 100, 1e-4)).toBe(0.5); // attack 0: at once
  });
});

describe("wet folding (ruling D5)", () => {
  it("is 1 − (1 − g)·w for one hit", () => {
    expect(hitWetFactor(-30, 0.6)).toBeCloseTo(0.418973665961010, 12);
    expect(hitWetFactor(0, 1)).toBe(1); // a transparent hit
    expect(hitWetFactor(-80, 0)).toBe(1); // removes nothing from the wet path
    expect(hitWetFactor(-80, 1)).toBeCloseTo(1e-4, 12);
  });

  it("multiplies each hit's own factor over a ray", () => {
    // concrete (-30 dB, 0.6) then wood (-12 dB, 0.5)
    expect(hitWetFactor(-30, 0.6) * hitWetFactor(-12, 0.5)).toBeCloseTo(0.262107546314870, 12);
  });
});

describe("lateral rays ([ARCH §3.2])", () => {
  const axis = (dx: number, dy: number, dz: number) => {
    const o = { x: NaN, y: NaN, z: NaN };
    lateralAxis(dx, dy, dz, o);
    return [o.x, o.y, o.z].map((v) => v + 0); // -0 → 0
  };

  it("is dir × up, horizontal and unit", () => {
    expect(axis(0, 0, -1)).toEqual([1, 0, 0]); // looking down −Z: right is +X
    expect(axis(0, 0, 5)).toEqual([-1, 0, 0]);
    expect(axis(2, 0, 0)).toEqual([0, 0, 1]);
    expect(axis(3, 7, 4)).toEqual([-0.8, 0, 0.6]);
  });

  it("takes +X for a vertical or zero ray", () => {
    expect(axis(0, 10, 0)).toEqual([1, 0, 0]);
    expect(axis(0, -1, 0)).toEqual([1, 0, 0]);
    expect(axis(0, 0, 0)).toEqual([1, 0, 0]);
  });

  it("offsets ray 0 none, ray 1 right, ray 2 left by 0.5 m", () => {
    expect(LATERAL_OFFSET_M).toBe(0.5);
    expect([lateralOffset(0), lateralOffset(1), lateralOffset(2)]).toEqual([0, 0.5, -0.5]);
  });
});
