/**
 * Render feature adapters for the Babylon backend (ADR 0130): each wraps one existing module as a
 * `BabylonFeature`, and each has its spec constant (name, phase, the Components it owns, lazy or not).
 *
 * The renderer's own feature here is reflection probes, a shared render service that stays core (ADR
 * 0140). The lighting rig (lights, environment, skybox) is core too but isn't a feature: the renderer
 * resolves it once after the `lighting` phase, from what that phase's features contributed (ADR 0252).
 * Every feature that draws a plugin's Components is registered by its plugin and must not be imported
 * here: sprites, meshes, water (`waterFeature.ts`) and UI (`uiFeature.ts`, ADR 0140), particles,
 * tilemaps (ADR 0135, 0136) and the sky.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import { ReflectionProbe } from "../components";
import type { RenderFeatureSpec } from "../renderFeatures";
import type { BabylonFeature, FeatureState, FeatureSyncContext } from "./feature";
import type { BabylonProbes, ProbeHit } from "./probes";

// --- Specs ----------------------------------------------------------------------------------------

export const PROBES_SPEC: RenderFeatureSpec = { name: "probes", phase: "capture", types: [ReflectionProbe], lazy: false };

// --- Adapters -------------------------------------------------------------------------------------

/** @internal Reflection probes. `reflecting` is the renderer's count of meshes drawn with a probe this frame. */
export class ProbesFeature implements BabylonFeature {
  constructor(
    readonly probes: BabylonProbes,
    private readonly host: { reflecting(): number },
  ) {}

  sync(world: World, ctx: FeatureSyncContext): void {
    this.probes.sync(world, ctx.probeMeshes as AbstractMesh[], ctx.ready);
  }

  /** A ReflectionProbe was destroyed: free its capture now, instead of at the next sync. */
  release(c: Component): void {
    if (c instanceof ReflectionProbe) this.probes.release(c);
  }

  state(): FeatureState {
    return { probes: this.probes.state(this.host.reflecting()) };
  }

  lookup(x: number, y: number, z: number): ProbeHit | null {
    return this.probes.lookup(x, y, z);
  }

  capture(camera: BabylonCamera | null): void {
    this.probes.capture(camera);
  }

  warmHits(): ProbeHit[] {
    return this.probes.warmHits();
  }

  bake(probe: ReflectionProbe): Promise<ArrayBuffer> {
    return this.probes.bake(probe);
  }

  textures(): ProbeHit[] {
    return this.probes.textures();
  }

  dispose(): void {
    this.probes.dispose();
  }
}

