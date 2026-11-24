// The Lights 2D plugin's runtime half (ADR 0399): claims the Light2D and ShadowCaster2D components. Their drawing (the
// light textures, shadows and the lit 2D material) is the renderer core's lighting rig, which the lit 2D draws of four
// plugins read whether or not this one is on, as Environment's (ADR 0140): with the plugin off the rig finds no 2D
// lights, and every 2D draw is unlit. `myco` (`src/myco.ts`) exports the public parts from here.
// Server: scripts read and toggle lights there; no drawing loads (there's no renderer).
import { Light2D, ShadowCaster2D } from "../../../engine/render/components";
import type { RuntimePlugin } from "../../runtimeContext";
import { lights2dManifest } from "../manifest";

export { Light2D, ShadowCaster2D, type Light2DType, type ShadowCaster2DShape } from "../../../engine/render/components";
export type { BlendStyleMask, LightBlendStyle, Lighting2DSettings } from "../../../engine/render/lights2D/settings";

export const lights2dRuntimePlugin: RuntimePlugin = {
  manifest: lights2dManifest,
  activate(context) {
    context.registerComponents([Light2D, ShadowCaster2D]);
  },
};
