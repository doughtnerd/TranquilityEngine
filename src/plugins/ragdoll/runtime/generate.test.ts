// Ragdoll bodies from a rest pose (T44): shapes by the number of children, sizes from bone lengths, masses from volumes,
// limits and drives from the description.
import { describe, expect, it } from "vitest";
import { Quaternion } from "../../../engine/core/math";
import type { RagdollBoneDescription, RagdollDescription } from "../../animation/runtime";
import { generateRagdollBones, type RagdollRigData } from "./generate";

/** A pelvis at height 1 with a spine, two legs down along each thigh's x axis, and a hand at the spine's end. */
function rig(): RagdollRigData {
  const names = ["pelvis", "spine", "hand", "thighL", "shinL", "thighR"];
  const parents = [-1, 0, 1, 0, 3, 0];
  const down = Quaternion.axisAngle([0, 0, 1], -Math.PI / 2); // x axis pointing down
  const at: [number, number, number, Quaternion][] = [
    [0, 1, 0, new Quaternion()],
    [0, 1.4, 0, new Quaternion()],
    [0, 1.8, 0, new Quaternion()],
    [0.1, 1, 0, down],
    [0.1, 0.5, 0, down],
    [-0.1, 1, 0, down],
  ];
  const restModel = new Float32Array(names.length * 12);
  at.forEach(([x, y, z, q], i) => {
    const { x: a, y: b, z: c, w } = q;
    restModel.set([1 - 2 * (b * b + c * c), 2 * (a * b - c * w), 2 * (a * c + b * w), x, 2 * (a * b + c * w), 1 - 2 * (a * a + c * c), 2 * (b * c - a * w), y, 2 * (a * c - b * w), 2 * (b * c + a * w), 1 - 2 * (a * a + b * b), z], i * 12);
  });
  return { names, parents, restModel };
}

const bone = (body: boolean, swing = 45): RagdollBoneDescription => ({ body, jointFrame: new Quaternion(), swing: { y: swing, z: swing }, twist: { min: -20, max: 25 }, stiffness: 400, damping: 40, maxForce: 1000, strength: 1, pin: 0 });

describe("generateRagdollBones", () => {
  const description: RagdollDescription = { bones: [{ ...bone(true), pin: 1 }, bone(true, 30), bone(false), bone(true), bone(true), bone(true)], front: "+z" };
  const out = generateRagdollBones(rig(), description);
  const by = (n: string) => out.find((b) => b.bone === n)!;

  it("lists only the description's body bones, with its limits, drives and pins", () => {
    expect(out.map((b) => b.bone)).toEqual(["pelvis", "spine", "thighL", "shinL", "thighR"]);
    expect(by("spine").swing).toEqual({ y: 30, z: 30 });
    expect(by("spine").twist).toEqual({ min: -20, max: 25 });
    expect(by("pelvis").pin).toBe(1);
    expect(by("thighL")).toMatchObject({ stiffness: 400, damping: 40, maxForce: 1000, strength: 1, pin: 0 });
  });

  it("gives a one-child bone a capsule to its child along the nearest body axis, a fifth as thick as long", () => {
    const spine = by("spine"); // child (the hand) 0.4 up
    expect(spine.shape).toBe("capsule");
    expect(spine.axis).toBe("y");
    expect(spine.size.y).toBeCloseTo(0.4, 5);
    expect(spine.size.x).toBeCloseTo(0.08, 5);
    expect(spine.center.y).toBeCloseTo(0.2, 5);
    const thigh = by("thighL"); // its x axis points down the leg, to the shin 0.5 away
    expect(thigh.axis).toBe("x");
    expect(thigh.size.y).toBeCloseTo(0.5, 5);
    expect(thigh.center.x).toBeCloseTo(0.25, 5);
  });

  it("gives a bone with several children a box around them and a leaf a sphere past its joint", () => {
    const pelvis = by("pelvis");
    expect(pelvis.shape).toBe("box");
    expect(pelvis.size.x).toBeCloseTo(0.2, 5); // from thighR (−0.1) to thighL (0.1)
    expect(pelvis.size.y).toBeCloseTo(0.4, 5); // to the spine
    const shin = by("shinL"); // a leaf: a quarter of its 0.5 m parent segment
    expect(shin.shape).toBe("sphere");
    expect(shin.size.x).toBeCloseTo(0.125, 5);
    expect(shin.center.x).toBeCloseTo(0.125, 5);
  });

  it("weighs bodies by volume at the density given", () => {
    const s = by("shinL");
    expect(s.mass).toBeCloseTo((4 / 3) * Math.PI * 0.125 ** 3 * 985, 3);
    expect(generateRagdollBones(rig(), description, 500).find((b) => b.bone === "shinL")!.mass).toBeCloseTo((4 / 3) * Math.PI * 0.125 ** 3 * 500, 3);
  });
});
