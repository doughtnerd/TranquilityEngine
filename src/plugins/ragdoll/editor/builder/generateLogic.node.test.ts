// T55 (ADR 0373, 0375): Generate from skeleton through the real animation core in Node: the core's description builder over
// each fixture skeleton, then the ragdoll plugin's generator, give bodies a ragdoll can use: only bones of the skeleton, in
// its order, a shape that suits each (capsules by bone length for one-child bones, boxes for branching ones, spheres for
// leaves), positive sizes and masses, and limits inside the rules the builder's table enforces.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSkeletonInfo } from "../../../animation/runtime/assetInfo";
import { boneProblem } from "./ragdollLogic";
import { generateRagdoll, type GeneratedRagdoll } from "./generateLogic";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../animation/runtime/wasm/fixtures/${name}`, import.meta.url)));

async function generated(name: string): Promise<GeneratedRagdoll> {
  const out = await generateRagdoll(fixture(name));
  if ("error" in out) throw new Error(`${name}: ${out.error}`);
  return out;
}

describe("generateRagdoll", () => {
  for (const name of ["humanoid.skel", "rig.skel", "small.skel"]) {
    it(`fills sensible bodies for ${name}`, async () => {
      const info = readSkeletonInfo(fixture(name))!;
      const out = await generated(name);
      expect(out.bones.length).toBeGreaterThan(0);
      // Bones of the skeleton, once each, in the skeleton's order.
      const at = out.bones.map((b) => info.indexOf(b.bone));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(new Set(at).size).toBe(at.length);
      for (const b of out.bones) {
        expect(boneProblem(b), `${b.bone}: ${boneProblem(b)}`).toBeNull();
        expect(b.mass).toBeGreaterThan(0);
        expect(["capsule", "box", "sphere"]).toContain(b.shape);
      }
      // The shape follows the skeleton's shape: one child → capsule, several → box, none → sphere.
      const children = (i: number) => Array.from({ length: info.bones }, (_, k) => k).filter((k) => info.parents[k] === i).length;
      for (const b of out.bones) {
        const kids = children(info.indexOf(b.bone));
        if (kids === 0) expect(b.shape).toBe("sphere");
        else if (kids > 1) expect(b.shape).toBe("box");
        else expect(b.shape).toBe("capsule");
      }
      if (out.pelvis) expect(out.bones.some((b) => b.bone === out.pelvis)).toBe(true);
      expect(["+x", "-x", "+y", "-y", "+z", "-z"]).toContain(out.front);
    });
  }

  it("is deterministic", async () => {
    expect(await generated("humanoid.skel")).toEqual(await generated("humanoid.skel"));
  });

  it("explains a file that isn't a skeleton", async () => {
    expect(await generateRagdoll(new Uint8Array(8))).toEqual({ error: "the skeleton file can't be read." });
  });
});
