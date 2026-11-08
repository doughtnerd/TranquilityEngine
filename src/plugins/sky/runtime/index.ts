// The Sky plugin's runtime half (ADR 0134, 0135): the `Sky` component and the sky render feature,
// registered when the plugin activates. The sky asset's format, presets and maths stay in
// `src/engine/sky/`: core code reads them too (the Environment's sky asset in the renderer's lighting,
// asset thumbnails, the editor's Environment inspector). This module re-exports their public parts,
// so `myco` (`src/myco.ts`) exports them from here.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; never imports
// Babylon (the feature's code loads on demand).
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { skyManifest } from "../manifest";
import { Sky } from "./Sky";

export { Sky };
export {
  SKY_FORMAT,
  MAX_CLOUD_LAYERS,
  defaultSky,
  defaultCloudLayer,
  parseSky,
  formatSky,
  cloneSky,
  type SkySettings,
  type SkyMode,
  type SunPlacement,
  type SkySun,
  type SkyAtmosphere,
  type SkyGradient,
  type SkySunDisc,
  type SkyMoon,
  type SkyCloudLayer,
  type SkyStars,
  type SkyHorizon,
  type SkyLighting,
  type SkyProblem,
} from "../../../engine/sky/skyFormat";
export { SKY_PRESETS, skyPreset, type SkyPresetId } from "../../../engine/sky/presets";

/** @internal Reads Environment (the sky asset) and Sky; owns nothing to release. Before the lights: it may drive the sun. */
export const SKY_SPEC: RenderFeatureSpec = { name: "sky", phase: "lighting", types: [], lazy: false };

export const skyRuntimePlugin: RuntimePlugin = {
  manifest: skyManifest,
  activate(context) {
    context.registerComponents([Sky]);
    context.registerRenderFeature({ spec: SKY_SPEC, load: () => import("./skyFeature").then((m) => m.createSkyFeature) });
  },
};
