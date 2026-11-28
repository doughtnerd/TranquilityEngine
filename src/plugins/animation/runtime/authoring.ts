// What the ragdoll builder (editor half of the Ragdoll plugin, T55) reads of the animation plugin, through this plugin's one
// public module (`runtime/index.ts`, ADR 0133): a skeleton file's bytes and header, the animation core's default ragdoll
// description of a skeleton (for its Skeleton's profile, T70), and a bone's world matrix now. Also the mirror table of a
// skeleton's profile (T70: the pose database bake's mirrored copies). Authoring support only: a running game never calls it.
import { fnv1aHex } from "../../../engine/animation/compile/hash";
import { encodeSkeletonProfile, parseSkeletonProfile } from "../../../engine/animation/skeletonProfile";
import { Quaternion } from "../../../engine/core/math";
import type { GameObject } from "../../../engine/scene/GameObject";
import { multiply34, toMat4 } from "./affine";
import { readSkeletonInfo, type SkeletonInfo } from "./assetInfo";
import type { AnimationCore } from "./core/AnimationCore";
import { loadAnimationCore } from "./core/loader";
import { getRecord } from "./core/records";
import { loadSkeletonBytes } from "./features/clipSources";
import { readJsonAsset } from "./features/graph/jsonAsset";
import { modelBoneMap } from "./features/retarget/maps";
import type { RagdollDescription } from "./ragdoll";
import { skinningMatrices } from "./skeletonInstances";
import { BONE_BODY, RAGDOLL_BONE, RAGDOLL_INFO } from "./wasm/wire/physics";
import { normalizeAssetPath } from "../../../engine/scene/assetPath";

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

/** A skeleton profile (`*.skelprofile.json`) loaded into `core` as one reference (release it after use), or why not. */
async function profileIn(core: AnimationCore, path: string): Promise<{ readonly handle: number; readonly bytes: Uint8Array } | { readonly error: string }> {
  let value: unknown;
  try {
    value = await readJsonAsset(normalizeAssetPath(path));
  } catch {
    return { error: `the skeleton profile "${path}" can't be read.` };
  }
  const encoded = encodeSkeletonProfile(parseSkeletonProfile(value, path).value);
  if (!("bytes" in encoded)) return { error: `the skeleton profile "${path}" can't be used: ${encoded.problem}` };
  const bytes = encoded.bytes;
  const handle = core.acquire(`profile:${fnv1aHex(bytes)}:${bytes.length}`, "profile", { kind: "profile", bytes });
  return handle ? { handle, bytes } : { error: `the animation core refused the skeleton profile "${path}" (status ${core.lastStatus()}).` };
}

/**
 * @internal The animation core's default ragdoll description of the `myco.skel@1` file `skeleton`, from the skeleton's own
 * joint ranges, else the roles' ranges of `profile` (a Skeleton's `profile`: a `*.skelprofile.json`; "" for the built-in
 * Humanoid, T70), or why not.
 */
export async function defaultRagdollDescription(skeleton: Uint8Array, profile = ""): Promise<RagdollDescription | { readonly error: string }> {
  const loaded = await loadAnimationCore();
  if (loaded.status !== "ready") return { error: "the animation core can't run here (it needs WebAssembly SIMD)." };
  const core = loaded.core;
  const p = profile ? await profileIn(core, profile) : { handle: 0 };
  if ("error" in p) return p;
  const out = core.ragdollBuild(skeleton, p.handle);
  if (p.handle) core.release(p.handle);
  if (!out.length) return { error: `the animation core couldn't build a ragdoll for this skeleton (status ${core.lastStatus()}).` };
  return decodeRagdollDescription(out) ?? { error: "the animation core's ragdoll description doesn't parse." };
}

/**
 * @internal T70: the mirror table of the skeleton `skeletonRef` (its `myco.skel@1` bytes `skeleton`) through `profile` (""
 * for the Humanoid): the skeleton's mirror axis (0 x, 1 y, 2 z), then the graph `MIRROR` node's word per bone (partner and
 * flip), from the profile's mirror roles over the skeleton's bone map (a model's import map for the Humanoid, else the
 * core's guess), or why not. The pose database bake mirrors clips through it.
 */
export async function profileMirrorTable(skeleton: Uint8Array, skeletonRef: string, profile = ""): Promise<Uint32Array | { readonly error: string }> {
  const info = readSkeletonInfo(skeleton);
  if (!info) return { error: "the skeleton file can't be read." };
  const loaded = await loadAnimationCore();
  if (loaded.status !== "ready") return { error: "the animation core can't run here (it needs WebAssembly SIMD)." };
  const core = loaded.core;
  const p = profile ? await profileIn(core, profile) : { handle: 0, bytes: null };
  if ("error" in p) return p;
  try {
    const map = (!profile ? await modelBoneMap(skeletonRef, info) : null) ?? core.guessBoneMap(skeleton, p.bytes);
    if (!map) return { error: `the bones of "${skeletonRef}" can't be mapped to ${profile ? `the profile "${profile}"` : "the Humanoid profile"}.` };
    const words = core.mirrorTable(skeleton, p.handle, map);
    if (!words) return { error: `the animation core couldn't make the mirror table of "${skeletonRef}" (status ${core.lastStatus()}).` };
    const out = new Uint32Array(words.length + 1);
    out[0] = info.mirrorAxis;
    out.set(words, 1);
    return out;
  } finally {
    if (p.handle) core.release(p.handle);
  }
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
