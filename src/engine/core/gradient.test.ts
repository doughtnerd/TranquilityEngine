// ADR 0396: the engine's gradient, shared by particles and line and trail renderers.
import { describe, expect, it } from "vitest";
import { evaluateGradient, isGradient, whiteGradient, type Gradient } from "./gradient";
import { evalGradient } from "../scene/particles";

const g: Gradient = { colors: [[0, "#ff0000"], [1, "#0000ff"]], alphas: [[0, 1], [0.5, 0]] };

describe("Gradient (ADR 0396)", () => {
  it("blends colours in sRGB between keys and holds them outside", () => {
    expect(Array.from(evaluateGradient(g, 0))).toEqual([1, 0, 0, 1]);
    expect(Array.from(evaluateGradient(g, 0.5))).toEqual([0.5, 0, 0.5, 0]);
    expect(Array.from(evaluateGradient(g, 2))).toEqual([0, 0, 1, 0]);
    expect(Array.from(evaluateGradient(g, -1))).toEqual([1, 0, 0, 1]);
  });

  it("writes into an output array without allocating one", () => {
    const out = new Float32Array(4);
    expect(evaluateGradient(g, 0.25, out)).toBe(out);
    expect(out[3]).toBeCloseTo(0.5);
  });

  it("reads no colour keys as white and no alpha keys as opaque", () => {
    expect(Array.from(evaluateGradient({ colors: [], alphas: [] }, 0.3))).toEqual([1, 1, 1, 1]);
    expect(Array.from(evaluateGradient(whiteGradient(), 0.7))).toEqual([1, 1, 1, 1]);
  });

  it("is the particle gradient: the same values for the same keys", () => {
    for (const t of [0, 0.2, 0.5, 0.9, 1]) expect(Array.from(evaluateGradient(g, t))).toEqual(evalGradient(g, t));
  });

  it("tells a gradient's shape", () => {
    expect(isGradient(g)).toBe(true);
    expect(isGradient({ colors: [] })).toBe(false);
    expect(isGradient(null)).toBe(false);
  });
});
