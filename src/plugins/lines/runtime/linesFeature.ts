// The Lines plugin's render feature (ADR 0130, 0396): line and trail ribbons drawn through the renderer core's
// dynamic meshes (3D) and quad batches (2D). Loaded by the renderer from the loader the plugin registers, so it stays
// out of the `myco` module. Imports no Babylon module and nothing of the backend but its feature types.
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import { PICK_ORDER, type BabylonFeature, type BabylonFeatureFactory, type DrawnNode } from "../../../engine/render/babylon/feature";
import { LinesRenderer } from "./linesRenderer";

/** @internal Lines and trails. Syncs in `content`, after the meshes (`after` constraint, ADR 0135). */
export class LinesFeature implements BabylonFeature {
  constructor(readonly lines: LinesRenderer) {}

  sync(world: World): void {
    this.lines.sync(world);
  }

  /** ADR 0276: each ribbon as a polyline (its camera-facing triangles have no CPU shape): 2D ones at their draw order, 3D ones depth-tested. */
  *drawn(): Iterable<DrawnNode> {
    for (const r of this.lines.drawn()) {
      yield { component: r.component, shape: { kind: "polyline", points: r.points, halfWidth: r.halfWidth, closed: r.closed }, order: r.order ?? PICK_ORDER.depthTested };
    }
  }

  loaded(): boolean {
    return this.lines.loaded();
  }

  diagnostics(): unknown {
    return this.lines.diagnostics();
  }

  release(c: Component): void {
    this.lines.release(c);
  }

  dispose(): void {
    this.lines.dispose();
  }
}

declare module "../../../engine/render/RenderSurface" {
  interface RenderFeatureDiagnostics {
    /** The Lines plugin's (ADR 0396): ribbons drawn now, their points and meshes. */
    lines?: { lines: number; trails: number; points: number; meshes: number };
  }
}

/** @internal Builds the feature from the renderer's shared services: the dynamic meshes and the quad batches. */
export const createLinesFeature: BabylonFeatureFactory = (host) => new LinesFeature(new LinesRenderer({ dynamicMeshes: host.dynamicMeshes, quads: host.quads }));
