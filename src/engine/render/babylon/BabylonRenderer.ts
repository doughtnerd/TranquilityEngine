/**
 * Babylon.js renderer, stage 1 of ADR 0075: the engine (WebGPU, WebGL2 fallback), cameras, meshes
 * (built-in and imported), sprites and material assets. Loaded on demand by `BabylonSurface`.
 * Internal: game code never sees anything here.
 *
 * The engine node graph is authoritative (ADR 0010): each frame, sync copies world matrices into
 * Babylon objects, which are kept flat (no parenting) with frozen world matrices. The scene is
 * right-handed, +Y up, like the engine (ADR 0014).
 *
 * Lights, shadows and the environment (stage 2) are in `lighting.ts`; the frame graph that draws each
 * frame, with post-processing (stage 3), is in `frameGraph.ts`.
 *
 * Materials and textures (stage 4: material assets, shader graphs, script Materials, per-renderer
 * properties, probe copies) are built by the scene's `BabylonMaterialLibrary` (`materialLibrary.ts`,
 * ADR 0127) from the renderer-neutral resolution in `render/materialResolution.ts`.
 *
 * Editor helpers (stage 8) are in `editorTools.ts` (loaded on demand) over the context below; their
 * overlay is a utility layer the frame graph draws after the view camera. The camera preview inset is
 * one more camera in the frame graph, drawn last.
 *
 * Render features (ADR 0130, 0135, 0140, 0154) draw everything else. The renderer runs them by phase and
 * asks them things only through `BabylonFeature`'s optional hooks (warm items, describing a drawn
 * object, diagnostics, the UI core), so it names no particle, UI, sky or water feature: the UI plugin's
 * feature, for one, hands the frame graph its screen layer, drawn after the game's camera (in the
 * editor, over its overlay).
 */
import "./register";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import { createBabylonEngine } from "./createEngine";
import { EDITOR_LAYER_MASK, type BabylonEditorContext } from "./editorContext";
import type { BabylonEditorTools } from "./editorTools";
import type { Component } from "../../core/Component";
import type { ProjectSettings } from "../../core/settings";
import type { World } from "../../core/World";
import type { Color } from "../../core/math";
import type { GraphShared } from "./graphMaterial";
import { Camera, PostProcessing, ReflectionProbe, SpriteRenderer } from "../components";
import type { UICore } from "../../ui/UICore";
import { BabylonProbes } from "./probes";
import { BabylonRenderTextures } from "./renderTextures";
import type { GameObject } from "../../scene/GameObject";
import type { PixelGrid, RenderDiagnostics, RenderFeatureDiagnostics } from "../RenderSurface";
import { Graphics } from "../Graphics";
import type { PostSettings } from "../postEffects";
import { canvasCameras, planFrame, type FrameCamera, type PlannedView, type Rgb, type ViewRect } from "../framePlan";
import { GAME_POLICY, type RenderPolicy } from "../renderPolicy";
import type { PostEffects, ToneMappingName } from "../postEffects";
import { BabylonFrame, type CameraView } from "./frameGraph";
import { BabylonLighting } from "./lighting";
import { BabylonMaterialLibrary } from "./materialLibrary";
import { eagerFeature, lazyFeature, type BabylonFeature, type BabylonFeatureFactory, type BabylonFeatureHost, type BabylonWarmFactory, type FeatureSlot, type FeatureSyncContext, type MeshesFeatureApi, type SpritesFeatureApi } from "./feature";
import { _registeredRenderFeatures, byPhase, ownerOf, specNeeded, SYNC_PHASES, type RenderFeatureRegistration, type RenderFeatureSpec, type SyncPhase } from "../renderFeatures";
import { BabylonQuadBatches } from "./quadBatches";
import { ENVIRONMENT_SPEC, EnvironmentFeature, FOG_SPEC, LIGHTS_SPEC, LightsFeature, PROBES_SPEC, ProbesFeature } from "./features";
import { FogFeature } from "./fog";
import { sortingOrder, unknownLayerMessage } from "../sortOrder";
import { snapToGrid } from "../pixelPerfect";
import { AsyncPipelines, FirstFrames } from "./asyncPipelines";
import { effectClock, PipelineWarmer, VariantReport, type WarmItem } from "./warmUp";
import type { WarmContent } from "../../scene/warmUp";
import type { QualityTier } from "../../core/graphics";
import { _instantiatedPrefabOf } from "../../scene/SceneLoader";

interface CameraEntry {
  camera: TargetCamera;
  /** Its rectangle on the canvas, fractions from the bottom-left (ADR 0056). */
  rect: { x: number; y: number; width: number; height: number };
}


const tmpMatrix = new Matrix();
const tmpScale = new Vector3();
const tmpQuat = new Quaternion();
const tmpPos = new Vector3();


/**
 * @internal The tier settings that change the pipelines draws need (ADR 0080): the sample count, the
 * passes (post-processing, ambient occlusion, depth of field, bloom), shadow maps and cascades, the
 * shader level graph materials compile for, and probe captures. Not the render scale or particle budget.
 */
export function pipelineTierKey(t: Readonly<QualityTier>): string {
  return [t.antialias, t.shadows, t.shadowCascades, t.shaderLevel, t.postProcessing, t.bloom, t.ambientOcclusion, t.depthOfField, t.reflectionProbes].join("|");
}

/** The whole camera texture (each camera renders into a texture its rectangle's size, frameGraph.ts). */
const FULL_VIEW: ViewRect = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

/** How many shader effects `engine` has compiled and holds (Babylon keeps them by key). */
function compiledEffects(engine: AbstractEngine): number {
  const effects = (engine as unknown as { _compiledEffects?: Record<string, unknown> })._compiledEffects;
  return effects ? Object.keys(effects).length : 0;
}

function color4(c: Rgb): Color4 {
  return new Color4(c[0], c[1], c[2], 1);
}

/** An engine colour as the frame plan's sRGB triple (as `clearColorOf` reads its hex: 8 bits a channel). */
function rgbOf(c: Color): Rgb {
  const q = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255) / 255;
  return [q(c.r), q(c.g), q(c.b)];
}

/** A CSS colour string or 0xRRGGBB number as a Babylon colour (gamma space, for clearing). */
function clearColorOf(v: string | number): Color4 {
  if (typeof v === "number") return Color4.FromColor3(Color3.FromInts((v >> 16) & 255, (v >> 8) & 255, v & 255), 1);
  const hex = /^#([0-9a-f]{6})$/i.test(v) ? v : /^#([0-9a-f]{3})$/i.test(v) ? "#" + [...v.slice(1)].map((c) => c + c).join("") : "#000000";
  return Color4.FromColor3(Color3.FromHexString(hex), 1);
}

/** @internal Stage 1 Babylon.js renderer (ADR 0075). */
export class BabylonRenderer {
  readonly scene: Scene;
  /** Quad batches for plugin features (the Tilemaps plugin's tiles, ADR 0136). */
  private readonly quads: BabylonQuadBatches;
  private readonly cameras = new Map<Camera, CameraEntry>();
  /** Materials and textures (ADR 0127): every material and texture the scene draws is built and cached there. */
  private readonly materials: BabylonMaterialLibrary;
  private readonly warned = new Set<string>();
  /** Time and drawing-buffer size, read by every graph material. */
  private readonly graphShared: GraphShared = { time: 0, resolution: [1, 1] }; // `mainLight` is the lighting's, set once it exists
  /** ADR 0080: draws queued meshes once, hidden, so their shader pipelines exist before they're shown. */
  private readonly warmer: PipelineWarmer;
  /** A World's first frames, held while their pipelines compile asynchronously (ADR 0120). */
  private readonly firstFrames = new FirstFrames();
  /** True while the frame graph runs in a held first frame: `AsyncPipelines` skips any draw then, not just the warmer's. */
  private firstFrameDrawing = false;
  /** Whether the World's textures and models had all loaded at the last sync (a held first frame waits for them). */
  private contentLoaded = false;
  /** WebGPU: the warm-up's pipelines compile asynchronously while the warmer is busy (no frame waits for them); null elsewhere. */
  private readonly asyncPipelines: AsyncPipelines | null;
  /** Time spent creating effects, which sizes the warm-up's batches. */
  private readonly effects: { ms(): number; dispose(): void };
  /** ADR 0080: editor play mode's log of shader variants compiled after loading; null when off. */
  private report: VariantReport | null = null;
  /** The tier settings the warmed pipelines were made for (`pipelineTierKey`). */
  private warmedTier = pipelineTierKey(Graphics.tier);
  /** How many probes had captured when the warm-up last covered their copies. */
  private warmedProbes = 0;
  /** When `render` last drew a frame: a warm-up only waits while frames are being drawn. */
  private lastRenderAt = -Infinity;
  /** Shared by the sky, lights and environment features, and the frame's sky fit. */
  private readonly lighting: BabylonLighting;
  private readonly lights: LightsFeature;
  private readonly fog: FogFeature;
  /** Reflection probes (stage 6): the probe lookup meshes and water use. */
  private readonly probes: BabylonProbes;
  /** Render texture assets cameras draw into (ADR 0109). */
  private readonly renderTextures: BabylonRenderTextures;
  /**
   * Every render feature, in registration order (ADR 0130): the built-ins (the lighting rig and probes),
   * then plugins' (ADR 0135, 0140) in their registration order. The renderer asks them things through
   * their optional hooks (ADR 0154); only the sprite and mesh features' content APIs are read by name (ADR 0140).
   */
  private readonly slots: FeatureSlot[];
  /** Their specs, in the same order (for `ownerOf`). */
  private readonly specs: RenderFeatureSpec[];
  /** The slots of each sync phase, in run order (`byPhase`). */
  private readonly phases = new Map<SyncPhase, FeatureSlot[]>();
  /** What the renderer worked out for the features this sync. */
  private readonly syncCtx: FeatureSyncContext = { view: null, viewCamera: null, ready: false, probeMeshes: [] };
  /** Meshes drawn with a probe's map last frame, for tests. */
  private reflecting = 0;
  /** The core services plugin features are built from (ADR 0135, 0154). */
  private readonly host: BabylonFeatureHost;
  /** Plugin features' registered warm loaders (ADR 0154 `loadWarm`), by slot, and what they loaded. */
  private readonly warmLoaders = new Map<FeatureSlot, () => Promise<unknown>>();
  private readonly warmSources = new Map<FeatureSlot, Promise<Pick<BabylonFeature, "warm"> | null>>();
  /** The pixel ratio the drawing buffer follows (`resize`), and the surface's device-pixel grid once it gives one. */
  private pixelRatio = 1;
  private gridSource: (() => PixelGrid) | null = null;
  /** What this World's renderer does beyond game rules (ADR 0129); the editor sets it through its viewport handle. */
  private policy: RenderPolicy = { ...GAME_POLICY };
  /** The last frame's plan (ADR 0129), for diagnostics. */
  private lastPlan: PlannedView[] = [];
  private readonly frame: BabylonFrame;
  private readonly casters: AbstractMesh[] = [];
  /** What the last frame's first camera ran, for tests and the editor. */
  private lastPost: { composed: boolean; toneMapping: ToneMappingName; effects: PostEffects | null; composedCameras: number } | null = null;
  private clearColor: Color4;
  private owner: World | null = null;
  private disposed = false;
  /** Editor helpers (stage 8), loaded on first use; an editor World loads them at once. */
  private tools: BabylonEditorTools | null = null;
  private toolsLoading: Promise<BabylonEditorTools | null> | null = null;
  private overlayLayer: UtilityLayerRenderer | null = null;
  /** Editor: whether the last frame drew the camera preview. */
  cameraPreviewDrawn = false;
  /** What reflection probes capture: the scene's meshes minus editor-only ones, refilled each frame. */
  private readonly probeMeshes: AbstractMesh[] = [];

  /** Creates the engine (`createBabylonEngine`: WebGPU, else the WebGL2 fallback, ADR 0156) and the scene. */
  static async create(canvas: HTMLCanvasElement, settings: ProjectSettings): Promise<BabylonRenderer> {
    const engine = await createBabylonEngine(canvas);
    return new BabylonRenderer(engine, settings, await loadPluginFeatures());
  }

  private constructor(
    readonly engine: AbstractEngine,
    private readonly settings: ProjectSettings,
    plugged: readonly PluginFeature[] = [],
    /** Thumbnails (ADR 0153): not a World's surface; null for every other renderer. */
    private readonly thumbnail: ThumbnailPolicy | null = null,
  ) {
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true; // the engine's convention (ADR 0014)
    scene.autoClear = true;
    this.clearColor = clearColorOf(settings.display.backgroundColor);
    scene.clearColor = this.clearColor;
    this.scene = scene;

    this.lighting = new BabylonLighting(scene);
    if (thumbnail) this.lighting.shareStudio(thumbnail.studio);
    this.graphShared.mainLight = this.lighting.mainLight;
    this.frame = new BabylonFrame(scene);
    this.frame.beforeView = (camera) => {
      this.lighting.fitSky(camera);
      for (const slot of this.slots) slot.feature?.fit?.(camera); // the sky's box (ADR 0112)
    };
    this.probes = new BabylonProbes(scene);
    this.renderTextures = new BabylonRenderTextures(scene);
    this.materials = new BabylonMaterialLibrary(scene, {
      shared: this.graphShared,
      renderTexture: (path) => this.renderTextures.texture(path),
      editorPicking: () => this.policy.drawPolicy === "perObject", // the editor's picking needs per-object instances
    });
    this.quads = new BabylonQuadBatches({
      scene,
      texture: (path, onLoad) => {
        const t = this.materials.loadedTexture(path);
        if (t) return t;
        this.materials.texture(path).then(onLoad, (err) => this.warnOnce(`tile|${path}`, `failed to load tile texture "${path}": ${(err as Error).message}`));
        return null;
      },
      sortOrder: (layer, order) => sortingOrder(this.settings.render.sortingLayers, layer, order, (l) => this.warnOnce(`layer|${l}`, unknownLayerMessage(l))),
    });
    this.lights = new LightsFeature(this.lighting);
    this.fog = new FogFeature({ scene, setSkyFog: (amount) => this.lighting.setSkyFog(amount) });
    // Order inside a phase is registration order adjusted by the specs' `after` constraints (ADR 0130,
    // 0135, 0140): the sky (the Sky plugin's) before lights (it may drive the sun), lights before fog, fog
    // before the environment (the skybox fades with the sky fog); sprites, tilemaps, then meshes.
    const host = (this.host = this.featureHost());
    this.slots = [
      eagerFeature(LIGHTS_SPEC, this.lights),
      eagerFeature(FOG_SPEC, this.fog),
      eagerFeature(ENVIRONMENT_SPEC, new EnvironmentFeature(this.lighting)),
      eagerFeature(PROBES_SPEC, new ProbesFeature(this.probes, { reflecting: () => this.reflecting })),
    ];
    for (const p of plugged) {
      for (const slot of pluginSlot(p, host)) {
        this.slots.push(slot);
        if (p.registration.loadWarm) this.warmLoaders.set(slot, p.registration.loadWarm);
      }
    }
    this.specs = this.slots.map((f) => f.spec);
    for (const i of byPhase(this.specs)) {
      const slot = this.slots[i];
      const list = this.phases.get(slot.spec.phase) ?? [];
      list.push(slot);
      this.phases.set(slot.spec.phase, list);
    }

    // Before the warmer, which asks whether compiles are async. Only while it's busy: everywhere else a
    // missing pipeline is made as Babylon makes it, so what's drawn never skips a frame.
    // A World's first frames (ADR 0120) use it for every draw of the frame graph.
    this.asyncPipelines = thumbnail ? null : AsyncPipelines.install(this.engine, () => (this.warmer?.drawing ?? false) || this.firstFrameDrawing, () => !(this.warmer?.drawing ?? false));
    this.effects = thumbnail ? { ms: () => 0, dispose: () => undefined } : effectClock(this.engine); // a shared thumbnail engine is never wrapped
    this.warmer = new PipelineWarmer({
      scene,
      materials: this.materials,
      ...(this.asyncPipelines ? { compiling: () => this.asyncPipelines!.settled() } : {}),
      effectMs: () => this.effects.ms(),
      probeVariants: (base) => this.probes.warmHits().map((hit) => this.materials.probeCopy(base, hit)),
    });
    this.warmer.onDrained = () => this.report?.quiet();
  }

  // --- Warm-up (ADR 0080) -----------------------------------------------------------------------

  /**
   * Draw `meshes` once, hidden, in every pass the frame puts them in, so their pipelines exist before
   * they're shown. Resolves when they've drawn, or at once while no frames are being drawn (a World's
   * first scene, loaded before the engine starts): they're drawn over the first frames instead.
   */
  warmUp(set: WarmContent): Promise<void> {
    const items: WarmItem[] = [...set.meshes];
    const later: Promise<void>[] = [];
    // Each feature builds its own warm items (ADR 0130); a lazy one that hasn't loaded is loaded for the
    // content its spec `warms` (or its registration's lighter `loadWarm`), then asked (ADR 0154).
    for (const slot of this.slots) {
      const feature = slot.feature;
      if (feature) items.push(...(feature.warm?.(set) ?? []));
      else if (slot.spec.warms?.(set)) later.push(this.warmSource(slot).then((w) => (w?.warm && !this.disposed ? this.warmer.add(w.warm(set)) : undefined)));
    }
    const done = Promise.all([this.warmer.add(items), ...later]).then(() => undefined);
    return performance.now() - this.lastRenderAt < 500 ? done : Promise.resolve();
  }

  /** What warms a lazy feature's content before it has loaded: its registration's warm factory (loaded once), else the feature. */
  private warmSource(slot: FeatureSlot): Promise<Pick<BabylonFeature, "warm"> | null> {
    const load = this.warmLoaders.get(slot);
    if (!load) return slot.whenLoaded();
    let source = this.warmSources.get(slot);
    if (!source) {
      source = load().then(
        (factory) => (this.disposed ? null : (factory as BabylonWarmFactory)(this.host)),
        (err) => {
          this.warmSources.delete(slot); // try again at the next warm-up
          console.error(`[myco] the ${slot.spec.name} render feature's warm-up couldn't load:`, err);
          return null;
        },
      );
      this.warmSources.set(slot, source);
    }
    return source;
  }

  /** The tier changed what draws need (MSAA, passes, shadows, shader level): draw what this World warmed again in the new passes. */
  private rewarmOnTierChange(): void {
    const key = pipelineTierKey(Graphics.tier);
    if (key === this.warmedTier) return;
    this.warmedTier = key;
    void this.warmer.rewarm();
  }

  /** Editor play mode: log shader variants compiled after loading, naming their node and prefab (ADR 0080). */
  setVariantReport(on: boolean): void {
    if (on === !!this.report) return;
    this.report?.dispose();
    this.report = on ? new VariantReport(this.engine, this.scene, (m) => this.describeMesh(m)) : null;
  }

  /**
   * What a drawn object is, for the variant report: the first feature that knows it says (ADR 0154
   * `describe`), and the node's prefab, if it came from one, is named; null for other objects.
   */
  private describeMesh(drawn: object): { what: string; prefab?: string } | null {
    for (const slot of this.slots) {
      const d = slot.feature?.describe?.(drawn);
      if (!d) continue;
      let prefab: string | undefined;
      for (let n: GameObject | null = d.node ?? null; n && !prefab; n = n.parent) prefab = _instantiatedPrefabOf(n);
      if (prefab) return { what: `${d.what} (from ${prefab})`, prefab };
      return d.asset ? { what: d.what, prefab: d.asset } : { what: d.what };
    }
    return null;
  }

  // --- Editor (ADR 0022; stage 8) ---------------------------------------------------------------

  /** The editor helpers (the editor viewport's Babylon adapter, ADR 0128), or null while they load (the first call starts loading them). */
  editorTools(): BabylonEditorTools | null {
    if (!this.disposed) void this.loadEditorTools();
    return this.tools;
  }

  /** Load the editor helpers (once); resolves with them, or null if they couldn't load or the renderer was disposed. */
  loadEditorTools(): Promise<BabylonEditorTools | null> {
    this.toolsLoading ??= import("./editorTools")
      .then((m) => {
        if (this.disposed) return null;
        // Manual rendering: the frame graph draws it (frameGraph.ts), straight onto the canvas.
        const layer = new UtilityLayerRenderer(this.scene, true, true);
        layer.utilityLayerScene._useCurrentFrameBuffer = true;
        this.overlayLayer = layer;
        this.frame.overlay = layer;
        this.tools = new m.BabylonEditorTools(this.editorContext(layer));
        return this.tools;
      })
      .catch((err) => {
        console.error("[myco] the Babylon editor helpers couldn't load:", err);
        this.toolsLoading = null; // try again on the next call, and stop counting as loading (sprite batching)
        return null;
      });
    return this.toolsLoading;
  }

  /** What the editor helpers read (editorContext.ts). */
  private editorContext(overlay: UtilityLayerRenderer): BabylonEditorContext {
    const self = this;
    return {
      scene: this.scene,
      overlay,
      canvas: this.engine.getRenderingCanvas() as HTMLCanvasElement,
      settings: this.settings,
      get editor() {
        return self.policy.sceneView;
      },
      world: () => this.owner,
      viewCameras: () => (this.owner ? this.viewCameras(this.owner) : []),
      babylonCamera: (c) => this.cameras.get(c)?.camera ?? null,
      sprites: () => self.spritesFeature()?.editorSprites() ?? [],
      meshes: () => self.meshesFeature()?.editorMeshes() ?? [],
      texts: () => [], // Text draws from stage 9
      renderer: {
        setClearColor: (color) => this.setClearColor(color),
        cameraPreviewDrawn: () => this.cameraPreviewDrawn,
        spriteSize: (sprite) => this.spriteSize(sprite),
        ui: () => this.uiState(),
        bakeReflectionProbe: (probe) => this.bakeReflectionProbe(probe),
      },
    };
  }

  /** ADR 0129: change some render policy settings (the editor's viewport handle, through the surface). */
  setPolicy(change: Partial<RenderPolicy>): void {
    this.policy = { ...this.policy, ...change }; // the UI reads `interactive()` at its next sync
  }

  /**
   * The camera preview inset as fractions of the canvas (x and width from the left, top and height from
   * the top), or null when there's none to draw.
   */
  private previewRect(): { x: number; top: number; width: number; height: number } | null {
    const p = this.policy.cameraPreview;
    const entry = p && p.camera.node.isValid && p.camera.isActiveAndEnabled ? this.cameras.get(p.camera) : undefined;
    if (!p || !entry) return null;
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas) return null;
    const c = canvas.getBoundingClientRect(), r = p.frame.getBoundingClientRect();
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (r.width < 2 || r.height < 2 || cw <= 0 || ch <= 0) return null;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const x = clamp((r.left - c.left) / cw), top = clamp((r.top - c.top) / ch);
    const w = Math.min(clamp(r.width / cw), 1 - x), h = Math.min(clamp(r.height / ch), 1 - top);
    if (w <= 0.001 || h <= 0.001) return null;
    return { x, top, width: w, height: h };
  }

  /** The frame plan's preview input (ADR 0129): the inset from the bottom-left, its aspect ratio, and whether its overlay layer is set. */
  private previewInput(): { camera: Camera; rect: { x: number; y: number; width: number; height: number }; aspect: number; ui: boolean } | null {
    const p = this.policy.cameraPreview;
    const rect = p ? this.previewRect() : null;
    if (!p || !rect) return null;
    const r = p.frame.getBoundingClientRect();
    const y = Math.min(1, Math.max(0, 1 - rect.top - rect.height));
    return { camera: p.camera, rect: { x: rect.x, y, width: rect.width, height: rect.height }, aspect: r.width / r.height, ui: this.frame.previewUI !== null };
  }

  /** Sets the editor background (editor Worlds) and clear colour. */
  setClearColor(color: string | number): void {
    this.clearColor = clearColorOf(color);
  }

  /** The drawing buffer follows the canvas's CSS size times `pixelRatio`. */
  resize(pixelRatio: number): void {
    this.pixelRatio = pixelRatio;
    this.engine.setHardwareScalingLevel(1 / Math.max(0.01, pixelRatio));
    this.engine.resize();
  }

  /** The surface's device-pixel grid (ADR 0154), which features (the UI) read: the same answer the camera's maths reads. */
  setPixelGrid(source: () => PixelGrid): void {
    this.gridSource = source;
  }

  /** The view's device-pixel grid: the surface's, else (tests) the canvas's size, or the reference resolution, at the pixel ratio `resize` applied. */
  private pixelGrid(): PixelGrid {
    if (this.gridSource) return this.gridSource();
    const canvas = this.engine.getRenderingCanvas();
    return { width: canvas?.clientWidth || this.settings.display.width, height: canvas?.clientHeight || this.settings.display.height, pixelRatio: this.pixelRatio };
  }

  // --- Textures ---------------------------------------------------------------------------------

  /** Load textures ahead of time so sprites don't pop in. */
  async preloadTextures(paths: string[], onProgress?: (p: number) => void): Promise<void> {
    let done = 0;
    await Promise.all(
      paths.map((p) =>
        this.materials
          .texture(p)
          .catch((err) => console.error(`[myco] failed to load texture "${p}":`, err))
          .finally(() => onProgress?.(++done / paths.length)),
      ),
    );
  }

  // --- Frame ------------------------------------------------------------------------------------

  /** Step 8: mirror the World's cameras, meshes and sprites into Babylon. */
  sync(world: World): void {
    this.claim(world);
    const ctx = this.syncCtx;
    ctx.view = ctx.viewCamera = null;
    ctx.ready = false;
    this.reflecting = 0; // the mesh feature counts this frame's meshes drawn with a probe as it syncs
    for (const phase of SYNC_PHASES) {
      for (const slot of this.phases.get(phase) ?? []) slot.ensure(world)?.sync(world, ctx);
      this.afterPhase(phase, world, ctx);
    }
    this.tools?.sync(world);
    // A thumbnail is drawn without `render`: graph materials' Time and size follow its World here (ADR 0156).
    if (this.thumbnail) {
      this.graphShared.time = world.time.time;
      this.graphShared.resolution = [this.engine.getRenderWidth(), this.engine.getRenderHeight()];
    }
  }

  /** The renderer's own steps between feature phases (ADR 0130 `SYNC_PHASES`). */
  private afterPhase(phase: SyncPhase, world: World, ctx: FeatureSyncContext): void {
    if (phase === "content") {
      for (const c of world._componentsOfType(Camera)) this.syncCamera(world, c);
      const view = this.viewCameras(world)[0] ?? null;
      ctx.view = view;
      ctx.viewCamera = view ? this.cameras.get(view)!.camera : null;
      this.casters.length = 0;
      this.meshesFeature()?.casters(this.casters);
    } else if (phase === "effects") {
      ctx.ready = this.contentLoaded = !this.materials.loading() && (this.meshesFeature()?.loaded() ?? true);
      this.probeMeshes.length = 0;
      for (const m of this.scene.meshes) if ((m.layerMask & EDITOR_LAYER_MASK) === 0) this.probeMeshes.push(m);
      ctx.probeMeshes = this.probeMeshes;
    } else if (phase === "capture") {
      // Probes capture after the scene loads, after its warm-up: warm their material copies once they exist (ADR 0080).
      const captured = this.probes.textures().length;
      if (captured > this.warmedProbes) void this.warmer.rewarm();
      this.warmedProbes = captured;
    }
  }

  /** @internal Tests and the editor: the UI core (layout and routing) a loaded feature runs (ADR 0154 `uiCore`), or null. */
  uiState(): UICore | null {
    for (const slot of this.slots) {
      const core = slot.feature?.uiCore?.();
      if (core) return core;
    }
    return null;
  }

  /** A named feature once it exists (ADR 0140: the sprite and mesh features, whose content the renderer's own steps read). */
  private feature<F>(name: string): F | null {
    return (this.slots.find((s) => s.spec.name === name)?.feature as F | null | undefined) ?? null;
  }

  private spritesFeature(): SpritesFeatureApi | null {
    return this.feature<SpritesFeatureApi>("sprites");
  }

  private meshesFeature(): MeshesFeatureApi | null {
    return this.feature<MeshesFeatureApi>("meshes");
  }

  /** @internal Tests and e2e: the Meshes plugin's feature (`meshRenderers`, `batchStats()`), or null without it. */
  get meshes(): MeshesFeatureApi | null {
    return this.meshesFeature();
  }

  /** The core services plugin render features are built from (ADR 0135, 0154): nothing here is one feature's. */
  private featureHost(): BabylonFeatureHost {
    const probes = this.probes;
    return {
      scene: this.scene,
      lighting: this.lighting,
      materials: this.materials,
      probeLookup: (x, y, z) => probes.lookup(x, y, z),
      probes: {
        get any() {
          return probes.any;
        },
        lookup: (x, y, z) => probes.lookup(x, y, z),
        reflected: () => void this.reflecting++,
      },
      settings: this.settings,
      drawPolicy: () => this.policy.drawPolicy,
      policy: () => this.policy,
      world: () => this.owner,
      viewCamera: () => (this.owner ? (this.viewCameras(this.owner)[0] ?? null) : null),
      previewRect: () => this.previewRect(),
      pixelGrid: () => this.pixelGrid(),
      setScreenLayer: (draw) => (this.frame.ui = draw),
      setPreviewLayer: (draw) => (this.frame.previewUI = draw),
      quads: this.quads,
      warnOnce: (key, message) => this.warnOnce(key, message),
    };
  }

  render(world: World): void {
    this.claim(world);
    this.rewarmOnTierChange();
    this.graphShared.time = world.time.time;
    this.graphShared.resolution = [this.engine.getRenderWidth(), this.engine.getRenderHeight()];
    const engine = this.engine;
    engine.beginFrame();
    // ADR 0129: the frame plan decides the views; this only maps them to Babylon cameras and passes.
    const cc = this.clearColor;
    const skyFog = this.fog.skyFog();
    const plan = planFrame({
      cameras: this.frameCameras(world),
      clearColor: [cc.r, cc.g, cc.b],
      skyFog: skyFog ? { color: [skyFog.color.r, skyFog.color.g, skyFog.color.b], amount: skyFog.amount } : null,
      tier: Graphics.tier,
      sceneView: this.policy.sceneView,
      overlay: !!this.tools,
      preview: this.previewInput(),
    });
    this.lastPlan = plan;
    const views: CameraView[] = [];
    let previewShown = false, composedCameras = 0;
    for (const v of plan) {
      const view = this.cameraView(v);
      if (!view) continue;
      views.push(view);
      if (v.output.kind === "preview") previewShown = true;
      if (v.output.kind === "canvas" && view.effects) composedCameras++;
    }
    const first = plan[0]?.output.kind === "canvas" ? views[0] : undefined;
    this.lastPost = first ? { composed: !!first.effects, toneMapping: first.toneMapping, effects: first.effects, composedCameras } : null;
    this.cameraPreviewDrawn = previewShown && this.frame.ready;
    for (const slot of this.slots) slot.feature?.beforeFrame?.(); // the sky's bake: before the frame graph runs, like probe captures
    if (views.length) this.probes.capture(views[0].camera); // before the frame graph runs
    this.warmer.beforeRender(views[0]?.camera ?? null, this.casters);
    let held = false;
    if (views.length) {
      // A World's first frames (ADR 0120): every missing pipeline compiles asynchronously, and a frame missing a draw is held on the clear colour.
      const first = !!this.asyncPipelines && this.firstFrames.begin(this.frame.ready, performance.now());
      const skipped = this.asyncPipelines?.skippedShown ?? 0;
      this.firstFrameDrawing = first;
      try {
        this.frame.render(views, this.lights.shadows(), this.casters, Graphics.tier.antialias === "msaa" ? 4 : 1);
      } finally {
        this.firstFrameDrawing = false;
      }
      // A layout change rebuilds the graph instead of running it: that frame shows the clear colour and doesn't count.
      if (first && this.frame.ready) held = this.firstFrames.end(this.asyncPipelines!.skippedShown > skipped, this.contentLoaded && !this.slots.some((f) => f.loading && f.spec.holdsFirstFrame), performance.now());
      if (held) engine.restoreDefaultFramebuffer();
    }
    if (!views.length || !this.frame.ready || held) engine.clear(this.clearColor, true, true, true);
    engine.endFrame();
    if (views.length && this.frame.ready) {
      this.warmer.afterRender();
      this.report?.afterRender();
      this.lastRenderAt = performance.now();
    }
  }

  /** A planned view as a frame-graph camera view (ADR 0129), or null when its render texture isn't ready. */
  private cameraView(v: PlannedView): CameraView | null {
    const entry = this.cameras.get(v.camera);
    if (!entry) return null;
    const camera = entry.camera;
    camera.layerMask = v.editorContent ? 0xffffffff : 0x0fffffff; // editor-only meshes (the grid) carry EDITOR_LAYER_MASK
    const out = v.output;
    let viewport = FULL_VIEW;
    let target: CameraView["target"];
    if (out.kind === "canvas") viewport = out.rect;
    else if (out.kind === "texture") {
      const t = this.renderTextures.target(out.texture);
      if (!t) return null;
      target = t;
    } else {
      viewport = out.rect;
      // The inset's aspect until the next sync recomputes the camera's own.
      if (v.camera.projection === "orthographic") {
        const s = v.camera.orthographicSize;
        camera.orthoLeft = -s * out.aspect;
        camera.orthoRight = s * out.aspect;
      }
    }
    return {
      camera,
      viewport,
      clear: v.clear ? color4(v.clear) : null,
      backdrop: v.backdrop ? color4(v.backdrop) : undefined,
      effects: v.post.composer,
      toneMapping: v.post.toneMapping,
      exposure: v.post.exposure,
      ui: v.ui === "screen",
      previewUI: v.ui === "preview",
      overlay: v.overlay,
      target,
    };
  }

  /**
   * The frame plan's cameras (ADR 0129): every enabled, synced camera, in component order. Without
   * `full`, backgrounds and post settings are left out (enough to pick the canvas cameras).
   */
  private frameCameras(world: World, full = true): FrameCamera[] {
    const out: FrameCamera[] = [];
    for (const c of world._componentsOfType(Camera)) {
      const entry = c.isActiveAndEnabled ? this.cameras.get(c) : undefined;
      if (!entry) continue;
      const bg = full ? c.backgroundColor : null;
      const p = full ? c.node.getComponent(PostProcessing) : null;
      out.push({
        camera: c,
        depth: c.depth,
        rect: entry.rect,
        target: c.targetTexture,
        background: bg ? rgbOf(bg) : null,
        post: p && p.isActiveAndEnabled ? ({ ...p, enabled: true } as unknown as PostSettings) : null,
        editMode: world.inEditMode(c.node.entity),
      });
    }
    return out;
  }

  /** Editor (ADR 0110): a probe's current capture as a prefiltered `.env` file. */
  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer> {
    return this.probes.bake(probe);
  }

  /** A destroyed Component's drawing goes (ADR 0130: to the feature that owns it). */
  release(c: Component): void {
    if (c instanceof Camera) {
      this.cameras.get(c)?.camera.dispose();
      this.cameras.delete(c);
      return;
    }
    const i = ownerOf(this.specs, c);
    if (i >= 0) this.slots[i].feature?.release?.(c);
  }

  releaseWorld(): void {
    this.owner = null;
    this.lastPlan = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.warmer.dispose();
    this.asyncPipelines?.dispose();
    this.effects.dispose();
    this.report?.dispose();
    this.tools?.dispose();
    this.frame.overlay = null;
    this.overlayLayer?.dispose();
    for (let i = this.slots.length - 1; i >= 0; i--) this.slots[i].dispose(); // reverse registration order (ADR 0130)
    this.quads.dispose(); // after the features that drew with them
    this.frame.ui = null;
    this.frame.previewUI = null;
    this.materials.dispose();
    this.renderTextures.dispose();
    this.frame.dispose();
    this.scene.dispose();
    if (!this.thumbnail) this.engine.dispose(); // a thumbnail's engine is the thumbnail renderer's
  }

  private claim(world: World): void {
    this.owner ??= world;
    if (this.owner !== world) throw new Error(`This render surface draws World "${this.owner.name}"; World "${world.name}" needs its own (ADR 0032).`);
  }

  /** Enabled cameras that draw on the canvas, in depth order (the editor's scene camera in edit mode, ADR 0026), as the frame plan picks them. */
  private viewCameras(world: World): Camera[] {
    return canvasCameras(this.frameCameras(world, false)).map((f) => f.camera);
  }

  // --- Cameras ----------------------------------------------------------------------------------

  private syncCamera(world: World, c: Camera): void {
    let entry = this.cameras.get(c);
    if (!entry) {
      const camera = new TargetCamera(`camera:${c.node.name}`, Vector3.Zero(), this.scene, false);
      camera.rotationQuaternion = new Quaternion();
      entry = { camera, rect: { x: 0, y: 0, width: 1, height: 1 } };
      this.cameras.set(c, entry);
    }
    const { camera } = entry;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const x = clamp(c.viewportPosition.x), y = clamp(c.viewportPosition.y);
    const w = Math.max(0.001, Math.min(clamp(c.viewportSize.x), 1 - x)), h = Math.max(0.001, Math.min(clamp(c.viewportSize.y), 1 - y));
    // Each camera renders into its own texture the size of its rectangle (frameGraph.ts), so its own viewport is the whole texture.
    camera.viewport = new Viewport(0, 0, 1, 1);
    entry.rect = { x, y, width: w, height: h };
    const target = c.targetTexture ? this.renderTextures.target(c.targetTexture) : null;
    // A render texture's own shape (ADR 0109), else the camera's rectangle on the view's pixel grid, as its maths reads it (ADR 0154).
    const aspect = target ? target.width / target.height : c.aspect;
    if (c.projection === "orthographic") {
      camera.mode = BabylonCamera.ORTHOGRAPHIC_CAMERA;
      const s = c._effectiveOrthographicSize(); // a pixel-perfect camera's whole-number zoom (ADR 0108)
      camera.orthoLeft = -s * aspect;
      camera.orthoRight = s * aspect;
      camera.orthoTop = s;
      camera.orthoBottom = -s;
    } else {
      camera.mode = BabylonCamera.PERSPECTIVE_CAMERA;
      camera.fov = (c.fieldOfView * Math.PI) / 180; // vertical, like the engine's
      camera.fovMode = BabylonCamera.FOVMODE_VERTICAL_FIXED;
    }
    camera.minZ = c.near;
    camera.maxZ = c.far;
    const e = c.node.entity;
    Matrix.FromArrayToRef(world.worldMatrix(e) as unknown as ArrayLike<number> as number[], e * 16, tmpMatrix);
    tmpMatrix.decompose(tmpScale, tmpQuat, tmpPos);
    const snap = c._pixelSnap();
    if (snap) {
      // On the view's device-pixel grid (half a pixel off for an odd number of pixels, so pixel centres line up).
      tmpPos.x = snapToGrid(tmpPos.x, snap.unit) + snap.offsetX;
      tmpPos.y = snapToGrid(tmpPos.y, snap.unit) + snap.offsetY;
    }
    camera.position.copyFrom(tmpPos);
    camera.rotationQuaternion!.copyFrom(tmpQuat);
  }

  /** @internal The sprite's size in node units once its texture has loaded. */
  spriteSize(s: SpriteRenderer): [number, number] | null {
    return this.spritesFeature()?.spriteSize(s) ?? null;
  }

  /** @internal Tests: sync just the MeshRenderers (the Meshes plugin's feature, ADR 0130, 0140). */
  syncMeshes(world: World): void {
    this.meshesFeature()?.sync(world, this.syncCtx);
  }

  // --- Thumbnails (ADR 0153) -------------------------------------------------------------------

  /**
   * @internal Asset thumbnails: a renderer that draws a headless World's nodes with the real render
   * features (`plugged`) into a scene of its own on the thumbnail engine, which it doesn't own (disposing
   * it leaves the engine). It runs without the warm-up machinery (no async pipelines, no held first
   * frames, ADR 0080, 0120) and lights with the thumbnails' shared studio room. Only `sync` is used: the
   * thumbnail frames the result and draws the scene with its own camera.
   */
  static forThumbnail(engine: AbstractEngine, settings: ProjectSettings, plugged: readonly PluginFeature[], policy: ThumbnailPolicy): BabylonRenderer {
    return new BabylonRenderer(engine, settings, plugged, policy);
  }

  /** @internal Thumbnails: whether the World's textures, models and environment map had all loaded at the last sync. */
  contentReady(): boolean {
    return this.contentLoaded && this.lighting.environmentReady();
  }

  /** @internal Thumbnails (ADR 0156): whether the scene draws anything: an enabled, visible mesh or a particle system (a disabled plugin's Components give neither). */
  drawsAnything(): boolean {
    return this.scene.meshes.some((m) => m.isEnabled() && m.isVisible && m.getTotalVertices() > 0) || this.scene.particleSystems.length > 0;
  }

  /** @internal Thumbnails (ADR 0156): the world-space box around the content meshes and what features report through `bounds()` (live particles), or null. */
  contentBounds(): { min: number[]; max: number[] } | null {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const add = (x: number, y: number, z: number) => {
      const p = [x, y, z];
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    };
    for (const m of this.contentMeshes()) {
      const { minimum: a, maximum: b } = m.getBoundingInfo().boundingBox;
      const world = m.computeWorldMatrix(true);
      for (const x of [a.x, b.x]) for (const y of [a.y, b.y]) for (const z of [a.z, b.z]) {
        const c = Vector3.TransformCoordinatesFromFloatsToRef(x, y, z, world, tmpPos);
        add(c.x, c.y, c.z);
      }
    }
    for (const slot of this.slots) {
      const b = slot.feature?.bounds?.();
      if (!b) continue;
      add(b.min[0], b.min[1], b.min[2]);
      add(b.max[0], b.max[1], b.max[2]);
    }
    return min[0] > max[0] ? null : { min, max };
  }

  /** @internal Thumbnails: the main view after the last sync (the first canvas camera, ADR 0129) and its Babylon camera, or null. */
  mainView(): { camera: Camera; babylon: TargetCamera } | null {
    const { view, viewCamera } = this.syncCtx;
    return view && viewCamera ? { camera: view, babylon: viewCamera } : null;
  }

  /** @internal Thumbnails: the Babylon meshes the content features drew for the World's MeshRenderers and SpriteRenderers (one each under a `perObject` draw policy). */
  contentMeshes(): AbstractMesh[] {
    const out: AbstractMesh[] = [];
    for (const m of this.meshesFeature()?.editorMeshes() ?? []) if (m.component.isActiveAndEnabled) out.push(...m.meshes);
    for (const s of this.spritesFeature()?.editorSprites() ?? []) if (s.component.isActiveAndEnabled && s.mesh.isEnabled()) out.push(s.mesh);
    return out;
  }

  /** @internal Thumbnails: what a frame does before drawing a view, for a still drawn with `camera` outside the frame graph (the sky box fits it; the sky bakes). */
  beforeStill(camera: TargetCamera): void {
    this.frame.beforeView?.(camera);
    for (const slot of this.slots) slot.feature?.beforeFrame?.();
  }

  // --- Diagnostics (ADR 0128) ------------------------------------------------------------------

  /** The renderer's state as engine facts (the surface adds the quality tier). */
  diagnostics(): Omit<RenderDiagnostics, "started" | "quality"> {
    const world = this.owner;
    const cameras: RenderDiagnostics["cameras"] = [];
    // The last frame's plan (ADR 0129): what drew, not worked out again.
    if (world) {
      for (const v of this.lastPlan) {
        const kind = v.output.kind;
        if (kind === "preview" && !this.cameraPreviewDrawn) continue;
        cameras.push({ camera: v.camera, target: kind === "texture" ? "texture" : kind });
      }
    }
    const post = this.lastPost;
    const features: RenderFeatureDiagnostics = {};
    const out: Omit<RenderDiagnostics, "started" | "quality"> = {
      lighting: this.lighting.state(),
      // Composed only once the frame graph with the composer's passes has built: until then it hasn't drawn.
      post: { composed: !!post?.composed && this.frame.ready, loaded: this.frame.ready, toneMapping: post?.toneMapping ?? "none", effects: post?.effects ?? null, composedCameras: this.frame.ready ? (post?.composedCameras ?? 0) : 0 },
      probes: this.probes.state(this.reflecting),
      renderTextures: this.renderTextures.state(),
      // Babylon counts the draw calls of the frame being drawn and resets at the next frame's start, so between frames this is the last frame's (0 on NullEngine).
      // Programs: the shader effects the engine has compiled and holds (on WebGPU, each makes its pipelines).
      stats: { drawCalls: this.engine._drawCalls?.current ?? 0, triangles: 0, lines: 0, points: 0, geometries: this.scene.geometries.length, textures: this.scene.textures.length, programs: compiledEffects(this.engine) },
      cameras,
      drawn: { meshes: this.meshesFeature()?.drawn() ?? [], sprites: this.spritesFeature()?.drawnNodes() ?? [] },
      features,
    };
    for (const slot of this.slots) {
      const feature = slot.feature;
      if (!feature) continue;
      Object.assign(out, feature.state?.()); // a built-in feature's core part (ADR 0130)
      const own = feature.diagnostics?.(); // any feature's own part, by its name (ADR 0154)
      if (own !== undefined) features[slot.spec.name] = own;
    }
    return out;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}

/** @internal How a thumbnail renderer differs from a World's (ADR 0153). */
export interface ThumbnailPolicy {
  /** The studio room every thumbnail shares (made once by the thumbnail renderer), or null for none. */
  readonly studio: HDRCubeTexture | null;
}

/** A plugin's render feature (ADR 0135): an eager one's factory is loaded before the renderer starts; a lazy one's on first need. */
export interface PluginFeature {
  readonly registration: RenderFeatureRegistration;
  readonly factory: BabylonFeatureFactory | null;
}

/**
 * @internal Load the factories of the registered eager features; one that fails to load is logged and left
 * out. Tests pass them to the constructor. With `world` (thumbnails, ADR 0153), the lazy features that
 * World needs are loaded now too, so they start with the renderer, and the ones it doesn't are left out.
 */
export async function loadPluginFeatures(world?: World): Promise<PluginFeature[]> {
  const loaded = await Promise.all(
    _registeredRenderFeatures().map(async (registration): Promise<PluginFeature | null> => {
      if (registration.spec.lazy && world && !specNeeded(registration.spec, world)) return null;
      if (registration.spec.lazy && !world) return { registration, factory: null };
      try {
        return { registration, factory: (await registration.load()) as BabylonFeatureFactory };
      } catch (err) {
        console.error(`[myco] the render feature "${registration.spec.name}" couldn't load:`, err);
        return null;
      }
    }),
  );
  return loaded.filter((p): p is PluginFeature => p !== null);
}

function pluginSlot(p: PluginFeature, host: BabylonFeatureHost): FeatureSlot[] {
  const { spec } = p.registration;
  if (!p.factory) return [lazyFeature(spec, (cancelled) => p.registration.load().then((f) => (cancelled() ? null : (f as BabylonFeatureFactory)(host))))];
  try {
    return [eagerFeature(spec, p.factory(host))];
  } catch (err) {
    console.error(`[myco] the render feature "${spec.name}" couldn't start:`, err);
    return [];
  }
}
