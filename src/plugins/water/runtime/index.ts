// The Water plugin's runtime half (ADR 0072, 0140): claims WaterSurface and registers the lazy water
// render feature. The component class, its wave maths (`render/water/`) and the Babylon adapter stay in
// core: the adapter reads the class from `render/babylon/` (ADR 0075), and physics' Buoyancy samples the
// waves. `myco` (`src/myco.ts`) exports the public parts from here.
// Runtime code: never imports from `src/editor/` or Babylon (the feature's code loads on demand).
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import { WaterSurface } from "../../../engine/render/water/WaterSurface";
import type { RuntimePlugin } from "../../runtimeContext";
import { waterManifest } from "../manifest";

export { Water, WaterSurface, type WaterSample } from "../../../engine/render/water/WaterSurface";

/** @internal Loaded the first time a World has a surface; holds the first frame meanwhile, so water shows from frame one (ADR 0120). */
export const WATER_SPEC: RenderFeatureSpec = { name: "water", phase: "surfaces", types: [WaterSurface], lazy: true, holdsFirstFrame: true };

export const waterRuntimePlugin: RuntimePlugin = {
  manifest: waterManifest,
  activate(context) {
    context.registerComponents([WaterSurface]);
    context.registerRenderFeature({ spec: WATER_SPEC, load: () => import("./waterFeature").then((m) => m.createWaterFeature) });
  },
};
