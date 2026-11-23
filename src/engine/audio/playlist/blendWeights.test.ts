// ADR 0343 Blend weights: 1D crossfade, layer and equal power; 2D inside, outside the hull, and with fewer than three points.
import { describe, expect, it } from "vitest";
import { blendWeights1D, blendWeights2D, delaunay } from "./blendWeights";

const close = (got: number[], want: number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((g, i) => expect(g).toBeCloseTo(want[i]!, 9));
};

describe("1D", () => {
  it("crossfade is piecewise linear between neighbours and clamps outside the ends", () => {
    close(blendWeights1D([0, 0.5, 1], 0.25, "crossfade", "linear"), [0.5, 0.5, 0]);
    close(blendWeights1D([0, 0.5, 1], 0.9, "crossfade", "linear"), [0, 0.2, 0.8]);
    close(blendWeights1D([0.2, 0.8], 0, "crossfade", "linear"), [1, 0]);
    close(blendWeights1D([0.2, 0.8], 1, "crossfade", "linear"), [0, 1]);
  });

  it("entries out of order are sorted by position; results stay in entry order", () => {
    close(blendWeights1D([1, 0], 0.25, "crossfade", "linear"), [0.25, 0.75]);
  });

  it("equal power is √weight", () => {
    close(blendWeights1D([0, 1], 0.3, "crossfade", "equalPower"), [Math.sqrt(0.7), Math.sqrt(0.3)]);
  });

  it("layer: the first entry is always 1, each next ramps between its neighbour and itself (no equal power)", () => {
    close(blendWeights1D([0, 0.5, 1], 0.75, "layer", "equalPower"), [1, 1, 0.5]);
    close(blendWeights1D([0, 0.5, 1], 0, "layer", "linear"), [1, 0, 0]);
  });
});

describe("2D", () => {
  const TRI = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];

  it("barycentric weights inside a triangle", () => {
    close(blendWeights2D(TRI, { x: 0.2, y: 0.3 }), [0.5, 0.2, 0.3]);
  });

  it("outside the hull: projection onto the nearest hull edge", () => {
    close(blendWeights2D(TRI, { x: 0.5, y: -1 }), [0.5, 0.5, 0]);
    close(blendWeights2D(TRI, { x: 2, y: 2 }), [0, 0.5, 0.5]);
  });

  it("a square triangulates into two triangles and blends inside each", () => {
    const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    expect(delaunay(sq)).toHaveLength(2);
    const w = blendWeights2D(sq, { x: 0.5, y: 0.5 });
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    close(blendWeights2D(sq, { x: 1, y: 1 }), [0, 0, 1, 0]);
  });

  it("one point gets 1; two points use their segment", () => {
    close(blendWeights2D([{ x: 0.3, y: 0.3 }], { x: 0.9, y: 0.1 }), [1]);
    close(blendWeights2D([{ x: 0, y: 0 }, { x: 1, y: 0 }], { x: 0.25, y: 0.7 }), [0.75, 0.25]);
  });

  it("collinear points use the nearest segment between two of them", () => {
    close(blendWeights2D([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }], { x: 0.75, y: 0.2 }), [0, 0.5, 0.5]);
  });

  it("equal power is √weight", () => {
    close(blendWeights2D(TRI, { x: 0.2, y: 0.3 }, "equalPower"), [Math.sqrt(0.5), Math.sqrt(0.2), Math.sqrt(0.3)]);
  });
});
