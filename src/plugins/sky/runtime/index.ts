// The Sky plugin's runtime half (ADR 0134, 0135): the `Sky` component and the sky render feature,
// registered when the plugin activates. The sky asset's format, presets and maths stay in
// `src/engine/sky/`: core code reads them too (the Environment's sky asset in the renderer's lighting,
// asset thumbnails, the editor's Environment inspector). The plugin's public module (`./public.ts`)
// re-exports their public parts, so `myco` exports them with `Sky`.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; never imports
// Babylon (the feature's code loads on demand).
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { skyManifest } from "../manifest";
import { Sky } from "./Sky";

export * from "./public";
export { cloneSky } from "../../../engine/sky/skyFormat";

/** Reads Environment (the sky asset) and Sky; owns nothing to release. Contributes its sun and bake to the lighting rig (ADR 0252). */
const SKY_SPEC: RenderFeatureSpec = { name: "sky", phase: "lighting", types: [], lazy: false };

export const skyRuntimePlugin: RuntimePlugin = {
  manifest: skyManifest,
  activate(context) {
    context.registerComponents([Sky]);
    context.registerRenderFeature({ spec: SKY_SPEC, load: () => import("./skyFeature").then((m) => m.createSkyFeature) });
  },
};
