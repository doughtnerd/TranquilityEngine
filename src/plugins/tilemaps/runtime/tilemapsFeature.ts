// The Tilemaps plugin's render feature (ADR 0103, 0130, 0136): tile layers drawn through the renderer
// core's quad batches. Loaded by the renderer from the loader the plugin registers, so it stays out of the
// `myco` module. Imports no Babylon module and nothing of the backend but its feature types: the drawing
// itself is `BabylonQuadBatches`, which knows nothing of tiles.
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import type { BabylonFeature, BabylonFeatureFactory } from "../../../engine/render/babylon/feature";
import { Tilemap } from "./Tilemap";
import { TilemapRenderer } from "./tilemapRenderer";

/** @internal Tilemaps. Syncs after sprites and before meshes (`after` constraints, ADR 0135). */
export class TilemapsFeature implements BabylonFeature {
  constructor(readonly tilemaps: TilemapRenderer) {}

  sync(world: World): void {
    this.tilemaps.sync(world);
  }

  release(c: Component): void {
    if (c instanceof Tilemap) this.tilemaps.release(c);
  }

  dispose(): void {
    this.tilemaps.dispose();
  }
}

/** @internal Builds the feature from the renderer's shared services: only the quad batches. */
export const createTilemapsFeature: BabylonFeatureFactory = (host) => new TilemapsFeature(new TilemapRenderer(host.quads));
