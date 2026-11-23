// Editor registration seam: scene (T18). Registers dropping models with skins (Skeleton, SkinnedMeshRenderers, an Animator), clips dropped on Animators, bones in the Hierarchy and the bone gizmo, clip previews.
// The editor half's `activate()` (`../index.ts`) calls it once per activation. (The clip preview is the clip kinds'
// Inspector view, `formats/assetKinds.ts`; picking GPU-skinned meshes by their bounds is the Babylon editor viewport's.)
import type { EditorPluginContext, NodePath, OpenScene } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { boneGizmoTool } from "./boneGizmo";
import { skeletonBonesContribution } from "./bones";
import { clipDropLabel, dropClipOnAnimator } from "./clipDrop";
import { skinnedModelAugment } from "./skinnedModelDrop";

/** @internal */
export function registerScene(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  // Drop a skinned model: Skeleton, SkinnedMeshRenderers and an Animator playing its first clip (ADR 0373).
  context.registerAssetNodesAugment(skinnedModelAugment);
  // Drop a clip on an Animator: on its Hierarchy row, or on the drop zone under its Inspector card.
  context.registerNodeAssetDrop({
    id: "myco.animation.clipOnAnimator",
    label: clipDropLabel,
    drop: (scene: OpenScene, path: NodePath, assets: readonly string[]) => void dropClipOnAnimator(scene, path, assets[0]!),
  });
  context.registerInspectorSection("engine.Animator", () => import("./AnimatorClipDrop").then((m) => m.AnimatorClipDrop), { single: true });
  // Bones in the Hierarchy, the Inspector's bone target, and the bone gizmo.
  context.registerSkeletonBones(skeletonBonesContribution);
  context.registerViewportTool(boneGizmoTool);
}
