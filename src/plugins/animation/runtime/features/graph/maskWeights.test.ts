// ADR 0371, 0372 (T32): avatar masks resolved to per-bone weights. A chain root → spine → chest → (head, arm → hand),
// plus a leg off the root.
import { describe, expect, it } from "vitest";
import type { MaskEntry } from "../../../../../engine/animation/mask";
import { resolveMaskWeights } from "./maskWeights";

const skeleton = {
  names: ["root", "spine", "chest", "head", "arm", "hand", "leg"],
  parents: [-1, 0, 1, 2, 2, 4, 0],
};
const noRoles = () => -1;
const bone = (name: string, weight = 1, recursive = true): MaskEntry => ({ bone: name, weight, recursive });

describe("resolveMaskWeights", () => {
  it("gives a recursive entry's weight to the bone and its descendants, 0 elsewhere", () => {
    const { weights, missing } = resolveMaskWeights([bone("chest", 0.8)], skeleton, noRoles);
    expect(Array.from(weights)).toEqual([0, 0, 0.8, 0.8, 0.8, 0.8, 0].map(Math.fround));
    expect(missing).toEqual([]);
  });

  it("lets a deeper entry override what a recursive ancestor gave", () => {
    const { weights } = resolveMaskWeights([bone("spine"), bone("arm", 0.25)], skeleton, noRoles);
    expect(Array.from(weights)).toEqual([0, 1, 1, 1, 0.25, 0.25, 0]);
  });

  it("keeps a non-recursive entry to its own bone: descendants take the ancestors' weight", () => {
    const { weights } = resolveMaskWeights([bone("spine", 0.5), bone("chest", 1, false)], skeleton, noRoles);
    expect(Array.from(weights)).toEqual([0, 0.5, 1, 0.5, 0.5, 0.5, 0]);
  });

  it("maps role entries through roleBone, and lists entries the skeleton lacks", () => {
    const roles: Record<string, number> = { LeftUpperLeg: 6 };
    const entries: MaskEntry[] = [{ role: "LeftUpperLeg", weight: 1, recursive: true }, { role: "Tail", weight: 1, recursive: true }, bone("wing")];
    const { weights, missing } = resolveMaskWeights(entries, skeleton, (r) => roles[r] ?? -1);
    expect(Array.from(weights)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(missing).toEqual(["role Tail", "wing"]);
  });
});
