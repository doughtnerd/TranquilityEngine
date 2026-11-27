import { describe, expect, it } from "vitest";
import { IMPULSE_SHAPES } from "./presets";
import { addImpulse, strengthAt, zero6 } from "./signal";

describe("camera shake signal (ADR 0435)", () => {
  it("is full strength within the radius and fades smoothly to zero over the dissipation distance", () => {
    expect(strengthAt(5, 10, 20)).toBe(1);
    expect(strengthAt(20, 10, 20)).toBeCloseTo(0.5);
    expect(strengthAt(30, 10, 20)).toBe(0);
    expect(strengthAt(11, 10, 0)).toBe(0);
  });

  it("moves a directional preset along its velocity, only within its duration", () => {
    const out = zero6();
    addImpulse(out, IMPULSE_SHAPES.recoil, 0.016, 0.2, 0, -2, 0, 1, 1);
    expect(out[1]).toBeLessThan(0);
    expect(out[0]).toBe(0);
    expect(out[3]).toBeGreaterThan(0); // pitched toward the push
    const after = zero6();
    addImpulse(after, IMPULSE_SHAPES.recoil, 0.25, 0.2, 0, -2, 0, 1, 1);
    expect(after).toEqual(zero6());
  });
});
