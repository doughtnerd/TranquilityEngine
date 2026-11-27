import { describe, expect, it } from "vitest";
import { noise1 } from "./noise";

describe("noise1 (ADR 0436)", () => {
  it("is deterministic, zero on lattice points, bounded and continuous", () => {
    expect(noise1(7, 3.25)).toBe(noise1(7, 3.25));
    expect(noise1(7, 3.25)).not.toBe(noise1(8, 3.25));
    for (let i = -5; i <= 5; i++) expect(noise1(1, i)).toBeCloseTo(0, 12);
    let prev = noise1(3, 0);
    let peak = 0;
    for (let t = 0.001; t < 50; t += 0.001) {
      const v = noise1(3, t);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.01);
      peak = Math.max(peak, Math.abs(v));
      prev = v;
    }
    expect(peak).toBeGreaterThan(0.5);
  });
});
