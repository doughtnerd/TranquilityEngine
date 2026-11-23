// A Skeleton's bones in the editor (ADR 0373 "Skeleton and retarget tools"; T18): the read-only rows the Hierarchy lists
// under a node with a Skeleton (names and parent structure from the skeleton asset), a bone's details for the Inspector's
// bone target (name, parent, rest pose, current pose), its world matrix for the bone gizmo, and Add BoneAttachment.
//
// Poses: the rest pose is the asset's (local TRS per bone). The current pose is the bone's model-space transform: the
// animated one where the Editor World animates the skeleton (`skinningMatrices` × bind; D10), else the rest pose in model
// space. Skinned draws and BoneAttachments live in the skeleton node's world space (D104), so the gizmo multiplies by it.
import type { NodePath } from "../../../../editor/document";
import { select } from "../../../../editor/inspectorTarget";
import { insertNodes, whyNotInsert } from "../../../../editor/nodeInsertion";
import { accept, applyEdit, refuse, type EditResult } from "../../../../editor/sdk/editResult";
import type { NodeTemplate, SkeletonBoneRow, SkeletonBonesContribution } from "../../../../editor/sdk/contributions";
import type { OpenScene } from "../../../../editor/state";
import { localPoseFromMatrix } from "../../../../engine/render/gizmoMath";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { multiply34, toMat4 } from "../../runtime/affine";
import type { SkeletonInfo } from "../../runtime/assetInfo";
import { Skeleton } from "../../runtime/components/Skeleton";
import { skinningMatrices } from "../../runtime/skeletonInstances";
import { skeletonInfoIfLoaded } from "./skeletonAssets";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** A transform as position, rotation (x, y, z, w) and scale. */
export interface BonePose {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/** What the Inspector shows of a bone (ADR 0373). */
export interface BoneDetails {
  readonly name: string;
  /** Its parent bone's name, or null for a root. */
  readonly parent: string | null;
  /** How many bones are under it, directly. */
  readonly children: number;
  /** The rest pose, local to its parent (from the asset). */
  readonly rest: BonePose;
  /** The current pose in the skeleton's model space. */
  readonly pose: BonePose;
  /** True when `pose` is the Editor World's animated pose; false when it is the rest pose (nothing animates it). */
  readonly animated: boolean;
}

/** The node at `path` and its Skeleton's asset, read through the Editor World (prefab values and overrides applied). */
function skeletonAt(scene: OpenScene, path: NodePath): { node: GameObject; info: SkeletonInfo | null } | null {
  const node = scene.sync.nodeFor(path);
  const skeleton = node?.getComponent(Skeleton);
  if (!node || !skeleton) return null;
  return { node, info: skeletonInfoIfLoaded(skeleton.skeleton) };
}

/** The bone tree of a skeleton asset: roots first, children in bone order (parents come before children in the file). */
function boneTree(info: SkeletonInfo): SkeletonBoneRow[] {
  const rows: { name: string; children: SkeletonBoneRow[] }[] = info.names.map((name, i) => ({ name: name || `Bone ${i}`, children: [] }));
  const roots: SkeletonBoneRow[] = [];
  for (let b = 0; b < info.bones; b++) {
    const parent = info.parents[b]!;
    (parent < 0 ? roots : rows[parent]!.children).push(rows[b]!);
  }
  return roots;
}

/** The bone rows under the node at `path`: its Skeleton's asset's bones, or none (no Skeleton, or its asset hasn't loaded). */
function boneRowsAt(scene: OpenScene, path: NodePath): readonly SkeletonBoneRow[] {
  const found = skeletonAt(scene, path);
  return found?.info ? boneTree(found.info) : [];
}

const poseOf = (m: Float32Array | Float64Array, at: number): BonePose => {
  const m4 = new Float64Array(16);
  toMat4(m4, 0, m, at);
  const local = localPoseFromMatrix(null, m4);
  return { position: [...local.position] as Vec3, rotation: [...local.rotation] as Quat, scale: [...local.scale] as Vec3 };
};

/** Bone `bone`'s model-space matrix now (3×4 at offset 0) and whether it is animated, or null when the bone isn't in `info`. */
function boneModelMatrix(node: GameObject, info: SkeletonInfo, bone: number): { matrix: Float64Array; animated: boolean } {
  const matrix = new Float64Array(12);
  const skinning = skinningMatrices(node.world, node);
  if (skinning && skinning.length >= (bone + 1) * 12) {
    multiply34(matrix, 0, skinning, bone * 12, info.bind, bone * 12); // model = skinning × bind (D10)
    return { matrix, animated: true };
  }
  matrix.set(info.restModel.subarray(bone * 12, bone * 12 + 12));
  return { matrix, animated: false };
}

/** The bone `bone` of the Skeleton on the node at `path` as the Inspector shows it, or null (no such bone, or the skeleton hasn't loaded). */
export function boneDetails(scene: OpenScene, path: NodePath, bone: string): BoneDetails | null {
  const found = skeletonAt(scene, path);
  const info = found?.info;
  const index = info ? info.indexOf(bone) : -1;
  if (!found || !info || index < 0) return null;
  const parent = info.parents[index]!;
  const r = info.rest.subarray(index * 10, index * 10 + 10);
  const { matrix, animated } = boneModelMatrix(found.node, info, index);
  let children = 0;
  for (let b = 0; b < info.bones; b++) if (info.parents[b] === index) children++;
  return {
    name: bone,
    parent: parent >= 0 ? info.names[parent] || `Bone ${parent}` : null,
    children,
    rest: { position: [r[0]!, r[1]!, r[2]!], rotation: [r[3]!, r[4]!, r[5]!, r[6]!], scale: [r[7]!, r[8]!, r[9]!] },
    pose: poseOf(matrix, 0),
    animated,
  };
}

/**
 * The bone's world matrix now (column-major 4×4: the skeleton node's world matrix × the bone's model-space matrix) and the
 * rig's size (its rest pose's radius, model units), for the bone gizmo; null when the bone or its skeleton isn't there.
 */
export function boneWorldMatrix(scene: OpenScene, path: NodePath, bone: string): { matrix: Float64Array; size: number } | null {
  const found = skeletonAt(scene, path);
  const info = found?.info;
  const index = info ? info.indexOf(bone) : -1;
  if (!found || !info || index < 0 || !found.node.transform) return null;
  const model = new Float64Array(16);
  toMat4(model, 0, boneModelMatrix(found.node, info, index).matrix, 0);
  const world = found.node.world.worldMatrix(found.node.entity);
  const w = found.node.entity * 16;
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += world[w + k * 4 + r]! * model[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return { matrix: out, size: info.radius };
}

/** The node Add BoneAttachment makes: a child named after the bone, following it (its Skeleton: the nearest ancestor's, this node). */
const attachmentTemplate = (bone: string): NodeTemplate => ({ name: bone, components: [{ type: "engine.Transform", data: {} }, { type: "engine.BoneAttachment", data: { bone } }] });

/** Add BoneAttachment for `bone` under the node at `path`, or why it can't (the node insertion's reasons: playing, a read-only scene…). */
function addBoneAttachmentEdit(scene: OpenScene, path: NodePath, bone: string): EditResult<NodeTemplate> {
  const template = attachmentTemplate(bone);
  const why = whyNotInsert(scene, { kind: "template", nodes: [template], label: "" }, { kind: "into", key: path.join("/") });
  return why ? refuse(why) : accept(template);
}

/**
 * Add a child node with a BoneAttachment following `bone` under the node at `path` (its Skeleton's node), as one undo
 * step, and select it; or report why not. Returns the new node's key, or null.
 */
export function addBoneAttachment(scene: OpenScene, path: NodePath, bone: string): string | null {
  const label = `Add BoneAttachment for ${bone}`;
  let key: string | null = null;
  applyEdit(addBoneAttachmentEdit(scene, path, bone), label, (template) => {
    const made = insertNodes(scene, { kind: "template", nodes: [template], label }, { kind: "into", key: path.join("/") });
    if (made.ok) key = made.keys[0] ?? null;
  });
  if (key) select([key], key);
  return key;
}

/** @internal The bone rows contribution the scene seam registers. */
export const skeletonBonesContribution: SkeletonBonesContribution = {
  id: "myco.animation.bones",
  bones: boneRowsAt,
  inspector: () => import("./BoneInspector").then((m) => m.BoneInspector),
};
