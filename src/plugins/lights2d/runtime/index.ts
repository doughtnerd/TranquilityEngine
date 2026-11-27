// The Lights 2D plugin's runtime half (ADR 0399): claims the Light2D and ShadowCaster2D components, and registers the
// lazy render feature drawing light volumes (ADR 0415, `volumeRenderer.ts`). Their drawing (the
// light textures, shadows and the lit 2D material) is the renderer core's lighting rig, which the lit 2D draws of four
// plugins read whether or not this one is on, as Environment's (ADR 0140): with the plugin off the rig finds no 2D
// lights, and every 2D draw is unlit. `myco` (`src/myco.ts`) exports the public parts from here.
// Server: scripts read and toggle lights there; no drawing loads (there's no renderer).
import { CompositeShadowCaster2D, Light2D, ShadowCaster2D } from "../../../engine/render/components";
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { lights2dManifest } from "../manifest";

export { CompositeShadowCaster2D, Light2D, ShadowCaster2D, type Light2DNormals, type Light2DOverlap, type Light2DType, type ShadowCaster2DShape } from "../../../engine/render/components";
export type { BlendStyleMask, LightBlendStyle, Lighting2DSettings } from "../../../engine/render/lights2D/settings";

/** Light volumes (ADR 0415), in `content`: loaded the first time a World has a Light2D. */
const LIGHTS2D_SPEC: RenderFeatureSpec = { name: "lights2dVolumes", phase: "content", types: [Light2D], lazy: true };

export const lights2dRuntimePlugin: RuntimePlugin = {
  manifest: lights2dManifest,
  activate(context) {
    context.registerComponents([Light2D, ShadowCaster2D, CompositeShadowCaster2D]);
    context.registerRenderFeature({ spec: LIGHTS2D_SPEC, load: () => import("./volumeRenderer").then((m) => m.createLights2DFeature) });
  },
};
