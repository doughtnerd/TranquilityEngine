/**
 * Particles as a lazy render feature (ADR 0130): its own module, statically importing the player, so
 * the renderer loads both together on first need (ADR 0083).
 */
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import type { WarmContent, WarmEffect } from "../../scene/warmUp";
import { ParticleSystem } from "../components";
import type { ParticlePreviewSettings } from "../RenderSurface";
import type { BabylonFeature, FeatureState } from "./feature";
import { BabylonParticles, type BabylonParticleHost } from "./particles";
import { WARM_PREFIX, type WarmCustom, type WarmItem } from "./warmUp";

/** @internal The particle player as a feature. `previewSettings` is applied once, at construction. */
export class ParticlesFeature implements BabylonFeature {
  readonly particles: BabylonParticles;

  constructor(host: BabylonParticleHost, previewSettings: () => Partial<ParticlePreviewSettings> = () => ({})) {
    this.particles = new BabylonParticles(host);
    Object.assign(this.particles.preview, previewSettings());
  }

  sync(world: World): void {
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

  state(): FeatureState {
    return { particles: this.particles.state() };
  }

  /** Editor: apply preview settings to the running player. */
  setPreview(preview: Partial<ParticlePreviewSettings>): void {
    Object.assign(this.particles.preview, preview);
  }

  restartAll(): void {
    this.particles.restartAll();
  }

  dispose(): void {
    this.particles.dispose();
  }
}
