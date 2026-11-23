// The model import's bone-map guesser (ADR 0371 "Model import": `boneMap` auto-filled on import), over the animation
// core's `guess_bone_map` (T41g). `registerCore` installs it into the engine (`setBoneMapGuesser`) when the plugin
// activates, so models imported in the editor, a game or Node get a guessed map whenever their sidecar has none. The
// core loads lazily through the page's loader; where it can't run (no `simd128`) the guess is null and the import
// leaves the map empty and says so.
import type { BoneMapGuesser } from "../../../../engine/animation/import/boneMapGuess";
import { encodeSkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import type { AnimationCoreLoader } from "./loader";

const side = (s: "Left" | "Right") => [
  `${s}Shoulder`, `${s}UpperArm`, `${s}LowerArm`, `${s}Hand`,
  `${s}ThumbMetacarpal`, `${s}ThumbProximal`, `${s}ThumbDistal`,
  `${s}IndexProximal`, `${s}IndexIntermediate`, `${s}IndexDistal`,
  `${s}MiddleProximal`, `${s}MiddleIntermediate`, `${s}MiddleDistal`,
  `${s}RingProximal`, `${s}RingIntermediate`, `${s}RingDistal`,
  `${s}LittleProximal`, `${s}LittleIntermediate`, `${s}LittleDistal`,
];
const leg = (s: "Left" | "Right") => [`${s}UpperLeg`, `${s}LowerLeg`, `${s}Foot`, `${s}Toes`];

/**
 * @internal The built-in Humanoid profile's roles in the core's order (`anim-retarget`'s `HUMANOID_ROLES`, `humanoid`
 * constants: Root 0 … RightLowerLegTwist 63).
 */
export const HUMANOID_ROLES: readonly string[] = Object.freeze([
  "Root", "Hips", "Spine", "Chest", "UpperChest", "Neck", "Head", "LeftEye", "RightEye", "Jaw",
  ...side("Left"), ...side("Right"), ...leg("Left"), ...leg("Right"),
  "LeftUpperArmTwist", "LeftLowerArmTwist", "RightUpperArmTwist", "RightLowerArmTwist",
  "LeftUpperLegTwist", "LeftLowerLegTwist", "RightUpperLegTwist", "RightLowerLegTwist",
]);

const NO_BONE = 0xffff;

/** @internal A guesser over a core loader: role → bone name for every role the core mapped. */
export function createBoneMapGuesser(load: AnimationCoreLoader): BoneMapGuesser {
  return async (skeleton, bones, profile) => {
    try {
      const loaded = await load();
      if (loaded.status !== "ready") return null;
      let encoded: Uint8Array | null = null;
      if (profile) {
        const e = encodeSkeletonProfile(profile);
        if (!("bytes" in e)) return null;
        encoded = e.bytes;
      }
      const roles = profile ? profile.roles.map((r) => r.name) : HUMANOID_ROLES;
      const guess = loaded.core.guessBoneMap(skeleton, encoded);
      if (!guess) return null;
      const out: Record<string, string> = {};
      guess.forEach((bone, role) => {
        if (bone !== NO_BONE && bone < bones.length && roles[role] !== undefined) out[roles[role]] = bones[bone];
      });
      return out;
    } catch {
      return null;
    }
  };
}
