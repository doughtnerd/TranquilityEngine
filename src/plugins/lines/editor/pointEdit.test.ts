// ADR 0382: the line point tool's maths.
import { describe, expect, it } from "vitest";
import { invertAffine, lerp3, nearestSegment, pointsJson, rayPlane, transformPoint } from "./pointEdit";

describe("line point editing maths (ADR 0382)", () => {
  it("meets a plane with a ray, and not one it runs along or that's behind it", () => {
    expect(rayPlane([0, 0, -5], [0, 0, 1], [0, 0, 0], [0, 0, 1])).toEqual([0, 0, 0]);
    expect(rayPlane([0, 0, -5], [1, 0, 0], [0, 0, 0], [0, 0, 1])).toBeNull();
    expect(rayPlane([0, 0, 5], [0, 0, 1], [0, 0, 0], [0, 0, 1])).toBeNull();
  });

  it("finds the segment nearest a canvas point within reach, skipping off-screen vertices", () => {
    const screen: ([number, number] | null)[] = [[0, 0], [100, 0], [100, 100], null];
    expect(nearestSegment(screen, 50, 4, 10, false)).toEqual({ index: 0, t: 0.5 });
    expect(nearestSegment(screen, 50, 40, 10, false)).toBeNull();
    expect(nearestSegment(screen, 103, 25, 10, false)).toEqual({ index: 1, t: 0.25 });
    expect(nearestSegment([[0, 0], [100, 0], [100, 100]], 52, 48, 10, true)).toEqual({ index: 2, t: 0.5 });
  });

  it("inverts an affine matrix", () => {
    const m = [2, 0, 0, 0, 0, 0, 3, 0, 0, -1, 0, 0, 5, 6, 7, 1]; // scale, turn and move
    const inv = invertAffine(m)!;
    const p = transformPoint(m, [1, 2, 3]);
    const back = transformPoint(inv, p);
    back.forEach((v, i) => expect(v).toBeCloseTo([1, 2, 3][i]!));
    expect(invertAffine([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull();
  });

  it("interpolates and tidies points for the scene file", () => {
    expect(lerp3([0, 0, 0], [2, 4, 6], 0.25)).toEqual([0.5, 1, 1.5]);
    expect(pointsJson([[1 / 3, 0, 2]])).toEqual([[0.3333, 0, 2]]);
  });
});
