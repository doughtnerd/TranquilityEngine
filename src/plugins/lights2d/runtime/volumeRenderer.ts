/**
 * The Lights 2D plugin's light volumes (ADR 0415): one additive quad batch per Light2D with a `volumeIntensity`,
 * placed by its node and drawn at the top of its highest target sorting layer, so the glow lies over the sprites it
 * lights and under the layers above. The meshes are `volumes.ts`'s; this keeps the batches in step with the lights.
 * Renderer-neutral: it draws through the renderer core's quad batches (ADR 0136). It is the plugin's render feature
 * (ADR 0418: no pass-through class), loaded by the renderer from the loader the plugin registers, so it stays out of the
 * `myco` module. The light textures, shadows and lit material stay the core lighting rig's (ADR 0399).
 */
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import type { Point2 } from "../../../engine/physics/polygon";
import { Light2D } from "../../../engine/render/components";
import type { BabylonFeature, BabylonFeatureFactory } from "../../../engine/render/babylon/feature";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { spriteFrame } from "../../../engine/render/spriteFrame";
import { Assets } from "../../../engine/scene/Assets";
import { splitSpriteRef } from "../../../engine/scene/importSettings";
import { spriteVolume, volumeLayer, volumeMesh, volumeStrength, type VolumeMesh } from "./volumes";

/** What the volumes borrow from the renderer. */
export interface VolumesHost {
  readonly quads: QuadBatchHost;
  /** Whether 2D lighting draws now (the editor's scene view can switch it off). */
  lit(): boolean;
}

interface Entry {
  batch: QuadBatch;
  /** What the geometry was built from. */
  sig: string;
  shown: boolean;
}

/** The highest order in a sorting layer (orders step 10000 a layer, ADR 0014). */
const TOP_OF_LAYER = 9999;

/** @internal Light volumes: the Lights 2D plugin's render feature. */
export class Lights2DVolumes implements BabylonFeature {
  private readonly entries = new Map<Light2D, Entry>();

  constructor(private readonly host: VolumesHost) {}

  sync(world: World): void {
    const seen = new Set<Light2D>();
    const on = this.host.lit();
    for (const l of world._componentsOfType(Light2D)) {
      if (!on || !l.isActiveAndEnabled || l.type === "global" || volumeStrength(l) <= 0) continue;
      seen.add(l);
      this.syncOne(world, l);
    }
    for (const l of [...this.entries.keys()]) if (!seen.has(l)) this.release(l);
  }

  private syncOne(world: World, l: Light2D): void {
    let e = this.entries.get(l);
    if (!e) {
      const batch = this.host.quads.createBatch(`light2d-volume:${l.node.name}`);
      batch.setBlend("additive");
      this.entries.set(l, (e = { batch, sig: "", shown: false }));
    }
    const built = this.geometry(world, l);
    if (!built) {
      e.batch.setVisible(false);
      e.shown = false;
      return;
    }
    if (built.sig !== e.sig) {
      e.sig = built.sig;
      const m = built.mesh;
      e.batch.setTriangles(built.texture, m.positions, m.uvs, m.indices, m.colors);
    }
    e.batch.setOrder(volumeLayer(world.settings.render.sortingLayers, l.targetSortingLayers), TOP_OF_LAYER); // unlit: a new batch has no material
    e.batch.setMatrix(world.worldMatrix(l.node.entity), l.node.entity * 16);
    if (!e.shown) e.batch.setVisible(true);
    e.shown = true;
  }

  /** The light's volume mesh, its texture ("" for none) and what it was built from, or null (nothing to draw yet). */
  private geometry(world: World, l: Light2D): { mesh: VolumeMesh; texture: string; sig: string } | null {
    const sig = JSON.stringify([l.type, l.color.r, l.color.g, l.color.b, l.intensity, l.volumeIntensity, l.innerRadius, l.outerRadius, l.innerAngle, l.outerAngle, l.falloff, l.falloffSize, l.sprite, l.shape.map((p) => [p.x, p.y])]);
    if (l.type !== "sprite") {
      const mesh = volumeMesh({ ...fields(l), shape: l.shape.map((p): Point2 => [p.x, p.y]) });
      return mesh ? { mesh, texture: "", sig } : null;
    }
    const { path, slice } = splitSpriteRef(l.sprite);
    if (!path) return null;
    const size = this.host.quads.textureSize(path, () => {}); // the next sync builds it once it has loaded
    if (!size) return null;
    const f = spriteFrame(Assets.importSettings(path), slice, size[0], size[1], { component: 0, project: world.settings.render.pixelsPerUnit });
    const [w, h] = f.size, [px, py] = f.pivot;
    const mesh = spriteVolume(l, [-px * w, -py * h, (1 - px) * w, (1 - py) * h], f.uv ?? [0, 0, 1, 1]);
    return mesh ? { mesh, texture: path, sig: `${sig}|${size[0]}x${size[1]}` } : null;
  }

  /** Volumes drawn now. */
  count(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.shown) n++;
    return n;
  }

  diagnostics(): { volumes: number } {
    return { volumes: this.count() };
  }

  release(c: Component): void {
    const e = c instanceof Light2D ? this.entries.get(c) : undefined;
    if (!e) return;
    e.batch.dispose();
    this.entries.delete(c as Light2D);
  }

  dispose(): void {
    for (const l of [...this.entries.keys()]) this.release(l);
  }
}

const fields = (l: Light2D) => ({
  type: l.type,
  color: l.color,
  intensity: l.intensity,
  volumeIntensity: l.volumeIntensity,
  innerRadius: l.innerRadius,
  outerRadius: l.outerRadius,
  innerAngle: l.innerAngle,
  outerAngle: l.outerAngle,
  falloff: l.falloff,
  falloffSize: l.falloffSize,
});

declare module "../../../engine/render/RenderSurface" {
  interface RenderFeatureDiagnostics {
    /** The Lights 2D plugin's (ADR 0415): light volumes drawn now. */
    lights2dVolumes?: { volumes: number };
  }
}

/** @internal Builds the feature from the renderer's quad batches and render policy. */
export const createLights2DFeature: BabylonFeatureFactory = (host) => new Lights2DVolumes({ quads: host.quads, lit: () => host.policy().lighting2D !== false });
