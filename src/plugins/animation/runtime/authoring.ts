// What the ragdoll builder (editor half of the Ragdoll plugin, T55) reads of the animation plugin, through this plugin's one
// public module (`runtime/index.ts`, ADR 0133): a skeleton file's bytes and header, the animation core's default ragdoll
// description of a skeleton, and a bone's world matrix now. Authoring support only: a running game never calls it.
import { Quaternion } from "../../../engine/core/math";
import type { GameObject } from "../../../engine/scene/GameObject";
import { multiply34, toMat4 } from "./affine";
import { readSkeletonInfo, type SkeletonInfo } from "./assetInfo";
import { loadAnimationCore } from "./core/loader";
import { getRecord } from "./core/records";
import { loadSkeletonBytes } from "./features/clipSources";
import type { RagdollDescription } from "./ragdoll";
import { skinningMatrices } from "./skeletonInstances";
import { BONE_BODY, RAGDOLL_BONE, RAGDOLL_INFO } from "./wasm/wire/physics";

export { loadSkeletonBytes, readSkeletonInfo, type SkeletonInfo };

const NONE = 0xffffffff;
const FRONT_AXES = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;

/** @internal The core's description records as a description, or null when they don't parse. */
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

/** @internal The animation core's default ragdoll description of the `myco.skel@1` file `skeleton` (profile 0: Humanoid), or why not. */
export async function defaultRagdollDescription(skeleton: Uint8Array): Promise<RagdollDescription | { readonly error: string }> {
  const loaded = await loadAnimationCore();
  if (loaded.status !== "ready") return { error: "the animation core can't run here (it needs WebAssembly SIMD)." };
  const out = loaded.core.ragdollBuild(skeleton, 0);
  if (!out.length) return { error: `the animation core couldn't build a ragdoll for this skeleton (status ${loaded.core.lastStatus()}).` };
  return decodeRagdollDescription(out) ?? { error: "the animation core's ragdoll description doesn't parse." };
}

/**
 * @internal Bone `bone` of the Skeleton on `skeletonNode` in the world now (column-major 4×4: the node's world matrix times
 * the bone's model-space matrix, animated where the World animates it, else the rest pose), or null when the bone isn't in `info`.
 */
export function boneWorldMatrixOf(skeletonNode: GameObject, info: SkeletonInfo, bone: string): Float64Array | null {
  const index = info.indexOf(bone);
  if (index < 0 || !skeletonNode.transform) return null;
  const m = new Float64Array(12);
  const skinning = skinningMatrices(skeletonNode.world, skeletonNode);
  if (skinning && skinning.length >= (index + 1) * 12) multiply34(m, 0, skinning, index * 12, info.bind, index * 12);
  else m.set(info.restModel.subarray(index * 12, index * 12 + 12));
  const model = new Float64Array(16);
  toMat4(model, 0, m, 0);
  const world = skeletonNode.world.worldMatrix(skeletonNode.entity);
  const w = skeletonNode.entity * 16;
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += world[w + k * 4 + r]! * model[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}
