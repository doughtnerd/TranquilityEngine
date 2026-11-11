import { describe, expect, it } from "vitest";
import { GIZMO_MAX_DEPTH, frustumCorners, frustumSegments } from "../render/cameraGizmo";

describe("camera gizmo geometry (ADR 0022)", () => {
  it("draws an orthographic camera as a box of the view's size, looking along +Z", () => {
    const c = frustumCorners({ projection: "orthographic", orthographicSize: 10, fieldOfView: 60, aspect: 2, near: 0.1, far: 20 });
    expect(c[0]).toEqual([-20, -10, 0.1]); // near bottom-left
    expect(c[2]).toEqual([20, 10, 0.1]); // near top-right
    expect(c[6]).toEqual([20, 10, 20]); // far top-right: same size, further away
  });

  it("draws a perspective camera as a pyramid that widens with distance", () => {
    const c = frustumCorners({ projection: "perspective", orthographicSize: 5, fieldOfView: 90, aspect: 1, near: 1, far: 11 });
    expect(c[2][0]).toBeCloseTo(1); // tan(45°) * 1
    expect(c[6][0]).toBeCloseTo(11);
    expect(c[6][2]).toBeCloseTo(11);
  });

  it("stops long frustums at the gizmo depth", () => {
    const c = frustumCorners({ projection: "orthographic", orthographicSize: 1, fieldOfView: 60, aspect: 1, near: 0.5, far: 1000 });
    expect(c[4][2]).toBeCloseTo(0.5 + GIZMO_MAX_DEPTH);
  });

  it("produces 12 line segments", () => {
    const s = frustumSegments({ projection: "orthographic", orthographicSize: 1, fieldOfView: 60, aspect: 1, near: 0, far: 1 });
    expect(s.length).toBe(12 * 2 * 3);
  });
});
