// Visibility views (ADR 0446 §3): frustum planes and the view-projection matrix agree on what's inside, for perspective
// and orthographic views in any orientation.
import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "../../core/math";
import { makeView, type ViewSpec } from "./views";

function spec(projection: "perspective" | "orthographic", q: Quaternion, position: [number, number, number]): ViewSpec {
  const axis = (x: number, y: number, z: number): [number, number, number] => {
    const v = Quaternion.rotate(q, new Vector3(x, y, z));
    return [v.x, v.y, v.z];
  };
  return { key: "k", kind: "camera", position, right: axis(1, 0, 0), up: axis(0, 1, 0), forward: axis(0, 0, 1), projection, fovY: 1, orthoHalfHeight: 4, near: 0.5, far: 50, widthPx: 640, heightPx: 360, persistent: true, occlusion: false };
}

/** Whether `p` is inside by the planes, and by the view-projection matrix (clip x, y in -w..w, z in 0..w). */
function inside(v: ReturnType<typeof makeView>, p: [number, number, number]): [boolean, boolean] {
  const pl = v.planes;
  let byPlanes = true;
  for (let i = 0; i < 24; i += 4) if (pl[i] * p[0] + pl[i + 1] * p[1] + pl[i + 2] * p[2] + pl[i + 3] < 0) byPlanes = false;
  const m = v.viewProjection;
  const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  const w = c[3];
  const byMatrix = w > 0 && Math.abs(c[0]) <= w && Math.abs(c[1]) <= w && c[2] >= 0 && c[2] <= w;
  return [byPlanes, byMatrix];
}

describe("makeView", () => {
  for (const projection of ["perspective", "orthographic"] as const) {
    it(`builds ${projection} planes and a view-projection that agree`, () => {
      const v = makeView(spec(projection, Quaternion.euler(0.3, 1.2, -0.4), [3, -2, 7]));
      let seed = 7;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 120 - 60;
      let ins = 0;
      for (let i = 0; i < 4000; i++) {
        const p: [number, number, number] = [3 + rnd(), -2 + rnd(), 7 + rnd()];
        const [a, b] = inside(v, p);
        // Points within a hair of a side may round either way.
        if (a !== b) {
          const pl = v.planes;
          const near = [0, 4, 8, 12, 16, 20].some((o) => Math.abs(pl[o] * p[0] + pl[o + 1] * p[1] + pl[o + 2] * p[2] + pl[o + 3]) < 1e-3);
          expect(near).toBe(true);
        }
        if (a) ins++;
      }
      expect(ins).toBeGreaterThan(5); // some points landed inside, so both tests were exercised
      const planes = v.planes;
      for (let i = 0; i < 24; i += 4) expect(Math.hypot(planes[i], planes[i + 1], planes[i + 2])).toBeCloseTo(1, 5);
    });
  }

  it("puts the view's centre line at clip x = y = 0, near at depth 0 and far at depth 1", () => {
    const v = makeView(spec("perspective", new Quaternion(), [0, 0, 0]));
    const clip = (z: number) => {
      const m = v.viewProjection;
      const c = [0, 1, 2, 3].map((r) => m[8 + r] * z + m[12 + r]);
      return c.map((x) => x / c[3]);
    };
    expect(clip(0.5)[2]).toBeCloseTo(0);
    expect(clip(50)[2]).toBeCloseTo(1);
    expect(clip(10)[0]).toBeCloseTo(0);
  });
});
