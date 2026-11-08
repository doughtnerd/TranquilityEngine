/**
 * The Babylon backend's render features (ADR 0130): one shape for every feature the renderer runs
 * (sprites, meshes, sky, lights, fog, probes, water, UI, and plugins' tilemaps and particles), and the slot that loads
 * a lazy one exactly once. Each feature gets what it shares with others (materials, casters, the probe
 * lookup, the render policy) as explicit host arguments, like `BabylonParticleHost`.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import type { WarmContent } from "../../scene/warmUp";
import type { Camera, ParticleSystem } from "../components";
import type { ParticlePreviewSettings, RenderDiagnostics } from "../RenderSurface";
import type { QuadBatchHost } from "../quadBatches";
import { specNeeded, type RenderFeatureSpec } from "../renderFeatures";
import type { WarmItem } from "./warmUp";
import type { Scene } from "@babylonjs/core/scene.js";
import type { BabylonLighting } from "./lighting";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import type { BabylonParticleHost } from "./particles";
import type { ProbeHit } from "./probes";

/** @internal What the renderer worked out before a feature's phase (ADR 0130). */
export interface FeatureSyncContext {
  /** The main view: the first canvas camera (ADR 0129 `canvasCameras`), or null. Set from `lighting` on. */
  view: Camera | null;
  /** Its Babylon camera, or null. */
  viewCamera: TargetCamera | null;
  /** Whether the World's materials and models have all loaded. Set from `capture` on. */
  ready: boolean;
  /** What reflection probes capture: the scene's meshes minus editor-only ones. Set from `capture` on. */
  probeMeshes: readonly AbstractMesh[];
}

/** The diagnostics a feature contributes (merged into `RenderSurface.diagnostics()`). */
export type FeatureState = Partial<Omit<RenderDiagnostics, "started" | "quality" | "post" | "stats" | "cameras">>;

/** @internal One render feature of the Babylon backend (ADR 0130). */
export interface BabylonFeature {
  sync(world: World, ctx: FeatureSyncContext): void;
  /** A Component it owns was destroyed (`world.render?.release`). */
  release?(c: Component): void;
  /** ADR 0080: warm items for the content it draws (particle effects, the world UI canvas…). */
  warm?(content: WarmContent): WarmItem[];
  /** Its part of the diagnostics snapshot. */
  state?(): FeatureState;
  /** Before each view is drawn: follow its camera (the sky's box around it). */
  fit?(camera: TargetCamera): void;
  /** Once a frame, before the frame graph runs (the sky's bake, like probe captures). */
  beforeFrame?(): void;
  dispose(): void;
}

/**
 * @internal The renderer's shared services a plugin's render feature is built from (ADR 0135): its
 * factory (`RenderFeatureRegistration.load`) gets this. Internal and first-party only (ADR 0133).
 */
export interface BabylonFeatureHost {
  readonly scene: Scene;
  /** Lights, the environment and its skybox; the sky drives the sun and lights through it. */
  readonly lighting: BabylonLighting;
  /** The material library (ADR 0127). */
  readonly materials: BabylonMaterialLibrary;
  /** The reflection probe nearest a point (ADR 0130's probe lookup). */
  probeLookup(x: number, y: number, z: number): ProbeHit | null;
  /** Sorted, unlit textured quad batches (ADR 0136): what the Tilemaps plugin draws its tiles with. */
  readonly quads: QuadBatchHost;
  warnOnce(key: string, message: string): void;
  /** The particle player's services (the Particles plugin's feature): the World's matrices, textures, materials, ray queries. */
  particleHost(): BabylonParticleHost;
  /** The editor's particle preview settings so far (`setParticlePreview`), applied when the particles feature starts. */
  particlePreview(): Partial<ParticlePreviewSettings>;
}

/**
 * @internal What the renderer asks of the feature named "particles" (the Particles plugin's, ADR 0135):
 * the editor's particle preview, and which ParticleSystem drew something (the variant report).
 */
export interface ParticlesFeatureApi extends BabylonFeature {
  setPreview(preview: Partial<ParticlePreviewSettings>): void;
  restartAll(): void;
  ownerOf(drawn: object): ParticleSystem | null;
}

/** @internal A plugin render feature's factory, as `RenderFeatureRegistration.load` gives it for this backend. */
export type BabylonFeatureFactory = (host: BabylonFeatureHost) => BabylonFeature;

/** @internal A registered feature: its spec, and the feature once it exists. */
export interface FeatureSlot<F extends BabylonFeature = BabylonFeature> {
  readonly spec: RenderFeatureSpec;
  /** The feature, or null while a lazy one hasn't loaded. */
  readonly feature: F | null;
  /** True while a lazy feature is loading. */
  readonly loading: boolean;
  /** Start loading a lazy feature if `world` needs it (or always, without a World); returns it once loaded. */
  ensure(world?: World): F | null;
  dispose(): void;
}

/** @internal A feature that exists from the start. */
export function eagerFeature<F extends BabylonFeature>(spec: RenderFeatureSpec, feature: F): FeatureSlot<F> {
  let disposed = false;
  return {
    spec,
    get feature() {
      return disposed ? null : feature;
    },
    loading: false,
    ensure: () => (disposed ? null : feature),
    dispose() {
      if (disposed) return;
      disposed = true;
      feature.dispose();
    },
  };
}

/**
 * @internal A feature loaded on first need (ADR 0083), once. `load` gets `cancelled()`: true once the
 * slot was disposed, so it can skip building the feature (return null); a feature that arrives anyway
 * is disposed. A failed load is logged and tried again at the next need.
 */
export function lazyFeature<F extends BabylonFeature>(spec: RenderFeatureSpec, load: (cancelled: () => boolean) => Promise<F | null>): FeatureSlot<F> {
  let feature: F | null = null;
  let pending: Promise<void> | null = null;
  let disposed = false;
  const start = (): void => {
    if (feature || pending || disposed) return;
    pending = load(() => disposed)
      .then((f) => {
        if (disposed) f?.dispose();
        else feature = f;
      })
      .catch((err) => console.error(`[myco] the ${spec.name} render feature couldn't load:`, err))
      .finally(() => (pending = null));
  };
  return {
    spec,
    get feature() {
      return feature;
    },
    get loading() {
      return pending !== null;
    },
    ensure(world?: World) {
      if (!feature && (!world || specNeeded(spec, world))) start();
      return feature;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      feature?.dispose();
      feature = null;
    },
  };
}
