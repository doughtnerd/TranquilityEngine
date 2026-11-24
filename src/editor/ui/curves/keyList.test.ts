import { describe, expect, it } from "vitest";
import type { Curve } from "../../../engine/core/curve";
import { addKey, axisTicks, copyKeysAt, fitYRange, moveKey, pasteKeys, pixelToX, pixelToY, removeKey, removeKeys, rippleKeys, scaleKeys, setKeyInterp, shiftKeys, xToPixel, yToPixel } from "./keyList";

describe("curve keys (ported from the particle editor)", () => {
  it("adds keys in order and clamps t", () => {
    const { keys, index } = addKey([[0, 0], [1, 1]] as [number, number][], 0.5, 3);
    expect(keys).toEqual([[0, 0], [0.5, 3], [1, 1]]);
    expect(index).toBe(1);
    expect(addKey(keys, 2, 9).keys[3]).toEqual([1, 9]);
    expect(addKey(keys, -1, 9).keys.map((k) => k[0])).toEqual([0, 0, 0.5, 1]);
  });
  it("moves keys but not past their neighbours", () => {
    const keys: [number, number][] = [[0, 0], [0.5, 1], [1, 2]];
    expect(moveKey(keys, 1, 0.7, 5)).toEqual([[0, 0], [0.7, 5], [1, 2]]);
    expect(moveKey(keys, 1, 2, 5)[1][0]).toBe(1);
    expect(moveKey(keys, 1, -2, 5)[1][0]).toBe(0);
    expect(moveKey(keys, 0, -1, 0)[0][0]).toBe(0);
    expect(keys[1]).toEqual([0.5, 1]);
  });
  it("never removes the last key", () => {
    expect(removeKey([[0, 1], [1, 2]] as [number, number][], 0)).toEqual([[1, 2]]);
    expect(removeKey([[0.3, 1]] as [number, number][], 0)).toEqual([[0.3, 1]]);
  });
  it("gives display ranges with padding, and for flat curves", () => {
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
  it("adds and clamps keys within [0, 30]", () => {
    expect(addKey([[0, 0], [30, 1]] as [number, number][], 12, 0.5, [0, 30]).keys).toEqual([[0, 0], [12, 0.5], [30, 1]]);
    expect(addKey([[0, 0], [30, 1]] as [number, number][], 99, 0.5, [0, 30]).keys[2]).toEqual([30, 0.5]);
  });
  it("clamps keys into a range that doesn't start at 0", () => {
    expect(addKey([] as [number, number][], -5, 1, [-2, 2]).keys).toEqual([[-2, 1]]);
    expect(moveKey([[-2, 0], [0, 1], [2, 0]] as [number, number][], 1, 9, 1, [-2, 2])[1][0]).toBe(2);
  });
  it("maps x to pixels and back over the range", () => {
    expect(xToPixel(15, [0, 30], 10, 110)).toBe(60);
    expect(xToPixel(-2, [-2, 2], 6, 194)).toBe(6);
    expect(pixelToX(60, [0, 30], 10, 110)).toBe(15);
    expect(pixelToX(500, [0, 30], 10, 110)).toBe(30);
    expect(pixelToX(-500, [0, 30], 10, 110)).toBe(0);
    expect(xToPixel(5, [3, 3], 10, 110)).toBe(10);
    expect(pixelToX(50, [3, 3], 10, 110)).toBe(3);
  });
  it("maps y with the low end at the bottom", () => {
    expect(yToPixel(0, [0, 1], 6, 74)).toBe(74);
    expect(yToPixel(1, [0, 1], 6, 74)).toBe(6);
    expect(pixelToY(40, [0, 1], 6, 74)).toBeCloseTo(0.5);
    expect(pixelToY(-100, [0, 1], 6, 74)).toBeGreaterThan(1);
  });
  it("picks nice grid lines inside the range", () => {
    expect(axisTicks([0, 1], 4)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(axisTicks([0, 30], 4)).toEqual([10, 20]);
    expect(axisTicks([3, 3], 4)).toEqual([]);
    expect(axisTicks([0, 1], 0)).toEqual([]);
  });
});

describe("per-segment interpolation", () => {
  it("sets a key's interp without touching the others or the input", () => {
    const curve: Curve = [[0, 0], [1, 1], [2, 0]];
    const next = setKeyInterp(curve, 1, "smooth");
    expect(next).toEqual([[0, 0], [1, 1, "smooth"], [2, 0]]);
    expect(curve).toEqual([[0, 0], [1, 1], [2, 0]]);
  });
  it("stores linear as the plain two-number form", () => {
    expect(setKeyInterp([[0, 0, "step"], [1, 1]], 0, "linear")).toEqual([[0, 0], [1, 1]]);
    expect(setKeyInterp([[0, 0], [1, 1]], 5, "step")).toEqual([[0, 0], [1, 1]]);
  });
  it("keeps a key's interp when it moves", () => {
    expect(moveKey([[0, 0, "step"], [1, 1]] as Curve[number][], 0, 0.2, 3, [0, 1])).toEqual([[0.2, 3, "step"], [1, 1]]);
  });
  it("gives an added key the interp of the key before it", () => {
    expect(addKey([[0, 0, "smooth"], [1, 1]] as Curve[number][], 0.5, 0.2).keys[1]).toEqual([0.5, 0.2, "smooth"]);
    expect(addKey([[0.5, 0, "smooth"], [1, 1]] as Curve[number][], 0.1, 0.2).keys[0]).toEqual([0.1, 0.2]);
  });
});

describe("several keys at once (ADR 0373)", () => {
  type K = [number, string];
  const keys: K[] = [[0, "a"], [0.25, "b"], [0.5, "c"], [1, "d"]];
  it("shifts a group together, clamped so its spacing is kept, and reports where the keys landed", () => {
    expect(shiftKeys(keys, [1, 2], 0.125, [0, 1])).toEqual({ keys: [[0, "a"], [0.375, "b"], [0.625, "c"], [1, "d"]], indices: [1, 2] });
    // Past the end: the group stops when its last key reaches 1, and so replaces "d".
    const r = shiftKeys(keys, [1, 2], 2, [0, 1]);
    expect(r.keys).toEqual([[0, "a"], [0.75, "b"], [1, "c"]]);
    expect(r.indices).toEqual([1, 2]);
    expect(keys[1]).toEqual([0.25, "b"]);
  });
  it("re-sorts when a moved key passes another, which keeps its order", () => {
    const r = shiftKeys(keys, [0], 0.375, [0, 1]);
    expect(r.keys.map((k) => k[1])).toEqual(["b", "a", "c", "d"]);
    expect(r.indices).toEqual([1]);
  });
  it("scales about a pivot and clamps; a factor that isn't positive changes nothing", () => {
    expect(scaleKeys(keys, [1, 2], 0.25, 2, [0, 1]).keys).toEqual([[0, "a"], [0.25, "b"], [0.75, "c"], [1, "d"]]);
    expect(scaleKeys(keys, [2], 0, 4, [0, 1]).keys).toEqual([[0, "a"], [0.25, "b"], [1, "c"]]);
    expect(scaleKeys(keys, [1], 0, -1, [0, 1]).keys).toEqual(keys);
  });
  it("moved keys landing on each other: the last one landing replaces the others, so no two keys share a time", () => {
    // Scaled up against the end, "c" and "d" both clamp to 1; "d" lands last and wins, "c" is gone.
    const r = scaleKeys(keys, [2, 3], 0, 4, [0, 1]);
    expect(r.keys).toEqual([[0, "a"], [0.25, "b"], [1, "d"]]);
    expect(r.indices).toEqual([-1, 2]);
    // The order the indices are given in doesn't change which key wins.
    expect(scaleKeys(keys, [3, 2], 0, 4, [0, 1])).toEqual({ keys: [[0, "a"], [0.25, "b"], [1, "d"]], indices: [2, -1] });
    // Collapsed onto an unmoved key and onto each other: the latest moved key replaces both.
    const c = scaleKeys(keys, [0, 1], 0.5, 1e-9, [0, 1]);
    expect(c.keys.map((k) => k[1])).toEqual(["b", "d"]);
    expect(c.keys[0][0]).toBeCloseTo(0.5, 6);
    expect(c.indices).toEqual([-1, 0]);
    // Pasting keys that land on each other keeps the later copied one.
    const p = pasteKeys(keys, [[0, "x"], [1e-9, "y"]] as K[], 0.5, [0, 1]);
    expect(p.keys.map((k) => k[1])).toEqual(["a", "b", "y", "d"]);
    expect(p.indices).toEqual([-1, 2]);
  });
  it("removes any number of keys, all of them included", () => {
    expect(removeKeys(keys, [0, 3])).toEqual([[0.25, "b"], [0.5, "c"]]);
    expect(removeKeys(keys, [0, 1, 2, 3])).toEqual([]);
  });
  it("ripples: inserting time moves later keys, removing time cuts the span out", () => {
    expect(rippleKeys(keys, 0.5, 0.25)).toEqual([[0, "a"], [0.25, "b"], [0.75, "c"], [1.25, "d"]]);
    expect(rippleKeys(keys, 0.5, -0.25)).toEqual([[0, "a"], [0.25, "c"], [0.75, "d"]]);
  });
  it("copies relative to the first key and pastes at a point, replacing keys there and leaving out what falls outside", () => {
    const copied = copyKeysAt(keys, [2, 1]);
    expect(copied).toEqual([[0, "b"], [0.25, "c"]]);
    const r = pasteKeys(keys, copied, 0.75, [0, 1]);
    expect(r.keys).toEqual([[0, "a"], [0.25, "b"], [0.5, "c"], [0.75, "b"], [1, "c"]]);
    expect(r.indices).toEqual([3, 4]);
    expect(pasteKeys(keys, copied, 0.875, [0, 1]).indices[1]).toBe(-1);
  });
});
