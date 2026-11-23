// Registration seam: skinning (T16). Registers the skinning render feature (`renderFeature.ts`: the `mycoSkin` kernel on
// `render/gpuKernels/`, bone matrices uploaded once a frame per skeleton and morph weights at render sync), lazily: a World
// without SkinnedMeshRenderers never loads it. `activate()` (`../../index.ts`) calls it once per activation.
import type { RenderFeatureSpec } from "../../../../../engine/render/renderFeatures";
import type { RuntimePluginContext } from "../../../../runtimeContext";
import { SkinnedMeshRenderer } from "../../components/SkinnedMeshRenderer";
import type { AnimationIntegrations } from "../../registration";

/** @internal Content phase, after the meshes (a frame's casters include both). */
export const SKINNING_SPEC: RenderFeatureSpec = { name: "skinning", phase: "content", types: [SkinnedMeshRenderer], lazy: true, after: ["meshes"] };

/** @internal */
export function registerSkinning(context: RuntimePluginContext, _on: AnimationIntegrations): void {
  context.registerRenderFeature({ spec: SKINNING_SPEC, load: () => import("./renderFeature").then((m) => m.createSkinningFeature) });
}
