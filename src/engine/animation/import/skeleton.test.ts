// ADR 0371: the imported skeleton model: parents-first order (reordered and remapped), roles from a bone map, and the
// `myco.skel@1` bytes the import writes for the core (checked by the compiled-format header reader).
import { describe, expect, it } from "vitest";
import { readAnimationHeader } from "../binaryHeader";
import { orderParentsFirst, parentsFirstSkeleton, rolesFromBoneMap, type ImportedBone } from "./skeleton";
import { encodeSkeleton } from "./skeletonBinary";

const rest = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
const bone = (name: string, parent: number): ImportedBone => ({ name, parent, rest });

describe("imported skeletons", () => {
  it("keeps an order that is already parents first", () => {
    expect(orderParentsFirst([-1, 0, 1, 1])).toEqual({ order: [0, 1, 2, 3], remap: [0, 1, 2, 3], reordered: false });
  });

  it("reorders children listed before their parents and remaps parents and inverse binds", () => {
    // Head (parent Neck), Hips, Neck (parent Hips).
    const binds = new Float32Array(36).map((_, i) => Math.floor(i / 12));
    const s = parentsFirstSkeleton([bone("Head", 2), bone("Hips", -1), bone("Neck", 1)], binds);
    expect(s.bones.map((b) => [b.name, b.parent])).toEqual([["Hips", -1], ["Neck", 0], ["Head", 1]]);
    expect(s.remap).toEqual([2, 0, 1]);
    expect([s.inverseBinds[0], s.inverseBinds[12], s.inverseBinds[24]]).toEqual([1, 2, 0]);
  });

  it("breaks a parent cycle (no valid file has one) instead of looping", () => {
    const { order } = orderParentsFirst([1, 0]);
    expect(order.sort()).toEqual([0, 1]);
  });

  it("gives bones roles from a bone map and lists roles naming missing bones", () => {
    expect(rolesFromBoneMap([bone("Hips", -1), bone("Spine", 0)], { Hips: "Hips", Chest: "Ribs" })).toEqual({ roles: ["Hips", null], missing: ["Chest"] });
  });

  it("writes myco.skel@1 bytes the header reader accepts", () => {
    const skeleton = { bones: [bone("Hips", -1), bone("Spine", 0)], inverseBinds: new Float32Array(24), roles: [null, null], profile: null };
    const read = readAnimationHeader(encodeSkeleton(skeleton, "rig"));
    expect(read.ok && read.header).toMatchObject({ format: "myco.skel@1", name: "rig", info: { kind: "skeleton", bones: 2, profile: null } });
    expect(readAnimationHeader(encodeSkeleton(skeleton)).ok).toBe(true);
  });
});
