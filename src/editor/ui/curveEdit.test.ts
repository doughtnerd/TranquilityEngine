import { describe, expect, it } from "vitest";
import type { Curve } from "../../engine/core/curve";
import { addKey, axisTicks, curveSamples, fitYRange, moveKey, pixelToX, pixelToY, removeKey, setKeyInterp, xToPixel, yToPixel } from "./curveEdit";

describe("curve keys (ported from the particle editor)", () => {
  it.skip("adds keys in order and clamps t", () => {
    const { keys, index } = addKey([[0, 0], [1, 1]] as [number, number][], 0.5, 3);
    expect(keys).toEqual([[0, 0], [0.5, 3], [1, 1]]);
    expect(index).toBe(1);
    expect(addKey(keys, 2, 9).keys[3]).toEqual([1, 9]);
    expect(addKey(keys, -1, 9).keys.map((k) => k[0])).toEqual([0, 0, 0.5, 1]);
  });
  it.skip("moves keys but not past their neighbours", () => {
    const keys: [number, number][] = [[0, 0], [0.5, 1], [1, 2]];
    expect(moveKey(keys, 1, 0.7, 5)).toEqual([[0, 0], [0.7, 5], [1, 2]]);
    expect(moveKey(keys, 1, 2, 5)[1][0]).toBe(1);
    expect(moveKey(keys, 1, -2, 5)[1][0]).toBe(0);
    expect(moveKey(keys, 0, -1, 0)[0][0]).toBe(0);
    expect(keys[1]).toEqual([0.5, 1]);
  });
  it.skip("never removes the last key", () => {
    expect(removeKey([[0, 1], [1, 2]] as [number, number][], 0)).toEqual([[1, 2]]);
    expect(removeKey([[0.3, 1]] as [number, number][], 0)).toEqual([[0.3, 1]]);
  });
  it.skip("gives display ranges with padding, and for flat curves", () => {
    const [lo, hi] = fitYRange([[0, 0], [1, 10]]);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(10);
    const [flo, fhi] = fitYRange([[0, 2], [1, 2]]);
    expect(flo).toBeLessThan(2);
    expect(fhi).toBeGreaterThan(2);
    expect(fitYRange([[0, 5]], 0, 1)).toEqual([0, 1]);
  });
});

describe("an arbitrary x range", () => {
  it.skip("adds and clamps keys within [0, 30]", () => {
    expect(addKey([[0, 0], [30, 1]] as [number, number][], 12, 0.5, [0, 30]).keys).toEqual([[0, 0], [12, 0.5], [30, 1]]);
    expect(addKey([[0, 0], [30, 1]] as [number, number][], 99, 0.5, [0, 30]).keys[2]).toEqual([30, 0.5]);
  });
  it.skip("clamps keys into a range that doesn't start at 0", () => {
    expect(addKey([] as [number, number][], -5, 1, [-2, 2]).keys).toEqual([[-2, 1]]);
    expect(moveKey([[-2, 0], [0, 1], [2, 0]] as [number, number][], 1, 9, 1, [-2, 2])[1][0]).toBe(2);
  });
  it.skip("maps x to pixels and back over the range", () => {
    expect(xToPixel(15, [0, 30], 10, 110)).toBe(60);
    expect(xToPixel(-2, [-2, 2], 6, 194)).toBe(6);
    expect(pixelToX(60, [0, 30], 10, 110)).toBe(15);
    expect(pixelToX(500, [0, 30], 10, 110)).toBe(30);
    expect(pixelToX(-500, [0, 30], 10, 110)).toBe(0);
    expect(xToPixel(5, [3, 3], 10, 110)).toBe(10);
    expect(pixelToX(50, [3, 3], 10, 110)).toBe(3);
  });
  it.skip("maps y with the low end at the bottom", () => {
    expect(yToPixel(0, [0, 1], 6, 74)).toBe(74);
    expect(yToPixel(1, [0, 1], 6, 74)).toBe(6);
    expect(pixelToY(40, [0, 1], 6, 74)).toBeCloseTo(0.5);
    expect(pixelToY(-100, [0, 1], 6, 74)).toBeGreaterThan(1);
  });
  it.skip("picks nice grid lines inside the range", () => {
    expect(axisTicks([0, 1], 4)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(axisTicks([0, 30], 4)).toEqual([10, 20]);
    expect(axisTicks([3, 3], 4)).toEqual([]);
    expect(axisTicks([0, 1], 0)).toEqual([]);
  });
});

describe("per-segment interpolation", () => {
  it.skip("sets a key's interp without touching the others or the input", () => {
    const curve: Curve = [[0, 0], [1, 1], [2, 0]];
    const next = setKeyInterp(curve, 1, "smooth");
    expect(next).toEqual([[0, 0], [1, 1, "smooth"], [2, 0]]);
    expect(curve).toEqual([[0, 0], [1, 1], [2, 0]]);
  });
  it.skip("stores linear as the plain two-number form", () => {
    expect(setKeyInterp([[0, 0, "step"], [1, 1]], 0, "linear")).toEqual([[0, 0], [1, 1]]);
    expect(setKeyInterp([[0, 0], [1, 1]], 5, "step")).toEqual([[0, 0], [1, 1]]);
  });
  it.skip("keeps a key's interp when it moves", () => {
    expect(moveKey([[0, 0, "step"], [1, 1]] as Curve[number][], 0, 0.2, 3, [0, 1])).toEqual([[0.2, 3, "step"], [1, 1]]);
  });
  it.skip("gives an added key the interp of the key before it", () => {
    expect(addKey([[0, 0, "smooth"], [1, 1]] as Curve[number][], 0.5, 0.2).keys[1]).toEqual([0.5, 0.2, "smooth"]);
    expect(addKey([[0.5, 0, "smooth"], [1, 1]] as Curve[number][], 0.1, 0.2).keys[0]).toEqual([0.1, 0.2]);
  });
});

describe("curveSamples", () => {
  it.skip("samples evenly and includes the keys", () => {
    const pts = curveSamples([[0, 0], [0.3, 1], [1, 0]], 5);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([1, 0]);
    expect(pts.some((p) => p[0] === 0.3 && p[1] === 1)).toBe(true);
    expect(pts.map((p) => p[0])).toEqual([...pts.map((p) => p[0])].sort((a, b) => a - b));
  });
  it.skip("draws a step square", () => {
    const pts = curveSamples([[0, 0, "step"], [1, 1]], 3);
    expect(pts).toContainEqual([1, 0]);
    expect(pts).toContainEqual([1, 1]);
  });
  it.skip("is empty for an empty curve and follows the x range", () => {
    expect(curveSamples([], 5)).toEqual([]);
    expect(curveSamples([[0, 1], [10, 1]], 3, [0, 10]).map((p) => p[0])).toEqual([0, 5, 10]);
  });
});
