// Registration seam: sprites2d (T21). Registers the skinned sprites render feature (`renderFeature.ts`: slices with a 2D
// skin under a Skeleton2D, deformed by the `mycoSkin` kernel and drawn on the quad-batch path), lazily: a World without a
// Skeleton2D never loads it. The Skeleton2D's skeleton itself is `../sprites2d.ts` (its lifecycle), and image flipbook
// clips are made where Animators load clips (`../subAssetClips.ts`). `activate()` (`../../index.ts`) calls it once per
// activation.
import type { RenderFeatureSpec } from "../../../../../engine/render/renderFeatures";
import type { RuntimePluginContext } from "../../../../runtimeContext";
import { Skeleton2D } from "../../components/Skeleton2D";
import type { AnimationIntegrations } from "../../registration";

/** @internal Content phase, after the sprites (which skip the sprites it claims). */
export const SKINNED_SPRITES_SPEC: RenderFeatureSpec = { name: "skinnedSprites", phase: "content", types: [Skeleton2D], lazy: true, after: ["sprites"] };

/** @internal */
export function registerSprites2D(context: RuntimePluginContext, _on: AnimationIntegrations): void {
  context.registerRenderFeature({ spec: SKINNED_SPRITES_SPEC, load: () => import("./renderFeature").then((m) => m.createSkinnedSpritesFeature) });
}
