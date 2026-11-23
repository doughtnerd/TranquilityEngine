// The built-in Humanoid profile as a `SkeletonProfile` value (ADR 0372; `anim-retarget`'s `Profile::humanoid`), for the
// editor's bone map table and for "Copy Humanoid as a custom profile". Roles come in the core's order
// (`HUMANOID_ROLES`, the order a bone map's indices use). Mirrors, required flags, chains, root and hips follow
// `profile.rs`; the joint ranges are left out (the core owns them: a copy starts free and the chain editor sets them).
import { SKELETON_PROFILE_FORMAT, type ChainKind, type ProfileChain, type ProfileRole, type SkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import { HUMANOID_ROLES } from "../../runtime/core/boneMap";

const REQUIRED = new Set(["Hips", "Spine", "Chest", "Neck", "Head", ...["Left", "Right"].flatMap((s) => ["UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot"].map((r) => `${s}${r}`))]);

const counterpart = (name: string): string => (name.startsWith("Left") ? `Right${name.slice(4)}` : name.startsWith("Right") ? `Left${name.slice(5)}` : name);

/** @internal The built-in Humanoid profile (named "Humanoid"). */
export function humanoidProfile(): SkeletonProfile {
  const names = new Set(HUMANOID_ROLES);
  const roles: ProfileRole[] = HUMANOID_ROLES.map((name) => {
    const other = counterpart(name);
    return { name, mirror: names.has(other) ? other : name, flip: "auto", range: null, required: REQUIRED.has(name) };
  });
  const chains: ProfileChain[] = [];
  const chain = (name: string, kind: ChainKind, ik: boolean, list: string[]) => chains.push({ name, kind, roles: list, ik });
  chain("Spine", "spine", false, ["Spine", "Chest", "UpperChest"]);
  chain("Head", "head", false, ["Neck", "Head"]);
  chain("LeftEye", "head", false, ["LeftEye"]);
  chain("RightEye", "head", false, ["RightEye"]);
  chain("Jaw", "head", false, ["Jaw"]);
  for (const side of ["Left", "Right"]) {
    chain(`${side}Arm`, "arm", true, ["Shoulder", "UpperArm", "LowerArm", "Hand"].map((r) => side + r));
    for (const [finger, parts] of [["Thumb", ["Metacarpal", "Proximal", "Distal"]], ["Index", ["Proximal", "Intermediate", "Distal"]], ["Middle", ["Proximal", "Intermediate", "Distal"]], ["Ring", ["Proximal", "Intermediate", "Distal"]], ["Little", ["Proximal", "Intermediate", "Distal"]]] as const) {
      chain(`${side}${finger}`, "finger", false, parts.map((p) => `${side}${finger}${p}`));
    }
  }
  for (const side of ["Left", "Right"]) {
    chain(`${side}Leg`, "leg", true, ["UpperLeg", "LowerLeg", "Foot"].map((r) => side + r));
    chain(`${side}Toes`, "leg", false, [`${side}Toes`]);
  }
  for (const side of ["Left", "Right"]) for (const part of ["UpperArmTwist", "LowerArmTwist", "UpperLegTwist", "LowerLegTwist"]) chain(`${side}${part}`, "twist", false, [`${side}${part}`]);
  return { format: SKELETON_PROFILE_FORMAT, name: "Humanoid", roles, chains, root: "Root", hips: "Hips" };
}
