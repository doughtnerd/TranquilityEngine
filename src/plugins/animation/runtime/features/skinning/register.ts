// Registration seam: skinning (T16). Registers the skinning render feature (`renderFeature.ts`: the `mycoSkin` kernel on
// `render/gpuKernels/`, bone matrices uploaded once a frame per skeleton and morph weights at render sync), lazily: a World
// without SkinnedMeshRenderers never loads it. `activate()` (`../../index.ts`) calls it once per activation.
import { registerLodMemberType } from "../../../../../engine/render/visibility/lodMember";
import type { RenderFeatureSpec } from "../../../../../engine/render/renderFeatures";
import type { RuntimePluginContext } from "../../../../runtimeContext";
import { SkinnedMeshRenderer } from "../../components/SkinnedMeshRenderer";
import type { AnimationIntegrations } from "../../registration";

/** @internal Content phase, after the meshes (a frame's casters include both). */
export const SKINNING_SPEC: RenderFeatureSpec = { name: "skinning", phase: "content", types: [SkinnedMeshRenderer], lazy: true, after: ["meshes"] };

/** @internal */
export function registerSkinning(context: RuntimePluginContext, _on: AnimationIntegrations): void {
  // ADR 0459 §2: an LODGroup controls skinned meshes too, through the visibility stage's member types (a repeat is a no-op).
  registerLodMemberType(SkinnedMeshRenderer);
  context.registerRenderFeature({ spec: SKINNING_SPEC, load: () => import("./renderFeature").then((m) => m.createSkinningFeature) });
}
