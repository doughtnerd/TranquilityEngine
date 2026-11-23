// T55 (ADR 0373, 0375): Generate from skeleton through the real animation core in Node: the core's description builder over
// each fixture skeleton, then the ragdoll plugin's generator, give bodies a ragdoll can use: only bones of the skeleton, in
// its order, a shape that suits each (capsules by bone length for one-child bones, boxes for branching ones, spheres for
// leaves), positive sizes and masses, and limits inside the rules the builder's table enforces.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Assets } from "../../../../engine/scene/Assets";
import { readSkeletonInfo } from "../../../animation/runtime/assetInfo";
import { HUMANOID_ROLES } from "../../../animation/runtime/core/boneMap";
import { loadAnimationCompiler } from "../../../animation/editor/compile/compiler";
import type { RagdollBone } from "../../runtime/Ragdoll";
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

  // T70: the Skeleton's `profile` gives the roles' joint ranges. The humanoid fixture (bones named bone0…) gets a role per
  // bone, written by the editor module's skeleton compile as an import writes its map (bone i: Humanoid role i); the custom
  // profile has the Humanoid's roles with every range 12° of swing and ±7° of twist, where profile 0 (the Humanoid's
  // defaults) has others.
  it("takes the joint ranges of the Skeleton's profile", async () => {
    const raw = fixture("humanoid.skel");
    const roles = Uint16Array.from({ length: readSkeletonInfo(raw)!.bones }, (_, b) => (b < HUMANOID_ROLES.length ? b : 0xffff));
    const compiled = (await loadAnimationCompiler()).compileSkeleton(raw, roles, "Humanoid");
    if (!("bytes" in compiled)) throw new Error(compiled.error);
    const range = { swingY: 12, swingZ: 12, twistMin: -7, twistMax: 7 };
    Assets.addSource(Assets.fromObject({ "rig/tight.skelprofile.json": { format: "myco.skelprofile@1", name: "Tight", roles: HUMANOID_ROLES.map((name) => ({ name, range })), root: "Root", hips: "Hips" } }));
    const plain = await generateRagdoll(compiled.bytes);
    const out = await generateRagdoll(compiled.bytes, "rig/tight.skelprofile.json");
    if ("error" in out || "error" in plain) throw new Error("generate failed");
    const key = (b: RagdollBone) => [b.swing.y, b.swing.z, b.twist.min, b.twist.max].map((v) => Math.round(v * 1e3) / 1e3);
    const tight = out.bones.filter((b) => key(b).join() === "12,12,-7,7");
    expect(tight.length).toBeGreaterThan(2);
    expect(plain.bones.filter((b) => key(b).join() === "12,12,-7,7")).toEqual([]);
    expect(await generateRagdoll(compiled.bytes, "rig/missing.skelprofile.json")).toEqual({ error: 'the skeleton profile "rig/missing.skelprofile.json" can\'t be read.' });
  });
});
