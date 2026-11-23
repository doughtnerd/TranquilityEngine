// Generate a ragdoll from a skeleton (ADR 0373 "Ragdoll builder: generate bodies and joints from a skeleton (capsules by bone
// length, limits from the profile's joint ranges)"; T55). The animation core's builder (`ragdoll_build`) says which bones
// get bodies and with what limits and drives: from the skeleton file's own joint ranges, else the roles' defaults of the
// Skeleton's `profile` (T70; the built-in Humanoid when it names none). The Ragdoll plugin's generator (`runtime/generate.ts`, `generateRagdollBones`) turns that and the
// skeleton's rest pose into shapes (a capsule by bone length for a one-child bone, a box for a branching one, a sphere for a
// leaf) and masses. Together they are what a Ragdoll with an empty `bones` list uses at run time; the builder writes the
// result into `bones` so the table and the gizmos can edit it.
//
// The description is read from the core through the animation plugin's public module (`defaultRagdollDescription`): the
// ragdoll runtime gets it only through a bound Animator (`PhysicalAnimationSource`), and the editor has no instance to ask.
import type { RagdollDescription } from "../../../animation/runtime";
import { defaultRagdollDescription, readSkeletonInfo, type SkeletonInfo } from "../../../animation/runtime";
import { generateRagdollBones, type RagdollRigData } from "../../runtime/generate";
import type { RagdollBone } from "../../runtime/Ragdoll";

/** What the generator reads of a skeleton file. */
export const rigOf = (info: SkeletonInfo): RagdollRigData => ({ names: info.names, parents: info.parents, restModel: info.restModel });

/** The generated ragdoll: the bodies, and the pelvis bone and facing axis the core's description gives. */
export interface GeneratedRagdoll {
  readonly bones: RagdollBone[];
  /** The pelvis bone's name, or "" (the first root body). */
  readonly pelvis: string;
  readonly front: RagdollDescription["front"];
}

/**
 * The ragdoll for the skeleton file `skeleton` (`myco.skel@1` bytes) through the Skeleton's `profile` (a `*.skelprofile.json`;
 * "" for the Humanoid), or why not.
 */
export async function generateRagdoll(skeleton: Uint8Array, profile = ""): Promise<GeneratedRagdoll | { readonly error: string }> {
  const info = readSkeletonInfo(skeleton);
  if (!info) return { error: "the skeleton file can't be read." };
  const description = await defaultRagdollDescription(skeleton, profile);
  if ("error" in description) return description;
  const bones = generateRagdollBones(rigOf(info), description);
  if (bones.length === 0) return { error: "no bone of the skeleton gets a body: its joint ranges and profile roles name none." };
  const pelvis = description.pelvis !== undefined && description.bones[description.pelvis]?.body ? (info.names[description.pelvis] ?? "") : "";
  return { bones, pelvis, front: description.front };
}
