import { Matrix4 } from "three";
import { describe, expect, it } from "vitest";
import { lightSegments } from "../render/RenderBackend";

describe("light gizmo wireframes (ADR 0043)", () => {
  const at = new Matrix4().makeTranslation(1, 2, 3);

  it("draws a directional light's rays down its -Z axis", () => {
    const segs = lightSegments({ type: "directional", range: 10, spotAngle: 30 }, at, false);
    expect(segs[0]).toEqual([[1, 2, 3], [1, 2, 1]]); // the main ray, 2 m long
    expect(segs.length).toBe(9);
  });

  it("draws a spot light's cone out to its range", () => {
    const segs = lightSegments({ type: "spot", range: 4, spotAngle: 90 }, at, false);
    const [, tip] = segs[0];
    expect(tip[0]).toBeCloseTo(1 + 4); // tan(45°) × 4 to the side
    expect(tip[2]).toBeCloseTo(3 - 4);
    expect(segs.length).toBe(4 + 32);
  });

  it("shows a point light's range only while selected, and nothing for ambient light", () => {
    expect(lightSegments({ type: "point", range: 5, spotAngle: 30 }, at, false)).toEqual([]);
    expect(lightSegments({ type: "point", range: 5, spotAngle: 30 }, at, true)).toHaveLength(96);
    expect(lightSegments({ type: "ambient", range: 5, spotAngle: 30 }, at, true)).toEqual([]);
  });
});
