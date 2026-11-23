// The ragdoll builder's gizmo geometry (ADR 0373; T55): shape outlines for each shape, the joint's swing cone and twist arc (the
// physics plugin's joint maths), the handles, and handle drags as value patches kept inside the table's rules.
import { describe, expect, it } from "vitest";
import type { RagdollBone } from "../../runtime/Ragdoll";
import { bodyHandles, bodyMatrix, dragPatch, extentOf, handlesToWorld, invertAffine, jointLimitWire, jointScaleOf, shapeWire, transformDirection, transformPoint, wireToWorld } from "./gizmoGeometry";
import { boneProblem, editBone } from "./ragdollLogic";

type Shaped = Pick<RagdollBone, "shape" | "size" | "center" | "axis" | "swing" | "twist">;
const base: Shaped = { shape: "capsule", size: { x: 0.1, y: 0.6, z: 0.1 }, center: { x: 0, y: 0.3, z: 0 }, axis: "y", swing: { y: 40, z: 30 }, twist: { min: -20, max: 25 } };
const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
const points = (wire: readonly (readonly (readonly number[])[])[]) => wire.flat();
const bounds = (wire: readonly (readonly (readonly number[])[])[]) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points(wire)) for (let i = 0; i < 3; i++) (lo[i] = Math.min(lo[i]!, p[i]!)), (hi[i] = Math.max(hi[i]!, p[i]!));
  return { lo, hi };
};

describe("shapeWire", () => {
  it("outlines a box with its twelve edges around the centre", () => {
    const wire = shapeWire({ ...base, shape: "box", size: { x: 0.4, y: 0.2, z: 0.1 }, center: { x: 1, y: 2, z: 3 } });
    expect(wire).toHaveLength(12);
    expect(wire.every((l) => l.length === 2)).toBe(true);
    const { lo, hi } = bounds(wire);
    close(lo, [0.8, 1.9, 2.95]);
    close(hi, [1.2, 2.1, 3.05]);
  });

  it("outlines a sphere with three circles of its radius around the centre", () => {
    const wire = shapeWire({ ...base, shape: "sphere", size: { x: 0.25, y: 0.25, z: 0.25 }, center: { x: 0, y: 1, z: 0 } });
    expect(wire).toHaveLength(3);
    for (const p of points(wire)) expect(Math.hypot(p[0]!, p[1]! - 1, p[2]!)).toBeCloseTo(0.25, 6);
  });

  it("outlines a capsule along its axis: its height from end to end, its radius across", () => {
    for (const [axis, long] of [["x", 0], ["y", 1], ["z", 2]] as const) {
      const { lo, hi } = bounds(shapeWire({ ...base, axis, center: { x: 0, y: 0, z: 0 } }));
      for (let i = 0; i < 3; i++) {
        expect(hi[i]! - lo[i]!).toBeCloseTo(i === long ? 0.6 : 0.2, 6);
        expect(hi[i]! + lo[i]!).toBeCloseTo(0, 6);
      }
    }
  });

  it("outlines a capsule two radii tall as a round shape (no straight sides)", () => {
    const { lo, hi } = bounds(shapeWire({ ...base, size: { x: 0.1, y: 0.2, z: 0.1 }, center: { x: 0, y: 0, z: 0 } }));
    expect(hi[1]! - lo[1]!).toBeCloseTo(0.2, 6);
  });
});

describe("the joint", () => {
  it("draws the swing cone and twist arc about the body's x axis, sized to the body", () => {
    const wire = jointLimitWire(base);
    const scale = jointScaleOf(base);
    expect(scale).toBeCloseTo((0.6 * 0.8) / 0.5, 10);
    // The cone opens along +x from the origin (its rim is at x > 0 for swings under 90°).
    const rim = wire.find((l) => l.length > 30)!;
    expect(rim.every((p) => p[0]! > 0)).toBe(true);
    // Its widest points along y and z are the swing limits: tan(30°) and tan(40°) of the distance along x.
    const maxY = Math.max(...rim.map((p) => Math.abs(p[1]! / p[0]!)));
    const maxZ = Math.max(...rim.map((p) => Math.abs(p[2]! / p[0]!)));
    expect(maxY).toBeCloseTo(Math.tan((30 * Math.PI) / 180), 2); // swing.z tips the axis toward y
    expect(maxZ).toBeCloseTo(Math.tan((40 * Math.PI) / 180), 2); // swing.y tips it toward z
  });

  it("draws the twist arc between the limits in the y-z plane", () => {
    const wire = jointLimitWire(base);
    const arc = wire.filter((l) => l.length > 2 && l.length < 30 && l.every((p) => Math.abs(p[0]!) < 1e-9))[0]!;
    expect(arc).toBeDefined();
    const angles = arc.map((p) => (Math.atan2(p[2]!, p[1]!) * 180) / Math.PI);
    expect(angles[0]).toBeCloseTo(-20, 3);
    expect(angles.at(-1)).toBeCloseTo(25, 3);
  });

  it("draws no twist arc for a zero twist range", () => {
    const flat = jointLimitWire({ ...base, twist: { min: 10, max: 10 } });
    expect(flat.some((l) => l.length > 2 && l.length < 30 && l.every((p) => Math.abs(p[0]!) < 1e-9))).toBe(false);
  });

  it("sizes the wire to a small body at least 5 cm across, and to a box by its longest side", () => {
    expect(jointScaleOf({ shape: "sphere", size: { x: 0.005, y: 0.005, z: 0.005 } })).toBeCloseTo(0.05 / 0.5, 10);
    expect(extentOf({ shape: "box", size: { x: 0.1, y: 0.7, z: 0.2 } })).toBe(0.7);
    expect(extentOf({ shape: "sphere", size: { x: 0.2, y: 0.2, z: 0.2 } })).toBe(0.4);
  });
});

describe("matrices", () => {
  /** Rotation of 90° about +Z, then a move to (1, 2, 3), as a column-major 4×4. */
  const m = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];

  it("moves points and turns directions", () => {
    close(transformPoint(m, [1, 0, 0]), [1, 3, 3]);
    close(transformDirection(m, [1, 0, 0]), [0, 1, 0]);
    expect(Math.hypot(...transformDirection([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1], [1, 1, 0]))).toBeCloseTo(1, 10);
  });

  it("inverts an affine matrix, with scale", () => {
    const scaled = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1];
    const inv = invertAffine(scaled)!;
    close(transformPoint(inv, transformPoint(scaled, [0.3, -0.7, 1.1])), [0.3, -0.7, 1.1]);
    expect(invertAffine(new Array(16).fill(0))).toBeNull();
  });

  it("turns the bone's frame by the body's frame rotation", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    expect(bodyMatrix(identity)).toEqual(identity);
    const half = Math.SQRT1_2;
    const turned = bodyMatrix(identity, { x: 0, y: 0, z: half, w: half }); // 90° about z
    close(transformPoint(turned, [1, 0, 0]), [5, 1, 0]); // the frame's x axis points along the bone's y
    close(transformPoint(turned, [0, 1, 0]), [4, 0, 0]);
    close(transformPoint(turned, [0, 0, 0]), [5, 0, 0]); // the origin stays at the bone
  });

  it("maps wires and handles to the world", () => {
    const wire = wireToWorld(m, [[[1, 0, 0], [0, 1, 0]]]);
    close(wire[0]![0]!, [1, 3, 3]);
    close(wire[0]![1]!, [0, 2, 3]);
    const handles = handlesToWorld(m, { a: [1, 0, 0] });
    close(handles.a!, [1, 3, 3]);
  });
});

describe("handles", () => {
  it("gives a capsule a radius handle off its axis and a height handle at its end", () => {
    const h = bodyHandles(base);
    expect(Object.keys(h).sort()).toEqual(["size:height", "size:radius", "swing:y", "swing:z", "twist:max", "twist:min"]);
    close(h["size:height"]!, [0, 0.6, 0]); // centre y 0.3 + half height 0.3
    expect(Math.hypot(h["size:radius"]![0]! - 0, h["size:radius"]![1]! - 0.3, h["size:radius"]![2]!)).toBeCloseTo(0.1, 10);
    expect(h["size:radius"]![1]).toBeCloseTo(0.3, 10); // off the axis, level with the centre
  });

  it("gives a box a handle per side and a sphere one on its surface", () => {
    const box = bodyHandles({ ...base, shape: "box", size: { x: 0.4, y: 0.2, z: 0.1 }, center: { x: 0, y: 0, z: 0 } });
    close(box["size:x"]!, [0.2, 0, 0]);
    close(box["size:y"]!, [0, 0.1, 0]);
    close(box["size:z"]!, [0, 0, 0.05]);
    const sphere = bodyHandles({ ...base, shape: "sphere", size: { x: 0.3, y: 0.3, z: 0.3 }, center: { x: 0, y: 0, z: 0 } });
    expect(Object.keys(sphere)).toContain("size:radius");
    close(sphere["size:radius"]!, [0.3, 0, 0]);
  });

  it("puts the limit handles where the wire has them: swing on the rim, twist on the arc", () => {
    const h = bodyHandles(base);
    // swing.z tips the axis toward +y by 30°, swing.y toward +z by 40°.
    expect((Math.atan2(h["swing:z"]![1]!, h["swing:z"]![0]!) * 180) / Math.PI).toBeCloseTo(30, 6);
    expect((Math.atan2(h["swing:y"]![2]!, h["swing:y"]![0]!) * 180) / Math.PI).toBeCloseTo(40, 6);
    expect((Math.atan2(h["twist:min"]![2]!, h["twist:min"]![1]!) * 180) / Math.PI).toBeCloseTo(-20, 6);
    expect((Math.atan2(h["twist:max"]![2]!, h["twist:max"]![1]!) * 180) / Math.PI).toBeCloseTo(25, 6);
    expect(Math.abs(h["twist:min"]![0]!)).toBeLessThan(1e-9);
  });
});

describe("dragPatch", () => {
  it("sets a sphere's radius from the distance to its centre", () => {
    const sphere: Shaped = { ...base, shape: "sphere", size: { x: 0.1, y: 0.1, z: 0.1 }, center: { x: 0, y: 1, z: 0 } };
    expect(dragPatch(sphere, "size:radius", [0, 1.4, 0])).toEqual({ size: { x: 0.4 } });
    expect(dragPatch(sphere, "size:radius", [0, 1, 0])).toEqual({ size: { x: 0.005 } }); // never below the minimum
  });

  it("sets a capsule's radius from the distance off its axis, never more than half its height, and its height from the distance along it", () => {
    expect(dragPatch(base, "size:radius", [0.15, 0.3, 0])).toEqual({ size: { x: 0.15 } });
    expect(dragPatch(base, "size:radius", [0, 5, 0.9])).toEqual({ size: { x: 0.3 } }); // half the 0.6 height
    expect(dragPatch(base, "size:height", [0, 0.9, 0])).toEqual({ size: { y: 1.2 } });
    expect(dragPatch(base, "size:height", [0, 0.3, 0])).toEqual({ size: { y: 0.2 } }); // two radii at least
  });

  it("sets a box's sides from the distance to the centre along each axis", () => {
    const box: Shaped = { ...base, shape: "box", size: { x: 0.4, y: 0.2, z: 0.1 }, center: { x: 0, y: 0, z: 0 } };
    expect(dragPatch(box, "size:x", [0.5, 0, 0])).toEqual({ size: { x: 1 } });
    expect(dragPatch(box, "size:y", [0, -0.25, 0])).toEqual({ size: { y: 0.5 } });
    expect(dragPatch(box, "size:z", [0, 0, 0.2])).toEqual({ size: { z: 0.4 } });
  });

  it("sets the swing limits from the angle of the pointer's point off the twist axis, within 0 to 180", () => {
    expect(dragPatch(base, "swing:z", [1, 1, 0])).toEqual({ swing: { z: 45 } });
    expect(dragPatch(base, "swing:y", [1, 0, Math.tan((70 * Math.PI) / 180)])).toEqual({ swing: { y: 70 } });
    expect(dragPatch(base, "swing:z", [-1, 0, 0])).toEqual({ swing: { z: 180 } });
    expect(dragPatch(base, "swing:z", [1, -1, 0])).toEqual({ swing: { z: 45 } }); // the cone is symmetric
  });

  it("sets the twist limits from the angle about the axis, kept in order and within -180 to 180", () => {
    expect(dragPatch(base, "twist:min", [0, 1, -1])).toEqual({ twist: { min: -45 } });
    expect(dragPatch(base, "twist:max", [0, 1, 1])).toEqual({ twist: { max: 45 } });
    expect(dragPatch(base, "twist:min", [0, 1, 1])).toEqual({ twist: { min: 25 } }); // not past the maximum
    expect(dragPatch(base, "twist:max", [0, 1, -1])).toEqual({ twist: { max: -20 } }); // not below the minimum
    expect(dragPatch(base, "twist:min", [0, -1, -0.0001])).toEqual({ twist: { min: -180 } });
  });

  it("answers null for a handle it doesn't have", () => {
    expect(dragPatch(base, "size:depth", [0, 0, 0])).toBeNull();
  });

  it("makes patches the table accepts, whatever the pointer does", () => {
    const body: RagdollBone = { ...base, bone: "spine", mass: 3, stiffness: 400, damping: 40, maxForce: 1000, strength: 1, pin: 0 };
    for (const id of Object.keys(bodyHandles(body))) {
      for (const p of [[0, 0, 0], [1, 1, 1], [-3, 2, -1], [0, -9, 0.2], [100, 100, 100]]) {
        const patch = dragPatch(body, id, p)!;
        const result = editBone([body], "spine", patch);
        expect("next" in result, `${id} at ${p}: ${"refused" in result ? result.refused : ""}`).toBe(true);
        if ("next" in result) expect(boneProblem(result.next[0]!)).toBeNull();
      }
    }
  });
});
