// ADR 0081 step 2: the internal maths that replaced three.js's outside the renderer (physics, the
// editor's gizmo): the `Quat` helpers and `Mat4` on double-precision arrays.
import { describe, expect, it } from "vitest";
import { Mat4, Quat, Quaternion, Vector3 } from "../core/math";

const close = (v: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 9);
  expect(v.y).toBeCloseTo(y, 9);
  expect(v.z).toBeCloseTo(z, 9);
};

describe("Quat helpers (ADR 0081)", () => {
  it("rotates a vector in place, as the matrix of the same rotation does", () => {
    const q = Quaternion.fromEuler(30, 45, 60);
    const m = new Float64Array(16);
    Mat4.compose(m, 0, [0, 0, 0], 0, [q.x, q.y, q.z, q.w], 0, [1, 1, 1], 0);
    const v = new Vector3(1, 2, 3);
    expect(Quat.rotate(q, v)).toBe(v);
    const [x, y, z] = Mat4.transformPoint(m, 0, 1, 2, 3);
    close(v, x, y, z);
  });

  it("turns about an axis by the right hand, and the conjugate undoes it", () => {
    const q = Quat.fromAxisAngle(0, 0, 1, Math.PI / 2);
    close(Quat.rotate(q, new Vector3(1, 0, 0)), 0, 1, 0);
    close(Quat.rotate(Quat.conjugate(q), Quat.rotate(q, new Vector3(1, 2, 3))), 1, 2, 3);
    const e = Quat.fromAxisAngle(1, 0, 0, Math.PI / 3).toEuler();
    expect(e.x).toBeCloseTo(Math.PI / 3, 9); // radians (ADR 0164)
  });
});

describe("Mat4 on Float64Array (ADR 0081)", () => {
  it("keeps double precision through compose, invert, multiply and decompose", () => {
    const q = Quaternion.fromEuler(10, 20, 30);
    const a = new Float64Array(16);
    Mat4.compose(a, 0, [1234.56789, -0.1, 0.2], 0, [q.x, q.y, q.z, q.w], 0, [2, 3, 4], 0);
    const inv = new Float64Array(16);
    expect(Mat4.invert(inv, 0, a, 0)).toBe(true);
    const id = new Float64Array(16);
    Mat4.multiply(id, 0, a, 0, inv, 0);
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 12);
    const p = [0, 0, 0], r = [0, 0, 0, 1], s = [0, 0, 0];
    Mat4.decompose(a, 0, p, 0, r, 0, s, 0);
    expect(p[0]).toBe(1234.56789); // a Float32Array would hold 1234.5678710...
    expect(s).toEqual([expect.closeTo(2, 12), expect.closeTo(3, 12), expect.closeTo(4, 12)]);
  });
});
