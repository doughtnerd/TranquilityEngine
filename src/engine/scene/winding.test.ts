// The engine's one triangle winding (ADR 0450): every built-in mesh is wound in it, so `frontNormal` points out of it.
import { describe, expect, it } from "vitest";
import { builtinMeshData } from "./builtinMeshes";
import { FRONT_FACE_WINDING, frontNormal } from "./winding";

describe("the engine's winding", () => {
  it("puts a front face's right-hand normal inward: (c - a) × (b - a) faces the viewer", () => {
    expect(FRONT_FACE_WINDING).toBe("rightHandNormalInward");
    // Seen from -z (looking along +z, x right, y up), a → b → c runs counter-clockwise: the outward normal points to -z.
    expect([...frontNormal([0, 0, 0], [1, 0, 0], [0, 1, 0])]).toEqual([0, 0, -1]);
  });

  it("is what every built-in mesh is wound in: each triangle's front normal points away from the mesh's centre", () => {
    for (const name of ["cube", "sphere", "capsule", "cylinder"] as const) {
      const data = builtinMeshData(name);
      const p = data.positions, idx = data.indices;
      let outward = 0, inward = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const v = (i: number) => [p[idx[t + i] * 3], p[idx[t + i] * 3 + 1], p[idx[t + i] * 3 + 2]];
        const [a, b, c] = [v(0), v(1), v(2)];
        const n = frontNormal(a, b, c);
        const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        const d = n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2];
        if (d > 1e-9) outward++;
        else if (d < -1e-9) inward++;
      }
      expect({ name, inward }).toEqual({ name, inward: 0 });
      expect(outward).toBeGreaterThan(0);
    }
  });
});
