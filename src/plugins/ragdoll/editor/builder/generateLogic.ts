// Generate a ragdoll from a skeleton (ADR 0373 "Ragdoll builder: generate bodies and joints from a skeleton (capsules by bone
// length, limits from the profile's joint ranges)"; T55). The animation core's builder (`ragdoll_build`) says which bones
// get bodies and with what limits and drives: from the skeleton file's own joint ranges, else the Humanoid profile's roles'
// defaults (profile 0). The Ragdoll plugin's generator (`runtime/generate.ts`, `generateRagdollBones`) turns that and the
// skeleton's rest pose into shapes (a capsule by bone length for a one-child bone, a box for a branching one, a sphere for a
// leaf) and masses. Together they are what a Ragdoll with an empty `bones` list uses at run time; the builder writes the
// result into `bones` so the table and the gizmos can edit it.
//
// The description is read from the core directly (`loadAnimationCore`, `ragdollBuild`, the wire's `RAGDOLL_*` records):
// the animation plugin offers it to the ragdoll runtime only through a bound Animator (`PhysicalAnimationSource`), and the
// editor has no instance to ask. Decoding is the same layout `features/physical.ts` decodes.
import { Quaternion } from "../../../../engine/core/math";
import type { RagdollDescription } from "../../../animation/runtime";
import { loadAnimationCore } from "../../../animation/runtime/core/loader";
import { getRecord } from "../../../animation/runtime/core/records";
import { readSkeletonInfo, type SkeletonInfo } from "../../../animation/runtime/assetInfo";
import { BONE_BODY, RAGDOLL_BONE, RAGDOLL_INFO } from "../../../animation/runtime/wasm/wire/physics";
import { generateRagdollBones, type RagdollRigData } from "../../runtime/generate";
import type { RagdollBone } from "../../runtime/Ragdoll";

const NONE = 0xffffffff;
const FRONT_AXES = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;

/** The core's description records as a description, or null when they don't parse. */
export function decodeRagdollDescription(bytes: Uint8Array): RagdollDescription | null {
  if (bytes.length < RAGDOLL_INFO.stride) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = getRecord(view, 0, RAGDOLL_INFO);
  if (bytes.length !== RAGDOLL_INFO.stride + info.boneCount * RAGDOLL_BONE.stride) return null;
  const bones = [];
  for (let i = 0; i < info.boneCount; i++) {
    const b = getRecord(view, RAGDOLL_INFO.stride + i * RAGDOLL_BONE.stride, RAGDOLL_BONE);
    bones.push({
      body: (b.flags & BONE_BODY) !== 0,
      jointFrame: new Quaternion(b.frameX, b.frameY, b.frameZ, b.frameW),
      swing: { y: b.swingY, z: b.swingZ },
      twist: { min: b.twistMin, max: b.twistMax },
      stiffness: b.stiffness,
      damping: b.damping,
      maxForce: b.maxForce,
      strength: b.strength,
      pin: b.pin,
    });
  }
  return { bones, pelvis: info.pelvis === NONE ? undefined : info.pelvis, front: FRONT_AXES[info.front] ?? "+z" };
}

/** What the generator reads of a skeleton file. */
export const rigOf = (info: SkeletonInfo): RagdollRigData => ({ names: info.names, parents: info.parents, restModel: info.restModel });

/** The generated ragdoll: the bodies, and the pelvis bone and facing axis the core's description gives. */
export interface GeneratedRagdoll {
  readonly bones: RagdollBone[];
  /** The pelvis bone's name, or "" (the first root body). */
  readonly pelvis: string;
  readonly front: RagdollDescription["front"];
}

/** The ragdoll for the skeleton file `skeleton` (`myco.skel@1` bytes), or why not. */
export async function generateRagdoll(skeleton: Uint8Array): Promise<GeneratedRagdoll | { readonly error: string }> {
  const info = readSkeletonInfo(skeleton);
  if (!info) return { error: "the skeleton file can't be read." };
  const loaded = await loadAnimationCore();
  if (loaded.status !== "ready") return { error: "the animation core can't run here (it needs WebAssembly SIMD), so a ragdoll can't be generated." };
  const out = loaded.core.ragdollBuild(skeleton, 0);
  if (!out.length) return { error: `the animation core couldn't build a ragdoll for this skeleton (status ${loaded.core.lastStatus()}).` };
  const description = decodeRagdollDescription(out);
  if (!description) return { error: "the animation core's ragdoll description doesn't parse." };
  const bones = generateRagdollBones(rigOf(info), description);
  if (bones.length === 0) return { error: "no bone of the skeleton gets a body: its joint ranges and profile roles name none." };
  const pelvis = description.pelvis !== undefined && description.bones[description.pelvis]?.body ? (info.names[description.pelvis] ?? "") : "";
  return { bones, pelvis, front: description.front };
}
