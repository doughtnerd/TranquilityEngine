// Rig entries and their gizmos (T51): the graph's rig nodes as a list, and what each draws over a skeleton (given its
// bones' world matrices): a limb chain with its IK target and pole, spring colliders in their bones' space, look-at limit
// cones; bones the skeleton lacks are skipped.
import { describe, expect, it } from "vitest";
import { emptyAnimGraph, type GraphNode } from "../../../../engine/animation/animGraph";
import { rigEntries, rigGizmoLines, type Mat4 } from "./rigLogic";

/** A bone at `p` with identity rotation (column-major). */
const at = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const bones: Record<string, Mat4> = { UpperArm: at(0, 1, 0), LowerArm: at(0.3, 1, 0.1), Hand: at(0.6, 1, 0), Head: at(0, 1.6, 0), Neck: at(0, 1.5, 0) };
const lookup = (name: string) => bones[name] ?? null;
const node = (kind: string, params: GraphNode["params"]): GraphNode => ({ id: kind, family: "rig", kind, name: "", inputs: [], params });

describe("rig entries (T51)", () => {
  it("lists the graph's rig nodes with what they act on", () => {
    const g = { ...emptyAnimGraph(), nodes: [node("twoBoneIk", { root: "UpperArm", mid: "LowerArm", tip: "Hand" }), node("springChain", { bones: ["A", "B"], colliderBones: ["A"] }), { ...node("clipPlayer", {}), family: "sources" as const }] };
    expect(rigEntries(g)).toEqual([
      { id: "twoBoneIk", title: "Two Bone Ik", kind: "Two Bone Ik", summary: "UpperArm → LowerArm → Hand", weight: 1 },
      { id: "springChain", title: "Spring Chain", kind: "Spring Chain", summary: "A → B, 1 collider", weight: 1 },
    ]);
  });

  it("draws a two-bone limb: the chain, a target cross at the tip, and the pole out from the mid joint", () => {
    const lines = rigGizmoLines(node("twoBoneIk", { root: "UpperArm", mid: "LowerArm", tip: "Hand" }), lookup, 1);
    expect(lines[0]!.points).toEqual([[0, 1, 0], [0.3, 1, 0.1], [0.6, 1, 0]]);
    const pole = lines.find((l) => l.points.length === 2 && l.points[0]![0] === 0.3 && l.color === lines.at(-1)!.color)!;
    // Away from the root–tip line: +z, like the bend.
    expect(pole.points[1]![2]).toBeGreaterThan(0.1);
    expect(lines.length).toBe(1 + 3 + 1 + 3);
  });

  it("draws spring colliders in their bones' space; skips bones the skeleton lacks", () => {
    const lines = rigGizmoLines(node("springChain", { bones: ["Neck", "Head"], colliderBones: ["Head", "Ghost"], colliderShapes: ["capsule", "sphere"], colliderA: [0, 0.1, 0, 0, 0, 0], colliderB: [0, 0.3, 0, 0, 0, 0], colliderRadius: [0.05, 0.1] }), lookup, 1);
    // The chain, then the capsule: two spheres of three circles and their axis.
    expect(lines).toHaveLength(1 + 3 + 3 + 1);
    const axis = lines.at(-1)!;
    expect(axis.points[0]![1]).toBeCloseTo(1.7, 12);
    expect(axis.points[1]![1]).toBeCloseTo(1.9, 12);
  });

  it("draws look-at limits as cones; a free joint draws none", () => {
    const lines = rigGizmoLines(node("lookAt", { bones: ["Neck", "Head"], limits: [0.5, 0] }), lookup, 1);
    expect(lines).toHaveLength(1 + 1 + 4);
  });
});
