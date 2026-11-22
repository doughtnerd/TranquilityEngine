// The Sky plugin's render feature (ADR 0112, 0135): the procedural sky, drawn behind every camera,
// baked for lighting, and driving the sun. Loaded on demand by the renderer (the plugin registers a
// loader for it), so Babylon stays out of the `myco` module. The feature is `BabylonSky` itself, which stays in
// `render/babylon/` with the rest of the Babylon code (ADR 0140); sky thumbnails draw through it
// in a headless World, as a World draws the sky (ADR 0189).
import type { BabylonFeatureFactory } from "../../../engine/render/babylon/feature";
import { BabylonSky, type SkyState } from "../../../engine/render/babylon/sky/BabylonSky";
import { worldSky } from "./Sky";

declare module "../../../engine/render/RenderSurface" {
  interface RenderFeatureDiagnostics {
    /** The Sky plugin's state (ADR 0112), once its feature has loaded. */
    sky?: SkyState;
  }
}

/** @internal Builds the feature from the renderer's shared services. */
export const createSkyFeature: BabylonFeatureFactory = (host) => new BabylonSky(host.scene, host.lighting, worldSky);
