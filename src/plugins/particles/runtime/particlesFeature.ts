// The Particles plugin's render feature (ADR 0057, 0130, 0135): plays a World's ParticleSystems. Its
// own module, statically importing the particle player, so the renderer loads both together on first
// need (ADR 0083) through the loader the plugin registers. Only this feature uses `BabylonParticles`
// (the World adapter); it stays in the renderer folder because Babylon does (ADR 0075), and the effect
// player under it (`effectPlayer.ts`, ADR 0153) also plays the particle graph's preview and the thumbnails.
// ADR 0154: the renderer names nothing here. The factory builds the player's host from the renderer's
// core host, the editor's preview arrives as render policy, and the feature answers the renderer's
// generic hooks (warm items, a drawn object's description, its diagnostics).
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import { _worldRaycast } from "../../../engine/core/worldServices";
import { PARTICLE_SCALE } from "../../../engine/core/graphics";
import type { WarmContent, WarmEffect } from "../../../engine/scene/warmUp";
import { ParticleSystem } from "../../../engine/render/components";
import { Graphics } from "../../../engine/render/Graphics";
import type { ParticleStats } from "../../../engine/render/RenderSurface";
import type { BabylonFeature, BabylonFeatureFactory, BabylonFeatureHost, DrawnDescription } from "../../../engine/render/babylon/feature";
import { BabylonParticles, type BabylonParticleHost } from "../../../engine/render/babylon/particles";
import { WARM_PREFIX, type WarmCustom, type WarmItem } from "../../../engine/render/babylon/warmUp";

declare module "../../../engine/render/RenderSurface" {
  interface RenderFeatureDiagnostics {
    /** The Particles plugin's counts (ADR 0057), once its feature has loaded. */
    particles?: ParticleStats;
  }
}

/** A warm item's mesh (a Babylon mesh; this module names no Babylon types itself, ADR 0075). */
type Mesh = NonNullable<ReturnType<WarmCustom["build"]>>["meshes"][number];

/** @internal The particle player's host, from the renderer's core host (ADR 0130's model, ADR 0154). */
export function particleHost(host: BabylonFeatureHost): BabylonParticleHost {
  return {
    scene: host.scene,
    particlePreview: () => host.policy().particlePreview,
    worldMatrix: (c) => {
      const e = c.node.entity;
      return host.world()!.worldMatrix(e).subarray(e * 16, e * 16 + 16);
    },
    texture: (path, sheet) => host.materials.texture(path, sheet ? "sheet" : "color"),
    tierScale: () => PARTICLE_SCALE[Graphics.tier.particles],
    material: (path) => host.materials.material(path), // shared with MeshRenderers; null while missing
    materialCopy: (path, name) => host.materials.copy(path, name), // soft and kernel particles (ADR 0126)
    // A World service that answers ray queries (3D physics, ADR 0135); null while the World has none
    raycast: (ox, oy, oz, dx, dy, dz, maxDistance) => {
      const world = host.world();
      const hit = world && _worldRaycast(world, { x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, maxDistance);
      return hit ? { point: [hit.point.x, hit.point.y, hit.point.z], normal: [hit.normal.x, hit.normal.y, hit.normal.z], distance: hit.distance } : null;
    },
  };
}

/**
 * @internal The particle player as a feature. The editor's preview (which nodes play, the playback,
 * the restart count) is render policy, read through the host each sync (ADR 0154).
 */
export class ParticlesFeature implements BabylonFeature {
  readonly particles: BabylonParticles;
  /** The preview's restart count already acted on. */
  private restarts: number;

  constructor(private readonly host: BabylonParticleHost) {
    this.particles = new BabylonParticles(host);
    this.restarts = host.particlePreview()?.restarts ?? 0;
  }

  sync(world: World): void {
    const restarts = this.host.particlePreview()?.restarts ?? this.restarts;
    if (restarts !== this.restarts) {
      this.restarts = restarts;
      this.particles.restartAll(); // the overlay's Restart (ADR 0057)
    }
    this.particles.sync(world._componentsOfType(ParticleSystem), world.time.deltaTime, world.time.unscaledDeltaTime);
  }

  release(c: Component): void {
    if (c instanceof ParticleSystem) this.particles.release(c);
  }

  /** One warm item per effect the content uses (ADR 0080): its draws, one particle each, built by the player. */
  warm(content: WarmContent): WarmItem[] {
    return content.effects.map((e) => this.warmEffect(e));
  }

  private warmEffect(effect: WarmEffect): WarmCustom {
    const name = `${WARM_PREFIX}particles:${typeof effect === "string" ? effect : "embedded"}`;
    return {
      key: typeof effect === "string" ? name : `${name}:${JSON.stringify(effect)}`,
      build: (_at, position, camera) => {
        const draws = this.particles.warmDraws(effect, name, position, () => camera);
        if (!draws) return null; // a texture or model is still loading
        const meshes: Mesh[] = [];
        const systems: { render(): number; isReady(): boolean }[] = [];
        for (const d of draws) {
          if (d.kind === "system") systems.push(d.ps as unknown as { render(): number; isReady(): boolean });
          else meshes.push((d as unknown as { mesh: Mesh }).mesh);
        }
        return {
          meshes,
          systems,
          ready: () => meshes.every((m) => m.isReady(true)) && systems.every((s) => s.isReady()),
          dispose: () => draws.forEach((d) => d.dispose()),
        };
      },
    };
  }

  /** `RenderDiagnostics.features.particles`. */
  diagnostics(): ParticleStats {
    return this.particles.state();
  }

  /** The particle effect that drew `drawn` (the variant report), naming its effect asset. */
  describe(drawn: object): DrawnDescription | null {
    const system = this.particles.ownerOf(drawn);
    if (!system) return null;
    return { node: system.node, what: `The particle effect of "${system.node.name}"`, ...(system.effect ? { asset: system.effect.replace(/^asset:/, "") } : {}) };
  }

  dispose(): void {
    this.particles.dispose();
  }
}

/** @internal Builds the feature from the renderer's core services. */
export const createParticlesFeature: BabylonFeatureFactory = (host) => new ParticlesFeature(particleHost(host));
