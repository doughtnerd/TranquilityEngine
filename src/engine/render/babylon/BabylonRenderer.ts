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
 * Game UI (stage 9, ADR 0076): the renderer-neutral `UICore` lays out and routes, `ui.ts` draws it
 * with Babylon GUI (both loaded on demand), and the frame graph draws the screen UI after the game's
 * camera (in the editor, over its overlay).
 */
import "./register";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import { EDITOR_LAYER_MASK, type BabylonEditorContext, type EditorMesh, type EditorSprite } from "./editorContext";
import type { BabylonEditorTools } from "./editorTools";
import type { Component } from "../../core/Component";
import type { ProjectSettings } from "../../core/settings";
import type { World } from "../../core/World";
import type { Color } from "../../core/math";
import { Assets } from "../../scene/Assets";
import { authoredSize, splitSpriteRef } from "../../scene/importSettings";
import type { MaterialInstancing } from "../../scene/material";
import { drawnVariant, materialSlots, meshesIfLoaded, type MaterialSlot, type ModelMesh } from "../../scene/models";
import type { GraphShared } from "./graphMaterial";
import { Camera, Fog, Light, MeshRenderer, ParticleSystem, PostProcessing, ReflectionProbe, SpriteRenderer, Text } from "../components";
import { UICanvas, isUIComponent } from "../../ui/components";
import type { UICore } from "../../ui/UICore";
import type { BabylonUI } from "./ui";
import { Scene as BabylonScene } from "@babylonjs/core/scene.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { BabylonProbes, type ProbeHit } from "./probes";
import { setHeightFog } from "./heightFog";
import { BabylonRenderTextures } from "./renderTextures";
import { BabylonWater } from "./water";
import { WaterSurface } from "../water/WaterSurface";
import type { GameObject } from "../../scene/GameObject";
import type { DrawnMaterial, ParticlePreviewSettings, RenderDiagnostics } from "../RenderSurface";
import type { BabylonParticles } from "./particles";
import { PARTICLE_SCALE } from "../../core/graphics";
import { Graphics } from "../Graphics";
import type { PostSettings } from "../postEffects";
import { canvasCameras, planFrame, type FrameCamera, type PlannedView, type Rgb, type ViewRect } from "../framePlan";
import { GAME_POLICY, type RenderPolicy } from "../renderPolicy";
import type { PostEffects, ToneMappingName } from "../postEffects";
import { BabylonFrame, type CameraView, type ShadowRequest } from "./frameGraph";
import { BabylonSky } from "./sky/BabylonSky";
import { BabylonLighting } from "./lighting";
import { MAX_TILE_QUADS, SPRITE_GRID_INDICES, spriteFrame, spriteMeshData, type SpriteFrame } from "../spriteFrame";
import { BabylonTilemaps } from "./tilemaps";
import { Tilemap } from "../../tilemap/Tilemap";
import { pbr } from "./materials";
import { BabylonMaterialLibrary } from "./materialLibrary";
import { MeshBatches, sameDraw, type DrawKey, type Drawable } from "./meshBatches";
import { SpriteBatcher, type SpriteItem } from "./spriteBatches";
import { pixelCenterOffset, snapToGrid } from "../pixelPerfect";
import { AsyncPipelines, FirstFrames } from "./asyncPipelines";
import { effectClock, PipelineWarmer, VariantReport, WARM_PREFIX, type ParticleSystemLike, type WarmCustom, type WarmItem, type WarmParts } from "./warmUp";
import type { WarmContent, WarmEffect } from "../../scene/warmUp";
import type { QualityTier } from "../../core/graphics";
import { _instantiatedPrefabOf } from "../../scene/SceneLoader";

interface SpriteEntry {
  /** Its own quad and material: the editor's scene view only (picking and outlines); other Worlds batch (ADR 0108). */
  mesh: Mesh | null;
  material: PBRMaterial | null;
  /** What the batcher draws for it (ADR 0108), null while hidden. */
  item: SpriteItem | null;
  spritePath: string | null;
  texture: Texture | null;
  /** The UVs the quad has, as a key ("" for the whole texture). */
  uvKey: string;
  /** The mesh's vertex count (16 for the 9-slice grid; more when tiled). */
  vertexCount: number;
  /** Size in node units (before the node's scale), once the texture has loaded. */
  size: [number, number] | null;
  /** The world matrix the quad is frozen at (Babylon keeps it), or null before the first sync. */
  matrix: Matrix | null;
}

interface MeshEntry {
  /** The renderer's own Babylon meshes (instances, or whole meshes with instancing off); none in a thin batch. */
  meshes: AbstractMesh[];
  /** One per model mesh: where it draws (ADR 0108). */
  drawables: Drawable[];
  /** Drawables that haven't had a matrix yet. */
  pending: boolean[];
  sources: readonly ModelMesh[] | null;
  material: BabylonMaterial | null;
  /** Its meshes' material slots (ADR 0089). */
  slotList: MaterialSlot[];
  /** The world matrix its meshes were last frozen with (null: freeze next sync). */
  matrix: Float32Array | null;
}

interface CameraEntry {
  camera: TargetCamera;
  /** Its rectangle on the canvas, fractions from the bottom-left (ADR 0056). */
  rect: { x: number; y: number; width: number; height: number };
}


const tmpMatrix = new Matrix();
const HEIGHT_FOG_OFF = { on: false, density: 0, base: 0, falloff: 1, color: [1, 1, 1] as [number, number, number] };
const HEIGHT_FOG_SCRATCH = { on: false, density: 0, base: 0, falloff: 1, color: [1, 1, 1] as [number, number, number] };
/** Each renderer mesh's frozen world matrix (Babylon keeps the one it's given), refilled when its node moves. */
const frozenMatrices = new WeakMap<Mesh, Matrix>();
const tmpSpriteA = new Matrix();
const tmpColor = new Color3();
/** The batch a renderer mesh wants this frame, refilled per mesh (ADR 0108). */
const wantedKey: DrawKey = { src: null as unknown as ModelMesh, material: null as unknown as BabylonMaterial, receiveShadows: true, castShadows: true, mode: "auto", applyFog: true };
const tmpSpriteB = new Matrix();
const tmpSpriteC = new Matrix();
const tmpScale = new Vector3();
const tmpQuat = new Quaternion();
const tmpPos = new Vector3();
/** Unit quad facing +Z, centred on the origin: bottom-left, bottom-right, top-right, top-left. */
const SPRITE_GRID_NORMALS = Array.from({ length: 16 }, () => [0, 0, 1]).flat();
const WHOLE_FRAME: SpriteFrame = { uv: null, size: [1, 1], pivot: [0.5, 0.5], border: null, fill: "stretch", pixelsPerUnit: 1, pixelSize: [1, 1], missingSlice: false };

/**
 * @internal Whether a world matrix (16 floats of `source` from `offset`) differs from the one an
 * entry's meshes were last frozen with; if so, it becomes the entry's.
 */
export function matrixChanged(entry: { matrix: Float32Array | null }, source: ArrayLike<number>, offset: number): boolean {
  let m = entry.matrix;
  if (m) {
    let i = 0;
    while (i < 16 && m[i] === source[offset + i]) i++;
    if (i === 16) return false;
  } else {
    m = entry.matrix = new Float32Array(16);
  }
  for (let i = 0; i < 16; i++) m[i] = source[offset + i];
  return true;
}

/** A CSS colour string or 0xRRGGBB number as a Babylon colour (gamma space, for clearing). */
/** World-space UI canvases' planes are named with this (`ui.ts`). */
const CANVAS_PREFIX = "myco.canvas.";

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

function color4(c: Rgb): Color4 {
  return new Color4(c[0], c[1], c[2], 1);
}

/** An engine colour as the frame plan's sRGB triple (as `clearColorOf` reads its hex: 8 bits a channel). */
function rgbOf(c: Color): Rgb {
  const q = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255) / 255;
  return [q(c.r), q(c.g), q(c.b)];
}

function clearColorOf(v: string | number): Color4 {
  if (typeof v === "number") return Color4.FromColor3(Color3.FromInts((v >> 16) & 255, (v >> 8) & 255, v & 255), 1);
  const hex = /^#([0-9a-f]{6})$/i.test(v) ? v : /^#([0-9a-f]{3})$/i.test(v) ? "#" + [...v.slice(1)].map((c) => c + c).join("") : "#000000";
  return Color4.FromColor3(Color3.FromHexString(hex), 1);
}

/** @internal Stage 1 Babylon.js renderer (ADR 0075). */
export class BabylonRenderer {
  readonly scene: Scene;
  private readonly sprites = new Map<SpriteRenderer, SpriteEntry>();
  private readonly meshRenderers = new Map<MeshRenderer, MeshEntry>();
  /** MeshRenderer meshes batched for GPU instancing (ADR 0108). */
  private readonly batches: MeshBatches;
  /** Sprites batched per texture run (ADR 0108); the editor's scene view keeps a mesh per sprite. */
  private readonly spriteBatcher: SpriteBatcher;
  /** A sprite changed since the batcher was last given them. */
  private spritesDirty = true;
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
  private readonly lighting: BabylonLighting;
  /** Tilemap chunks (ADR 0103). */
  private readonly tilemaps: BabylonTilemaps;
  /** Reflection probes (stage 6). */
  private readonly probes: BabylonProbes;
  /** Render texture assets cameras draw into (ADR 0109). */
  private readonly renderTextures: BabylonRenderTextures;
  /** The procedural sky (ADR 0112): drawn, baked and driving the sun when the Environment uses a sky asset. */
  private readonly sky: BabylonSky;
  /** Water surfaces (ADR 0072; stage 6), made the first time a World has one. */
  private water: BabylonWater | null = null;
  /** Meshes drawn with a probe's map last frame, for tests. */
  private reflecting = 0;
  /** The World's fog over the sky this frame (ADR 0071): how much, and its colour (sRGB). */
  private skyFog: { amount: number; color: Color4 } | null = null;
  /** Particle effects (stage 5), loaded the first time a World has a ParticleSystem. */
  private particles: BabylonParticles | null = null;
  private particlesLoading = false;
  /** Editor preview settings set before the particles loaded. */
  private readonly particlePreview: Partial<ParticlePreviewSettings> = {};
  /** What this World's renderer does beyond game rules (ADR 0129); the editor sets it through its viewport handle. */
  private policy: RenderPolicy = { ...GAME_POLICY };
  /** The last frame's plan (ADR 0129), for diagnostics. */
  private lastPlan: PlannedView[] = [];
  private readonly frame: BabylonFrame;
  private shadows: ShadowRequest[] = [];
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
  /** Game UI (stage 9): the layout and routing core and the GUI drawing, loaded the first time a World has a UICanvas or Text. */
  private uiCore: UICore | null = null;
  private uiDraw: BabylonUI | null = null;
  private uiLoading = false;
  /** The UI drawing module loaded for the warm-up (a world canvas's plane) before the World had UI. */
  private uiDrawModule: typeof import("./ui") | null = null;
  private uiDrawLoading: Promise<unknown> | null = null;
  /** The UI modules, once loaded (the camera preview builds its own core and drawing from them). */
  private uiModules: { core: typeof import("../../ui/UICore"); draw: typeof import("./ui") } | null = null;
  /**
   * Editor: the game's screen UI laid out again at the camera preview inset's size and drawn into it,
   * so the preview shows what the game camera's view will (a passive core: no routing or typing).
   */
  private previewUI: { core: UICore; draw: BabylonUI } | null = null;
  /** What reflection probes capture: the scene's meshes minus editor-only ones, refilled each frame. */
  private readonly probeMeshes: AbstractMesh[] = [];

  /** Creates the engine (WebGPU, else the WebGL2 fallback, loaded only then) and the scene. */
  static async create(canvas: HTMLCanvasElement, settings: ProjectSettings): Promise<BabylonRenderer> {
    let engine: AbstractEngine;
    if (await WebGPUEngine.IsSupportedAsync) {
      // The adapter's limits rather than WebGPU's minimums: a material with clustered lights (ADR 0079),
      // cascaded shadows and two-sided lighting passes more than the minimum 16 values between its stages.
      const gpu = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false, setMaximumLimits: true });
      await gpu.initAsync();
      engine = gpu;
    } else {
      const { Engine } = await import("@babylonjs/core/Engines/engine.js");
      engine = new Engine(canvas, true, { adaptToDeviceRatio: false });
    }
    return new BabylonRenderer(engine, settings);
  }

  private constructor(
    readonly engine: AbstractEngine,
    private readonly settings: ProjectSettings,
  ) {
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true; // the engine's convention (ADR 0014)
    scene.autoClear = true;
    this.clearColor = clearColorOf(settings.display.backgroundColor);
    scene.clearColor = this.clearColor;
    this.scene = scene;

    this.lighting = new BabylonLighting(scene);
    this.graphShared.mainLight = this.lighting.mainLight;
    this.frame = new BabylonFrame(scene);
    this.sky = new BabylonSky(scene, this.lighting);
    this.frame.beforeView = (camera) => {
      this.lighting.fitSky(camera);
      this.sky.fit(camera);
    };
    this.probes = new BabylonProbes(scene);
    this.renderTextures = new BabylonRenderTextures(scene);
    this.materials = new BabylonMaterialLibrary(scene, {
      shared: this.graphShared,
      renderTexture: (path) => this.renderTextures.texture(path),
      editorPicking: () => this.spriteMeshes, // with editor tools, picking needs per-object instances
    });
    this.batches = new MeshBatches(scene);
    this.spriteBatcher = new SpriteBatcher(scene);
    this.tilemaps = new BabylonTilemaps({
      scene,
      texture: (path, onLoad) => {
        const t = this.materials.loadedTexture(path);
        if (t) return t;
        this.materials.texture(path).then(onLoad, (err) => this.warnOnce(`tile|${path}`, `failed to load tile texture "${path}": ${(err as Error).message}`));
        return null;
      },
      sortOrder: (layer, order) => this.sortOrder(layer, order),
    });

    // Before the warmer, which asks whether compiles are async. Only while it's busy: everywhere else a
    // missing pipeline is made as Babylon makes it, so what's drawn never skips a frame.
    // A World's first frames (ADR 0120) use it for every draw of the frame graph.
    this.asyncPipelines = AsyncPipelines.install(this.engine, () => (this.warmer?.drawing ?? false) || this.firstFrameDrawing, () => !(this.warmer?.drawing ?? false));
    this.effects = effectClock(this.engine);
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
    for (const e of set.effects) items.push(this.warmEffect(e));
    if (set.worldUI) items.push(this.warmWorldCanvas());
    const done = this.warmer.add(items);
    return performance.now() - this.lastRenderAt < 500 ? done : Promise.resolve();
  }

  /** A particle effect to warm: its draws, built by the particle player (loaded now if it isn't). */
  private warmEffect(effect: WarmEffect): WarmCustom {
    const name = `${WARM_PREFIX}particles:${typeof effect === "string" ? effect : "embedded"}`;
    return {
      key: typeof effect === "string" ? name : `${name}:${JSON.stringify(effect)}`,
      build: (_at, position, camera) => {
        const particles = this.loadParticles();
        const draws = particles?.warmDraws(effect, name, position, () => camera);
        if (!draws) return null; // the player, or a texture or model, is still loading
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

  /** A world-space UI canvas's plane to warm (ADR 0076): the GUI's material on a plane (the UI drawing loads now if it isn't). */
  private warmWorldCanvas(): WarmCustom {
    return {
      key: "worldUI",
      build: (at) => {
        const ui = this.loadUIDraw();
        if (!ui) return null;
        const parts: WarmParts = ui.warmWorldCanvas(this.scene, `${WARM_PREFIX}canvas`, at);
        return parts;
      },
    };
  }

  /** The UI drawing module for the warm-up, or null while it loads (the first call starts loading it). */
  private loadUIDraw(): typeof import("./ui") | null {
    if (this.uiModules) return this.uiModules.draw;
    if (!this.uiDrawLoading) {
      this.uiDrawLoading = import("./ui")
        .then((m) => (this.uiDrawModule = m))
        .catch((err) => console.error("[myco] the UI couldn't load for the warm-up:", err));
    }
    return this.uiDrawModule;
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

  /** The node (and prefab) a renderer's mesh belongs to, for the variant report; null for other meshes. */
  private describeMesh(drawn: AbstractMesh | ParticleSystemLike): { what: string; prefab?: string } | null {
    const of = (node: GameObject, what: string, asset?: string) => {
      let prefab: string | undefined;
      for (let n: GameObject | null = node; n && !prefab; n = n.parent) prefab = _instantiatedPrefabOf(n);
      if (prefab) return { what: `${what} (from ${prefab})`, prefab };
      return asset ? { what, prefab: asset } : { what };
    };
    for (const [r, e] of this.meshRenderers) {
      if (e.meshes.includes(drawn as AbstractMesh) || e.drawables.some((d) => d.source === drawn)) return of(r.node, `"${r.node.name}"`);
    }
    const system = this.particles?.ownerOf(drawn);
    if (system) return of(system.node, `The particle effect of "${system.node.name}"`, system.effect ? system.effect.replace(/^asset:/, "") : undefined);
    if (drawn.name.startsWith(CANVAS_PREFIX)) return { what: `The world-space UI canvas "${drawn.name.slice(CANVAS_PREFIX.length)}"` };
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
      *sprites(): Iterable<EditorSprite> {
        for (const [component, e] of self.sprites) if (e.mesh) yield { component, mesh: e.mesh, size: e.size, order: self.sortOrder(component.sortingLayer, component.orderInLayer) };
      },
      *meshes(): Iterable<EditorMesh> {
        for (const [component, e] of self.meshRenderers) yield { component, meshes: e.meshes };
      },
      texts: () => [], // Text draws from stage 9
      renderer: {
        setClearColor: (color) => this.setClearColor(color),
        cameraPreviewDrawn: () => this.cameraPreviewDrawn,
        spriteSize: (sprite) => this.spriteSize(sprite),
        ui: () => this.uiCore,
        bakeReflectionProbe: (probe) => this.bakeReflectionProbe(probe),
      },
    };
  }

  /** ADR 0129: change some render policy settings (the editor's viewport handle, through the surface). */
  setPolicy(change: Partial<RenderPolicy>): void {
    this.policy = { ...this.policy, ...change };
    this.uiCore?.setInteractive(!this.policy.sceneView);
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

  /** The frame plan's preview input (ADR 0129): the inset from the bottom-left, its aspect ratio, and whether its UI is ready. */
  private previewInput(): { camera: Camera; rect: { x: number; y: number; width: number; height: number }; aspect: number; ui: boolean } | null {
    const p = this.policy.cameraPreview;
    const rect = p ? this.previewRect() : null;
    if (!p || !rect) return null;
    const r = p.frame.getBoundingClientRect();
    const y = Math.min(1, Math.max(0, 1 - rect.top - rect.height));
    return { camera: p.camera, rect: { x: rect.x, y, width: rect.width, height: rect.height }, aspect: r.width / r.height, ui: !!this.previewUI };
  }

  /** Sets the editor background (editor Worlds) and clear colour. */
  setClearColor(color: string | number): void {
    this.clearColor = clearColorOf(color);
  }

  /** The drawing buffer follows the canvas's CSS size times `pixelRatio`. */
  resize(pixelRatio: number): void {
    this.engine.setHardwareScalingLevel(1 / Math.max(0.01, pixelRatio));
    this.engine.resize();
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
    const snap = this.spriteSnap(world);
    for (const s of world._componentsOfType(SpriteRenderer)) this.syncSprite(world, s, snap);
    this.flushSprites();
    this.tilemaps.sync(world);
    this.syncMeshes(world);
    for (const c of world._componentsOfType(Camera)) this.syncCamera(world, c);
    const view = this.viewCameras(world)[0];
    const camera = view ? this.cameras.get(view)!.camera : null;
    this.casters.length = 0;
    for (const [r, e] of this.meshRenderers) if (r.castShadows && r.isActiveAndEnabled) this.casters.push(...e.meshes);
    for (const m of this.batches.thinCasters()) this.casters.push(m);
    this.sky.sync(world); // before the lights: the sky may drive the sun
    this.shadows = this.lighting.syncLights(world, camera);
    this.syncParticles(world);
    this.syncFog(world);
    this.lighting.syncEnvironment(world, view?.far ?? 1000);
    let ready = !this.materials.loading();
    if (ready) for (const m of this.meshRenderers.values()) if (m.sources === null) { ready = false; break; }
    this.contentLoaded = ready;
    this.probeMeshes.length = 0;
    for (const m of this.scene.meshes) if ((m.layerMask & EDITOR_LAYER_MASK) === 0) this.probeMeshes.push(m);
    this.probes.sync(world, this.probeMeshes, ready);
    // Probes capture after the scene loads, after its warm-up: warm their material copies once they exist (ADR 0080).
    const captured = this.probes.textures().length;
    if (captured > this.warmedProbes) void this.warmer.rewarm();
    this.warmedProbes = captured;
    const surfaces = world._componentsOfType(WaterSurface);
    if (surfaces.length || this.water) {
      this.water ??= new BabylonWater(this.scene, (x, y, z) => this.probes.lookup(x, y, z));
      this.water.sync(world, surfaces);
    }
    this.syncUI(world);
    this.tools?.sync(world);
  }

  // --- Game UI (ADR 0069, 0076; stage 9) ----------------------------------------------------------

  /** Load the UI on first use (games without UI never download Yoga or Babylon GUI), then lay out and mirror it. */
  private syncUI(world: World): void {
    if (!this.uiCore || !this.uiDraw) {
      if (this.uiLoading || (!world._componentsOfType(UICanvas).length && !world._componentsOfType(Text).length)) return;
      this.uiLoading = true;
      // The bundled Inter loads before the first layout, so text isn't measured in a fallback font first.
      Promise.all([import("../../ui/UICore"), import("./ui"), import("../../ui/fonts").then((f) => f.loadBundledFont())])
        .then(([core, draw]) => {
          if (this.disposed) return;
          this.uiModules = { core, draw };
          this.uiDraw = new draw.BabylonUI(this.scene, { texture: (ref) => this.materials.texture(ref) });
          this.uiCore = new core.UICore({
            interactive: !this.policy.sceneView, // the editor's scene view: clicks select, they don't press buttons
            host: { viewCamera: () => (this.owner ? (this.viewCameras(this.owner)[0] ?? null) : null), measureText: draw.measureText },
          });
          const screen = this.uiDraw.screen;
          this.frame.ui = () => {
            screen._checkUpdate(null);
            return screen._layerToDispose;
          };
        })
        .catch((err) => console.error("[myco] the UI couldn't start on the Babylon backend:", err))
        .finally(() => (this.uiLoading = false));
      return;
    }
    const canvas = this.engine.getRenderingCanvas();
    const cssW = canvas?.clientWidth || this.settings.display.width, cssH = canvas?.clientHeight || this.settings.display.height;
    const pixelRatio = this.engine.getRenderWidth() / Math.max(1, cssW);
    const core = this.uiCore;
    core.sync(world, cssW, cssH, world.time.unscaledDeltaTime);
    this.uiDraw.sync(world, core, { caretOf: (c) => core.caretOf(c) }, cssW, cssH, pixelRatio);
    this.uiDraw.syncTexts(world, cssW, cssH);
    this.syncPreviewUI(world, cssW, cssH, pixelRatio);
  }

  /** Editor: lay the screen UI out at the camera preview inset's size and draw it there (or drop it when there's no inset). */
  private syncPreviewUI(world: World, cssW: number, cssH: number, pixelRatio: number): void {
    const rect = this.uiModules ? this.previewRect() : null;
    if (!rect) {
      if (this.previewUI) {
        this.frame.previewUI = null;
        this.previewUI.core.dispose();
        this.previewUI.draw.dispose();
        this.previewUI = null;
      }
      return;
    }
    if (!this.previewUI) {
      const { core, draw } = this.uiModules!;
      const ui = {
        core: new core.UICore({ interactive: false, passive: true, host: { measureText: draw.measureText } }),
        draw: new draw.BabylonUI(this.scene, { texture: (ref) => this.materials.texture(ref), screenOnly: true }),
      };
      this.previewUI = ui;
      const screen = ui.draw.screen;
      this.frame.previewUI = () => {
        screen._checkUpdate(null);
        return screen._layerToDispose;
      };
    }
    const { core, draw } = this.previewUI;
    const w = rect.width * cssW, h = rect.height * cssH;
    core.sync(world, w, h, 0);
    draw.sync(world, core, {}, w, h, pixelRatio, { x: rect.x * cssW, y: rect.top * cssH });
    draw.syncTexts(world, w, h);
  }

  /** @internal Tests and the editor: the UI core (layout and routing), once loaded. */
  uiState(): UICore | null {
    return this.uiCore;
  }

  render(world: World): void {
    this.claim(world);
    this.rewarmOnTierChange();
    this.reflecting = 0;
    this.graphShared.time = world.time.time;
    this.graphShared.resolution = [this.engine.getRenderWidth(), this.engine.getRenderHeight()];
    const engine = this.engine;
    engine.beginFrame();
    // ADR 0129: the frame plan decides the views; this only maps them to Babylon cameras and passes.
    const cc = this.clearColor;
    const plan = planFrame({
      cameras: this.frameCameras(world),
      clearColor: [cc.r, cc.g, cc.b],
      skyFog: this.skyFog ? { color: [this.skyFog.color.r, this.skyFog.color.g, this.skyFog.color.b], amount: this.skyFog.amount } : null,
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
    this.sky.bake(); // before the frame graph runs, like probe captures
    if (views.length) this.probes.capture(views[0].camera); // before the frame graph runs
    this.warmer.beforeRender(views[0]?.camera ?? null, this.casters);
    let held = false;
    if (views.length) {
      // A World's first frames (ADR 0120): every missing pipeline compiles asynchronously, and a frame missing a draw is held on the clear colour.
      const first = !!this.asyncPipelines && this.firstFrames.begin(this.frame.ready, performance.now());
      const skipped = this.asyncPipelines?.skippedShown ?? 0;
      this.firstFrameDrawing = first;
      try {
        this.frame.render(views, this.shadows, this.casters, Graphics.tier.antialias === "msaa" ? 4 : 1);
      } finally {
        this.firstFrameDrawing = false;
      }
      // A layout change rebuilds the graph instead of running it: that frame shows the clear colour and doesn't count.
      if (first && this.frame.ready) held = this.firstFrames.end(this.asyncPipelines!.skippedShown > skipped, this.contentLoaded && !this.uiLoading, performance.now());
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

  // --- Particles (ADR 0057, 0060; stage 5) -------------------------------------------------------

  /** Load the particle player on first use (games without particles never download it), then step it. */
  private syncParticles(world: World): void {
    const systems = world._componentsOfType(ParticleSystem);
    if (!this.particles) {
      if (systems.length) this.loadParticles();
      return;
    }
    this.particles.sync(systems, world.time.deltaTime, world.time.unscaledDeltaTime);
  }

  /** The particle player, or null while it loads (the first call starts loading it). */
  private loadParticles(): BabylonParticles | null {
    if (!this.particles && !this.particlesLoading && !this.disposed) {
      this.particlesLoading = true;
      import("./particles")
        .then((m) => {
          if (this.disposed) return;
          this.particles = new m.BabylonParticles({
            scene: this.scene,
            particlePreview: () => this.policy.particlePreview,
            worldMatrix: (c) => {
              const e = c.node.entity;
              return this.owner!.worldMatrix(e).subarray(e * 16, e * 16 + 16);
            },
            texture: (path, sheet) => this.materials.texture(path, sheet ? "sheet" : "color"),
            tierScale: () => PARTICLE_SCALE[Graphics.tier.particles],
            material: (path) => this.materials.material(path), // shared with MeshRenderers; null while missing
            materialCopy: (path, name) => this.materials.copy(path, name), // soft and kernel particles (ADR 0126)
            // 3D physics only; null while the World has none (loaded later by a scene)
            raycast: (ox, oy, oz, dx, dy, dz, maxDistance) => {
              const hit = this.owner?.physics3D?.raycast({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, maxDistance);
              return hit ? { point: [hit.point.x, hit.point.y, hit.point.z], normal: [hit.normal.x, hit.normal.y, hit.normal.z], distance: hit.distance } : null;
            },
          });
          Object.assign(this.particles.preview, this.particlePreview);
        })
        .catch((err) => console.error("[myco] particles couldn't start on the Babylon backend:", err))
        .finally(() => (this.particlesLoading = false));
    }
    return this.particles;
  }

  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void {
    Object.assign(this.particlePreview, preview);
    if (this.particles) Object.assign(this.particles.preview, preview);
  }

  restartParticlePreview(): void {
    this.particles?.restartAll();
  }

  // --- Reflection probes and fog (ADR 0054, 0071; stage 6) ----------------------------------------

  /** The probe a mesh's bounds centre lies in, if any. */
  private probeAt(m: Mesh): ProbeHit | null {
    const centre = m.getBoundingInfo().boundingBox.centerWorld;
    return this.probes.lookup(centre.x, centre.y, centre.z);
  }

  /** Editor (ADR 0110): a probe's current capture as a prefiltered `.env` file. */
  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer> {
    return this.probes.bake(probe);
  }

  /**
   * The World's first enabled Fog sets the scene's distance fog (ADR 0071): linear or exponential
   * squared, like three.js's Fog and FogExp2. Its colour is linear here, since the scene renders in
   * linear HDR. With `affectsSkybox`, the sky dims towards the fog and a plain background lerps to it.
   */
  private syncFog(world: World): void {
    const fog = world._componentsOfType(Fog).find((f) => f.isActiveAndEnabled) ?? null;
    const s = this.scene;
    if (!fog) {
      s.fogMode = BabylonScene.FOGMODE_NONE;
      this.skyFog = null;
      this.lighting.setSkyFog(0);
      setHeightFog(s, HEIGHT_FOG_OFF);
      return;
    }
    const exp = fog.mode === "exponential";
    s.fogMode = fog.mode === "none" ? BabylonScene.FOGMODE_NONE : exp ? BabylonScene.FOGMODE_EXP2 : BabylonScene.FOGMODE_LINEAR;
    s.fogColor.set(fog.color.r, fog.color.g, fog.color.b).toLinearSpaceToRef(s.fogColor); // in place: no colour per frame
    s.fogDensity = Math.max(0, fog.density);
    s.fogStart = Math.max(0, fog.near);
    s.fogEnd = Math.max(s.fogStart + 1e-3, fog.far);
    const amount = fog.affectsSkybox ? Math.min(1, Math.max(0, fog.skyboxFog)) : 0;
    if (amount <= 0) this.skyFog = null;
    else {
      this.skyFog ??= { amount, color: new Color4() };
      this.skyFog.amount = amount;
      this.skyFog.color.set(fog.color.r, fog.color.g, fog.color.b, 1);
    }
    this.lighting.setSkyFog(amount);
    // Height fog (ADR 0110): in the same linear colour as distance fog.
    const hf = HEIGHT_FOG_SCRATCH;
    hf.on = fog.heightFog;
    hf.density = Math.max(0, fog.heightFogDensity);
    hf.base = fog.heightFogBase;
    hf.falloff = Math.max(1e-4, fog.heightFogFalloff);
    hf.color[0] = s.fogColor.r;
    hf.color[1] = s.fogColor.g;
    hf.color[2] = s.fogColor.b;
    setHeightFog(s, hf);
  }

  release(c: Component): void {
    if (this.uiDraw && this.uiCore && isUIComponent(c)) {
      this.uiCore.release(c);
      this.uiDraw.release(c);
      this.previewUI?.core.release(c);
      this.previewUI?.draw.release(c);
      return;
    }
    if (c instanceof SpriteRenderer) {
      const e = this.sprites.get(c);
      if (e) {
        e.mesh?.dispose();
        e.material?.dispose();
        this.sprites.delete(c);
        this.spritesDirty = true;
      }
    } else if (c instanceof MeshRenderer) {
      const e = this.meshRenderers.get(c);
      if (e) {
        for (const d of e.drawables) this.batches.release(d);
        this.meshRenderers.delete(c);
      }
      this.materials.release(c);
    } else if (c instanceof Tilemap) {
      this.tilemaps.release(c);
    } else if (c instanceof WaterSurface) {
      this.water?.release(c);
    } else if (c instanceof ParticleSystem) {
      this.particles?.release(c);
    } else if (c instanceof Light) {
      this.lighting.release(c);
    } else if (c instanceof Text) {
      this.uiDraw?.release(c);
      this.previewUI?.draw.release(c);
    } else if (c instanceof Camera) {
      this.cameras.get(c)?.camera.dispose();
      this.cameras.delete(c);
    }
  }

  releaseWorld(): void {
    this.owner = null;
    this.lastPlan = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.warmer.dispose();
    this.batches.dispose();
    this.spriteBatcher.dispose();
    this.asyncPipelines?.dispose();
    this.effects.dispose();
    this.report?.dispose();
    this.particles?.dispose();
    this.tools?.dispose();
    this.frame.ui = null;
    this.frame.previewUI = null;
    this.uiCore?.dispose();
    this.uiDraw?.dispose();
    this.previewUI?.core.dispose();
    this.previewUI?.draw.dispose();
    this.frame.overlay = null;
    this.overlayLayer?.dispose();
    this.probes.dispose();
    this.materials.dispose();
    this.renderTextures.dispose();
    this.tilemaps.dispose();
    this.sky.dispose();
    this.water?.dispose();
    this.frame.dispose();
    this.scene.dispose();
    this.engine.dispose();
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
    const canvas = this.engine.getRenderingCanvas();
    const cw = canvas?.clientWidth || this.settings.display.width, ch = canvas?.clientHeight || this.settings.display.height;
    const target = c.targetTexture ? this.renderTextures.target(c.targetTexture) : null;
    const aspect = target ? target.width / target.height : (cw * w) / (ch * h); // a render texture's own shape (ADR 0109)
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
    if (c.pixelPerfect && c.projection === "orthographic") {
      // On the screen-pixel grid (half a pixel off for an odd number of pixels, so pixel centres line up).
      const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      const wPx = Math.round(cw * w * dpr), hPx = Math.round(ch * h * dpr);
      const unit = (2 * c._effectiveOrthographicSize()) / Math.max(1, hPx);
      tmpPos.x = snapToGrid(tmpPos.x, unit) + pixelCenterOffset(wPx, unit);
      tmpPos.y = snapToGrid(tmpPos.y, unit) + pixelCenterOffset(hPx, unit);
    }
    camera.position.copyFrom(tmpPos);
    camera.rotationQuaternion!.copyFrom(tmpQuat);
  }

  // --- Sprites (ADR 0014, 0040) -----------------------------------------------------------------

  private sortOrder(layer: string, order: number): number {
    let index = this.settings.render.sortingLayers.indexOf(layer);
    if (index < 0) {
      this.warnOnce(`layer|${layer}`, `unknown sorting layer "${layer}"; add it to project settings render.sortingLayers.`);
      index = 0;
    }
    return index * 10000 + order;
  }

  private syncSprite(world: World, s: SpriteRenderer, snap: number): void {
    let entry = this.sprites.get(s);
    if (!entry) {
      entry = { mesh: null, material: null, item: null, spritePath: null, texture: null, uvKey: "", vertexCount: 16, size: null, matrix: null };
      this.sprites.set(s, entry);
      this.spritesDirty = true;
    }
    const { path: image, slice } = splitSpriteRef(s.sprite);
    if (entry.spritePath !== s.sprite) {
      entry.spritePath = s.sprite;
      const tex = image ? this.materials.loadedTexture(image) : null;
      entry.texture = tex;
      if (tex) tex.hasAlpha = true; // Babylon reads a texture's alpha only when told it has one
      if (entry.material) entry.material.albedoTexture = tex;
      this.spritesDirty = true;
      if (image && !tex) {
        const requested = s.sprite;
        this.materials
          .texture(image)
          .then(() => {
            if (entry!.spritePath === requested) entry!.spritePath = null; // re-resolve next sync
          })
          .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
      }
    }
    // A sidecar rewritten since the texture loaded (the editor's import settings): sample it anew.
    if (entry.texture && image) this.materials.loadedTexture(image);

    const ready = !s.sprite || !!entry.texture;
    const visible = s.isActiveAndEnabled && ready;
    if (!visible) {
      entry.mesh?.setEnabled(false);
      if (entry.item) this.spritesDirty = true;
      entry.item = null;
      return;
    }

    let w = 1, h = 1, px = 0.5, py = 0.5;
    let frame: SpriteFrame | null = null;
    let texSize: { width: number; height: number } | null = null;
    if (entry.texture) {
      const base = entry.texture.getBaseSize();
      const settings = Assets.importSettings(image);
      const [aw, ah] = authoredSize(settings, base.width, base.height); // a build may have shrunk the image (ADR 0119)
      texSize = { width: aw, height: ah };
      frame = spriteFrame(settings, slice, texSize.width, texSize.height, { component: s.pixelsPerUnit, project: this.settings.render.pixelsPerUnit }, s.size);
      [w, h] = frame.size;
      [px, py] = frame.pivot;
      if (frame.missingSlice) this.warnOnce(`slice|${s.sprite}`, `${image} has no slice named "${slice}" (in ${image}.meta.json); drawing the whole image.`);
    } else if (s.size) {
      w = s.size.x;
      h = s.size.y;
    }
    entry.size = entry.texture || s.size ? [w, h] : null;

    // A mesh of its own with editor tools (picking and outlines), or for a 9-sliced or tiled slice
    // (ADR 0115), whose grid the batcher's quads can't draw; plain sprites batch (ADR 0108).
    const own = this.spriteMeshes || !!(frame && (frame.border || frame.fill === "tile"));
    if (own && !entry.mesh) this.makeSpriteMesh(s, entry);
    else if (!own && entry.mesh) {
      entry.mesh.dispose();
      entry.material?.dispose();
      entry.mesh = entry.material = null;
      entry.matrix = null;
    }
    const { mesh, material } = entry;
    if (mesh) {
      mesh.setEnabled(true);
      if (entry.item) this.spritesDirty = true; // drawn by its own mesh now
      entry.item = null;
    }

    const order = this.sortOrder(s.sortingLayer, s.orderInLayer);
    const c = s.color;
    if (material) {
      material.albedoColor.set(c.r, c.g, c.b).toLinearSpaceToRef(material.albedoColor);
      material.alpha = c.a;
      mesh!.alphaIndex = order;
      if (frame && texSize) this.setSpriteGeometry(entry, frame, texSize.width, texSize.height);
    } else {
      const item = (entry.item ??= { texture: null, order, matrix: new Float32Array(16), color: [1, 1, 1, 1], uvRect: [0, 0, 1, 1] });
      // The batch's instance colour multiplies the (white) albedo: linear, like the albedo colour.
      tmpColor.set(c.r, c.g, c.b).toLinearSpaceToRef(tmpColor);
      if (item.color[0] !== tmpColor.r || item.color[1] !== tmpColor.g || item.color[2] !== tmpColor.b || item.color[3] !== c.a || item.order !== order || item.texture !== entry.texture) {
        item.color[0] = tmpColor.r;
        item.color[1] = tmpColor.g;
        item.color[2] = tmpColor.b;
        item.color[3] = c.a;
        item.order = order;
        item.texture = entry.texture;
        this.spritesDirty = true;
      }
      const [u0, v0, u1, v1] = frame?.uv ?? [0, 0, 1, 1];
      const r = item.uvRect;
      if (r[0] !== u0 || r[1] !== v0 || r[2] !== u1 - u0 || r[3] !== v1 - v0) {
        r[0] = u0;
        r[1] = v0;
        r[2] = u1 - u0;
        r[3] = v1 - v0;
        this.spritesDirty = true;
      }
    }

    // Scale the unit quad to size with the pivot at the node's origin (flips mirror about it).
    const e = s.node.entity;
    // Without allocating, and frozen again only when it changed: freezing recomputes the bounds.
    Matrix.TranslationToRef(0.5 - px, 0.5 - py, 0, tmpSpriteA);
    Matrix.ScalingToRef(s.flipX ? -w : w, s.flipY ? -h : h, 1, tmpSpriteB);
    tmpSpriteA.multiplyToRef(tmpSpriteB, tmpSpriteC);
    Matrix.FromArrayToRef(world.worldMatrix(e) as unknown as number[], e * 16, tmpMatrix);
    if (snap > 0) {
      // A pixel-perfect camera's pixel snapping (ADR 0108): the node's position on the texel grid.
      const m = tmpMatrix.m as unknown as number[];
      tmpMatrix.setTranslationFromFloats(snapToGrid(m[12], snap), snapToGrid(m[13], snap), m[14]);
    }
    tmpSpriteC.multiplyToRef(tmpMatrix, tmpSpriteA);
    if (entry.matrix?.equals(tmpSpriteA)) return;
    entry.matrix ??= new Matrix();
    entry.matrix.copyFrom(tmpSpriteA);
    if (mesh) mesh.freezeWorldMatrix(entry.matrix);
    else {
      entry.matrix.copyToArray(entry.item!.matrix);
      this.spritesDirty = true;
    }
  }

  /** A sprite's own quad and material: a 4 × 4 vertex grid, so a slice's 9-slice border can move the inner lines (ADR 0115). */
  private makeSpriteMesh(s: SpriteRenderer, entry: SpriteEntry): void {
    const mesh = new Mesh(`sprite:${s.node.name}`, this.scene);
    const data = new VertexData();
    const grid = spriteMeshData(WHOLE_FRAME, 1, 1);
    data.positions = grid.positions;
    data.normals = SPRITE_GRID_NORMALS;
    data.uvs = grid.uvs;
    data.indices = SPRITE_GRID_INDICES as number[];
    data.applyToMesh(mesh, true);
    const material = pbr(`sprite:${s.node.name}`, this.scene);
    material.unlit = true;
    material.backFaceCulling = false; // flipped sprites mirror their quad
    material.disableDepthWrite = true;
    material.depthFunction = Constants.ALWAYS; // sprites draw in layer order, not by depth (ADR 0014)
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    material.useAlphaFromAlbedoTexture = true;
    material.albedoTexture = entry.texture;
    mesh.material = material;
    mesh.alwaysSelectAsActiveMesh = true;
    entry.mesh = mesh;
    entry.material = material;
    entry.uvKey = "";
    entry.vertexCount = 16;
    entry.matrix = null;
  }

  /** Draw a slice's part of the texture (9-sliced when it has a border), or the whole texture, on the sprite's own mesh. */
  private setSpriteGeometry(entry: SpriteEntry, frame: SpriteFrame, texWidth: number, texHeight: number): void {
    const mesh = entry.mesh;
    if (!mesh) return;
    const key = frame.uv || frame.border || frame.fill === "tile" ? `${frame.uv?.join(",") ?? ""}|${frame.border?.join(",") ?? ""}|${frame.fill}|${frame.size.join(",")}|${frame.pixelsPerUnit}|${texWidth}x${texHeight}` : "";
    if (key === entry.uvKey) return;
    entry.uvKey = key;
    const grid = spriteMeshData(frame, texWidth, texHeight);
    if (grid.tileCapped) this.warnOnce(`tiles|${entry.spritePath}`, `sprite "${entry.spritePath}" would need more than ${MAX_TILE_QUADS} tiles; drawing it stretched. Use a bigger tile or a smaller sprite.`);
    if (grid.indices === SPRITE_GRID_INDICES && entry.vertexCount === 16) {
      mesh.updateVerticesData(VertexBuffer.PositionKind, grid.positions);
      mesh.updateVerticesData(VertexBuffer.UVKind, grid.uvs);
      return;
    }
    // A different vertex count (tiling): replace the buffers and indices.
    const count = grid.positions.length / 3;
    entry.vertexCount = count;
    mesh.setVerticesData(VertexBuffer.PositionKind, grid.positions, true);
    mesh.setVerticesData(VertexBuffer.NormalKind, Array.from({ length: count }, () => [0, 0, 1]).flat());
    mesh.setVerticesData(VertexBuffer.UVKind, grid.uvs, true);
    mesh.setIndices(grid.indices);
  }

  /** After syncing sprites: hand the batcher this frame's sprites when any changed (ADR 0108). */
  private flushSprites(): void {
    if (!this.spritesDirty) return;
    this.spritesDirty = false;
    const items: SpriteItem[] = [];
    for (const e of this.sprites.values()) if (e.item && !e.mesh) items.push(e.item); // sprites with a mesh of their own draw with it
    this.spriteBatcher.update(items);
  }

  /**
   * Whether sprites draw as a mesh each: when the editor asked for this World's viewport (the scene
   * view, editor play mode), whose picking and outlines use them. Games batch plain sprites (ADR 0108, 0129).
   */
  private get spriteMeshes(): boolean {
    return this.policy.drawPolicy === "perObject";
  }

  /** The texel step sprites snap to this frame: a pixel-perfect view camera with pixel snapping, else 0. */
  private spriteSnap(world: World): number {
    // As `viewCameras` picks, without needing the camera synced yet (sprites sync first).
    const view = world._componentsOfType(Camera).filter((c) => c.isActiveAndEnabled && !world.inEditMode(c.node.entity)).sort((a, b) => a.depth - b.depth)[0];
    if (!view || !view.pixelPerfect || !view.pixelSnapping || view.projection !== "orthographic") return 0;
    const ppu = this.settings.render.pixelsPerUnit;
    return ppu > 0 ? 1 / ppu : 0;
  }

  /** @internal The sprite's size in node units once its texture has loaded. */
  spriteSize(s: SpriteRenderer): [number, number] | null {
    if (s.size) return [s.size.x, s.size.y];
    return this.sprites.get(s)?.size ?? null;
  }

  // --- Meshes and materials (ADR 0043, 0044) ----------------------------------------------------

  /** @internal Every MeshRenderer, then the script Material instances no renderer drew any more (ADR 0107). */
  syncMeshes(world: World): void {
    this.materials.beginSync();
    for (const m of world._componentsOfType(MeshRenderer)) this.syncMesh(world, m);
    this.materials.endSync();
    this.batches.flush();
  }

  private syncMesh(world: World, r: MeshRenderer): void {
    let entry = this.meshRenderers.get(r);
    if (!entry) {
      entry = { meshes: [], drawables: [], pending: [], sources: null, material: null, slotList: [], matrix: null };
      this.meshRenderers.set(r, entry);
    }
    const sources = meshesIfLoaded(r.mesh); // null while the model loads
    const same = entry.sources !== null && sources !== null && entry.sources.length === sources.length && entry.sources.every((m, i) => m === sources[i]);
    const slots = same ? entry.slotList : sources ? materialSlots(sources) : [];
    const variant = sources?.length ? drawnVariant(r.mesh, r.variant) : undefined; // ADR 0118
    // Material slots, script Materials and overrides (ADR 0089, 0107, 0049), resolved by the library.
    const drawnBy = this.materials.meshMaterials(r, slots, variant);
    const material = drawnBy.material;
    if (!same) {
      for (const d of entry.drawables) this.batches.release(d);
      entry.drawables = [];
      entry.pending = [];
      entry.sources = sources;
      entry.slotList = slots;
      entry.matrix = null;
    }
    entry.material = material;
    const visible = r.isActiveAndEnabled;
    const e = r.node.entity;
    const world16 = world.worldMatrix(e);
    // Refill the drawables' matrices only when the node moved: freezing recomputes their bounds.
    const moved = visible && (sources?.length ?? 0) > 0 && matrixChanged(entry, world16, e * 16);
    const mode = this.instancingFor(r);
    let changed = !same;
    (sources ?? []).forEach((src, i) => {
      // One material, or a multi-material shared by every renderer with the same slot materials, so they batch (ADR 0108).
      const base = drawnBy.of(src);
      // A reflection probe (ADR 0054) for built-in materials; graph materials keep the scene's environment.
      const probe = visible && this.probes.any && base instanceof PBRMaterial && !this.materials.isGraph(base) ? this.probes.lookup(world16[e * 16 + 12], world16[e * 16 + 13], world16[e * 16 + 14]) : null;
      const drawn = probe ? this.materials.probeCopy(base as PBRMaterial, probe) : base;
      if (probe) this.reflecting++;
      // The batch it draws in (ADR 0108): same geometry, material and shadow settings draw instanced.
      const key = wantedKey;
      key.src = src;
      key.material = drawn;
      key.receiveShadows = r.receiveShadows;
      key.castShadows = r.castShadows;
      key.mode = mode;
      key.applyFog = !this.materials.fogless(base);
      let d = entry!.drawables[i];
      if (!d || !sameDraw(d.draw, key)) {
        if (d) this.batches.release(d);
        d = this.batches.acquire(key, `${r.node.name}:${src.name}`);
        entry!.drawables[i] = d;
        entry!.pending[i] = true;
        changed = true;
      }
      d.setEnabled(visible);
      if (visible && (moved || entry!.pending[i]) && entry!.matrix) {
        Matrix.FromArrayToRef(entry!.matrix as unknown as number[], 0, tmpMatrix);
        d.setMatrix(tmpMatrix);
        entry!.pending[i] = false;
      }
    });
    if (changed) entry.meshes = entry.drawables.flatMap((d) => (d.mesh ? [d.mesh] : []));
  }

  /** How a renderer's meshes batch (ADR 0108): its slot 0 material asset's `instancing`. */
  private instancingFor(r: MeshRenderer): MaterialInstancing {
    return this.materials.instancing(r.materials[0] || r.material);
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
    const meshes = new Map<GameObject, DrawnMaterial[]>();
    for (const [r, e] of this.meshRenderers) {
      const shown = e.drawables.filter((d) => d.enabled);
      if (!shown.length) continue;
      const list = meshes.get(r.node) ?? [];
      for (const d of shown) list.push(drawnMaterial(d.draw.material));
      meshes.set(r.node, list);
    }
    const sprites = new Set<GameObject>();
    for (const [s, e] of this.sprites) if (e.mesh ? e.mesh.isEnabled() : e.item) sprites.add(s.node);
    const post = this.lastPost;
    return {
      lighting: this.lighting.state(),
      sky: this.sky.state(),
      post: { composed: !!post?.composed, loaded: this.frame.ready, toneMapping: post?.toneMapping ?? "none", effects: post?.effects ?? null, composedCameras: post?.composedCameras ?? 0 },
      water: this.water?.state() ?? { surfaces: 0 },
      probes: this.probes.state(this.reflecting),
      renderTextures: this.renderTextures.state(),
      particles: this.particles?.state() ?? null,
      // Babylon counts the draw calls of the frame being drawn and resets at the next frame's start, so between frames this is the last frame's (0 on NullEngine).
      stats: { drawCalls: this.engine._drawCalls?.current ?? 0, triangles: 0, lines: 0, points: 0, geometries: this.scene.geometries.length, textures: this.scene.textures.length, programs: 0 },
      cameras,
      drawn: { meshes: [...meshes].map(([node, materials]) => ({ node, materials })), sprites: [...sprites] },
    };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}

/** A Babylon material in the engine's material terms (diagnostics, ADR 0128). */
function drawnMaterial(m: BabylonMaterial): DrawnMaterial {
  if (m instanceof PBRMaterial) return { unlit: m.unlit, clearcoat: m.clearCoat.isEnabled ? m.clearCoat.intensity : 0, transmission: m.subSurface.isRefractionEnabled ? m.subSurface.refractionIntensity : 0 };
  const lit = m as { unlit?: boolean; disableLighting?: boolean };
  return { unlit: !!(lit.unlit ?? lit.disableLighting), clearcoat: 0, transmission: 0 };
}
