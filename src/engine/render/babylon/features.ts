/**
 * Render feature adapters for the Babylon backend (ADR 0130): each wraps one existing module as a
 * `BabylonFeature`, and each has its spec constant (name, phase, the Components it owns, lazy or not).
 *
 * The lazy water feature lives in `waterFeature.ts`; this file only holds its spec and must not import
 * `water.ts`, so a game without water never downloads it (ADR 0083). Particles are the Particles
 * plugin's feature (`src/plugins/particles/runtime/`), loaded the same way, and must not be imported here.
 *
 * Order inside the `lighting` phase matters, and the specs' `after` constraints say it (ADR 0135): sky,
 * then lights, then fog, then environment. The sky (the Sky plugin's feature, `src/plugins/sky/runtime/`)
 * may drive the sun, so it syncs before the lights; the environment's skybox dims by the sky fog the fog
 * sets, so it syncs after the fog.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import { Tilemap } from "../../tilemap/Tilemap";
import { Light, ReflectionProbe, Fog } from "../components";
import type { RenderFeatureSpec } from "../renderFeatures";
import { WaterSurface } from "../water/WaterSurface";
import type { BabylonFeature, FeatureState, FeatureSyncContext } from "./feature";
import type { ShadowRequest } from "./frameGraph";
import type { BabylonLighting } from "./lighting";
import type { BabylonProbes, ProbeHit } from "./probes";
import type { BabylonTilemaps } from "./tilemaps";

// --- Specs ----------------------------------------------------------------------------------------

export const TILEMAPS_SPEC: RenderFeatureSpec = { name: "tilemaps", phase: "content", types: [Tilemap], lazy: false, after: ["sprites"] };
/** After the sky, which may drive the sun. */
export const LIGHTS_SPEC: RenderFeatureSpec = { name: "lights", phase: "lighting", types: [Light], lazy: false, after: ["sky"] };
export const FOG_SPEC: RenderFeatureSpec = { name: "fog", phase: "lighting", types: [Fog], lazy: false, after: ["sky", "lights"] };
/** Reads Environment; owns nothing to release. After the fog (the skybox fades with the sky fog). */
export const ENVIRONMENT_SPEC: RenderFeatureSpec = { name: "environment", phase: "lighting", types: [], lazy: false, after: ["sky", "lights", "fog"] };
export const PROBES_SPEC: RenderFeatureSpec = { name: "probes", phase: "capture", types: [ReflectionProbe], lazy: false };
/** Holds the first frame while it loads, so a World that starts with water shows it from frame one (ADR 0120). */
export const WATER_SPEC: RenderFeatureSpec = { name: "water", phase: "surfaces", types: [WaterSurface], lazy: true, holdsFirstFrame: true };

// --- Adapters -------------------------------------------------------------------------------------

/** @internal Tilemaps (ADR 0130). */
export class TilemapsFeature implements BabylonFeature {
  constructor(readonly tilemaps: BabylonTilemaps) {}

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

/**
 * @internal Light components and their shadow requests. `BabylonLighting` is split into two features
 * (this and `EnvironmentFeature`) because the fog syncs between them: `syncEnvironment` reads the sky
 * fog (`setSkyFog`) the fog feature sets, so the order lights, fog, environment must hold.
 */
export class LightsFeature implements BabylonFeature {
  private requests: ShadowRequest[] = [];

  constructor(readonly lighting: BabylonLighting) {}

  sync(world: World, ctx: FeatureSyncContext): void {
    this.requests = this.lighting.syncLights(world, ctx.viewCamera);
  }

  /** The shadow maps the last sync asked for. */
  shadows(): ShadowRequest[] {
    return this.requests;
  }

  release(c: Component): void {
    if (c instanceof Light) this.lighting.release(c);
  }

  state(): FeatureState {
    return { lighting: this.lighting.state() };
  }

  /** Disposes the shared `BabylonLighting` (lights and environment); `EnvironmentFeature.dispose` does nothing. */
  dispose(): void {
    this.lighting.dispose();
  }
}

/** @internal The Environment component's lighting and skybox. Register after the fog. */
export class EnvironmentFeature implements BabylonFeature {
  constructor(readonly lighting: BabylonLighting) {}

  sync(world: World, ctx: FeatureSyncContext): void {
    this.lighting.syncEnvironment(world, ctx.view?.far ?? 1000);
  }

  /** Nothing: `LightsFeature.dispose` disposes the shared `BabylonLighting`. */
  dispose(): void {}
}

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

