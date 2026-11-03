import { Matrix4, Quaternion, Ray, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { rayQuadDistance } from "../render/picking";

const down = (x: number, y: number, z = 10) => new Ray(new Vector3(x, y, z), new Vector3(0, 0, -1));
const quad = (x = 0, y = 0, z = 0, sx = 1, sy = 1, angleZ = 0) =>
  new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angleZ), new Vector3(sx, sy, 1));

describe("editor picking ray test (ADR 0022)", () => {
  it("hits a unit quad and reports the world-space distance", () => {
    expect(rayQuadDistance(down(0, 0), quad())).toBeCloseTo(10);
    expect(rayQuadDistance(down(0.49, -0.49), quad())).toBeCloseTo(10);
    expect(rayQuadDistance(down(0.51, 0), quad())).toBeNull();
  });

  it("respects the quad's translation, scale and rotation", () => {
    const sprite = quad(-4, 1, 2, 3.4, 3.4); // the Flappy bird: 3.4 m at (-4, 1)
    expect(rayQuadDistance(down(-4 + 1.6, 1 - 1.6), sprite)).toBeCloseTo(8);
    expect(rayQuadDistance(down(-4 + 1.8, 1), sprite)).toBeNull();
    const tilted = quad(0, 0, 0, 4, 0.2, Math.PI / 2); // a thin bar turned vertical
    expect(rayQuadDistance(down(0, 1.5), tilted)).toBeCloseTo(10);
    expect(rayQuadDistance(down(1.5, 0), tilted)).toBeNull();
  });

  it("hits flipped and back-facing quads", () => {
    expect(rayQuadDistance(down(0.3, 0), quad(0, 0, 0, -1, 1))).toBeCloseTo(10);
    const fromBehind = new Ray(new Vector3(0, 0, -5), new Vector3(0, 0, 1));
    expect(rayQuadDistance(fromBehind, quad())).toBeCloseTo(5);
  });

  it("ignores quads behind the ray, parallel rays and zero-scale quads", () => {
    expect(rayQuadDistance(down(0, 0, -1), quad())).toBeNull();
    expect(rayQuadDistance(new Ray(new Vector3(-5, 0, 0), new Vector3(1, 0, 0)), quad())).toBeNull();
    expect(rayQuadDistance(down(0, 0), quad(0, 0, 0, 0, 1))).toBeNull();
  });
});
