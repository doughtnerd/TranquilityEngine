import { describe, expect, it } from "vitest";
import { colorFromHex, frameView, seededRandom } from "../render/thumbnailMath";

describe("thumbnail framing (ADR 0061)", () => {
  it("looks at the bounds' centre from the given direction, far enough to fit them", () => {
    const v = frameView({ min: [-1, 0, -1], max: [1, 2, 1] }, 30, [0, 0, 2]);
    expect(v.target).toEqual([0, 1, 0]);
    expect(v.position[0]).toBeCloseTo(0);
    expect(v.position[1]).toBeCloseTo(1);
    const radius = Math.sqrt(3);
    const distance = v.position[2];
    // The bounding sphere fits inside the field of view.
    expect(Math.asin(radius / distance)).toBeLessThan((15 * Math.PI) / 180);
    expect(v.near).toBeGreaterThan(0);
    expect(v.near).toBeLessThan(distance - radius);
    expect(v.far).toBeGreaterThan(distance + radius);
  });

  it("scales with the bounds and survives a point", () => {
    const small = frameView({ min: [0, 0, 0], max: [1, 1, 1] }, 30, [1, 1, 1]);
    const big = frameView({ min: [0, 0, 0], max: [10, 10, 10] }, 30, [1, 1, 1]);
    const dist = (p: number[], t: number[]) => Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    expect(dist(big.position, big.target)).toBeCloseTo(dist(small.position, small.target) * 10, 5);
    const point = frameView({ min: [2, 2, 2], max: [2, 2, 2] }, 30, [0, 1, 0]);
    expect(Number.isFinite(point.position[1])).toBe(true);
  });
});

describe("seeded random", () => {
  it("repeats for a seed, differs between seeds, and stays in [0, 1)", () => {
    const a = seededRandom(1), b = seededRandom(1), c = seededRandom(2);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe("sprite colours", () => {
  it("reads #rrggbb[aa], white otherwise", () => {
    expect(colorFromHex("#ff8000")).toBe(0xff8000);
    expect(colorFromHex("#ff800080")).toBe(0xff8000);
    expect(colorFromHex("nope")).toBe(0xffffff);
  });
});
