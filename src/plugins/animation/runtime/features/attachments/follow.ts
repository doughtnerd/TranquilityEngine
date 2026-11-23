// BoneAttachments follow their bones (ADR 0370's frame order, step 7; 0372; T17). Each World with an active
// BoneAttachment registers one hook with `World._afterPropagation`: after transform propagation (so the skeleton's
// node is where this frame's root motion and scripts put it), every attachment's node takes
//
//   world = skeleton node's world matrix × the bone's model-space matrix × offset (position, rotation)
//
// where the bone's model-space matrix is this frame's skinning matrix × the bind matrix (model × inverse bind × bind),
// or the rest pose while no Animator animates the skeleton; with bone overrides this frame (`Animator.bone`, T32), the
// overridden matrices, applied first. `follow` picks what it copies: `both` (position and
// rotation), `position` (keeps the node's own rotation) or `rotation` (keeps its position). The World propagates again
// after the hook, so the attachment's children and render sync see the new pose. Attachments are processed in
// activation order; an attachment that follows a bone of a skeleton carried by another attachment reads that one's
// pose of this frame only if it was activated after it.
import type { World } from "../../../../../engine/core/World";
import { Mat4, Quaternion } from "../../../../../engine/core/math";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import { multiply34, toMat4 } from "../../affine";
import type { BoneAttachment } from "../../components/BoneAttachment";
import { HANDLE_INDEX_MASK, MATRIX_FLOATS } from "../../wasm/wire/core";
import { applyBoneOverrides, posedMatrices } from "../bones";
import { skeletonOnNode, type SkeletonRuntime } from "../instances";

interface FollowList {
  readonly attachments: BoneAttachment[];
  readonly remove: () => void;
}

const lists = new WeakMap<World, FollowList>();

/** @internal Starts following (activation). */
export function joinFollowList(a: BoneAttachment): void {
  const world = a.node.world;
  let list = lists.get(world);
  if (!list) {
    const attachments: BoneAttachment[] = [];
    list = { attachments, remove: world._afterPropagation(follow) };
    lists.set(world, list);
  }
  if (!list.attachments.includes(a)) list.attachments.push(a);
}

/** @internal Stops following (deactivation, detach); the World's hook goes with its last attachment. */
export function leaveFollowList(a: BoneAttachment): void {
  const world = a.node.world;
  const list = lists.get(world);
  if (!list) return;
  const i = list.attachments.indexOf(a);
  if (i >= 0) list.attachments.splice(i, 1);
  if (!list.attachments.length) {
    list.remove();
    lists.delete(world);
  }
}

/** The Skeleton an attachment follows: its `skeleton` node's, or the nearest ancestor's. */
function skeletonFor(world: World, a: BoneAttachment): SkeletonRuntime | null {
  if (a.skeleton) return skeletonOnNode(world, a.skeleton);
  for (let n: GameObject | null = a.node.parent; n; n = n.parent) {
    const s = skeletonOnNode(world, n);
    if (s) return s;
  }
  return null;
}

/** @internal Whether an active BoneAttachment of `world` follows a bone of `s` (servers keep evaluating its pose, T33). */
export function isFollowed(world: World, s: SkeletonRuntime): boolean {
  const list = lists.get(world);
  return !!list && list.attachments.some((a) => skeletonFor(world, a) === s);
}

const bone34 = new Float32Array(12);
const skelMat = new Float64Array(16);
const boneMat = new Float64Array(16);
const offsetMat = new Float64Array(16);
const worldMat = new Float64Array(16);
const tmp = new Float64Array(16);
const pos = [0, 0, 0];
const rot = [0, 0, 0, 1];
const scl = [1, 1, 1];
const one = [1, 1, 1];

/** Writes the bone's model-space 3×4 (row-major) into `out`; false when the bone isn't known. */
function boneModelMatrix(s: SkeletonRuntime, bone: number, out: Float32Array): boolean {
  const info = s.info;
  if (!info || bone < 0 || bone >= info.bones) return false;
  const rt = s.animator;
  const posed = rt ? posedMatrices(rt) : null;
  if (posed) {
    // This frame's bone overrides (`../bones.ts`, T32).
    multiply34(out, 0, posed, bone * 12, info.bind, bone * 12);
    return true;
  }
  if (rt && rt.instance && rt.evaluated && rt.ns?.open) {
    const core = rt.ns.core;
    const at = core.matrixOffset(rt.instance) + bone * MATRIX_FLOATS;
    multiply34(out, 0, core.views().matrices, at, info.bind, bone * 12);
    return true;
  }
  out.set(info.restModel.subarray(bone * 12, bone * 12 + 12));
  return true;
}

const warnedBones = new Set<string>();

function follow(world: World): void {
  const list = lists.get(world);
  if (!list) return;
  applyBoneOverrides(world); // overrides written this frame first, whichever hook was registered first (T32)
  for (const a of list.attachments) {
    const t = a.node.transform;
    const s = skeletonFor(world, a);
    const skelTransform = s?.component.node.transform;
    if (!t || !s?.info || !skelTransform) continue;
    const index = s.info.indexOf(a.bone);
    if (index < 0) {
      const key = `${s.path}\u0000${a.bone}`;
      if (!warnedBones.has(key)) {
        warnedBones.add(key);
        console.warn(`[myco] ${a.node.name}: BoneAttachment's bone "${a.bone}" isn't in the skeleton "${s.path}".`);
      }
      continue;
    }
    if (!boneModelMatrix(s, index, bone34)) continue;
    toMat4(boneMat, 0, bone34, 0);
    const node = s.component.node;
    Mat4.copy(skelMat, 0, world.worldMatrix(node.entity), node.entity * 16);
    Mat4.multiplyAffine(tmp, 0, skelMat, 0, boneMat, 0);
    const o = a.offsetRotation, p = a.offsetPosition;
    rot[0] = o.x;
    rot[1] = o.y;
    rot[2] = o.z;
    rot[3] = o.w;
    pos[0] = p.x;
    pos[1] = p.y;
    pos[2] = p.z;
    Mat4.compose(offsetMat, 0, pos, 0, rot, 0, one, 0);
    Mat4.multiplyAffine(worldMat, 0, tmp, 0, offsetMat, 0);
    Mat4.decompose(worldMat, 0, pos, 0, rot, 0, scl, 0);
    if (a.follow !== "rotation") t.worldPosition = [pos[0]!, pos[1]!, pos[2]!];
    if (a.follow !== "position") t.worldRotation = new Quaternion(rot[0]!, rot[1]!, rot[2]!, rot[3]!).normalize();
  }
}
