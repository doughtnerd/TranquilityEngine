// The Lights 2D plugin's render feature (ADR 0415): light volumes, drawn through the renderer core's quad batches.
// Loaded by the renderer from the loader the plugin registers, so it stays out of the `myco` module. The light
// textures, shadows and lit material stay the core lighting rig's (ADR 0399); this draws only what lies over the sprites.
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import { Light2D } from "../../../engine/render/components";
import type { BabylonFeature, BabylonFeatureFactory } from "../../../engine/render/babylon/feature";
import { Lights2DVolumes } from "./volumeRenderer";

/** @internal Light volumes. */
export class Lights2DFeature implements BabylonFeature {
  constructor(readonly volumes: Lights2DVolumes) {}

  sync(world: World): void {
    this.volumes.sync(world);
  }

  diagnostics(): { volumes: number } {
    return { volumes: this.volumes.count() };
  }

  release(c: Component): void {
    if (c instanceof Light2D) this.volumes.release(c);
  }

  dispose(): void {
    this.volumes.dispose();
  }
}

declare module "../../../engine/render/RenderSurface" {
  interface RenderFeatureDiagnostics {
    /** The Lights 2D plugin's (ADR 0415): light volumes drawn now. */
    lights2dVolumes?: { volumes: number };
  }
}

/** @internal Builds the feature from the renderer's quad batches and render policy. */
export const createLights2DFeature: BabylonFeatureFactory = (host) => new Lights2DFeature(new Lights2DVolumes({ quads: host.quads, lit: () => host.policy().lighting2D !== false }));
