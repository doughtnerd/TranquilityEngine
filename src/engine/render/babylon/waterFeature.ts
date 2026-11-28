/** Water as a lazy render feature (ADR 0130): its own module so `features.ts` doesn't import `water.ts` (ADR 0083). */
import type { Scene } from "@babylonjs/core/scene.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import { WaterSurface } from "../water/WaterSurface";
import { PICK_ORDER, type BabylonFeature, type DrawnNode, type FeatureSyncContext } from "./feature";
import { BabylonWater, type BabylonWaterProbe } from "./water";

declare module "../RenderSurface" {
  interface RenderFeatureDiagnostics {
    /** The Water plugin's surfaces (ADR 0140), once its feature has loaded. */
    water?: { surfaces: number };
  }
}

/** @internal Water surfaces over `BabylonWater`. */
export class WaterFeature implements BabylonFeature {
  readonly water: BabylonWater;

  constructor(scene: Scene, probeLookup: BabylonWaterProbe) {
    this.water = new BabylonWater(scene, probeLookup);
  }

  sync(world: World, ctx?: FeatureSyncContext): void {
    this.water.sync(world, world._componentsOfType(WaterSurface), ctx?.viewCamera ?? null);
  }

  release(c: Component): void {
    if (c instanceof WaterSurface) this.water.release(c);
  }

  /** ADR 0276: each surface drawn, as its mesh, depth-tested. Water casts no shadow (it's transparent and never has). */
  *drawn(): Iterable<DrawnNode> {
    for (const { surface, mesh } of this.water.drawn()) yield { component: surface, shape: { kind: "meshes", meshes: [mesh] }, order: PICK_ORDER.depthTested };
  }

  /** `RenderDiagnostics.features.water` (ADR 0154). */
  diagnostics(): { surfaces: number } {
    return this.water.state();
  }

  dispose(): void {
    this.water.dispose();
  }
}
