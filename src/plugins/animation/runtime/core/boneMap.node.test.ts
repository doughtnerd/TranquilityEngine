// ADR 0371 (T14): a model imported while the Animation plugin is active gets its bone map guessed by the core's
// `guess_bone_map` (the committed wasm, in Node), through the guesser `registerCore` installs; the skeleton's roles
// follow. The skeleton reaches the core as the `myco.skel@1` bytes the import writes, which the header reader accepts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../../../../engine/index";
import { boneMapGuesser, setBoneMapGuesser } from "../../../../engine/animation/import/boneMapGuess";
import { encodeSkeleton } from "../../../../engine/animation/import/skeletonBinary";
import { readAnimationHeader } from "../../../../engine/animation/binaryHeader";
import { parseSkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import { loadModel } from "../../../../engine/scene/models";
import { skinnedGltf } from "../../../../engine/tests/fixtures/gltf/skinnedGltf";
import { createBoneMapGuesser, HUMANOID_ROLES } from "./boneMap";
import { loadAnimationCore } from "./loader";

const dataUrl = (text: string) => `data:application/octet-stream;base64,${Buffer.from(text).toString("base64")}`;

describe("bone maps guessed on import", () => {
  const before = boneMapGuesser();
  afterEach(() => {
    setBoneMapGuesser(before);
    Assets.clearSources();
    vi.restoreAllMocks();
  });

  it("lists the core's 64 Humanoid roles", () => {
    expect(HUMANOID_ROLES.length).toBe(64);
    expect([HUMANOID_ROLES[0], HUMANOID_ROLES[1], HUMANOID_ROLES[14], HUMANOID_ROLES[48], HUMANOID_ROLES[63]]).toEqual(["Root", "Hips", "LeftThumbMetacarpal", "LeftUpperLeg", "RightLowerLegTwist"]);
  });

  it("fills the skeleton's roles from the core's guess when the sidecar has no bone map", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setBoneMapGuesser(createBoneMapGuesser(loadAnimationCore));
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "models/guess.gltf": dataUrl(skinnedGltf()) }));
    const a = (await loadModel("models/guess.gltf")).animation!;
    expect(readAnimationHeader(encodeSkeleton(a.skeleton!, "guess")).ok).toBe(true);
    expect(a.boneMapSource).toBe("guessed");
    // The fixture is a spine chain without limbs: the core is sure only of the hips (its heuristics weigh the whole rig).
    expect(a.boneMap).toMatchObject({ Hips: "Hips" });
    expect(a.skeleton!.roles[0]).toBe("Hips");
    expect(a.skeleton!.roles.filter((r) => r !== null).length).toBe(Object.keys(a.boneMap).length);
  });

  it("guesses for a custom profile's roles", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const profile = parseSkeletonProfile({ format: "myco.skelprofile@1", name: "Mini", roles: [{ name: "Hips", required: true }, { name: "Head" }], chains: [], hips: "Hips" }).value;
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "models/guess.gltf": dataUrl(skinnedGltf()) }));
    const skeleton = (await loadModel("models/guess.gltf")).animation!.skeleton!;
    const guess = await createBoneMapGuesser(loadAnimationCore)(encodeSkeleton(skeleton), skeleton.bones.map((b) => b.name), profile);
    expect(guess).toMatchObject({ Hips: "Hips" });
  });
});
