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
import { parseMaterial, materialGraph, type MaterialSettings } from "../../scene/material";
import { meshesIfLoaded, type ModelMesh } from "../../scene/models";
import { isShaderGraphPath, parseShaderGraph, type GraphValue } from "../../scene/shaderGraph";
import { colorHex } from "../../scene/material";
import { Color as EngineColor, Vector2 as EngineVector2, Vector3 as EngineVector3 } from "../../core/math";
import type { MaterialPropertyValue } from "../components";
import { compileShaderGraph } from "../shaderGraph/compile";
import { createGraphMaterial, type BabylonGraphMaterial, type GraphShared } from "./graphMaterial";
import { Camera, Fog, Light, MeshRenderer, ParticleSystem, PostProcessing, SpriteRenderer, Text } from "../components";
import { UICanvas, isUIComponent } from "../../ui/components";
import type { UICore } from "../../ui/UICore";
import type { BabylonUI } from "./ui";
import { Scene as BabylonScene } from "@babylonjs/core/scene.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { BabylonProbes } from "./probes";
import { BabylonWater } from "./water";
import { WaterSurface } from "../water/WaterSurface";
import type { GameObject } from "../../scene/GameObject";
import type { ParticlePreviewSettings, ParticleStats } from "../RenderSurface";
import type { BabylonParticles } from "./particles";
import { PARTICLE_SCALE } from "../../core/graphics";
import { Graphics } from "../Graphics";
import { resolvePostEffects, type PostSettings } from "../postEffects";
import type { PostEffects, ToneMappingName } from "../PostProcessStack";
import { BabylonFrame, type CameraView, type ShadowRequest } from "./frameGraph";
import { BabylonLighting } from "./lighting";
import { spriteFrame } from "../spriteFrame";
import { applyBuiltinSettings, linear, meshOf, modelMaterial, pbr, tiledTexture } from "./materials";

interface SpriteEntry {
  mesh: Mesh;
  material: PBRMaterial;
  spritePath: string | null;
  texture: Texture | null;
  /** The UVs the quad has, as a key ("" for the whole texture). */
  uvKey: string;
  /** Size in node units (before the node's scale), once the texture has loaded. */
  size: [number, number] | null;
}

interface MeshEntry {
  meshes: Mesh[];
  sources: readonly ModelMesh[] | null;
  material: BabylonMaterial | null;
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
}

/** A renderer's own material holding its property overrides (ADR 0049). */
interface RendererMaterial {
  base: BabylonMaterial;
  material: BabylonMaterial;
  graph?: BabylonGraphMaterial;
  version: number;
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
const tmpScale = new Vector3();
const tmpQuat = new Quaternion();
const tmpPos = new Vector3();
/** Unit quad facing +Z, centred on the origin: bottom-left, bottom-right, top-right, top-left. */
const QUAD_POSITIONS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_NORMALS = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
const QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
const QUAD_INDICES = [0, 1, 2, 0, 2, 3];

/** A CSS colour string or 0xRRGGBB number as a Babylon colour (gamma space, for clearing). */
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
  /** Time and drawing-buffer size, read by every graph material. */
  private readonly graphShared: GraphShared = { time: 0, resolution: [1, 1] };
  /** Graph textures, sampled raw by graph code: colour ones through sRGB buffers, data ones linear. */
  private readonly graphTextures = new Map<string, Promise<Texture>>();
  /** Babylon materials made from models' own materials. */
  private readonly modelMaterials = new WeakMap<object, BabylonMaterial>();
  private readonly warned = new Set<string>();
  private readonly defaultMaterial: PBRMaterial;
  private readonly lighting: BabylonLighting;
  /** Reflection probes (stage 6). */
  private readonly probes: BabylonProbes;
  /** Water surfaces (ADR 0072; stage 6), made the first time a World has one. */
  private water: BabylonWater | null = null;
  /** Each material's copies reflecting a probe's map (ADR 0054), by the probe's texture. */
  private readonly probeMaterials = new WeakMap<BabylonMaterial, Map<BaseTexture, PBRMaterial>>();
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
  private readonly casters: Mesh[] = [];
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
      const gpu = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
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
    this.frame = new BabylonFrame(scene);
    this.probes = new BabylonProbes(scene);

    this.defaultMaterial = pbr("myco.default", scene);
    this.defaultMaterial.albedoColor = new Color3(1, 1, 1);
    this.defaultMaterial.metallic = 0;
    this.defaultMaterial.roughness = 0.5;
    if (fill) this.editorTools();
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
        for (const [component, e] of self.sprites) yield { component, mesh: e.mesh, size: e.size, order: self.sortOrder(component.sortingLayer, component.orderInLayer) };
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

  private texture(path: string): Promise<Texture> {
    const cached = this.textures.get(path);
    if (cached) return Promise.resolve(cached);
    let p = this.loading.get(path);
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
          invertY: true,
          samplingMode: this.samplingMode(settings),
          onLoad: () => {
            this.applySampling(path, tex);
            this.textures.set(path, tex);
            this.loading.delete(path);
            resolve(tex);
          },
          onError: (message) => {
            this.loading.delete(path);
            reject(new Error(message ?? `couldn't load ${path}`));
          },
        });
      });
      this.loading.set(path, p);
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
    for (const s of world._componentsOfType(SpriteRenderer)) this.syncSprite(world, s);
    for (const m of world._componentsOfType(MeshRenderer)) this.syncMesh(world, m);
    for (const c of world._componentsOfType(Camera)) this.syncCamera(world, c);
    const view = this.viewCameras(world)[0];
    const camera = view ? this.cameras.get(view)!.camera : null;
    this.casters.length = 0;
    for (const [r, e] of this.meshRenderers) if (r.castShadows && r.isActiveAndEnabled) this.casters.push(...e.meshes);
    this.shadows = this.lighting.syncLights(world, camera);
    this.syncParticles(world);
    this.syncFog(world);
    this.lighting.syncEnvironment(world, view?.far ?? 1000);
    const ready = this.loading.size === 0 && [...this.meshRenderers.values()].every((m) => m.sources !== null);
    this.probeMeshes.length = 0;
    for (const m of this.scene.meshes) if ((m.layerMask & EDITOR_LAYER_MASK) === 0) this.probeMeshes.push(m);
    this.probes.sync(world, this.probeMeshes, ready);
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
      return { ui: this.tools ? i === 0 : i === cams.length - 1, overlay: i === 0 && !!this.tools, camera: entry.camera, viewport: entry.rect, clear: i === 0 || c.backgroundColor ? background : null, effects: resolved.composer, toneMapping: resolved.toneMapping, exposure: resolved.exposure };
    });
    this.lastPost = views[0] ? { composed: !!views[0].effects, toneMapping: views[0].toneMapping, effects: views[0].effects } : null;
    const preview = views.length ? this.previewView(views) : null;
    if (preview) views.push(preview);
    this.cameraPreviewDrawn = !!preview && this.frame.ready;
    if (views.length) this.probes.capture(views[0].camera); // before the frame graph runs
    if (views.length) this.frame.render(views, this.shadows, this.casters, Graphics.tier.antialias === "msaa" ? 4 : 1);
    if (!views.length || !this.frame.ready) engine.clear(this.clearColor, true, true, true);
    engine.endFrame();
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
      if (!systems.length || this.particlesLoading) return;
      this.particlesLoading = true;
      import("./particles")
        .then((m) => {
          if (this.disposed) return;
          this.particles = new m.BabylonParticles({
            scene: this.scene,
            editor: this.fill,
            worldMatrix: (c) => {
              const e = c.node.entity;
              return (this.owner ?? world).worldMatrix(e).subarray(e * 16, e * 16 + 16);
            },
            selected: (c) => this.selectedNodes.has(c.node),
            texture: (path) => this.texture(path),
            tierScale: () => PARTICLE_SCALE[Graphics.tier.particles],
          });
          Object.assign(this.particles.preview, this.particlePreview);
        })
        .catch((err) => console.error("[myco] particles couldn't start on the Babylon backend:", err))
        .finally(() => (this.particlesLoading = false));
      return;
    }
    this.particles.sync(systems, world.time.deltaTime, world.time.unscaledDeltaTime);
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

  /** A copy of a material reflecting a probe's map, made once per material and probe. */
  private probeMaterial(base: PBRMaterial, texture: BaseTexture, intensity: number): PBRMaterial {
    let byProbe = this.probeMaterials.get(base);
    if (!byProbe) {
      byProbe = new Map();
      this.probeMaterials.set(base, byProbe);
    }
    let m = byProbe.get(texture);
    if (!m) {
      m = base.clone(`${base.name}:probe`);
      m.reflectionTexture = texture;
      byProbe.set(texture, m);
      if (this.noFog.has(base)) this.noFog.add(m);
    }
    m.environmentIntensity = intensity;
    return m;
  }

  /** Tests: how many water surfaces are drawn. */
  waterState(): { surfaces: number } {
    return this.water?.state() ?? { surfaces: 0 };
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
      return;
    }
    const exp = fog.mode === "exponential";
    s.fogMode = exp ? BabylonScene.FOGMODE_EXP2 : BabylonScene.FOGMODE_LINEAR;
    s.fogColor = new Color3(fog.color.r, fog.color.g, fog.color.b).toLinearSpace();
    s.fogDensity = Math.max(0, fog.density);
    s.fogStart = Math.max(0, fog.near);
    s.fogEnd = Math.max(s.fogStart + 1e-3, fog.far);
    const amount = fog.affectsSkybox ? Math.min(1, Math.max(0, fog.skyboxFog)) : 0;
    this.skyFog = amount > 0 ? { amount, color: new Color4(fog.color.r, fog.color.g, fog.color.b, 1) } : null;
    this.lighting.setSkyFog(amount);
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
        e.mesh.dispose();
        e.material.dispose();
        this.sprites.delete(c);
      }
    } else if (c instanceof MeshRenderer) {
      const e = this.meshRenderers.get(c);
      if (e) {
        for (const m of e.meshes) m.dispose();
        this.meshRenderers.delete(c);
      }
      this.releaseRendererMaterial(c);
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
      .filter((c) => c.isActiveAndEnabled && this.cameras.has(c) && !world.inEditMode(c.node.entity))
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
    const aspect = (cw * w) / (ch * h);
    if (c.projection === "orthographic") {
      camera.mode = BabylonCamera.ORTHOGRAPHIC_CAMERA;
      const s = c.orthographicSize;
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

  private syncSprite(world: World, s: SpriteRenderer): void {
    let entry = this.sprites.get(s);
    if (!entry) {
      const mesh = new Mesh(`sprite:${s.node.name}`, this.scene);
      const data = new VertexData();
      data.positions = QUAD_POSITIONS;
      data.normals = QUAD_NORMALS;
      data.uvs = QUAD_UVS;
      data.indices = QUAD_INDICES;
      data.applyToMesh(mesh, true);
      const material = pbr(`sprite:${s.node.name}`, this.scene);
      material.unlit = true;
      material.backFaceCulling = false; // flipped sprites mirror their quad
      material.disableDepthWrite = true;
      material.depthFunction = Constants.ALWAYS; // sprites draw in layer order, not by depth (ADR 0014)
      material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      material.useAlphaFromAlbedoTexture = true;
      mesh.material = material;
      mesh.alwaysSelectAsActiveMesh = true;
      entry = { mesh, material, spritePath: null, texture: null, uvKey: "", size: null };
      this.sprites.set(s, entry);
    }
    const { mesh, material } = entry;
    const { path: image, slice } = splitSpriteRef(s.sprite);
    if (entry.spritePath !== s.sprite) {
      entry.spritePath = s.sprite;
      const tex = image ? (this.textures.get(image) ?? null) : null;
      entry.texture = tex;
      if (tex) tex.hasAlpha = true; // Babylon reads a texture's alpha only when told it has one
      material.albedoTexture = tex;
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
    mesh.setEnabled(visible);
    if (!visible) return;

    material.albedoColor = linear(s.color);
    material.alpha = s.color.a;
    mesh.alphaIndex = this.sortOrder(s.sortingLayer, s.orderInLayer);

    let w = 1, h = 1, px = 0.5, py = 0.5;
    if (entry.texture) {
      const size = entry.texture.getBaseSize();
      const frame = spriteFrame(Assets.importSettings(image), slice, size.width, size.height, { component: s.pixelsPerUnit, project: this.settings.render.pixelsPerUnit }, s.size);
      [w, h] = frame.size;
      [px, py] = frame.pivot;
      if (frame.missingSlice) this.warnOnce(`slice|${s.sprite}`, `${image} has no slice named "${slice}" (in ${image}.meta.json); drawing the whole image.`);
      this.setSpriteUVs(entry, frame.uv);
    } else if (s.size) {
      w = s.size.x;
      h = s.size.y;
    }
    entry.size = entry.texture || s.size ? [w, h] : null;
    // Scale the unit quad to size with the pivot at the node's origin (flips mirror about it).
    const e = s.node.entity;
    const local = Matrix.Translation(0.5 - px, 0.5 - py, 0).multiply(Matrix.Scaling(s.flipX ? -w : w, s.flipY ? -h : h, 1));
    Matrix.FromArrayToRef(world.worldMatrix(e) as unknown as number[], e * 16, tmpMatrix);
    mesh.freezeWorldMatrix(local.multiply(tmpMatrix));
  }

  /** Draw a slice's part of the texture, or the whole texture. */
  private setSpriteUVs(entry: SpriteEntry, uv: [number, number, number, number] | null): void {
    const key = uv ? uv.join(",") : "";
    if (key === entry.uvKey) return;
    entry.uvKey = key;
    if (!uv) {
      entry.mesh.updateVerticesData(VertexBuffer.UVKind, QUAD_UVS);
      return;
    }
    const [u0, v0, u1, v1] = uv;
    entry.mesh.updateVerticesData(VertexBuffer.UVKind, [u0, v0, u1, v0, u1, v1, u0, v1]);
  }

  /** @internal The sprite's size in node units once its texture has loaded. */
  spriteSize(s: SpriteRenderer): [number, number] | null {
    if (s.size) return [s.size.x, s.size.y];
    return this.sprites.get(s)?.size ?? null;
  }

  // --- Meshes and materials (ADR 0043, 0044) ----------------------------------------------------

  private syncMesh(world: World, r: MeshRenderer): void {
    let entry = this.meshRenderers.get(r);
    if (!entry) {
      entry = { meshes: [], sources: null, material: null };
      this.meshRenderers.set(r, entry);
    }
    const sources = meshesIfLoaded(r.mesh); // null while the model loads
    const material = this.rendererMaterial(r, this.materialAsset(r.material));
    const same = entry.sources !== null && sources !== null && entry.sources.length === sources.length && entry.sources.every((m, i) => m === sources[i]);
    if (!same || entry.material !== material) {
      for (const m of entry.meshes) m.dispose();
      entry.meshes = (sources ?? []).map((src) => {
        const mesh = meshOf(this.scene, `mesh:${r.node.name}:${src.name}`, src);
        mesh.material = material ?? modelMaterial(this.scene, this.modelMaterials, src, mesh) ?? this.defaultMaterial;
        mesh.metadata = { mycoBase: mesh.material };
        return mesh;
      });
      entry.sources = sources;
      entry.material = material;
    }
    const visible = r.isActiveAndEnabled;
    const e = r.node.entity;
    for (const m of entry.meshes) {
      m.setEnabled(visible);
      m.receiveShadows = r.receiveShadows;
      if (!visible) continue;
      m.freezeWorldMatrix(Matrix.FromArray(world.worldMatrix(e) as unknown as number[], e * 16));
      const base = (m.metadata as { mycoBase?: BabylonMaterial } | null)?.mycoBase ?? m.material;
      if (!base) continue;
      m.applyFog = !this.noFog.has(base);
      // A reflection probe (ADR 0054) for built-in materials; graph materials keep the scene's environment.
      const centre = m.getBoundingInfo().boundingBox.centerWorld;
      const probe = base instanceof PBRMaterial && !this.graphs.has(base) ? this.probes.lookup(centre.x, centre.y, centre.z) : null;
      const drawn = probe ? this.probeMaterial(base as PBRMaterial, probe.texture, probe.intensity) : base;
      if (probe) this.reflecting++;
      if (m.material !== drawn) m.material = drawn;
    }
  }

  /**
   * The Babylon material for a material asset, or null for none (empty, missing, or not a material:
   * warned once). Rebuilt when the asset's JSON changes (the editor's Material inspector).
   */
  private materialAsset(path: string): BabylonMaterial | null {
    if (!path) return null;
    const read = (p: string): unknown => {
      try {
        return Assets.has(p) ? Assets.json(p) : undefined;
      } catch {
        return undefined;
      }
    };
    const raw = read(path);
    // A material naming a shader graph, or a renderer naming the graph itself, depends on the graph's JSON too.
    let graphPath: string | null = isShaderGraphPath(path) ? path : null;
    if (!graphPath && raw !== undefined) {
      try {
        graphPath = materialGraph(parseMaterial(raw).settings);
      } catch {
        graphPath = null;
      }
    }
    const graphRaw = graphPath ? read(graphPath) : undefined;
    const cached = this.materialAssets.get(path);
    const levelOk = !cached?.level || cached.level === Graphics.tier.shaderLevel; // Quality Branch nodes (ADR 0050)
    if (cached && levelOk && cached.raw === raw && cached.graphRaw === graphRaw && (cached.deps ?? []).every(([p, v]) => read(p) === v)) return cached.material;
    if (cached?.graph) cached.graph.dispose();
    else cached?.material?.dispose();
    for (const t of cached?.textures ?? []) t.dispose();
    let material: BabylonMaterial | null = null;
    let graph: BabylonGraphMaterial | undefined;
    const owned: Texture[] = [];
    const where = path.replace(/^asset:/, "");
    if (raw === undefined) {
      this.warnOnce(`missing|${path}`, `material "${where}" isn't in the project; using the default material.`);
    } else if (graphPath) {
      try {
        const properties: Record<string, GraphValue> = graphPath === path ? {} : parseMaterial(raw, where).settings.properties;
        if (graphRaw === undefined) throw new Error(`shader graph "${graphPath.replace(/^asset:/, "")}" isn't in the project.`);
        graph = this.graphMaterial(graphRaw, graphPath.replace(/^asset:/, ""), properties);
        material = graph.material;
      } catch (err) {
        const message = `${where}: ${(err as Error).message} Using the default material.`;
        this.warnOnce(message, message);
      }
    } else {
      try {
        const { settings, problems } = parseMaterial(raw, where);
        for (const p of problems) this.warnOnce(`${path}|${p}`, p);
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
    this.materialAssets.set(path, { raw, graphRaw, material, textures: owned, graph, deps, level });
    return material;
  }

  /** A graph compiled to WGSL as a Babylon material (ADR 0047, `graphMaterial.ts`). */
  private graphMaterial(graphRaw: unknown, where: string, properties: Record<string, GraphValue>): BabylonGraphMaterial {
    const { graph, problems } = parseShaderGraph(graphRaw, where);
    const compiled = compileShaderGraph(graph, { shaderLevel: Graphics.tier.shaderLevel, language: "wgsl" });
    for (const p of [...problems, ...compiled.problems.map((q) => `${where}: ${q}`)]) this.warnOnce(p, p);
    if (!this.engine.isWebGPU) this.warnOnce("graph|webgl", "shader graph materials need WebGPU on the Babylon backend; on the WebGL2 fallback they draw as plain PBR.");
    const made = createGraphMaterial(this.scene, `graph:${where}`, compiled, properties, this.graphShared, (p, linear) => this.graphTexture(p, linear));
    this.graphs.set(made.material, made);
    return made;
  }

  /** A texture for graph code: colour textures decode sRGB in hardware (graph code samples them raw), data textures stay linear. */
  private graphTexture(path: string, linear: boolean): Promise<Texture> {
    const key = `${linear ? "linear" : "srgb"}|${path}`;
    let p = this.graphTextures.get(key);
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
    const values: Record<string, GraphValue> = {};
    for (const [k, v] of overrides) values[k] = toGraphValue(v);
    const baseGraph = this.graphs.get(base);
    if (!entry) {
      if (baseGraph) {
        const g = createGraphMaterial(this.scene, `${base.name}:${r.node.name}`, baseGraph.compiled, { ...baseGraph.properties, ...values }, this.graphShared, (p, linear) => this.graphTexture(p, linear));
        entry = { base, material: g.material, graph: g, version: r._materialPropertiesVersion };
      } else {
        entry = { base, material: base, version: -1 };
      }
      this.rendererMaterials.set(r, entry);
      const known = baseGraph ? new Set(baseGraph.compiled.uniforms.flatMap((u) => (u.property ? [u.property] : []))) : BUILTIN_PROPERTIES;
      for (const k of overrides.keys()) if (!known.has(k)) this.warnOnce(`${r.material}|prop|${k}`, `${r.node.name}: its material has no property "${k}"; setMaterialProperty ignores it.`);
    }
    if (entry.version !== r._materialPropertiesVersion) {
      entry.version = r._materialPropertiesVersion;
      if (entry.graph && baseGraph) entry.graph.setProperties({ ...baseGraph.properties, ...values });
      else if (base instanceof PBRMaterial) {
        // A fresh copy of the base each time, so cleared overrides go back to the material's values.
        if (entry.material !== base) entry.material.dispose();
        entry.material = this.builtinOverrides(base, `${base.name}:${r.node.name}`, values);
      }
    }
    return entry.material;
  }

  /** A copy of a built-in material with a renderer's overrides (ADR 0049). */
  private builtinOverrides(base: PBRMaterial, name: string, values: Record<string, GraphValue>): PBRMaterial {
    const m = base.clone(name);
    const color = (v: GraphValue): EngineColor | null => (typeof v === "string" || Array.isArray(v) ? EngineColor.from(v as string) : null);
    const lin = (c: EngineColor) => new Color3(c.r, c.g, c.b).toLinearSpace();
    if (values.color !== undefined) {
      const c = color(values.color);
      if (c) {
        m.albedoColor = lin(c);
        m.alpha = c.a;
        m.transparencyMode = c.a < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : base.transparencyMode;
      }
    }
    if (values.emission !== undefined) {
      const c = color(values.emission);
      if (c) m.emissiveColor = lin(c);
    }
    const num = (k: string) => (typeof values[k] === "number" ? (values[k] as number) : undefined);
    if (num("metalness") !== undefined) m.metallic = num("metalness")!;
    if (num("roughness") !== undefined) m.roughness = num("roughness")!;
    if (num("clearcoat") !== undefined) {
      m.clearCoat.isEnabled = num("clearcoat")! > 0;
      m.clearCoat.intensity = num("clearcoat")!;
    }
    if (num("clearcoatRoughness") !== undefined) m.clearCoat.roughness = num("clearcoatRoughness")!;
    if (num("sheen") !== undefined) {
      m.sheen.isEnabled = num("sheen")! > 0;
      m.sheen.intensity = num("sheen")!;
    }
    if (num("sheenRoughness") !== undefined) m.sheen.roughness = num("sheenRoughness")!;
    if (values.sheenColor !== undefined) {
      const c = color(values.sheenColor);
      if (c) m.sheen.color = lin(c);
    }
    if (num("transmission") !== undefined) {
      m.subSurface.isRefractionEnabled = num("transmission")! > 0;
      m.subSurface.refractionIntensity = num("transmission")!;
    }
    if (num("thickness") !== undefined) m.subSurface.maximumThickness = Math.max(num("thickness")!, 0.001);
    if (num("ior") !== undefined) m.indexOfRefraction = num("ior")!;
    if (num("iridescence") !== undefined) {
      m.iridescence.isEnabled = num("iridescence")! > 0;
      m.iridescence.intensity = num("iridescence")!;
    }
    if (num("iridescenceIOR") !== undefined) m.iridescence.indexOfRefraction = num("iridescenceIOR")!;
    if (num("anisotropy") !== undefined) {
      m.anisotropy.isEnabled = num("anisotropy")! > 0;
      m.anisotropy.intensity = num("anisotropy")!;
    }
    if (num("anisotropyRotation") !== undefined) m.anisotropy.angle = (num("anisotropyRotation")! * Math.PI) / 180;
    if (num("specularIntensity") !== undefined) m.metallicF0Factor = num("specularIntensity")!;
    if (values.specularColor !== undefined) {
      const c = color(values.specularColor);
      if (c) m.metallicReflectanceColor = lin(c);
    }
    if (typeof values.texture === "string") {
      const image = values.texture.replace(/^asset:/, "");
      if (!image) m.albedoTexture = null;
      else
        this.texture(image)
          .then((tex) => {
            if ([...this.rendererMaterials.values()].some((e) => e.material === m)) m.albedoTexture = tex;
          })
          .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
    }
    return m;
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

  /** Tests: cascaded shadows and the environment map's state. */
  lightingState(): ReturnType<BabylonLighting["state"]> {
    return this.lighting.state();
  }

  // --- Diagnostics ------------------------------------------------------------------------------

  renderStats(): { drawCalls: number; triangles: number; lines: number; points: number; geometries: number; textures: number; programs: number } {
    return { drawCalls: 0, triangles: 0, lines: 0, points: 0, geometries: this.scene.geometries.length, textures: this.scene.textures.length, programs: 0 };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}
