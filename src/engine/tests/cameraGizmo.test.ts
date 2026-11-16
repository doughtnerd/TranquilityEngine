import { describe, expect, it } from "vitest";
import { frustumSegments, type FrustumShape } from "../render/cameraGizmo";

/** The 8 corners from the wireframe's segments: near plane then far plane, each [bottom-left, bottom-right, top-right, top-left]. Segment k starts at corner k. */
const corners = (shape: FrustumShape): number[][] => {
  const s = frustumSegments(shape);
  return Array.from({ length: 8 }, (_, k) => Array.from(s.slice(k * 6, k * 6 + 3)));
};
const near = (actual: number[], expected: number[]) => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 5));

describe("camera gizmo geometry (ADR 0022)", () => {
  it("draws an orthographic camera as a box of the view's size, looking along +Z", () => {
    const c = corners({ projection: "orthographic", orthographicSize: 10, fieldOfView: 60, aspect: 2, near: 0.1, far: 20 });
    near(c[0], [-20, -10, 0.1]); // near bottom-left
    near(c[2], [20, 10, 0.1]); // near top-right
    near(c[6], [20, 10, 20]); // far top-right: same size, further away
  });

  it("draws a perspective camera as a pyramid that widens with distance", () => {
    const c = corners({ projection: "perspective", orthographicSize: 5, fieldOfView: 90, aspect: 1, near: 1, far: 11 });
    expect(c[2][0]).toBeCloseTo(1); // tan(45°) * 1
    expect(c[6][0]).toBeCloseTo(11);
    expect(c[6][2]).toBeCloseTo(11);
  });

  it("stops long frustums at the gizmo depth", () => {
    const c = corners({ projection: "orthographic", orthographicSize: 1, fieldOfView: 60, aspect: 1, near: 0.5, far: 1000 });
    expect(c[4][2]).toBeCloseTo(0.5 + 30); // 30 m beyond the near plane
  });

  it("produces 12 line segments: the near and far rectangles and the edges joining them", () => {
    const shape: FrustumShape = { projection: "orthographic", orthographicSize: 1, fieldOfView: 60, aspect: 1, near: 0, far: 1 };
    const s = frustumSegments(shape);
    expect(s.length).toBe(12 * 2 * 3);
    const c = corners(shape);
    near(Array.from(s.slice(9, 12)), c[2]); // near: bottom-right to top-right
    near(Array.from(s.slice(8 * 6 + 3, 8 * 6 + 6)), c[4]); // edge: near bottom-left to far bottom-left
  });
});
