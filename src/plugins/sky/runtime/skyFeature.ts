// The Sky plugin's render feature (ADR 0112, 0135): the procedural sky, drawn behind every camera,
// baked for lighting, and driving the sun. Loaded on demand by the renderer (the plugin registers a
// loader for it), so Babylon stays out of the `myco` module. The drawing itself, `BabylonSky`, stays in
// the renderer because the asset thumbnails use its baker and drawable too.
import type { World } from "../../../engine/core/World";
import type { BabylonFeature, BabylonFeatureFactory, FeatureState } from "../../../engine/render/babylon/feature";
import { BabylonSky } from "../../../engine/render/babylon/sky/BabylonSky";
import { worldSky } from "./Sky";

/** The view camera `fit` gets (a Babylon camera; this module names no Babylon types itself, ADR 0075). */
type ViewCamera = Parameters<NonNullable<BabylonFeature["fit"]>>[0];

/** @internal The procedural sky. Syncs before the lights (`after` constraints, ADR 0135): it may drive the sun. */
export class SkyFeature implements BabylonFeature {
  constructor(readonly sky: BabylonSky) {}

  sync(world: World): void {
    this.sky.sync(world);
  }

  fit(camera: ViewCamera): void {
    this.sky.fit(camera);
  }

  /** Render a requested bake; runs before the frame graph. */
  beforeFrame(): void {
    this.sky.bake();
  }

  state(): FeatureState {
    return { sky: this.sky.state() };
  }

  dispose(): void {
    this.sky.dispose();
  }
}

/** @internal Builds the feature from the renderer's shared services. */
export const createSkyFeature: BabylonFeatureFactory = (host) => new SkyFeature(new BabylonSky(host.scene, host.lighting, worldSky));
