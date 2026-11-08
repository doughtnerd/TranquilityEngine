/** Water as a lazy render feature (ADR 0130): its own module so `features.ts` doesn't import `water.ts` (ADR 0083). */
import type { Scene } from "@babylonjs/core/scene.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import { WaterSurface } from "../water/WaterSurface";
import type { BabylonFeature, FeatureState } from "./feature";
import { BabylonWater, type BabylonWaterProbe } from "./water";

/** @internal Water surfaces over `BabylonWater`. */
export class WaterFeature implements BabylonFeature {
  readonly water: BabylonWater;

  constructor(scene: Scene, probeLookup: BabylonWaterProbe) {
    this.water = new BabylonWater(scene, probeLookup);
  }

  sync(world: World): void {
    this.water.sync(world, world._componentsOfType(WaterSurface));
  }

  release(c: Component): void {
    if (c instanceof WaterSurface) this.water.release(c);
  }

  state(): FeatureState {
    return { water: this.water.state() };
  }

  dispose(): void {
    this.water.dispose();
  }
}
