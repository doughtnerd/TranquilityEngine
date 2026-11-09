/**
 * The Babylon backend's render features (ADR 0130): one shape for every feature the renderer runs
 * (the built-in lights, fog, environment and probes; plugins' sprites, tilemaps, meshes, sky, particles, water
 * and UI, ADR 0135, 0140), and the slot that loads
 * a lazy one exactly once. Each feature gets what it shares with others (materials, casters, the probe
 * lookup, the render policy) as explicit host arguments.
 *
 * ADR 0154: the renderer asks features things through the optional hooks of `BabylonFeature`, iterated
 * over every loaded feature (describe a drawn object, warm items, diagnostics, the UI core), never a
 * particle or UI feature by name; a plugin's factory builds the services only its own feature needs (the
 * particle player's host, the UI's host) from the core host below.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { Layer } from "@babylonjs/core/Layers/layer.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import type { WarmContent } from "../../scene/warmUp";
import type { Camera, MeshRenderer, SpriteRenderer } from "../components";
import type { GameObject } from "../../scene/GameObject";
import type { ProjectSettings } from "../../core/settings";
import type { UICore } from "../../ui/UICore";
import type { DrawnMaterial, PixelGrid, RenderDiagnostics } from "../RenderSurface";
import type { RenderPolicy } from "../renderPolicy";
import type { QuadBatchHost } from "../quadBatches";
import { specNeeded, type RenderFeatureSpec } from "../renderFeatures";
import type { WarmItem } from "./warmUp";
import type { Scene } from "@babylonjs/core/scene.js";
import type { BabylonLighting } from "./lighting";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import type { ProbeHit } from "./probes";
import type { EditorMesh, EditorSprite } from "./editorContext";
import type { MeshBatches } from "./meshBatches";

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

/** The core diagnostics a built-in feature fills (the lighting rig's, the probes'), merged into `RenderSurface.diagnostics()`. */
export type FeatureState = Partial<Pick<RenderDiagnostics, "lighting" | "probes">>;

/**
 * @internal What a drawn object is (ADR 0080's variant report, ADR 0154 `describe`): words naming it,
 * the node it belongs to (the report names the prefab the node came from), else an asset to name.
 */
export interface DrawnDescription {
  what: string;
  node?: GameObject;
  asset?: string;
}

/** @internal One render feature of the Babylon backend (ADR 0130; the optional hooks the renderer iterates, ADR 0154). */
export interface BabylonFeature {
  sync(world: World, ctx: FeatureSyncContext): void;
  /** A Component it owns was destroyed (`world.render?.release`). */
  release?(c: Component): void;
  /**
   * ADR 0080: warm items for the content it draws (particle effects, the world UI canvas…). A lazy
   * feature that hasn't loaded is asked once it has, when its spec `warms` the content (ADR 0154).
   */
  warm?(content: WarmContent): WarmItem[];
  /** Its part of the core diagnostics (the built-in features: the lighting rig, the probes). */
  state?(): FeatureState;
  /** ADR 0154: its own diagnostics, reported as `RenderDiagnostics.features[<its spec's name>]`. */
  diagnostics?(): unknown;
  /** ADR 0154: what a drawn object of its is (the variant report), or null when it isn't one of its. */
  describe?(drawn: object): DrawnDescription | null;
  /** ADR 0154: the UI layout and routing core it runs (the editor's UI queries), or null. */
  uiCore?(): UICore | null;
  /** Before each view is drawn: follow its camera (the sky's box around it). */
  fit?(camera: TargetCamera): void;
  /** Once a frame, before the frame graph runs (the sky's bake, like probe captures). */
  beforeFrame?(): void;
  /**
   * ADR 0156: the world-space box around what it draws that isn't a content mesh (live particles), or null.
   * Thumbnails frame it with the content meshes.
   */
  bounds?(): { min: number[]; max: number[] } | null;
  dispose(): void;
}

/**
 * @internal What warms a lazy feature's content before the feature has loaded (ADR 0154): a
 * registration's optional `loadWarm` gives this factory, so a warm-up needn't load the whole feature
 * (the UI plugin warms a world canvas with the GUI drawing module alone, without Yoga and the font).
 */
export type BabylonWarmFactory = (host: BabylonFeatureHost) => Required<Pick<BabylonFeature, "warm">>;

/**
 * @internal The renderer's core services a plugin's render feature is built from (ADR 0135, 0154): its
 * factory (`RenderFeatureRegistration.load`) gets this and builds from it whatever only its own feature
 * needs. Nothing here is one feature's. Internal and first-party only (ADR 0133).
 */
export interface BabylonFeatureHost {
  readonly scene: Scene;
  /** Lights, the environment and its skybox; the sky drives the sun and lights through it. */
  readonly lighting: BabylonLighting;
  /** The material library (ADR 0127). */
  readonly materials: BabylonMaterialLibrary;
  /** The reflection probe nearest a point (ADR 0130's probe lookup). */
  probeLookup(x: number, y: number, z: number): ProbeHit | null;
  /** Reflection probes: whether any exist, the lookup, and counting a mesh drawn with one's reflection this frame (diagnostics). */
  readonly probes: { readonly any: boolean; lookup(x: number, y: number, z: number): ProbeHit | null; reflected(): void };
  /** The project settings the renderer was made with (pixels per unit, sorting layers). */
  readonly settings: ProjectSettings;
  /** `perObject` in the editor's scene view and editor play mode (picking and outlines), else `batched` (ADR 0129). Read each sync. */
  drawPolicy(): "batched" | "perObject";
  /** The render policy now (ADR 0129): the scene view, the particle preview… Read it each sync. */
  policy(): Readonly<RenderPolicy>;
  /** The World being drawn, or null before the first sync. */
  world(): World | null;
  /** The main view camera (the first canvas camera), or null. */
  viewCamera(): Camera | null;
  /** The editor's camera preview inset as fractions of the canvas (x and width from the left, top and height from the top), or null. */
  previewRect(): { x: number; top: number; width: number; height: number } | null;
  /** The view's device-pixel grid (ADR 0154): the canvas's CSS size and the pixel ratio applied to it. */
  pixelGrid(): PixelGrid;
  /** Set (or clear with null) the layer the frame graph draws over the screen views (`BabylonFrame.ui`). */
  setScreenLayer(draw: (() => Layer | null) | null): void;
  /** Set (or clear) the layer it draws over the camera preview inset (`BabylonFrame.previewUI`); while set, the inset's overlay counts as built. */
  setPreviewLayer(draw: (() => Layer | null) | null): void;
  /** Sorted, unlit textured quad batches (ADR 0136): what the Tilemaps plugin draws its tiles with. */
  readonly quads: QuadBatchHost;
  warnOnce(key: string, message: string): void;
}

/** @internal What the renderer asks of the feature named "sprites" (the Sprites plugin's, ADR 0140). */
export interface SpritesFeatureApi extends BabylonFeature {
  /** The sprite's size in node units once its texture has loaded. */
  spriteSize(s: SpriteRenderer): [number, number] | null;
  /** The sprites with a mesh of their own, for the editor tools (picking and outlines). */
  editorSprites(): Iterable<EditorSprite>;
  /** The nodes with a sprite drawn now (`RenderDiagnostics.drawn.sprites`). */
  drawnNodes(): GameObject[];
}

/** @internal What the renderer asks of the feature named "meshes" (the Meshes plugin's, ADR 0140). */
export interface MeshesFeatureApi extends BabylonFeature {
  /** Adds the meshes that cast shadows this frame. */
  casters(out: AbstractMesh[]): void;
  /** Whether every MeshRenderer's model has loaded (a World's first frames and probes wait for it). */
  loaded(): boolean;
  /** The MeshRenderer a drawn mesh belongs to, or null (the variant report asks `describe`). */
  ownerOf(drawn: unknown): MeshRenderer | null;
  /** What each node draws, with its materials (`RenderDiagnostics.drawn.meshes`). */
  drawn(): { node: GameObject; materials: DrawnMaterial[] }[];
  /** The MeshRenderers and their Babylon meshes, for the editor tools. */
  editorMeshes(): Iterable<EditorMesh>;
  /** Tests and e2e: the batches' counts (ADR 0108). */
  batchStats(): ReturnType<MeshBatches["stats"]>;
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
  /** Start loading a lazy feature; resolves with it once loaded, or null (the load failed, the slot was disposed). */
  whenLoaded(): Promise<F | null>;
  /**
   * What warms this feature's content before it has loaded (ADR 0154, 0163): its registration's lighter
   * warm factory (`loadWarm`, loaded once), else the feature itself (`whenLoaded`).
   */
  warmSource(): Promise<Pick<BabylonFeature, "warm"> | null>;
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
    whenLoaded: () => Promise.resolve(disposed ? null : feature),
    warmSource: () => Promise.resolve(disposed ? null : feature),
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
 * is disposed. A failed load is logged and tried again at the next need. `loadWarm`, when given, builds
 * what warms the feature's content without loading all of it (ADR 0154): loaded once, tried again after
 * a failure.
 */
export function lazyFeature<F extends BabylonFeature>(
  spec: RenderFeatureSpec,
  load: (cancelled: () => boolean) => Promise<F | null>,
  loadWarm?: (cancelled: () => boolean) => Promise<Pick<BabylonFeature, "warm"> | null>,
): FeatureSlot<F> {
  let feature: F | null = null;
  let pending: Promise<void> | null = null;
  let disposed = false;
  let warmSource: Promise<Pick<BabylonFeature, "warm"> | null> | null = null;
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
    whenLoaded() {
      start();
      return pending ? pending.then(() => feature) : Promise.resolve(feature);
    },
    warmSource() {
      if (!loadWarm) return this.whenLoaded();
      warmSource ??= loadWarm(() => disposed).catch((err) => {
        warmSource = null; // try again at the next warm-up
        console.error(`[myco] the ${spec.name} render feature's warm-up couldn't load:`, err);
        return null;
      });
      return warmSource;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      feature?.dispose();
      feature = null;
    },
  };
}
