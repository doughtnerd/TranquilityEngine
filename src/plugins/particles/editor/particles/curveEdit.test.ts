import { describe, expect, it } from "vitest";
import { evalGradient } from "../../../../engine/scene/particles";
import { addAlphaKey, addColorKey, convertColor, convertNumber, removeColorKey } from "./curveEdit";

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
