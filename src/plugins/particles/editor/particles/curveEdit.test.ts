import { describe, expect, it } from "vitest";
import { evalGradient } from "../../../../engine/scene/particles";
import { addAlphaKey, addColorKey, addKey, convertColor, convertNumber, curveRange, moveKey, removeColorKey, removeKey } from "./curveEdit";

describe("curve keys", () => {
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
    const [lo, hi] = curveRange([[0, 0], [1, 10]]);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(10);
    const [flo, fhi] = curveRange([[0, 2], [1, 2]]);
    expect(flo).toBeLessThan(2);
    expect(fhi).toBeGreaterThan(2);
    expect(curveRange([[0, 5]], 0, 1)).toEqual([0, 1]);
  });
});

describe("convertNumber", () => {
  it("goes constant to random to curves", () => {
    expect(convertNumber(2, "random")).toEqual({ random: [2, 2] });
    expect(convertNumber(2, "curve")).toEqual({ curve: [[0, 2], [1, 2]] });
    expect(convertNumber(2, "randomCurves")).toEqual({ randomCurves: [[[0, 2], [1, 2]], [[0, 2], [1, 2]]] });
  });
  it("comes back with firsts and averages", () => {
    expect(convertNumber({ random: [1, 3] }, "constant")).toBe(2);
    expect(convertNumber({ curve: [[0, 4], [1, 0]] }, "constant")).toBe(4);
    expect(convertNumber({ randomCurves: [[[0, 5], [1, 0]], [[0, 7], [1, 0]]] }, "random")).toEqual({ random: [5, 7] });
    expect(convertNumber({ randomCurves: [[[0, 5], [1, 0]], [[0, 7], [1, 0]]] }, "curve")).toEqual({ curve: [[0, 5], [1, 0]] });
  });
  it("keeps a value that is already the kind asked for", () => {
    const v = { random: [1, 2] as [number, number] };
    expect(convertNumber(v, "random")).toBe(v);
  });
});

describe("convertColor", () => {
  it("makes flat gradients that keep alpha", () => {
    const c = convertColor("#ff000080", "gradient") as { gradient: { colors: [number, string][]; alphas: [number, number][] } };
    expect(c.gradient.colors).toEqual([[0, "#ff0000"], [1, "#ff0000"]]);
    expect(c.gradient.alphas[0][1]).toBeCloseTo(128 / 255);
  });
  it("converts back to constants", () => {
    expect(convertColor({ random: ["#112233", "#ffffff"] }, "constant")).toBe("#112233");
    expect(convertColor({ gradient: { colors: [[0, "#00ff00"], [1, "#0000ff"]], alphas: [] } }, "constant")).toBe("#00ff00");
    expect(convertColor("#abcdef", "random")).toEqual({ random: ["#abcdef", "#abcdef"] });
  });
});

describe("gradient keys", () => {
  const g = { colors: [[0, "#000000"], [1, "#ffffff"]] as [number, string][], alphas: [[0, 0], [1, 1]] as [number, number][] };
  it("adds keys matching the gradient there", () => {
    const { gradient, index } = addColorKey(g, 0.5);
    expect(index).toBe(1);
    expect(gradient.colors[1][1]).toBe("#808080");
    const a = addAlphaKey(g, 0.5);
    expect(a.gradient.alphas[1][1]).toBeCloseTo(0.5);
    expect(evalGradient(a.gradient, 0.5)[3]).toBeCloseTo(0.5);
  });
  it("keeps at least one colour key", () => {
    expect(removeColorKey(removeColorKey(g, 0), 0).colors).toHaveLength(1);
  });
});
