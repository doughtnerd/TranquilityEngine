import { describe, expect, it } from "vitest";
import { colorFromHex, frameView, MAX_PITCH, moveOrbit, orbitOf, orbitPosition, seededRandom, previewPixels } from "../render/thumbnailMath";

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

describe("preview orbit (ADR 0061)", () => {
  it("round-trips a camera position through its orbit", () => {
    const target = [1, 2, 3];
    const o = orbitOf([4, 6, 7], target);
    const p = orbitPosition(target, o);
    expect(p[0]).toBeCloseTo(4);
    expect(p[1]).toBeCloseTo(6);
    expect(p[2]).toBeCloseTo(7);
    expect(o.distance).toBeCloseTo(Math.hypot(3, 4, 4));
  });

  it("turns, keeps the pitch off the poles, and clamps the zoom", () => {
    const o = { yaw: 0, pitch: 0, distance: 5 };
    const turned = moveOrbit(o, 0.5, 10, 1, 1, 10);
    expect(turned.yaw).toBeCloseTo(0.5);
    expect(turned.pitch).toBeCloseTo(MAX_PITCH);
    expect(moveOrbit(o, 0, -10, 1, 1, 10).pitch).toBeCloseTo(-MAX_PITCH);
    expect(moveOrbit(o, 0, 0, 0.01, 1, 10).distance).toBe(1);
    expect(moveOrbit(o, 0, 0, 100, 1, 10).distance).toBe(10);
    expect(moveOrbit(o, 0, 0, 0, 1, 10).distance).toBe(5); // a zero zoom factor leaves it alone
  });
});

describe("previewPixels", () => {
  it("keeps the canvas's shape, scaling both sides by one factor under the cap", () => {
    expect(previewPixels(1200, 560, 768)).toEqual([768, 358]);
    expect(previewPixels(560, 1200, 768)).toEqual([358, 768]);
  });
  it("leaves canvases within the cap alone, and never goes below 1 x 1", () => {
    expect(previewPixels(400, 300, 768)).toEqual([400, 300]);
    expect(previewPixels(0, 0, 768)).toEqual([1, 1]);
  });
});
