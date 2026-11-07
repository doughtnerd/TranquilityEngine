/**
 * Babylon.js renderer, stage 1 of ADR 0075: the engine (WebGPU, WebGL2 fallback), cameras, meshes
 * (built-in and imported), sprites and material assets. Loaded on demand by `BabylonSurface`, so a
 * page on the three.js backend never downloads Babylon. Internal: game code never sees anything here.
 *
 * The engine node graph is authoritative (ADR 0010): each frame, sync copies world matrices into
 * Babylon objects, which are kept flat (no parenting) with frozen world matrices. The scene is
 * right-handed, +Y up, like the engine (ADR 0014).
 *
 * Lights, shadows and the environment (stage 2) are in `lighting.ts`; the frame graph that draws each
 * frame, with post-processing (stage 3), is in `frameGraph.ts`.
 *
 * Shader graph materials and per-renderer material properties (stage 4) are in `graphMaterial.ts`
 * and `rendererMaterial` below.
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
import type { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
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
import { Assets, sidecarValue } from "../../scene/Assets";
import { splitSpriteRef, type ImportSettings } from "../../scene/importSettings";
import { defaultMaterialSettings, parseMaterial, materialGraphOfJson, type MaterialInstancing, type MaterialSettings } from "../../scene/material";
import { Material as EngineMaterial } from "../Material";
import { materialSlots, meshesIfLoaded, type MaterialSlot, type ModelMesh } from "../../scene/models";
import { isShaderGraphPath, parseShaderGraph, type GraphValue } from "../../scene/shaderGraph";
import { isShaderAssetPath, parseShaderAsset } from "../../scene/shaderAsset";
import { compileShaderAsset, type ShaderAssetSources } from "../shaderGraph/shaderAsset";
import { normalizeAssetPath } from "../../scene/Assets";
import { colorHex } from "../../scene/material";
import { Color as EngineColor, Vector2 as EngineVector2, Vector3 as EngineVector3 } from "../../core/math";
import type { MaterialPropertyValue } from "../components";
import { compileShaderGraph, type CompiledShaderGraph } from "../shaderGraph/compile";
import { MAX_WARM_VARIANTS, resolveKeywords, warmKeywordVariants } from "../../scene/shaderKeywords";
import { createGraphMaterial, type BabylonGraphMaterial, type GraphShared } from "./graphMaterial";
import { Camera, Fog, Light, MeshRenderer, ParticleSystem, PostProcessing, ReflectionProbe, SpriteRenderer, Text } from "../components";
import { UICanvas, isUIComponent } from "../../ui/components";
import type { UICore } from "../../ui/UICore";
import type { BabylonUI } from "./ui";
import { Scene as BabylonScene } from "@babylonjs/core/scene.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { BabylonProbes, type ProbeHit } from "./probes";
import { MycoProbeBlendPlugin } from "./probeBlend";
import { setHeightFog } from "./heightFog";
import { BabylonRenderTextures } from "./renderTextures";
import { isRenderTexturePath } from "../renderTexture";
import { BabylonWater } from "./water";
import { WaterSurface } from "../water/WaterSurface";
import type { GameObject } from "../../scene/GameObject";
import type { ParticlePreviewSettings, ParticleStats } from "../RenderSurface";
import type { BabylonParticles } from "./particles";
import { PARTICLE_SCALE } from "../../core/graphics";
import { Graphics } from "../Graphics";
import { resolvePostEffects, type PostSettings } from "../postEffects";
import type { PostEffects, ToneMappingName } from "../postEffects";
import { BabylonFrame, type CameraView, type ShadowRequest } from "./frameGraph";
import { BabylonSky } from "./sky/BabylonSky";
import { BabylonLighting } from "./lighting";
import { MAX_TILE_QUADS, SPRITE_GRID_INDICES, spriteFrame, spriteMeshData, type SpriteFrame } from "../spriteFrame";
import { BabylonTilemaps } from "./tilemaps";
import { Tilemap } from "../../tilemap/Tilemap";
import { applyBuiltinOverrides, applyBuiltinSettings, linear, meshOf, modelBaseMaterial, modelMaterial, pbr, tiledTexture } from "./materials";
import { MeshBatches, sameDraw, type DrawKey, type Drawable } from "./meshBatches";
import { SpriteBatcher, type SpriteItem } from "./spriteBatches";
import { pixelCenterOffset, snapToGrid } from "../pixelPerfect";
import { AsyncPipelines } from "./asyncPipelines";
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

interface MaterialEntry {
  raw: unknown;
  /** A shader graph material's graph JSON (ADR 0047), so editing the graph rebuilds it. */
  graphRaw?: unknown;
  material: BabylonMaterial | null;
  textures: Texture[];
  graph?: BabylonGraphMaterial;
  /** Sub-graph files the graph uses, with the JSON they had (ADR 0048): a change rebuilds it. */
  deps?: [string, unknown][];
  /** The shader level a graph with Quality Branch nodes was compiled for (ADR 0050). */
  level?: string;
  /** The asset's parsed settings (null: a renderer naming a graph or shader directly), to reset to under script values (ADR 0107). */
  settings: MaterialSettings | null;
}

/** A script Material instance's own Babylon material (ADR 0107). */
interface InstanceMaterial {
  base: BabylonMaterial;
  material: BabylonMaterial;
  graph?: BabylonGraphMaterial;
  version: number;
  /** Drawn this sync; instances no renderer drew are disposed after it. */
  seen: boolean;
}

/** A renderer's own material holding its property overrides (ADR 0049). */
interface RendererMaterial {
  base: BabylonMaterial;
  material: BabylonMaterial;
  graph?: BabylonGraphMaterial;
  version: number;
  /** The base's `stamp` when the overrides were applied: script Material values changed it since (ADR 0107). */
  stamp: number;
}

/** The built-in materials' property names a renderer may override (ADR 0049). */
const BUILTIN_PROPERTIES = new Set([
  "color", "emission", "metalness", "roughness", "texture",
  "clearcoat", "clearcoatRoughness", "sheen", "sheenColor", "sheenRoughness", "transmission", "thickness", "ior",
  "iridescence", "iridescenceIOR", "anisotropy", "anisotropyRotation", "specularIntensity", "specularColor",
]);

/** A script's property value as material-file data: colours as `#rrggbbaa`, vectors as number lists. */
function toGraphValue(v: MaterialPropertyValue): GraphValue {
  if (v instanceof EngineColor) return colorHex(v);
  if (v instanceof EngineVector2) return [v.x, v.y];
  if (v instanceof EngineVector3) return [v.x, v.y, v.z];
  return Array.isArray(v) ? [...v] : (v as number | string);
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
  /** Multi-slot materials by model mesh and slot materials (ADR 0089), shared by renderers that match so they batch. */
  private readonly slotMultis = new WeakMap<object, Map<string, MultiMaterial>>();
  /** Sprites batched per texture run (ADR 0108); the editor's scene view keeps a mesh per sprite. */
  private readonly spriteBatcher: SpriteBatcher;
  /** A sprite changed since the batcher was last given them. */
  private spritesDirty = true;
  private readonly cameras = new Map<Camera, CameraEntry>();
  private readonly textures = new Map<string, Texture>();
  private readonly loading = new Map<string, Promise<Texture>>();
  /** The sidecar each texture's sampling came from (ADR 0040), so a changed sidecar is applied again. */
  private readonly textureMeta = new Map<string, object | undefined>();
  private readonly materialAssets = new Map<string, MaterialEntry>();
  /** Graph materials by their Babylon material, for per-renderer copies. */
  private readonly graphs = new WeakMap<BabylonMaterial, BabylonGraphMaterial>();
  /** Renderers with property overrides, and their own materials (ADR 0049). */
  private readonly rendererMaterials = new Map<MeshRenderer, RendererMaterial>();
  /** The shared script Material version applied to each asset's Babylon material (ADR 0107). */
  private readonly sharedApplied = new WeakMap<BabylonMaterial, number>();
  /** Script Material instances' Babylon materials (ADR 0107). */
  private readonly instanceMaterials = new Map<EngineMaterial, InstanceMaterial>();
  /** Bumped when script values change a Babylon material in place, so renderer copies follow (ADR 0107). */
  private readonly stamps = new WeakMap<BabylonMaterial, number>();
  /** The image each built-in material copy's `texture` override asks for (null: the base's texture). */
  private readonly wantedTextures = new WeakMap<PBRMaterial, string | null>();
  /** Time and drawing-buffer size, read by every graph material. */
  private readonly graphShared: GraphShared = { time: 0, resolution: [1, 1] }; // `mainLight` is the lighting's, set once it exists
  /** Graph textures, sampled raw by graph code: colour ones through sRGB buffers, data ones linear. */
  private readonly graphTextures = new Map<string, Promise<Texture>>();
  /** Babylon materials made from models' own materials. */
  private readonly modelMaterials = new WeakMap<object, BabylonMaterial>();
  private readonly warned = new Set<string>();
  private readonly defaultMaterial: PBRMaterial;
  /** ADR 0080: draws queued meshes once, hidden, so their shader pipelines exist before they're shown. */
  private readonly warmer: PipelineWarmer;
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
  /** Each material's copies reflecting a probe's map (ADR 0054), by the probe's texture and any blend (ADR 0110). */
  private readonly probeMaterials = new WeakMap<BabylonMaterial, Map<string, PBRMaterial>>();
  /** Meshes drawn with a probe's map last frame, for tests. */
  private reflecting = 0;
  /** Materials whose asset opts out of the World's fog (ADR 0071). */
  private readonly noFog = new WeakSet<BabylonMaterial>();
  /** The World's fog over the sky this frame (ADR 0071): how much, and its colour (sRGB). */
  private skyFog: { amount: number; color: Color4 } | null = null;
  /** Particle effects (stage 5), loaded the first time a World has a ParticleSystem. */
  private particles: BabylonParticles | null = null;
  private particlesLoading = false;
  /** Editor preview settings set before the particles loaded. */
  private readonly particlePreview: Partial<ParticlePreviewSettings> = {};
  /** Editor: the selected nodes (the particle preview plays only theirs). */
  private readonly selectedNodes = new Set<GameObject>();
  private readonly frame: BabylonFrame;
  private shadows: ShadowRequest[] = [];
  private readonly casters: AbstractMesh[] = [];
  /** What the last frame's first camera ran, for tests and the editor. */
  private lastPost: { composed: boolean; toneMapping: ToneMappingName; effects: PostEffects | null } | null = null;
  private clearColor: Color4;
  private owner: World | null = null;
  private disposed = false;
  /** Editor helpers (stage 8), loaded on first use; an editor World loads them at once. */
  private tools: BabylonEditorTools | null = null;
  private toolsLoading = false;
  private overlayLayer: UtilityLayerRenderer | null = null;
  /** Editor: the camera drawn into an inset of the canvas (ADR 0022), and the element it fills. */
  private preview: { camera: Camera; frame: HTMLElement } | null = null;
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
  static async create(canvas: HTMLCanvasElement, settings: ProjectSettings, fill = false): Promise<BabylonRenderer> {
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
    return new BabylonRenderer(engine, settings, fill);
  }

  private constructor(
    readonly engine: AbstractEngine,
    private readonly settings: ProjectSettings,
    /** An editor World: its scene view previews the scene camera's effects (ADR 0051). */
    private readonly fill: boolean,
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
    this.batches = new MeshBatches(scene);
    this.spriteBatcher = new SpriteBatcher(scene);
    this.tilemaps = new BabylonTilemaps({
      scene,
      texture: (path, onLoad) => {
        const t = this.textures.get(path);
        if (t) {
          if (this.textureMeta.get(path) !== sidecarValue(path)) this.applySampling(path, t);
          return t;
        }
        this.texture(path).then(onLoad, (err) => this.warnOnce(`tile|${path}`, `failed to load tile texture "${path}": ${(err as Error).message}`));
        return null;
      },
      sortOrder: (layer, order) => this.sortOrder(layer, order),
    });

    this.defaultMaterial = pbr("myco.default", scene);
    this.defaultMaterial.albedoColor = new Color3(1, 1, 1);
    this.defaultMaterial.metallic = 0;
    this.defaultMaterial.roughness = 0.5;
    // Before the warmer, which asks whether compiles are async. Only while it's busy: everywhere else a
    // missing pipeline is made as Babylon makes it, so what's drawn never skips a frame.
    this.asyncPipelines = AsyncPipelines.install(this.engine, () => this.warmer?.drawing ?? false);
    this.effects = effectClock(this.engine);
    this.warmer = new PipelineWarmer({
      scene,
      materialFor: (path) => this.materialAsset(path),
      materialForSource: (src, mesh) => modelMaterial(this.scene, this.modelMaterials, src, mesh) ?? this.defaultMaterial,
      isGraph: (m) => this.graphs.has(m),
      fogless: (m) => this.noFog.has(m),
      instancing: (path) => this.instancingOf(path),
      keywordVariants: (m) => this.keywordVariants(m),
      loadingTextures: () => this.loading.size > 0,
      ...(this.asyncPipelines ? { compiling: () => this.asyncPipelines!.settled() } : {}),
      effectMs: () => this.effects.ms(),
      probeVariants: (base) => this.probes.textures().map((hit) => this.probeMaterial(base, hit)),
    });
    this.warmer.onDrained = () => this.report?.quiet();
    if (fill) this.editorTools();
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

  /** The editor helpers, or null while they load (the first call starts loading them). */
  editorTools(): BabylonEditorTools | null {
    if (this.tools || this.toolsLoading || this.disposed) return this.tools;
    this.toolsLoading = true;
    import("./editorTools")
      .then((m) => {
        if (this.disposed) return;
        // Manual rendering: the frame graph draws it (frameGraph.ts), straight onto the canvas.
        const layer = new UtilityLayerRenderer(this.scene, true, true);
        layer.utilityLayerScene._useCurrentFrameBuffer = true;
        this.overlayLayer = layer;
        this.frame.overlay = layer;
        this.tools = new m.BabylonEditorTools(this.editorContext(layer));
      })
      .catch((err) => console.error("[myco] the Babylon editor helpers couldn't load:", err))
      .finally(() => (this.toolsLoading = false));
    return null;
  }

  /** What the editor helpers read (editorContext.ts). */
  private editorContext(overlay: UtilityLayerRenderer): BabylonEditorContext {
    const self = this;
    return {
      scene: this.scene,
      overlay,
      canvas: this.engine.getRenderingCanvas() as HTMLCanvasElement,
      settings: this.settings,
      editor: this.fill,
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
    };
  }

  /** Editor: draw `camera` into the canvas under `frame` (picture-in-picture), without editor helpers; null stops. */
  setCameraPreview(camera: Camera | null, frame: HTMLElement | null): void {
    this.preview = camera && frame ? { camera, frame } : null;
  }

  /**
   * The camera preview inset as fractions of the canvas (x and width from the left, top and height from
   * the top), or null when there's none to draw.
   */
  private previewRect(): { x: number; top: number; width: number; height: number } | null {
    const p = this.preview;
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

  /** The camera preview's part of the frame, or null. Its projection takes the inset's aspect ratio until the next sync. */
  private previewView(views: CameraView[]): CameraView | null {
    const p = this.preview;
    const entry = p ? this.cameras.get(p.camera) : undefined;
    const rect = this.previewRect();
    if (!p || !entry || !rect || views.some((v) => v.camera === entry.camera)) return null;
    const r = p.frame.getBoundingClientRect();
    const { x, width: w, height: h } = rect;
    const y = Math.min(1, Math.max(0, 1 - rect.top - h));
    const camera = entry.camera;
    camera.layerMask = 0x0fffffff; // no editor-only meshes
    if (p.camera.projection === "orthographic") {
      const s = p.camera.orthographicSize, aspect = r.width / r.height;
      camera.orthoLeft = -s * aspect;
      camera.orthoRight = s * aspect;
    }
    const resolved = resolvePostEffects(this.postSettings(p.camera), Graphics.tier);
    const bg = p.camera.backgroundColor;
    return { camera, viewport: { x, y, width: w, height: h }, clear: bg ? clearColorOf(bg.toHex().slice(0, 7)) : this.clearColor, effects: resolved.composer, toneMapping: resolved.toneMapping, exposure: resolved.exposure, previewUI: !!this.previewUI };
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
        this.texture(p)
          .catch((err) => console.error(`[myco] failed to load texture "${p}":`, err))
          .finally(() => onProgress?.(++done / paths.length)),
      ),
    );
  }

  /**
   * A texture asset, loaded flipped (V 1 is the image's top) unless `sheet`: Babylon's particle sprite
   * sheets read cells with V 0 at the image's top, so a flipbook's texture is loaded unflipped (a copy
   * of its own, cached apart).
   */
  private texture(path: string, sheet = false): Promise<Texture> {
    const key = sheet ? `${path}#sheet` : path;
    const cached = this.textures.get(key);
    if (cached) return Promise.resolve(cached);
    if (isRenderTexturePath(path)) {
      // A render texture asset (ADR 0109): the texture a camera draws into, shared by everything naming it.
      const rt = this.renderTextures.texture(path);
      if (!rt) return Promise.reject(new Error(`render texture "${path}" isn't in the project`));
      this.textures.set(key, rt);
      this.textureMeta.set(path, sidecarValue(path)); // sampled from the asset's own settings, not a sidecar
      return Promise.resolve(rt);
    }
    let p = this.loading.get(key);
    if (!p) {
      p = new Promise<Texture>((resolve, reject) => {
        const settings: ImportSettings = Assets.importSettings(path);
        let url: string;
        try {
          url = Assets.url(path);
        } catch (err) {
          reject(err);
          return;
        }
        const tex = new Texture(url, this.scene, {
          noMipmap: !settings.mipmaps,
          invertY: !sheet,
          samplingMode: this.samplingMode(settings),
          onLoad: () => {
            this.applySampling(path, tex);
            this.textures.set(key, tex);
            this.loading.delete(key);
            resolve(tex);
          },
          onError: (message) => {
            this.loading.delete(key);
            reject(new Error(message ?? `couldn't load ${path}`));
          },
        });
      });
      this.loading.set(key, p);
    }
    return p;
  }

  private samplingMode(settings: ImportSettings): number {
    const point = settings.filter === "point";
    if (!settings.mipmaps) return point ? Texture.NEAREST_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE;
    return point ? Texture.NEAREST_NEAREST_MIPNEAREST : Texture.TRILINEAR_SAMPLINGMODE;
  }

  /** Filtering and wrapping from the image's import settings (ADR 0040). */
  private applySampling(path: string, tex: Texture): void {
    this.textureMeta.set(path, sidecarValue(path));
    const settings = Assets.importSettings(path);
    tex.updateSamplingMode(this.samplingMode(settings));
    const wrap = settings.wrap === "repeat" ? Texture.WRAP_ADDRESSMODE : settings.wrap === "mirror" ? Texture.MIRROR_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
    tex.wrapU = wrap;
    tex.wrapV = wrap;
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
    let ready = this.loading.size === 0;
    if (ready) for (const m of this.meshRenderers.values()) if (m.sources === null) { ready = false; break; }
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
          this.uiDraw = new draw.BabylonUI(this.scene, { texture: (ref) => this.texture(ref) });
          this.uiCore = new core.UICore({
            interactive: !this.fill, // the editor's own World: clicks select, they don't press buttons
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
    const rect = this.fill && this.uiModules ? this.previewRect() : null;
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
        draw: new draw.BabylonUI(this.scene, { texture: (ref) => this.texture(ref), screenOnly: true }),
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
    const cams = this.viewCameras(world);
    const engine = this.engine;
    engine.beginFrame();
    const views: CameraView[] = cams.map((c, i) => {
      // Post-processing (ADR 0051, 0056): each camera's own component, filtered by the tier; the editor's view previews the scene camera's.
      const resolved = resolvePostEffects(this.postSettings(c) ?? (i === 0 && this.fill ? this.scenePostSettings(world) : null), Graphics.tier);
      let background = c.backgroundColor ? clearColorOf(c.backgroundColor.toHex().slice(0, 7)) : this.clearColor;
      if (this.skyFog) background = Color4.Lerp(background, this.skyFog.color, this.skyFog.amount); // Fog's affectsSkybox (ADR 0071)
      const entry = this.cameras.get(c)!;
      entry.camera.layerMask = this.fill ? 0xffffffff : 0x0fffffff; // an editor World's view sees the grid
      // The game's screen UI goes over the editor's view (and its overlay), else over the last camera.
      // The editor's own view (it previews the scene camera's effects, having none of its own) shows the
      // editor background as set, not tone mapped with the scene (ADR 0111).
      const backdrop = this.fill && i === 0 && !c.backgroundColor && !this.postSettings(c) ? background : undefined;
      return { ui: this.tools ? i === 0 : i === cams.length - 1, overlay: i === 0 && !!this.tools, camera: entry.camera, viewport: entry.rect, clear: i === 0 || c.backgroundColor ? background : null, effects: resolved.composer, toneMapping: resolved.toneMapping, exposure: resolved.exposure, backdrop };
    });
    this.lastPost = views[0] ? { composed: !!views[0].effects, toneMapping: views[0].toneMapping, effects: views[0].effects } : null;
    // Cameras drawing into render textures (ADR 0109), after the canvas's: what samples their texture shows the last frame.
    for (const c of this.targetCameras(world)) {
      const target = this.renderTextures.target(c.targetTexture);
      if (!target) continue;
      const resolved = resolvePostEffects(this.postSettings(c), Graphics.tier);
      let background = c.backgroundColor ? clearColorOf(c.backgroundColor.toHex().slice(0, 7)) : this.clearColor;
      if (this.skyFog) background = Color4.Lerp(background, this.skyFog.color, this.skyFog.amount);
      const entry = this.cameras.get(c)!;
      entry.camera.layerMask = 0x0fffffff; // no editor-only meshes
      views.push({ camera: entry.camera, viewport: { x: 0, y: 0, width: 1, height: 1 }, clear: background, effects: resolved.composer, toneMapping: resolved.toneMapping, exposure: resolved.exposure, target });
    }
    const preview = views.length ? this.previewView(views) : null;
    if (preview) views.push(preview);
    this.cameraPreviewDrawn = !!preview && this.frame.ready;
    this.sky.bake(); // before the frame graph runs, like probe captures
    if (views.length) this.probes.capture(views[0].camera); // before the frame graph runs
    this.warmer.beforeRender(views[0]?.camera ?? null, this.casters);
    if (views.length) this.frame.render(views, this.shadows, this.casters, Graphics.tier.antialias === "msaa" ? 4 : 1);
    if (!views.length || !this.frame.ready) engine.clear(this.clearColor, true, true, true);
    engine.endFrame();
    if (views.length && this.frame.ready) {
      this.warmer.afterRender();
      this.report?.afterRender();
      this.lastRenderAt = performance.now();
    }
  }

  /** A camera's PostProcessing component, if it has an enabled one. */
  private postSettings(c: Camera): PostSettings | null {
    const p = c.node.getComponent(PostProcessing);
    return p && p.isActiveAndEnabled ? ({ ...p, enabled: true } as unknown as PostSettings) : null;
  }

  /** Editor: the scene view previews the first camera with a PostProcessing component, minus depth of field. */
  private scenePostSettings(world: World): PostSettings | null {
    for (const p of world._componentsOfType(PostProcessing)) {
      if (p.isActiveAndEnabled && p.node.getComponent(Camera)) return { ...(p as unknown as PostSettings), enabled: true, depthOfField: false };
    }
    return null;
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
            editor: this.fill,
            worldMatrix: (c) => {
              const e = c.node.entity;
              return this.owner!.worldMatrix(e).subarray(e * 16, e * 16 + 16);
            },
            selected: (c) => this.selectedNodes.has(c.node),
            texture: (path, sheet) => this.texture(path, sheet),
            tierScale: () => PARTICLE_SCALE[Graphics.tier.particles],
            material: (path) => this.materialAsset(path), // shared with MeshRenderers; null while missing
            materialCopy: (path, name) => this.particleMaterialCopy(path, name), // soft and kernel particles (ADR 0126)
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

  /** Editor: the selected nodes, for the particle preview. */
  setSelected(nodes: readonly GameObject[]): void {
    this.selectedNodes.clear();
    for (const n of nodes) this.selectedNodes.add(n);
  }

  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void {
    Object.assign(this.particlePreview, preview);
    if (this.particles) Object.assign(this.particles.preview, preview);
  }

  restartParticlePreview(): void {
    this.particles?.restartAll();
  }

  particleState(): ParticleStats | null {
    return this.particles?.state() ?? null;
  }

  // --- Reflection probes and fog (ADR 0054, 0071; stage 6) ----------------------------------------

  /** The probe a mesh's bounds centre lies in, if any. */
  private probeAt(m: Mesh): ProbeHit | null {
    const centre = m.getBoundingInfo().boundingBox.centerWorld;
    return this.probes.lookup(centre.x, centre.y, centre.z);
  }

  /**
   * A copy of a material reflecting a probe's map, made once per material, probe, and blend (a
   * neighbour's map and the primary's share, rounded to `BLEND_STEPS`; ADR 0110).
   */
  private probeMaterial(base: PBRMaterial, hit: ProbeHit): PBRMaterial {
    let byProbe = this.probeMaterials.get(base);
    if (!byProbe) {
      byProbe = new Map();
      this.probeMaterials.set(base, byProbe);
    }
    const b = hit.blend;
    const key = b ? `${hit.texture.uniqueId}|${b.texture.uniqueId}|${b.weight}` : `${hit.texture.uniqueId}`;
    let m = byProbe.get(key);
    if (!m) {
      m = base.clone(`${base.name}:probe`);
      m.reflectionTexture = hit.texture;
      if (b) new MycoProbeBlendPlugin(m, { texture: b.texture, weight: b.weight, intensityRatio: 1, box: null });
      byProbe.set(key, m);
      if (this.noFog.has(base)) this.noFog.add(m);
    }
    m.environmentIntensity = hit.intensity;
    if (b) {
      const plugin = m.pluginManager?.getPlugin<MycoProbeBlendPlugin>("MycoProbeBlend");
      if (plugin) {
        plugin.state.intensityRatio = hit.intensity > 0 ? b.intensity / hit.intensity : 0;
        plugin.state.box = b.box;
      }
    }
    return m;
  }

  /** Tests: how many water surfaces are drawn. */
  waterState(): { surfaces: number } {
    return this.water?.state() ?? { surfaces: 0 };
  }

  /** Editor (ADR 0110): a probe's current capture as a prefiltered `.env` file. */
  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer> {
    return this.probes.bake(probe);
  }

  /** Tests: probes captured, probes, and meshes reflecting one. */
  probeState(): { captured: number; probes: number; reflecting: number } {
    return this.probes.state(this.reflecting);
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

  /** Tests and the editor: what the last frame's first camera ran. */
  postState(): { composed: boolean; loaded: boolean; toneMapping: ToneMappingName; effects: PostEffects | null } {
    return { composed: !!this.lastPost?.composed, loaded: this.frame.ready, toneMapping: this.lastPost?.toneMapping ?? "none", effects: this.lastPost?.effects ?? null };
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
      this.releaseRendererMaterial(c);
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

  /** Enabled cameras that draw the view, in depth order (the editor's scene camera in edit mode, ADR 0026). */
  private viewCameras(world: World): Camera[] {
    return world
      ._componentsOfType(Camera)
      .filter((c) => c.isActiveAndEnabled && !c.targetTexture && this.cameras.has(c) && !world.inEditMode(c.node.entity))
      .sort((a, b) => a.depth - b.depth);
  }

  /**
   * Enabled cameras drawing into render textures (ADR 0109), in depth order. Drawn in the editor's edit
   * mode too, so materials showing their texture look in the scene view as they will in the game.
   */
  private targetCameras(world: World): Camera[] {
    return world
      ._componentsOfType(Camera)
      .filter((c) => c.isActiveAndEnabled && !!c.targetTexture && this.cameras.has(c))
      .sort((a, b) => a.depth - b.depth);
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
      const tex = image ? (this.textures.get(image) ?? null) : null;
      entry.texture = tex;
      if (tex) tex.hasAlpha = true; // Babylon reads a texture's alpha only when told it has one
      if (entry.material) entry.material.albedoTexture = tex;
      this.spritesDirty = true;
      if (image && !tex) {
        const requested = s.sprite;
        this.texture(image)
          .then(() => {
            if (entry!.spritePath === requested) entry!.spritePath = null; // re-resolve next sync
          })
          .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
      }
    }
    // A sidecar rewritten since the texture loaded (the editor's import settings): sample it anew.
    if (entry.texture && image && this.textureMeta.get(image) !== sidecarValue(image)) this.applySampling(image, entry.texture);

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
      texSize = entry.texture.getBaseSize();
      frame = spriteFrame(Assets.importSettings(image), slice, texSize.width, texSize.height, { component: s.pixelsPerUnit, project: this.settings.render.pixelsPerUnit }, s.size);
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
   * Whether sprites draw as a mesh each: with editor tools (the scene view, editor play mode), whose
   * picking and outlines use them. Games batch plain sprites (ADR 0108).
   */
  private get spriteMeshes(): boolean {
    return this.fill || this.tools !== null || this.toolsLoading;
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
    for (const e of this.instanceMaterials.values()) e.seen = false;
    for (const m of world._componentsOfType(MeshRenderer)) this.syncMesh(world, m);
    for (const [m, e] of this.instanceMaterials) if (!e.seen) this.disposeInstance(m);
    this.batches.flush();
  }

  private syncMesh(world: World, r: MeshRenderer): void {
    let entry = this.meshRenderers.get(r);
    if (!entry) {
      entry = { meshes: [], drawables: [], pending: [], sources: null, material: null, slotList: [], matrix: null };
      this.meshRenderers.set(r, entry);
    }
    const sources = meshesIfLoaded(r.mesh); // null while the model loads
    // Material slots (ADR 0089, 0107): a slot with its own `materials[i]` draws it (its script Material's
    // copy, or the asset with shared values); the others draw the renderer-wide `material` (slot 0's
    // script instance when slot 0 has no entry of its own, with 0049's overrides), then the model's
    // import settings, then the model's own material.
    const slot0 = r.materials[0] ? null : r._drawMaterial(0);
    const material = this.rendererMaterial(r, slot0?.isInstance ? this.instanceMaterial(slot0) : this.materialAsset(r.material));
    const same = entry.sources !== null && sources !== null && entry.sources.length === sources.length && entry.sources.every((m, i) => m === sources[i]);
    const slots = same ? entry.slotList : sources ? materialSlots(sources) : [];
    const remap = sources && slots.length ? this.sidecarMaterials(r.mesh) : null;
    const bySurface = new Map(slots.map((slot, i) => [slot.surface, (r.materials[i] ? this.drawnMaterial(r, i) : null) ?? material ?? (remap?.[slot.surface.name] ? this.materialAsset(remap[slot.surface.name]) : null)]));
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
      const base = modelBaseMaterial(this.scene, this.modelMaterials, src, (surface) => bySurface.get(surface) ?? null, this.slotMultis) ?? this.defaultMaterial;
      // A reflection probe (ADR 0054) for built-in materials; graph materials keep the scene's environment.
      const probe = visible && this.probes.any && base instanceof PBRMaterial && !this.graphs.has(base) ? this.probes.lookup(world16[e * 16 + 12], world16[e * 16 + 13], world16[e * 16 + 14]) : null;
      const drawn = probe ? this.probeMaterial(base as PBRMaterial, probe) : base;
      if (probe) this.reflecting++;
      // The batch it draws in (ADR 0108): same geometry, material and shadow settings draw instanced.
      const key = wantedKey;
      key.src = src;
      key.material = drawn;
      key.receiveShadows = r.receiveShadows;
      key.castShadows = r.castShadows;
      key.mode = mode;
      key.applyFog = !this.noFog.has(base);
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
    return this.instancingOf(r.materials[0] || r.material);
  }

  /** A material asset's `instancing` ("auto" without one); with editor tools (scene view, play mode) thin batches draw as instances, for picking. */
  private instancingOf(path: string | null): MaterialInstancing {
    const mode = (path && this.materialAssets.get(path)?.settings?.instancing) || "auto";
    return mode === "thin" && this.spriteMeshes ? "auto" : mode; // with editor tools, picking needs per-object instances
  }

  /**
   * Warm-up's extra copies of a graph or shader-asset material (ADR 0106): one per combination of its
   * `"variants": "all"` keywords beyond the one it draws, sharing its compiled program, so a script's
   * keyword switch finds its variant compiled. At most 16 per material.
   */
  private keywordVariants(m: BabylonMaterial): { material: BabylonMaterial; dispose(): void }[] {
    const g = this.graphs.get(m);
    if (!g || !g.compiled.keywords?.some((k) => k.variants === "all")) return [];
    const { variants, capped } = warmKeywordVariants(g.compiled.keywords, g.keywords);
    if (capped) this.warnOnce(`warm-cap|${m.name}`, `${m.name}: its "variants": "all" keywords make more than ${MAX_WARM_VARIANTS} combinations; warm-up compiles the first ${MAX_WARM_VARIANTS}.`);
    return variants.slice(1).map((kw) => {
      const copy = createGraphMaterial(this.scene, `${WARM_PREFIX}${m.name}:variant`, g.compiled, { ...g.properties }, this.graphShared, (p, linear) => this.graphTexture(p, linear));
      copy.setKeywords(kw);
      if (this.noFog.has(m)) this.noFog.add(copy.material);
      return { material: copy.material, dispose: () => copy.dispose() };
    });
  }

  /** A model's import settings' material assets by material name (ADR 0089), or null for a built-in mesh or none. */
  private sidecarMaterials(ref: string): Readonly<Record<string, string>> | null {
    if (!ref || ref.startsWith("builtin:")) return null;
    try {
      const path = splitSpriteRef(ref.replace(/^asset:/, "")).path;
      const materials = Assets.importSettings(path).materials;
      return Object.keys(materials).length ? materials : null;
    } catch {
      return null;
    }
  }

  /**
   * The Babylon material for a material asset, or null for none (empty, missing, or not a material:
   * warned once). Rebuilt when the asset's JSON changes (the editor's Material inspector).
   */
  /**
   * An unshared copy of a material asset for particle draws that change it (ADR 0126: a soft fade, kernel
   * placement): a shader graph's is a new graph material with the asset's properties and keywords (Babylon
   * can't clone graph plugins), others a clone. Null when the asset isn't there.
   */
  private particleMaterialCopy(path: string, name: string): { material: BabylonMaterial; dispose(): void } | null {
    const base = this.materialAsset(path);
    if (!base) return null;
    const g = this.graphs.get(base);
    if (g) {
      const made = createGraphMaterial(this.scene, name, g.compiled, { ...g.properties }, this.graphShared, (p, linear) => this.graphTexture(p, linear));
      made.setKeywords(g.keywords);
      return { material: made.material, dispose: () => made.dispose() };
    }
    const copy = base.clone(name);
    return copy ? { material: copy, dispose: () => copy.dispose(false, false) } : null;
  }

  private materialAsset(path: string): BabylonMaterial | null {
    const m = this.materialAssetBase(path);
    // The asset's shared script Material (ADR 0107), applied in place: every user of the asset follows.
    const shared = m && path ? EngineMaterial._sharedIfAny(path) : undefined;
    if (m && shared) this.applyShared(path, m, shared);
    return m;
  }

  private materialAssetBase(path: string): BabylonMaterial | null {
    if (!path) return null;
    const read = (p: string): unknown => {
      try {
        if (!Assets.has(p)) return undefined;
        const v = Assets.get(p); // text files (a Custom Function's .wgsl) read as strings, compared by value
        return typeof v === "string" ? v : Assets.json(p);
      } catch {
        return undefined;
      }
    };
    const raw = read(path);
    // A material naming a shader graph, or a renderer naming the graph itself, depends on the graph's JSON too.
    let graphPath: string | null = isShaderGraphPath(path) || isShaderAssetPath(path) ? path : null;
    if (!graphPath && raw !== undefined) graphPath = materialGraphOfJson(raw);
    const graphRaw = graphPath ? read(graphPath) : undefined;
    const cached = this.materialAssets.get(path);
    const levelOk = !cached?.level || cached.level === Graphics.tier.shaderLevel; // Quality Branch nodes (ADR 0050)
    if (cached && levelOk && cached.raw === raw && cached.graphRaw === graphRaw && (cached.deps ?? []).every(([p, v]) => read(p) === v)) return cached.material;
    if (cached?.graph) cached.graph.dispose();
    else cached?.material?.dispose();
    for (const t of cached?.textures ?? []) t.dispose();
    let material: BabylonMaterial | null = null;
    let graph: BabylonGraphMaterial | undefined;
    let assetSettings: MaterialSettings | null = null;
    const owned: Texture[] = [];
    const where = path.replace(/^asset:/, "");
    if (raw === undefined) {
      this.warnOnce(`missing|${path}`, `material "${where}" isn't in the project; using the default material.`);
    } else if (graphPath) {
      try {
        const settings = graphPath === path ? null : parseMaterial(raw, where).settings;
        assetSettings = settings;
        if (graphRaw === undefined) throw new Error(`${isShaderAssetPath(graphPath) ? "shader" : "shader graph"} "${graphPath.replace(/^asset:/, "")}" isn't in the project.`);
        graph = this.graphMaterial(graphRaw, graphPath.replace(/^asset:/, ""), settings?.properties ?? {}, isShaderAssetPath(graphPath) ? read : undefined);
        // Keyword values (ADR 0106): unknown names and values are warned once.
        const kw = settings?.keywords ?? {};
        resolveKeywords(graph.compiled.keywords, kw, (m) => this.warnOnce(`${path}|kw|${m}`, `${where}: ${m}`));
        graph.setKeywords(kw);
        material = graph.material;
      } catch (err) {
        const message = `${where}: ${(err as Error).message} Using the default material.`;
        this.warnOnce(message, message);
      }
    } else {
      try {
        const { settings, problems } = parseMaterial(raw, where);
        for (const p of problems) this.warnOnce(`${path}|${p}`, p);
        assetSettings = settings;
        material = this.builtinMaterial(path, settings, owned);
      } catch (err) {
        this.warnOnce(`bad|${path}`, `${(err as Error).message} Using the default material.`);
      }
    }
    const deps = graph?.compiled.dependencies.map((p): [string, unknown] => [p, read(p)]);
    const level = graph?.compiled.usesShaderLevel ? Graphics.tier.shaderLevel : undefined;
    if (material && raw !== undefined) {
      try {
        if (!parseMaterial(raw).settings.fog) this.noFog.add(material); // a material can opt out of the World's Fog (ADR 0071)
      } catch {
        /* warned above */
      }
    }
    this.materialAssets.set(path, { raw, graphRaw, material, textures: owned, graph, deps, level, settings: assetSettings });
    return material;
  }

  // --- Script materials (ADR 0107) ----------------------------------------------------------------

  /** A script Material's values as material-file data. */
  private static scriptValues(m: EngineMaterial): Record<string, GraphValue> {
    const values: Record<string, GraphValue> = {};
    for (const [k, v] of m._values) values[k] = toGraphValue(v);
    return values;
  }

  private bump(m: BabylonMaterial): void {
    this.stamps.set(m, (this.stamps.get(m) ?? 0) + 1);
  }

  /**
   * Apply a script Material's values and keywords to a Babylon material built from `path`, in place:
   * graph and shader-asset materials take them over the asset's properties and keywords (uniforms, or a
   * keyword variant); built-in materials reset to the asset's settings, then take the values.
   */
  private applyValues(path: string, target: BabylonMaterial, m: EngineMaterial, graph: BabylonGraphMaterial | undefined): void {
    const entry = path ? this.materialAssets.get(path) : undefined;
    const settings = entry?.settings ?? (path ? null : defaultMaterialSettings());
    const values = BabylonRenderer.scriptValues(m);
    const keywords = Object.fromEntries(m._keywords);
    const what = path ? path.replace(/^asset:/, "") : "the default material";
    if (graph) {
      graph.setProperties({ ...(settings?.properties ?? {}), ...values });
      resolveKeywords(graph.compiled.keywords, keywords, (msg) => this.warnOnce(`${path}|script-kw|${msg}`, `${what}: ${msg}`));
      graph.setKeywords({ ...(settings?.keywords ?? {}), ...keywords });
      const known = new Set(graph.compiled.uniforms.flatMap((u) => (u.property ? [u.property] : [])));
      for (const k of Object.keys(values)) if (!known.has(k)) this.warnOnce(`${path}|script-prop|${k}`, `${what} has no property "${k}"; the Material's value is ignored.`);
    } else if (target instanceof PBRMaterial && settings) {
      target.alpha = 1; // applyBuiltinSettings only sets these for see-through colours
      target.transparencyMode = null;
      applyBuiltinSettings(target, settings);
      applyBuiltinOverrides(target, target, values);
      if (typeof values.texture === "string") this.overrideTexture(target, target, values);
      for (const k of Object.keys(values)) if (!BUILTIN_PROPERTIES.has(k)) this.warnOnce(`${path}|script-prop|${k}`, `${what} has no property "${k}"; the Material's value is ignored.`);
      if (m._keywords.size) this.warnOnce(`${path}|script-kw`, `${what} is a built-in material; it has no keywords (shader graphs and shader assets do, ADR 0106).`);
    }
    this.bump(target);
  }

  /** The asset's shared Material on its Babylon material, when its version changed. */
  private applyShared(path: string, material: BabylonMaterial, shared: EngineMaterial): void {
    const applied = this.sharedApplied.get(material);
    if (applied === shared._version || (applied === undefined && shared._empty)) return;
    this.sharedApplied.set(material, shared._version);
    // A texture override taken back: rebuild the asset, so its own texture loads onto it again.
    const entry = this.materialAssets.get(path);
    if (applied !== undefined && !shared._values.has("texture") && material instanceof PBRMaterial && this.wantedTextures.get(material) && entry) {
      entry.raw = Symbol("rebuild");
      return;
    }
    this.applyValues(path, material, shared, this.graphs.get(material));
  }

  /** A script Material instance's own Babylon material: a copy of its asset's (a graph copy shares the compiled program). */
  private instanceMaterial(m: EngineMaterial): BabylonMaterial | null {
    const asset = m.asset ? this.materialAssetBase(m.asset) : this.defaultMaterial;
    if (!asset) return null;
    let e = this.instanceMaterials.get(m);
    if (e && e.base !== asset) {
      this.disposeInstance(m);
      e = undefined;
    }
    if (!e) {
      const g = this.graphs.get(asset);
      if (g) {
        const made = createGraphMaterial(this.scene, `${asset.name}:instance`, g.compiled, { ...g.properties }, this.graphShared, (p, linear) => this.graphTexture(p, linear));
        made.setKeywords(g.keywords);
        this.graphs.set(made.material, made);
        e = { base: asset, material: made.material, graph: made, version: -1, seen: true };
      } else if (asset instanceof PBRMaterial) {
        e = { base: asset, material: asset.clone(`${asset.name}:instance`), version: -1, seen: true };
      } else e = { base: asset, material: asset, version: m._version, seen: true };
      if (this.noFog.has(asset)) this.noFog.add(e.material);
      this.instanceMaterials.set(m, e);
    }
    e.seen = true;
    if (e.version !== m._version) {
      e.version = m._version;
      if (e.material !== e.base) this.applyValues(m.asset, e.material, m, e.graph);
    }
    // A copy taken before its asset's textures loaded follows them, unless it overrides its own.
    if (e.material instanceof PBRMaterial && e.base instanceof PBRMaterial && !this.wantedTextures.get(e.material)) {
      if (e.material.albedoTexture !== e.base.albedoTexture) e.material.albedoTexture = e.base.albedoTexture;
      if (e.material.bumpTexture !== e.base.bumpTexture) e.material.bumpTexture = e.base.bumpTexture;
    }
    return e.material;
  }

  private disposeInstance(m: EngineMaterial): void {
    const e = this.instanceMaterials.get(m);
    if (!e) return;
    if (e.graph) e.graph.dispose();
    else if (e.material !== e.base) e.material.dispose();
    this.instanceMaterials.delete(m);
  }

  /** The Babylon material a renderer's slot draws (ADR 0089, 0107): its script Material instance's copy, or its asset's (with shared values). */
  private drawnMaterial(r: MeshRenderer, slot = 0): BabylonMaterial | null {
    const m = r._drawMaterial(slot);
    if (m?.isInstance) return this.instanceMaterial(m);
    return this.materialAsset(r.materials[slot] || r.material);
  }

  /**
   * A graph compiled to WGSL as a Babylon material (ADR 0047, `graphMaterial.ts`), or a hand-written shader
   * asset (ADR 0106) when `readCode` is given: it reads the asset's code files, which become dependencies.
   */
  private graphMaterial(graphRaw: unknown, where: string, properties: Record<string, GraphValue>, readCode?: (path: string) => unknown): BabylonGraphMaterial {
    let compiled: CompiledShaderGraph;
    let problems: string[];
    if (readCode) {
      const parsed = parseShaderAsset(graphRaw, where);
      problems = parsed.problems;
      const sources: ShaderAssetSources = {};
      const deps: string[] = [];
      for (const lang of ["wgsl", "glsl"] as const) {
        const code = parsed.shader[lang];
        if (!code) continue;
        if ("code" in code) sources[lang] = code.code;
        else {
          const file = normalizeAssetPath(code.file);
          deps.push(file);
          const text = readCode(file);
          if (typeof text === "string") sources[lang] = text;
          else problems.push(`${where}: its ${lang.toUpperCase()} file "${file}" isn't in the project.`);
        }
      }
      compiled = compileShaderAsset(parsed.shader, sources, deps);
      const language = this.engine.isWebGPU ? "WGSL" : "GLSL";
      if (this.engine.isWebGPU ? compiled.noWgsl : !compiled.glsl) this.warnOnce(`shader|lang|${where}`, `${where}: has no ${language} code for this ${this.engine.isWebGPU ? "WebGPU" : "WebGL2"} engine; it draws as plain PBR.`);
    } else {
      const parsed = parseShaderGraph(graphRaw, where);
      problems = parsed.problems;
      compiled = compileShaderGraph(parsed.graph, { shaderLevel: Graphics.tier.shaderLevel });
      if (!this.engine.isWebGPU) this.warnOnce("graph|webgl", "shader graph materials need WebGPU on the Babylon backend; on the WebGL2 fallback they draw as plain PBR.");
    }
    for (const p of [...problems, ...compiled.problems.map((q) => `${where}: ${q}`)]) this.warnOnce(p, p);
    const made = createGraphMaterial(this.scene, `graph:${where}`, compiled, properties, this.graphShared, (p, linear) => this.graphTexture(p, linear));
    this.graphs.set(made.material, made);
    return made;
  }

  /** A texture for graph code: colour textures decode sRGB in hardware (graph code samples them raw), data textures stay linear. */
  private graphTexture(path: string, linear: boolean): Promise<Texture> {
    const key = `${linear ? "linear" : "srgb"}|${path}`;
    let p = this.graphTextures.get(key);
    if (!p && isRenderTexturePath(path)) {
      // Graph code samples raw: a render texture's colour is what the camera wrote (ADR 0109).
      const rt = this.renderTextures.texture(path);
      p = rt ? Promise.resolve(rt) : Promise.reject(new Error(`render texture "${path}" isn't in the project`));
      this.graphTextures.set(key, p);
    }
    if (!p) {
      p = new Promise<Texture>((resolve, reject) => {
        const settings: ImportSettings = Assets.importSettings(path);
        let url: string;
        try {
          url = Assets.url(path);
        } catch (err) {
          reject(err);
          return;
        }
        const tex: Texture = new Texture(url, this.scene, {
          noMipmap: !settings.mipmaps,
          invertY: true,
          samplingMode: this.samplingMode(settings),
          useSRGBBuffer: !linear,
          gammaSpace: false,
          onLoad: () => {
            const wrap = settings.wrap === "repeat" ? Texture.WRAP_ADDRESSMODE : settings.wrap === "mirror" ? Texture.MIRROR_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
            tex.wrapU = tex.wrapV = wrap;
            resolve(tex);
          },
          onError: (message) => reject(new Error(message ?? `couldn't load ${path}`)),
        });
      });
      this.graphTextures.set(key, p);
    }
    return p;
  }

  /**
   * The material a renderer draws with: its material asset's, or (with property overrides, ADR 0049)
   * its own copy with the overrides applied. A graph material's copy shares the compiled program.
   */
  private rendererMaterial(r: MeshRenderer, base: BabylonMaterial | null): BabylonMaterial | null {
    const overrides = r._materialProperties;
    let entry = this.rendererMaterials.get(r);
    if (!base || overrides.size === 0) {
      if (entry) this.releaseRendererMaterial(r);
      return base;
    }
    if (entry && entry.base !== base) {
      this.releaseRendererMaterial(r);
      entry = undefined;
    }
    const stamp = this.stamps.get(base) ?? 0;
    if (entry && entry.version === r._materialPropertiesVersion && entry.stamp === stamp) {
      // A copy taken before its base's textures loaded (they arrive after the material is made) follows them.
      const m = entry.material;
      if (m !== base && m instanceof PBRMaterial && base instanceof PBRMaterial) {
        if (this.wantedTextures.get(m) === null && m.albedoTexture !== base.albedoTexture) m.albedoTexture = base.albedoTexture;
        if (m.bumpTexture !== base.bumpTexture) m.bumpTexture = base.bumpTexture;
      }
      return m; // unchanged
    }
    const values: Record<string, GraphValue> = {};
    for (const [k, v] of overrides) values[k] = toGraphValue(v);
    const baseGraph = this.graphs.get(base);
    if (!entry) {
      if (baseGraph) {
        const g = createGraphMaterial(this.scene, `${base.name}:${r.node.name}`, baseGraph.compiled, { ...baseGraph.properties, ...values }, this.graphShared, (p, linear) => this.graphTexture(p, linear));
        g.setKeywords(baseGraph.keywords); // a variant of the base's (ADR 0106)
        entry = { base, material: g.material, graph: g, version: r._materialPropertiesVersion, stamp };
      } else {
        entry = { base, material: base, version: -1, stamp };
      }
      this.rendererMaterials.set(r, entry);
      const known = baseGraph ? new Set(baseGraph.compiled.uniforms.flatMap((u) => (u.property ? [u.property] : []))) : BUILTIN_PROPERTIES;
      for (const k of overrides.keys()) if (!known.has(k)) this.warnOnce(`${r.material}|prop|${k}`, `${r.node.name}: its material has no property "${k}"; setMaterialProperty ignores it.`);
    }
    if (entry.version !== r._materialPropertiesVersion || entry.stamp !== stamp) {
      entry.version = r._materialPropertiesVersion;
      entry.stamp = stamp;
      if (entry.graph && baseGraph) {
        entry.graph.setProperties({ ...baseGraph.properties, ...values });
        entry.graph.setKeywords(baseGraph.keywords);
      }
      else if (base instanceof PBRMaterial) {
        // One copy per renderer, updated in place: the base's values, then the overrides. A new copy
        // per change rebuilt the renderer's meshes and, once the old copy's effect was released,
        // compiled its shaders again (a splash fading its colour every frame did both).
        if (entry.material === base) entry.material = base.clone(`${base.name}:${r.node.name}`);
        const m = entry.material as PBRMaterial;
        applyBuiltinOverrides(m, base, values);
        this.overrideTexture(m, base, values);
      }
    }
    return entry.material;
  }

  /** A renderer's `texture` override on its copy of a built-in material (ADR 0049); the base's texture without one. */
  private overrideTexture(m: PBRMaterial, base: PBRMaterial, values: Record<string, GraphValue>): void {
    const image = typeof values.texture === "string" ? values.texture.replace(/^asset:/, "") : null;
    this.wantedTextures.set(m, image);
    if (image === null) m.albedoTexture = base.albedoTexture;
    else if (!image) m.albedoTexture = null;
    else
      this.texture(image)
        .then((tex) => {
          // Still wanting this image, and not disposed meanwhile.
          if (this.wantedTextures.get(m) === image && this.scene.materials.includes(m)) m.albedoTexture = tex;
        })
        .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
  }

  private releaseRendererMaterial(r: MeshRenderer): void {
    const e = this.rendererMaterials.get(r);
    if (!e) return;
    if (e.graph) e.graph.dispose();
    else if (e.material !== e.base) e.material.dispose();
    this.rendererMaterials.delete(r);
  }

  /** A lit, unlit or physical material asset (ADR 0043, 0052) as a Babylon PBR material. */
  private builtinMaterial(path: string, settings: MaterialSettings, owned: Texture[]): PBRMaterial {
    const m = pbr(`material:${path}`, this.scene);
    applyBuiltinSettings(m, settings);
    const load = (ref: string, apply: (tex: Texture) => void) => {
      const image = ref.replace(/^asset:/, "");
      if (!image) return;
      this.texture(image)
        .then((shared) => {
          if (this.materialAssets.get(path)?.material !== m) return; // replaced meanwhile
          const { texture, owned: own } = tiledTexture(shared, settings.tiling);
          if (own) owned.push(texture);
          apply(texture);
        })
        .catch((err) => console.error(`[myco] failed to load texture "${image}" for ${path}:`, err));
    };
    load(settings.texture, (tex) => (m.albedoTexture = tex));
    if (settings.shader !== "unlit") load(settings.normalMap, (tex) => (m.bumpTexture = tex));
    return m;
  }

  /** Tests and the editor: the render texture assets made so far (ADR 0109). */
  renderTextureState(): ReturnType<BabylonRenderTextures["state"]> {
    return this.renderTextures.state();
  }

  /** Tests: cascaded shadows and the environment map's state. */
  lightingState(): ReturnType<BabylonLighting["state"]> {
    return this.lighting.state();
  }

  /** Tests and the editor: the procedural sky's state (ADR 0112). */
  skyState(): ReturnType<BabylonSky["state"]> {
    return this.sky.state();
  }

  // --- Diagnostics ------------------------------------------------------------------------------

  renderStats(): { drawCalls: number; triangles: number; lines: number; points: number; geometries: number; textures: number; programs: number } {
    // Babylon counts the draw calls of the frame being drawn and resets at the next frame's start, so between frames this is the last frame's (0 on NullEngine).
    return { drawCalls: this.engine._drawCalls?.current ?? 0, triangles: 0, lines: 0, points: 0, geometries: this.scene.geometries.length, textures: this.scene.textures.length, programs: 0 };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}
