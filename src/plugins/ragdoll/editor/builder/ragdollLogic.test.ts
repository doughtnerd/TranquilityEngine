// The ragdoll builder's table edits (ADR 0373, 0375; T55): each cell edit is accepted or refused with the rule (positive sizes
// and masses, swing 0 to 180, twist within -180..180 and min not above max, no negative drives, pin 0 to 1), a shape change
// carries the size and mass over, and adding or removing a body keeps the list in skeleton order.
import { describe, expect, it } from "vitest";
import { refusalOf } from "../../../../editor/sdk";
import type { RagdollBone } from "../../runtime/Ragdoll";
import { RAGDOLL_LIMITS, addBone, boneProblem, bonesWithoutBody, describeShape, editBone, removeBone, resizedFor, setShape, sizeFields, tableProblems, volumeOf, type Bones } from "./ragdollLogic";

const body = (bone: string, over: Partial<RagdollBone> = {}): RagdollBone => ({
  bone, shape: "capsule", size: { x: 0.05, y: 0.4, z: 0.05 }, center: { x: 0, y: 0.2, z: 0 }, axis: "y", mass: 3, swing: { y: 40, z: 30 }, twist: { min: -20, max: 25 },
  stiffness: 400, damping: 40, maxForce: 1000, strength: 1, pin: 0, ...over,
});

const SKELETON = ["pelvis", "spine", "head", "thigh", "shin"];
const bones = (): Bones => [body("pelvis", { shape: "box", size: { x: 0.3, y: 0.2, z: 0.2 }, pin: 1 }), body("spine"), body("head", { shape: "sphere", size: { x: 0.1, y: 0.1, z: 0.1 } })];

const ok = (r: { next: Bones } | { refused: string }): Bones => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("editBone", () => {
  it("sets each value of a body", () => {
    let b = ok(editBone(bones(), "spine", { mass: 4.5 }));
    expect(b[1]!.mass).toBe(4.5);
    b = ok(editBone(b, "spine", { swing: { y: 60 } }));
    expect(b[1]!.swing).toEqual({ y: 60, z: 30 });
    b = ok(editBone(b, "spine", { swing: { z: 10 } }));
    expect(b[1]!.swing).toEqual({ y: 60, z: 10 });
    b = ok(editBone(b, "spine", { twist: { min: -90 } }));
    b = ok(editBone(b, "spine", { twist: { max: 90 } }));
    expect(b[1]!.twist).toEqual({ min: -90, max: 90 });
    b = ok(editBone(b, "spine", { stiffness: 800, damping: 80, maxForce: 2000, strength: 2, pin: 0.5 }));
    expect(b[1]).toMatchObject({ stiffness: 800, damping: 80, maxForce: 2000, strength: 2, pin: 0.5 });
    b = ok(editBone(b, "spine", { size: { x: 0.06, y: 0.5 } }));
    expect(b[1]!.size).toEqual({ x: 0.06, y: 0.5, z: 0.05 });
    b = ok(editBone(b, "spine", { center: { y: 0.3 }, axis: "x" }));
    expect(b[1]).toMatchObject({ center: { x: 0, y: 0.3, z: 0 }, axis: "x" });
  });

  it("leaves the other bodies as they were, and gives back the same list when nothing changes", () => {
    const start = bones();
    const next = ok(editBone(start, "spine", { mass: 9 }));
    expect(next[0]).toBe(start[0]);
    expect(next[2]).toBe(start[2]);
    expect(ok(editBone(start, "spine", { mass: 3 }))).toBe(start);
  });

  it("refuses a size or mass that isn't positive", () => {
    expect(refusalOf(editBone(bones(), "spine", { size: { x: 0 } }))).toMatch(/sizes are 0.005 to 100 m/);
    expect(refusalOf(editBone(bones(), "spine", { size: { y: -1 } }))).toMatch(/sizes are/);
    expect(refusalOf(editBone(bones(), "pelvis", { size: { z: 0 } }))).toMatch(/sizes are/);
    expect(refusalOf(editBone(bones(), "head", { size: { x: 0 } }))).toMatch(/sizes are/);
    expect(refusalOf(editBone(bones(), "spine", { mass: 0 }))).toMatch(/mass is above 0/);
    expect(refusalOf(editBone(bones(), "spine", { mass: -2 }))).toMatch(/mass is above 0/);
    expect(refusalOf(editBone(bones(), "spine", { mass: 1e9 }))).toMatch(/at most/);
  });

  it("refuses a capsule shorter than it is wide", () => {
    expect(refusalOf(editBone(bones(), "spine", { size: { y: 0.05 } }))).toMatch(/at least as tall as it is wide/);
    expect(refusalOf(editBone(bones(), "spine", { size: { x: 0.3 } }))).toMatch(/at least as tall as it is wide/);
  });

  it("refuses swing outside 0 to 180", () => {
    expect(refusalOf(editBone(bones(), "spine", { swing: { y: -1 } }))).toMatch(/swing is 0 to 180/);
    expect(refusalOf(editBone(bones(), "spine", { swing: { z: 181 } }))).toMatch(/swing is 0 to 180/);
    expect(ok(editBone(bones(), "spine", { swing: { y: 180 } }))[1]!.swing.y).toBe(180);
    expect(ok(editBone(bones(), "spine", { swing: { z: 0 } }))[1]!.swing.z).toBe(0);
  });

  it("refuses twist outside -180 to 180 or with the minimum above the maximum", () => {
    expect(refusalOf(editBone(bones(), "spine", { twist: { min: -181 } }))).toMatch(/twist is -180 to 180/);
    expect(refusalOf(editBone(bones(), "spine", { twist: { max: 200 } }))).toMatch(/twist is -180 to 180/);
    expect(refusalOf(editBone(bones(), "spine", { twist: { min: 30 } }))).toMatch(/minimum can't be above/);
    expect(ok(editBone(bones(), "spine", { twist: { min: 25 } }))[1]!.twist).toEqual({ min: 25, max: 25 });
  });

  it("refuses negative drives and strength, and a pin outside 0 to 1", () => {
    for (const key of ["stiffness", "damping", "maxForce", "strength"] as const) expect(refusalOf(editBone(bones(), "spine", { [key]: -1 })), key).toMatch(/can't be negative/);
    expect(ok(editBone(bones(), "spine", { stiffness: 0 }))[1]!.stiffness).toBe(0);
    expect(refusalOf(editBone(bones(), "spine", { pin: 1.5 }))).toMatch(/pin is 0 to 1/);
    expect(refusalOf(editBone(bones(), "spine", { pin: -0.1 }))).toMatch(/pin is 0 to 1/);
  });

  it("refuses a field with no number in it and a body that isn't there", () => {
    expect(refusalOf(editBone(bones(), "spine", { mass: NaN }))).toMatch(/enter a number/);
    expect(refusalOf(editBone(bones(), "spine", { swing: { y: NaN } }))).toMatch(/enter a number/);
    expect(refusalOf(editBone(bones(), "tail", { mass: 1 }))).toMatch(/tail has no body/);
  });
});

describe("shapes", () => {
  it("lists the size numbers each shape has", () => {
    expect(sizeFields("capsule").map((f) => f.label)).toEqual(["Radius", "Height"]);
    expect(sizeFields("box").map((f) => f.label)).toEqual(["X", "Y", "Z"]);
    expect(sizeFields("sphere").map((f) => f.label)).toEqual(["Radius"]);
  });

  it("carries the size over from capsule to box to sphere and back, keeping every size valid", () => {
    const capsule = body("spine");
    const asBox = ok(setShape([capsule], "spine", "box"))[0]!;
    expect(asBox.shape).toBe("box");
    expect(asBox.size).toEqual({ x: 0.1, y: 0.4, z: 0.1 });
    const asSphere = ok(setShape([asBox], "spine", "sphere"))[0]!;
    expect(asSphere.size.x).toBeCloseTo(0.05, 10);
    const back = ok(setShape([asSphere], "spine", "capsule"))[0]!;
    expect(back.size.y).toBeGreaterThanOrEqual(2 * back.size.x);
    for (const shaped of [asBox, asSphere, back]) expect(boneProblem(shaped)).toBeNull();
  });

  it("makes a capsule from a flat box tall enough for its radius", () => {
    const box = body("pelvis", { shape: "box", size: { x: 0.5, y: 0.1, z: 0.5 } });
    const capsule = resizedFor(box, "capsule");
    expect(capsule.y).toBeGreaterThanOrEqual(2 * capsule.x);
    expect(boneProblem({ ...box, shape: "capsule", size: capsule })).toBeNull();
  });

  it("scales the mass with the volume, and leaves a same-shape change alone", () => {
    const start = [body("spine")];
    const sphere = ok(setShape(start, "spine", "sphere"))[0]!;
    expect(sphere.mass).toBeCloseTo(Math.max(0.1, (3 * volumeOf(sphere)) / volumeOf(start[0]!)), 10);
    expect(ok(setShape(start, "spine", "capsule"))).toBe(start);
    expect(refusalOf(setShape(start, "tail", "box"))).toMatch(/tail has no body/);
  });

  it("measures volumes", () => {
    expect(volumeOf({ shape: "box", size: { x: 1, y: 2, z: 3 } })).toBe(6);
    expect(volumeOf({ shape: "sphere", size: { x: 1, y: 1, z: 1 } })).toBeCloseTo((4 / 3) * Math.PI, 10);
    expect(volumeOf({ shape: "capsule", size: { x: 1, y: 2, z: 1 } })).toBeCloseTo((4 / 3) * Math.PI, 10); // two radii tall: a sphere
    expect(volumeOf({ shape: "capsule", size: { x: 1, y: 4, z: 1 } })).toBeCloseTo((4 / 3) * Math.PI + 2 * Math.PI, 10);
  });

  it("describes a shape", () => {
    expect(describeShape(body("spine"))).toBe("capsule r 0.05 × 0.40 m along y");
    expect(describeShape(body("pelvis", { shape: "box", size: { x: 0.3, y: 0.2, z: 0.1 } }))).toBe("box 0.30 × 0.20 × 0.10 m");
    expect(describeShape(body("head", { shape: "sphere", size: { x: 0.1, y: 0.1, z: 0.1 } }))).toBe("sphere r 0.10 m");
  });
});

describe("adding and removing bodies", () => {
  it("removes a body but not the last one", () => {
    const next = ok(removeBone(bones(), "spine"));
    expect(next.map((b) => b.bone)).toEqual(["pelvis", "head"]);
    expect(refusalOf(removeBone(next.slice(0, 1), "pelvis"))).toMatch(/at least one body/);
    expect(refusalOf(removeBone(bones(), "tail"))).toMatch(/tail has no body/);
  });

  it("adds a valid body to a bone of the skeleton, in skeleton order", () => {
    const next = ok(addBone(bones(), "thigh", SKELETON));
    expect(next.map((b) => b.bone)).toEqual(["pelvis", "spine", "head", "thigh"]);
    expect(boneProblem(next[3]!)).toBeNull();
    expect(ok(addBone([next[3]!, next[0]!], "spine", SKELETON)).map((b) => b.bone)).toEqual(["pelvis", "spine", "thigh"]);
    expect(refusalOf(addBone(bones(), "spine", SKELETON))).toMatch(/already has a body/);
    expect(refusalOf(addBone(bones(), "tail", SKELETON))).toMatch(/no bone tail/);
  });

  it("lists the bones without a body", () => {
    expect(bonesWithoutBody(bones(), SKELETON)).toEqual(["thigh", "shin"]);
  });
});

describe("tableProblems", () => {
  it("marks a body that breaks a rule (hand-edited data) and one the skeleton lacks", () => {
    const list = [body("pelvis"), body("spine", { mass: -1 }), body("tail")];
    const problems = tableProblems(list, SKELETON);
    expect([...problems.keys()]).toEqual(["spine", "tail"]);
    expect(problems.get("spine")).toMatch(/mass/);
    expect(problems.get("tail")).toMatch(/skeleton has no bone tail/);
    expect(tableProblems(list, null).has("tail")).toBe(false);
    expect(tableProblems(bones(), SKELETON).size).toBe(0);
  });

  it("holds the limits the table's rules are written from", () => {
    expect(RAGDOLL_LIMITS).toMatchObject({ swingMax: 180, twistMin: -180, twistMax: 180 });
  });
});
