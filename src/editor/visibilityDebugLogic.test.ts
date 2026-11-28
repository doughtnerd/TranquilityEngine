// The occlusion debug view's pure parts (ADR 0460 §6): the grey depth image, the culled boxes' lines and the readout.
import { describe, expect, it } from "vitest";
import { boxLines, depthImage, occlusionReadout, readoutSource } from "./visibilityDebugLogic";
import { cleanDebugMode } from "./sceneTools";

describe("depthImage", () => {
  it("draws empty pixels black and drawn ones grey, the nearest white", () => {
    const rgba = depthImage({ width: 3, height: 1, data: new Float32Array([0, 0.5, 0.25]) });
    expect([...rgba]).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 152, 152, 152, 255]);
  });

  it("reuses an output of the right size, and an all-empty buffer is all black", () => {
    const out = new Uint8ClampedArray(8).fill(7);
    expect(depthImage({ width: 2, height: 1, data: new Float32Array(2) }, out)).toBe(out);
    expect([...out]).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
    expect(depthImage({ width: 1, height: 1, data: new Float32Array([1]) }, out)).not.toBe(out);
  });
});

describe("boxLines", () => {
  it("draws each box as its bottom and top rectangles and four vertical edges, in the colour", () => {
    const lines = boxLines(new Float32Array([0, 0, 0, 1, 2, 3, 5, 5, 5, 6, 6, 6]), 0xff0000);
    expect(lines).toHaveLength(12);
    expect(lines[0]).toEqual({ points: [[0, 0, 0], [1, 0, 0], [1, 0, 3], [0, 0, 3]], closed: true, color: 0xff0000 });
    expect(lines[1].points.every((p) => p[1] === 2)).toBe(true);
    expect(lines[2]).toEqual({ points: [[0, 0, 0], [0, 2, 0]], closed: false, color: 0xff0000 });
    expect(lines[6].points[0]).toEqual([5, 5, 5]);
    expect(boxLines(new Float32Array(0), 1)).toEqual([]);
  });
});

describe("the readout", () => {
  it("lists occluders, triangles, tested, culled and milliseconds, and names its view", () => {
    expect(occlusionReadout({ occluders: 3, triangles: 12345, tested: 40, culled: 7, ms: 1.234 })).toEqual([
      { label: "Occluders", value: "3" },
      { label: "Triangles", value: "12,345" },
      { label: "Tested", value: "40" },
      { label: "Culled", value: "7" },
      { label: "Time", value: "1.23 ms" },
    ]);
    expect(readoutSource("sceneView")).toBe("Scene view");
    expect(readoutSource("camera")).toBe("Main camera");
  });

  it("reads a stored debug mode, anything unknown as none", () => {
    expect(["none", "lodLevels", "occlusion", "other", undefined, 3].map(cleanDebugMode)).toEqual(["none", "lodLevels", "occlusion", "none", "none", "none"]);
  });
});
