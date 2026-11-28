import { describe, expect, it } from "vitest";
import { reachRadii, ringWire } from "./reachRings";

describe("shake impulse source reach rings", () => {
  it("adds the dissipation distance to the radius, never below 0", () => {
    expect(reachRadii(2, 10)).toEqual({ radius: 2, outer: 12 });
    expect(reachRadii(-1, -5)).toEqual({ radius: 0, outer: 0 });
    expect(reachRadii(Number.NaN, 3)).toEqual({ radius: 0, outer: 3 });
  });

  it("draws one XY circle in 2D and three great circles in 3D, at the radius around the centre", () => {
    const flat = ringWire([1, 2, 3], 4, true);
    expect(flat).toHaveLength(1);
    for (const [x, y, z] of flat[0]!) {
      expect(Math.hypot(x - 1, y - 2)).toBeCloseTo(4);
      expect(z).toBeCloseTo(3);
    }
    const sphere = ringWire([0, 0, 0], 2, false);
    expect(sphere).toHaveLength(3);
    for (const ring of sphere) for (const p of ring) expect(Math.hypot(...p)).toBeCloseTo(2);
  });

  it("draws nothing for a zero radius", () => {
    expect(ringWire([0, 0, 0], 0, false)).toEqual([]);
  });
});
