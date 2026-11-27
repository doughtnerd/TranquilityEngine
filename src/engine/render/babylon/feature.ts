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
 * particle player's host, the UI's host) from the core host below. ADR 0276: what a feature drew (per
 * node: its shape, pick order and materials), its shadow casters and whether its content has loaded are
 * hooks too, so no feature is reached by name, the sprite and mesh features included.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { Layer } from "@babylonjs/core/Layers/layer.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import type { WarmContent } from "../../scene/warmUp";
import type { Camera } from "../components";
import type { GameObject } from "../../scene/GameObject";
import type { ProjectSettings } from "../../core/settings";
import type { UICore } from "../../ui/UICore";
import type { DrawnMaterial, PixelGrid, RenderDiagnostics } from "../RenderSurface";
import type { RenderPolicy } from "../renderPolicy";
import type { QuadBatch, QuadBatchHost } from "../quadBatches";
import type { DecalHost } from "../decals";
import type { DynamicMeshHost } from "../dynamicMeshes";
import { specNeeded, type RenderFeatureSpec } from "../renderFeatures";
import { _instantiatedPrefabOf } from "../../scene/SceneLoader";
import type { WarmItem } from "./warmUp";
import type { Scene } from "@babylonjs/core/scene.js";
import type { LightingContributions } from "./lighting";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import type { BabylonMaterials2D } from "./materials2D";
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

/**
 * @internal What a drawn object is, for the variant report (ADR 0080): the first feature that knows it
 * says (ADR 0154 `describe`), and the prefab its node came from, if any, is named (else the asset the
 * feature gave); null when no feature knows it.
 */
export function describeDrawn(features: Iterable<BabylonFeature | null>, drawn: object): { what: string; prefab?: string } | null {
  for (const feature of features) {
    const d = feature?.describe?.(drawn);
    if (!d) continue;
    let prefab: string | undefined;
    for (let n: GameObject | null = d.node ?? null; n && !prefab; n = n.parent) prefab = _instantiatedPrefabOf(n);
    if (prefab) return { what: `${d.what} (from ${prefab})`, prefab };
    return d.asset ? { what: d.what, prefab: d.asset } : { what: d.what };
  }
  return null;
}

/**
 * @internal What a feature drew for a node (ADR 0276), as the renderer's own steps read it: the editor's
 * picking, framing, box selection and outlines, thumbnail framing, sprite sizes and `RenderDiagnostics.drawn`.
 *
 * - `quad`: a mesh of its own that is a unit quad (-0.5..0.5 on X and Y at local z = 0) through its world
 *   matrix, both faces (a sprite's): picked as that plane, outlined flat.
 * - `meshes`: meshes of its own (a MeshRenderer's, a water surface's, a world-space UI canvas's plane):
 *   picked against their triangles, framed and outlined by their boxes.
 * - `quads`: quad batches it drew through the renderer's `QuadBatchHost` (a tile layer's chunks, ADR 0136):
 *   the renderer resolves them to its meshes, so a renderer-neutral feature names no Babylon type.
 * - `box`: a box with no mesh of its own (a decal projector's volume, ADR 0395): `matrix` is the column-major
 *   world matrix of the unit cube (-0.5..0.5). Framed and outlined by it; a feature reports it `pickable: false`.
 * - `polyline`: a line through world-space `points` (xyz, `closed` joining the last to the first), `halfWidth`
 *   wide on each side (a line or trail ribbon, ADR 0396, whose camera-facing triangles have no CPU shape): picked
 *   by screen distance to its segments, framed and outlined by the box around its points grown by `halfWidth`.
 * - null: drawn inside a batch with no geometry of its own (a batched sprite): counted, not picked or framed.
 */
export type DrawnShape =
  | { readonly kind: "quad"; readonly mesh: AbstractMesh }
  | { readonly kind: "meshes"; readonly meshes: readonly AbstractMesh[] }
  | { readonly kind: "quads"; readonly batches: readonly QuadBatch[] }
  | { readonly kind: "box"; readonly matrix: ArrayLike<number> }
  | { readonly kind: "polyline"; readonly points: ArrayLike<number>; readonly halfWidth: number; readonly closed?: boolean };

/** @internal Pick orders (ADR 0276 `DrawnNode.order`) beside layered 2D content's (sorting layer × 10000 + order in layer, ADR 0014). */
export const PICK_ORDER = {
  /** Depth-tested 3D content: below every layered 2D item, nearest first among themselves. */
  depthTested: -1e12,
} as const;

/** @internal One node's drawing by a feature (ADR 0276). A node drawn by several Components or features has several. */
export interface DrawnNode {
  /** The Component it drew (its node is the one picked, framed and outlined). */
  readonly component: Component;
  readonly shape: DrawnShape | null;
  /** Pick order, higher on top: layered 2D content its draw order, else a {@link PICK_ORDER}. Equal orders go nearest first. */
  readonly order: number;
  /**
   * False when a scene-view click reaches it another way: the UI core picks UI canvases and elements, by
   * its own rules (ADR 0117). It is still framed, box-selected, outlined and reported. Default true.
   */
  readonly pickable?: boolean;
  /** The materials it drew with, in the engine's terms (`RenderDiagnostics.drawn`); none when it has none to report. */
  readonly materials?: readonly DrawnMaterial[];
  /** A flat drawing's size in node units before the node's scale, once known (a sprite's, from its texture): what a collider fits. */
  readonly size?: readonly [number, number] | null;
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
  /** Its part of the core diagnostics (the built-in features: the probes). */
  state?(): FeatureState;
  /** ADR 0154: its own diagnostics, reported as `RenderDiagnostics.features[<its spec's name>]`. */
  diagnostics?(): unknown;
  /** ADR 0154: what a drawn object of its is (the variant report), or null when it isn't one of its. */
  describe?(drawn: object): DrawnDescription | null;
  /**
   * ADR 0276: what it drew now, per node (visible and loaded only): picking, framing, outlines, thumbnails,
   * sprite sizes and `RenderDiagnostics.drawn` read every loaded feature's.
   */
  drawn?(): Iterable<DrawnNode>;
  /**
   * ADR 0276: add the meshes that cast shadows this frame (after the `content` phase). Only the meshes
   * feature casts: sprites, tiles, water and UI are flat, unlit or transparent and never have.
   */
  casters?(out: AbstractMesh[]): void;
  /**
   * ADR 0276: whether what it draws has loaded (a MeshRenderer's model); absent means always. A World's
   * first frames and its probe captures wait for every loaded feature's (`FeatureSyncContext.ready`).
   */
  loaded?(): boolean;
  /** ADR 0154: the UI layout and routing core it runs (the editor's UI queries), or null. */
  uiCore?(): UICore | null;
  /** Before each view is drawn: follow its camera (the sky's box around it). */
  fit?(camera: TargetCamera): void;
  /** Once a frame, before the frame graph runs (the sky's bake, like probe captures). */
  beforeFrame?(): void;
  /**
   * ADR 0189: whether what it draws and lights with has loaded and taken effect (the lighting rig's
   * environment map lights the scene; the sky's first bake does). Absent means always. A thumbnail
   * renderer syncs until every feature has settled (or its time runs out) before it draws a still.
   */
  settled?(): boolean;
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
  /**
   * The lighting rig (lights, shadows, environment, skybox; ADR 0252): a feature in the `lighting` phase
   * contributes to it (the sky its sun and bake), and the renderer resolves it after the phase.
   */
  readonly lighting: LightingContributions;
  /** The material library (ADR 0127). */
  readonly materials: BabylonMaterialLibrary;
  /** The 2D materials (ADR 0418): what every 2D draw (sprites, 2D particles) gets its material, lit or not, from. */
  readonly materials2D: BabylonMaterials2D;
  /** Reflection probes: whether any exist, the lookup (the probe nearest a point, ADR 0130), and counting a mesh drawn with one's reflection this frame (diagnostics). */
  readonly probes: { readonly any: boolean; lookup(x: number, y: number, z: number): ProbeHit | null; reflected(): void };
  /** The project settings the renderer was made with (pixels per unit, sorting layers). */
  readonly settings: ProjectSettings;
  /**
   * The render policy now (ADR 0129): the scene view, the particle preview, the draw policy (`perObject`
   * in the editor's scene view and editor play mode, for picking and outlines, else `batched`)… Read it each sync.
   */
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
  /** Decal volumes (ADR 0395): what the Decals plugin draws 3D decals with. */
  readonly decals: DecalHost;
  /** Depth-tested meshes a feature rewrites, camera-facing ribbons included (ADR 0396): what the Lines plugin draws 3D lines and trails with. */
  readonly dynamicMeshes: DynamicMeshHost;
  warnOnce(key: string, message: string): void;
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
   * What warms this feature's content before it has loaded (ADR 0154, 0240): its registration's lighter
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

/**
 * @internal The world-space box around a `box` or `polyline` shape (ADR 0395, 0396): a box's eight corners, a
 * polyline's points grown by its half width. Null for other shapes or an empty polyline.
 */
export function shapeWorldBox(shape: DrawnShape): { min: [number, number, number]; max: [number, number, number] } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number, r: number): void => {
    min[0] = Math.min(min[0], x - r); min[1] = Math.min(min[1], y - r); min[2] = Math.min(min[2], z - r);
    max[0] = Math.max(max[0], x + r); max[1] = Math.max(max[1], y + r); max[2] = Math.max(max[2], z + r);
  };
  if (shape.kind === "box") {
    for (const c of boxCorners(shape.matrix)) grow(c[0], c[1], c[2], 0);
  } else if (shape.kind === "polyline") {
    const p = shape.points;
    for (let i = 0; i + 2 < p.length; i += 3) grow(p[i]!, p[i + 1]!, p[i + 2]!, shape.halfWidth);
  } else return null;
  return min[0] <= max[0] ? { min, max } : null;
}

/** @internal The eight world corners of the unit cube (-0.5..0.5) under a column-major world matrix. */
export function boxCorners(m: ArrayLike<number>): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? 0.5 : -0.5, y = i & 2 ? 0.5 : -0.5, z = i & 4 ? 0.5 : -0.5;
    out.push([m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]);
  }
  return out;
}
