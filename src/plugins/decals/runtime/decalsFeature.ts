// The Decals plugin's render feature (ADR 0130, 0395): 3D decals drawn through the renderer core's decal volumes and
// 2D decals through its quad batches. Loaded by the renderer from the loader the plugin registers, so it stays out of
// the `myco` module. Imports no Babylon module and nothing of the backend but its feature types.
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import type { BabylonFeature, BabylonFeatureFactory, DrawnNode, FeatureSyncContext } from "../../../engine/render/babylon/feature";
import { DecalRenderer, type DecalsHost } from "./decalRenderer";

/** @internal Decals. Syncs in `effects`, after the content and the lighting rig. */
export class DecalsFeature implements BabylonFeature {
  constructor(
    readonly decals: DecalRenderer,
    private readonly host: { viewCamera(): { node: { transform: unknown; entity: number; world: World } } | null },
  ) {}

  sync(world: World, ctx: FeatureSyncContext): void {
    const view = ctx.view ?? this.host.viewCamera();
    let eye: [number, number, number] | null = null;
    if (view?.node.transform) {
      const m = world.worldMatrix(view.node.entity), o = view.node.entity * 16;
      eye = [m[o + 12]!, m[o + 13]!, m[o + 14]!];
    }
    this.decals.sync(world, eye);
  }

  /**
   * ADR 0276: each placed projector as its box (not picked: a click on a wall selects the wall) and each placed 2D decal
   * as its quad batch at its draw order. Spawned decals have no node and aren't reported.
   */
  *drawn(): Iterable<DrawnNode> {
    for (const d of this.decals.drawn()) {
      if (d.kind === "box") yield { component: d.component, shape: { kind: "box", matrix: d.matrix }, order: 0, pickable: false };
      else yield { component: d.component, shape: { kind: "quads", batches: [d.batch] }, order: d.order };
    }
  }

  loaded(): boolean {
    return this.decals.loaded();
  }

  diagnostics(): unknown {
    return this.decals.diagnostics();
  }

  release(c: Component): void {
    this.decals.release(c);
  }

  dispose(): void {
    this.decals.dispose();
  }
}

declare module "../../../engine/render/RenderSurface" {
  interface RenderFeatureDiagnostics {
    /** The Decals plugin's (ADR 0395): placed projectors and 2D decals drawn, spawned decals in the pool, and batches. */
    decals?: { projectors: number; decals2D: number; pooled: number; batches: number };
  }
}

/** @internal Builds the feature from the renderer's shared services: the decal volumes, the quad batches and the project's pixels per unit. */
export const createDecalsFeature: BabylonFeatureFactory = (host) => {
  const deps: DecalsHost = { decals: host.decals, quads: host.quads, pixelsPerUnit: () => host.settings.render.pixelsPerUnit };
  return new DecalsFeature(new DecalRenderer(deps), { viewCamera: () => host.viewCamera() });
};
