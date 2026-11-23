// Ball-joint drive targets from anim-physics targets (ADR 0375, D89): checked against the joint coordinates the physics
// plugin's ball joint measures, `F1⁻¹·F2` with each body holding the joint frame `F` from creation.
import { describe, expect, it } from "vitest";
import { Quaternion } from "../../../engine/core/math";
import { jointConversion, jointTarget } from "./jointTarget";

const turn = (axis: [number, number, number], angle: number) => Quaternion.axisAngle(axis, angle);

/** The shortest turn taking x onto `child`'s x axis (the physics plugin's joint frame). */
function frameOf(child: Quaternion): Quaternion {
  const v = Quaternion.rotate(child, [1, 0, 0]);
  const q = new Quaternion(0, -v.z, v.y, 1 + v.x);
  return q.normalize();
}

/** The joint's coordinates with the bodies at `parent`, `child`, made at `parent0`, `child0`. */
function coordinates(parent0: Quaternion, child0: Quaternion, parent: Quaternion, child: Quaternion): Quaternion {
  const f = frameOf(child0);
  const f1 = Quaternion.mul(parent, Quaternion.mul(Quaternion.inverse(parent0), f));
  const f2 = Quaternion.mul(child, Quaternion.mul(Quaternion.inverse(child0), f));
  return Quaternion.mul(Quaternion.inverse(f1), f2);
}

const same = (a: Quaternion, b: Quaternion) => Quaternion.angle(a, b);

describe("jointTarget", () => {
  const parent0 = Quaternion.mul(turn([0, 1, 0], 0.7), turn([1, 0, 0], -0.4));
  const child0 = Quaternion.mul(parent0, Quaternion.mul(turn([0, 0, 1], 0.9), turn([1, 0, 0], 0.5)));
  const c = jointConversion(parent0, child0);

  it("is the identity at the rest pose (the target equals the creation pose's relative rotation)", () => {
    const rest = Quaternion.mul(Quaternion.inverse(parent0), child0);
    expect(same(jointTarget(c, rest), new Quaternion())).toBeLessThan(1e-6);
  });

  it.each([
    ["a turn about one axis", turn([0, 0, 1], 0.6)],
    ["a combined turn", Quaternion.mul(turn([0, 1, 0], -0.5), turn([1, 0, 0], 0.8))],
    ["a large turn", turn([0.3, -0.8, 0.5], 2.4)],
  ])("gives the joint coordinates that put the child at the target relative to its parent: %s", (_name, target) => {
    // Wherever the parent has moved to, the child at parent · target reads as the converted target.
    const parent = Quaternion.mul(turn([1, 1, 0], 1.1), parent0);
    const child = Quaternion.mul(parent, target);
    expect(same(coordinates(parent0, child0, parent, child), jointTarget(c, target))).toBeLessThan(1e-5);
  });

  it("is canonical (w ≥ 0)", () => {
    expect(jointTarget(c, turn([0, 1, 0], 3)).w).toBeGreaterThanOrEqual(0);
  });
});
