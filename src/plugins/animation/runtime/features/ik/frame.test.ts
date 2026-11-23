// T40t: the character frame's conversions (grounder rays out to world space, hits back to model space), checked
// against the engine's own quaternion maths. f64 throughout: 1e-12 covers rounding.
import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "../../../../../engine/core/math";
import { CharacterFrame } from "./frame";

const EPS = 1e-12;
const close = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  for (let k = 0; k < 3; k++) expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(EPS);
};

describe("CharacterFrame", () => {
  const q = Quaternion.axisAngle([0.3, 1, -0.2], 1.1);
  const frame = new CharacterFrame().set([1, 2, -3], [q.x, q.y, q.z, q.w], [2, 0.5, 3]);
  const out = new Float64Array(3);

  it("maps a model point to world as P + R (S ∘ p), and back", () => {
    frame.pointToWorld([0.4, -1, 2], out);
    const want = Vector3.add(new Vector3(1, 2, -3), Quaternion.rotate(q, new Vector3(0.8, -0.5, 6)));
    close(out, [want.x, want.y, want.z]);
    const back = new Float64Array(3);
    frame.pointToModel(out, back);
    close(back, [0.4, -1, 2]);
  });

  it("scales directions to world length and keeps normals perpendicular to world tangents", () => {
    frame.vectorToWorld([0, 0, 1], out);
    expect(Math.abs(Math.hypot(out[0]!, out[1]!, out[2]!) - 3)).toBeLessThan(EPS);
    // A model plane with normal n: its tangent t (n · t = 0) maps to world; the world normal maps back to n.
    const n = [1, 1, 0].map((x) => x / Math.SQRT2), t = [1, -1, 0.5];
    const tw = new Float64Array(3), nw = new Float64Array(3);
    frame.vectorToWorld(t, tw);
    // The world normal is the inverse transpose: R (S⁻¹ ∘ n), normalised.
    frame.rotate([n[0]! / 2, n[1]! / 0.5, n[2]! / 3], nw);
    expect(Math.abs(nw[0]! * tw[0]! + nw[1]! * tw[1]! + nw[2]! * tw[2]!)).toBeLessThan(EPS);
    const l = Math.hypot(nw[0]!, nw[1]!, nw[2]!);
    frame.normalToModel([nw[0]! / l, nw[1]! / l, nw[2]! / l], out);
    close(out, n);
  });

  it("normalises the rotation it is given, and treats a zero one as the identity", () => {
    const f = new CharacterFrame().set([0, 0, 0], [0, 0, 0, 0], [1, 1, 1]);
    f.pointToWorld([1, 2, 3], out);
    close(out, [1, 2, 3]);
    f.set([0, 0, 0], [0, 2, 0, 0], [1, 1, 1]); // a half turn about +Y, unnormalised
    f.pointToWorld([1, 0, 0], out);
    close(out, [-1, 0, 0]);
  });
});
