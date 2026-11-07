/**
 * Stage 3 of ADR 0075: a frame graph draws every frame of a World on the Babylon backend.
 *
 * - Shadow maps are tasks shared by every camera: a plain map per shadow-casting light, or cascades
 *   for the one the lighting chose (ADR 0053).
 * - Each camera renders into its own HDR texture the size of its viewport rectangle (ADR 0056), so
 *   its projection has the rectangle's aspect ratio.
 * - Its effects follow (ADR 0051, filtered by the quality tier): ambient occlusion and depth of
 *   field (fed by a geometry pass of view depth and normals), bloom, chromatic aberration.
 * - The finish pass (`finishShader.ts`) grades, vignettes, tone maps and sRGB-encodes into the
 *   camera's rectangle of the canvas; a camera without a background colour blends over the ones
 *   before it. FXAA follows on tiers that ask for it.
 *
 * The game's screen UI (ADR 0076) draws after the camera marked `ui`, over the editor's overlay.
 *
 * The editor's overlay (a utility layer: outlines, icons, gizmos; stage 8) draws right after the camera
 * marked `overlay`, straight onto the canvas without post-processing, so a camera preview inset drawn
 * after it covers it.
 *
 * The graph is rebuilt only when its layout changes (cameras, their sizes and effects, shadow
 * lights, MSAA); every value is updated in place each frame.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph.js";
import { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList.js";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import type { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import type { Layer } from "@babylonjs/core/Layers/layer.js";
import { backbufferColorTextureHandle, type FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes.js";
import { FrameGraphBloomTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask.js";
import { FrameGraphChromaticAberrationTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/chromaticAberrationTask.js";
import { FrameGraphCustomPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/customPostProcessTask.js";
import { FrameGraphDepthOfFieldTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/depthOfFieldTask.js";
import { FrameGraphFXAATask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/fxaaTask.js";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask.js";
import { FrameGraphSSAO2RenderingPipelineTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/ssao2RenderingPipelineTask.js";
import { FrameGraphCascadedShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/csmShadowGeneratorTask.js";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask.js";
import { FrameGraphShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/shadowGeneratorTask.js";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js";
import type { IShadowLight } from "@babylonjs/core/Lights/shadowLight.js";
import type { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import type { Effect } from "@babylonjs/core/Materials/effect.js";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture.js";
import { ThinTexture } from "@babylonjs/core/Materials/Textures/thinTexture.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { Color4 } from "@babylonjs/core/Maths/math.color.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { ThinDepthOfFieldEffectBlurLevel } from "@babylonjs/core/PostProcesses/thinDepthOfFieldEffect.js";
import { stackKey, type PostEffects, type ToneMappingName } from "../postEffects";
import { FINISH_SAMPLERS, FINISH_SHADER, FINISH_UNIFORMS, TONE_MAPPING_CODE } from "./finishShader";
import { reclusterForNextCamera } from "./lighting";
import { cascadeCasterList, type CustomRenderList } from "./shadowCulling";
import type { RenderTarget } from "./renderTextures";
import { BabylonLuts } from "./lutTextures";

/** One camera's part of the frame. */
export interface CameraView {
  camera: TargetCamera;
  /** Its rectangle on the canvas, fractions from the bottom-left (ADR 0056). */
  viewport: { x: number; y: number; width: number; height: number };
  /** Clear colour (sRGB), or null to draw over the cameras before it. */
  clear: Color4 | null;
  /** Its effects on this tier, or null for none. */
  effects: PostEffects | null;
  toneMapping: ToneMappingName;
  exposure: number;
  /** Draw the editor's overlay right after this camera (at most one). */
  overlay?: boolean;
  /** Draw the game's screen UI after this camera and its overlay (at most one; ADR 0076). */
  ui?: boolean;
  /** Editor: draw the camera preview's screen UI (`BabylonFrame.previewUI`) after this camera, the preview inset. */
  previewUI?: boolean;
  /**
   * Draw into a render texture asset instead of the canvas (ADR 0109): the whole texture, at its size.
   * `viewport` is ignored. With `hdr` the finish pass writes linear colour without tone mapping.
   */
  target?: RenderTarget;
  /**
   * Editor (ADR 0111): a colour (sRGB) shown behind the scene as it is, not tone mapped with it. The
   * camera clears to transparent and the finish pass puts this behind what it drew.
   */
  backdrop?: Color4;
}

/**
 * @internal ADR 0109: a camera's scene depth this frame, for effects that sample it (soft particles).
 * `texture` holds linear view-space depth in world units (metres from the camera's plane, one channel,
 * half float), cleared to the camera's far plane where nothing opaque was drawn. It's written by a depth
 * pass before the camera's render pass, so it may be sampled while the camera draws its transparent
 * objects (particles), and by passes after it. Valid while the frame graph that made it lives: fetch it
 * again each frame rather than keeping it.
 */
export interface SceneDepth {
  /** For `Effect.setTexture`. */
  texture: ThinTexture;
  internal: InternalTexture;
  width: number;
  height: number;
  near: number;
  far: number;
}

/** Runs a draw callback onto the canvas (the game's screen UI), without owning what it draws. */
class FrameGraphDrawTask extends FrameGraphTask {
  targetTexture: FrameGraphTextureHandle | undefined;
  readonly outputTexture: FrameGraphTextureHandle;

  constructor(name: string, graph: FrameGraph, private readonly draw: () => Layer | null) {
    super(name, graph);
    this.outputTexture = this._frameGraph.textureManager.createDanglingHandle();
  }

  getClassName(): string {
    return "FrameGraphDrawTask";
  }

  record(): void {
    if (this.targetTexture === undefined) throw new Error("draw task: targetTexture is required");
    this._frameGraph.textureManager.resolveDanglingHandle(this.outputTexture, this.targetTexture);
    const pass = this._frameGraph.addRenderPass(this.name);
    pass.setRenderTarget(this.outputTexture);
    pass.setExecuteFunc((context) => {
      const layer = this.draw();
      if (!layer) return;
      // A layer draws into the engine's current viewport, which a camera drawn before (the editor's camera
      // preview inset) may have left on its rectangle: the UI texture covers the whole canvas.
      (context as unknown as { _applyRenderTarget(): void })._applyRenderTarget();
      this._frameGraph.engine.setViewport(DRAW_VIEWPORT);
      context.render(layer);
    });
    const disabled = this._frameGraph.addRenderPass(this.name + "_disabled", true);
    disabled.setRenderTarget(this.outputTexture);
    disabled.setExecuteFunc(() => {});
  }
}

const FULL_VIEWPORT = new Viewport(0, 0, 1, 1);
const DRAW_VIEWPORT = new Viewport(0, 0, 1, 1);

/** Renders an existing utility layer onto the canvas, in a camera's rectangle. */
class FrameGraphOverlayTask extends FrameGraphTask {
  targetTexture: FrameGraphTextureHandle | undefined;
  readonly outputTexture: FrameGraphTextureHandle;
  private readonly rect = new Viewport(0, 0, 1, 1);

  constructor(name: string, graph: FrameGraph, private readonly layer: UtilityLayerRenderer, public view: CameraView) {
    super(name, graph);
    this.outputTexture = this._frameGraph.textureManager.createDanglingHandle();
  }

  getClassName(): string {
    return "FrameGraphOverlayTask";
  }

  record(): void {
    if (this.targetTexture === undefined) throw new Error("overlay task: targetTexture is required");
    this._frameGraph.textureManager.resolveDanglingHandle(this.outputTexture, this.targetTexture);
    const pass = this._frameGraph.addRenderPass(this.name);
    pass.setRenderTarget(this.outputTexture);
    pass.setExecuteFunc((context) => {
      const { camera, viewport: r } = this.view;
      this.layer.setRenderCamera(camera);
      this.layer.utilityLayerScene.activeCamera = camera;
      // Cameras draw their own textures with a full viewport (frameGraph.ts); here the camera's rectangle of the canvas.
      this.rect.x = r.x;
      this.rect.y = r.y;
      this.rect.width = r.width;
      this.rect.height = r.height;
      camera.viewport = this.rect;
      try {
        context.render(this.layer);
      } finally {
        camera.viewport = FULL_VIEWPORT;
      }
    });
    const disabled = this._frameGraph.addRenderPass(this.name + "_disabled", true);
    disabled.setRenderTarget(this.outputTexture);
    disabled.setExecuteFunc(() => {});
  }
}

/** A light that casts shadows this frame. */
export interface ShadowRequest {
  light: IShadowLight;
  /** Cascades (directional only), following the first camera. */
  cascaded: boolean;
  mapSize: number;
  numCascades: number;
  shadowMaxZ: number;
}

interface ViewTasks {
  render: FrameGraphObjectRendererTask;
  geometry: FrameGraphGeometryRendererTask | null;
  ao: FrameGraphSSAO2RenderingPipelineTask | null;
  dof: FrameGraphDepthOfFieldTask | null;
  bloom: FrameGraphBloomTask | null;
  ca: FrameGraphChromaticAberrationTask | null;
  finish: FrameGraphCustomPostProcessTask;
  fxaa: FrameGraphFXAATask | null;
  clear: FrameGraphClearTextureTask;
  /** The vec4s the finish pass reads, refreshed each frame. */
  finishValues: Record<string, [number, number, number, number]>;
  /** The camera's scene depth once built (ADR 0109), wrapped on first request. */
  depth: SceneDepth | null;
  /** The camera's colour lookup table this frame (ADR 0111). */
  lutPath: string | null;
}

/** A camera's clear task, and the geometry pass's depth buffer (cleared) when it has one. */
interface ViewTargets {
  clear: FrameGraphClearTextureTask;
  geometryDepth: FrameGraphTextureHandle | null;
}

/**
 * Ambient occlusion per quality (ADR 0111): sample count and the share of the camera's resolution it
 * runs at. Low and medium run at half resolution (a quarter of the pixels), then blur at full.
 */
export const AO_SETTINGS = {
  low: { samples: 8, ratio: 0.5 },
  medium: { samples: 16, ratio: 0.5 },
  high: { samples: 32, ratio: 1 },
  ultra: { samples: 48, ratio: 1 },
} as const;

/**
 * @internal Refill the shadow casters' list only when its meshes changed, in one splice. Babylon
 * watches a shadow map's render list, and when it goes from empty to filled it marks every mesh in
 * the scene as needing its shader defines rebuilt: clearing and refilling it each frame did that
 * every frame.
 */
export function setCasters(list: AbstractMesh[], casters: readonly AbstractMesh[]): boolean {
  if (list.length === casters.length && list.every((m, i) => m === casters[i])) return false;
  list.splice(0, list.length, ...casters);
  return true;
}

/** @internal One kind of pass in a camera's part of the frame. */
export type PassKind = "clear" | "render" | "geometry" | "ao" | "dof" | "bloom" | "ca" | "finish" | "fxaa";

/**
 * @internal A camera's passes, in order, for its effects (null: none), and whether something asked for
 * the scene depth (ADR 0109). The builder follows this list; it's separate so the layout is tested
 * without a GPU. The geometry pass (view depth, and normals for ambient occlusion) runs before the
 * render pass, so what the render pass draws last (particles) can sample the opaque scene's depth.
 */
export function cameraPasses(effects: PostEffects | null, depth = false): PassKind[] {
  const passes: PassKind[] = ["clear"];
  if (depth || effects?.ambientOcclusion || effects?.depthOfField) passes.push("geometry");
  passes.push("render");
  if (effects?.ambientOcclusion) passes.push("ao");
  if (effects?.depthOfField) passes.push("dof");
  if (effects?.bloom) passes.push("bloom");
  if (effects?.chromaticAberration) passes.push("ca");
  passes.push("finish");
  // Babylon's frame graph has no SMAA: FXAA stands in for it.
  if (effects?.antialias === "fxaa" || effects?.antialias === "smaa") passes.push("fxaa");
  return passes;
}

/** Each scene's frame graph, for `requestSceneDepth` and `sceneDepth`. */
const frames = new WeakMap<Scene, BabylonFrame>();

/**
 * @internal ADR 0109, for render code that has only the Babylon scene (particles): keep a depth pass on
 * every camera of `scene` until the returned function is called. Ask once (when the first soft particle
 * system appears, say), not per frame: the frame graph rebuilds when the first consumer arrives and
 * after the last leaves. A no-op before the scene's renderer exists.
 */
export function requestSceneDepth(scene: Scene, consumer: object): () => void {
  return frames.get(scene)?.requestSceneDepth(consumer) ?? (() => {});
}

/**
 * @internal ADR 0109: the depth `camera` drew this frame (see `SceneDepth`), or null when nobody asked
 * for it, the graph is rebuilding, or the camera isn't drawn. Call it each frame, while drawing (an
 * object's `onBind`, a material's bind), and bind `texture` to the shader; don't keep it across frames.
 */
export function sceneDepth(scene: Scene, camera: TargetCamera): SceneDepth | null {
  return frames.get(scene)?.sceneDepth(camera) ?? null;
}

/** @internal The frame graph of one Babylon scene (ADR 0075 stage 3). */
export class BabylonFrame {
  private graph: FrameGraph | null = null;
  private key = "";
  private building = false;
  private views: ViewTasks[] = [];
  private shadowTasks: FrameGraphShadowGeneratorTask[] = [];
  private overlayTask: FrameGraphOverlayTask | null = null;
  /** The editor's overlay, drawn after the camera marked `overlay` (stage 8). */
  overlay: UtilityLayerRenderer | null = null;
  /**
   * The game's screen UI (ADR 0076): returns what to draw this frame (a GUI texture's layer, made
   * current), or null. Drawn after the camera marked `ui`.
   */
  ui: (() => Layer | null) | null = null;
  /** Editor: the game's screen UI laid out for the camera preview inset, drawn after the view marked `previewUI`. */
  previewUI: (() => Layer | null) | null = null;
  /** Called just before each camera draws its objects (the renderer fits the skybox to it). */
  beforeView: ((camera: TargetCamera) => void) | null = null;
  /** Every mesh in the scene, drawn by each camera (the scene's own list, so new meshes join at once). */
  private readonly objects = new FrameGraphObjectList();
  /** The meshes that cast shadows, refilled each frame. */
  private readonly casterList = new FrameGraphObjectList();
  private readonly casterMeshes: AbstractMesh[] = [];
  /** What asked for the scene depth (ADR 0109); while any is left, every camera gets a depth pass. */
  private readonly depthConsumers = new Set<object>();
  /** Colour lookup tables for the finish pass (ADR 0111). */
  private readonly luts: BabylonLuts;

  constructor(private readonly scene: Scene) {
    this.objects.meshes = scene.meshes;
    this.objects.particleSystems = scene.particleSystems;
    this.casterList.meshes = this.casterMeshes;
    this.casterList.particleSystems = [];
    frames.set(scene, this);
    this.luts = new BabylonLuts(scene);
  }

  /** Whether a graph is ready to draw. */
  get ready(): boolean {
    return !!this.graph && !this.building;
  }

  /**
   * @internal ADR 0109: ask for the scene depth of every camera (`sceneDepth`) until the returned
   * function is called. The frame graph rebuilds with a depth pass per camera (shared with ambient
   * occlusion and depth of field when a camera has them).
   */
  requestSceneDepth(consumer: object): () => void {
    this.depthConsumers.add(consumer);
    return () => {
      this.depthConsumers.delete(consumer);
    };
  }

  /** @internal ADR 0109: a camera's scene depth this frame (see `SceneDepth`), or null when there's none yet. */
  sceneDepth(camera: TargetCamera): SceneDepth | null {
    if (!this.graph || this.building) return null;
    const t = this.views.find((v) => v.render.camera === camera);
    if (!t?.geometry) return null;
    if (!t.depth) {
      const internal = this.graph.textureManager.getTextureFromHandle(t.geometry.geometryViewDepthTexture);
      if (!internal) return null;
      t.depth = { texture: new ThinTexture(internal), internal, width: internal.width, height: internal.height, near: camera.minZ, far: camera.maxZ };
    }
    t.depth.near = camera.minZ;
    t.depth.far = camera.maxZ;
    return t.depth;
  }

  /** The drawing-buffer size of a camera's rectangle (or its render texture). */
  private viewSize(v: CameraView): { width: number; height: number } {
    if (v.target) return { width: v.target.width, height: v.target.height };
    const engine = this.scene.getEngine();
    return { width: Math.max(1, Math.round(v.viewport.width * engine.getRenderWidth())), height: Math.max(1, Math.round(v.viewport.height * engine.getRenderHeight())) };
  }

  /** Draw a frame: rebuild the graph if its layout changed, update every value, run it. */
  render(views: CameraView[], shadows: ShadowRequest[], casters: readonly AbstractMesh[], samples: number): void {
    setCasters(this.casterMeshes, casters);
    const key = JSON.stringify({
      samples,
      depth: this.depthConsumers.size > 0,
      shadows: shadows.map((s) => [s.light.uniqueId, s.cascaded, s.mapSize, s.numCascades]),
      views: views.map((v, i) => [v.camera.uniqueId, this.viewSize(v), v.clear ? "clear" : "over", v.effects ? stackKey(v.effects, i > 0 && !v.clear) : "plain", !!v.overlay && !!this.overlay, !!v.ui && !!this.ui, !!v.previewUI && !!this.previewUI, v.target?.key ?? "", !!v.backdrop]),
    });
    if (key !== this.key && !this.building) this.rebuild(key, views, shadows, samples);
    if (!this.graph || this.building) return;
    this.update(views, shadows);
    this.scene.render();
  }

  private rebuild(key: string, views: CameraView[], shadows: ShadowRequest[], samples: number): void {
    this.key = key;
    this.scene.frameGraph = null;
    this.graph?.dispose();
    this.graph = null;
    this.views = [];
    this.shadowTasks = [];
    this.overlayTask = null;
    if (!views.length) return;
    const graph = new FrameGraph(this.scene, false);
    // Every camera's clear runs before the shadow maps: a shadow map renders through Babylon's own render
    // target, behind the frame graph's back, and a clear right after it lands on the wrong target.
    const targets = views.map((v, i) => this.viewTargets(graph, v, i, samples));
    this.shadowTasks = shadows.map((s, i) => this.shadowTask(graph, s, i, views[0].camera));
    this.views = views.map((v, i) => {
      const tasks = this.viewTasks(graph, v, i, samples, targets[i]);
      if (v.overlay && this.overlay && !this.overlayTask) {
        const task = new FrameGraphOverlayTask(`overlay${i}`, graph, this.overlay, v);
        task.targetTexture = backbufferColorTextureHandle;
        graph.addTask(task);
        this.overlayTask = task;
      }
      // The game's UI covers the editor's helpers, as on three.js, where they're part of the 3D scene.
      if (v.ui && this.ui) {
        const ui = this.ui;
        const task = new FrameGraphDrawTask(`ui${i}`, graph, () => ui());
        task.targetTexture = backbufferColorTextureHandle;
        graph.addTask(task);
      }
      if (v.previewUI && this.previewUI) {
        const draw = this.previewUI;
        const task = new FrameGraphDrawTask(`previewUI${i}`, graph, () => draw());
        task.targetTexture = backbufferColorTextureHandle;
        graph.addTask(task);
      }
      return tasks;
    });
    this.building = true;
    graph
      .buildAsync()
      .then(() => {
        this.building = false;
        if (this.key !== key) return graph.dispose(); // replaced meanwhile
        this.graph = graph;
        this.scene.frameGraph = graph;
        this.scene.cameraToUseForPointers = views[0].camera; // the frame graph clears scene.activeCamera
      })
      .catch((err) => {
        this.building = false;
        console.error("[myco] the Babylon frame graph couldn't build:", err);
      });
  }

  private shadowTask(graph: FrameGraph, s: ShadowRequest, i: number, camera: TargetCamera): FrameGraphShadowGeneratorTask {
    const task = s.cascaded ? new FrameGraphCascadedShadowGeneratorTask(`shadow${i}`, graph) : new FrameGraphShadowGeneratorTask(`shadow${i}`, graph);
    task.light = s.light;
    task.camera = camera;
    task.objectList = this.casterList;
    task.mapSize = s.mapSize;
    task.filter = ShadowGenerator.FILTER_PCF;
    task.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    task.bias = 0.0005;
    task.normalBias = 0.02;
    if (task instanceof FrameGraphCascadedShadowGeneratorTask) {
      task.numCascades = s.numCascades;
      task.stabilizeCascades = true;
      task.lambda = 0.8;
      task.cascadeBlendPercentage = 0.1;
      task.shadowMaxZ = s.shadowMaxZ;
    }
    graph.addTask(task);
    return task;
  }

  /**
   * A camera's colour and depth textures and the task that clears them, plus, when its effects need
   * the geometry pass, that pass's own depth buffer and its clear. Without a depth buffer the geometry
   * pass draws with no depth test: the last mesh drawn wins, so ambient occlusion read the depth and
   * normals of meshes behind nearer ones and drew their edges through them.
   */
  private viewTargets(graph: FrameGraph, v: CameraView, i: number, samples: number): ViewTargets {
    const tm = graph.textureManager;
    const size = this.viewSize(v);
    const texture = (name: string, type: number, format: number, s = samples): FrameGraphTextureHandle =>
      tm.createRenderTargetTexture(`${name}${i}`, { size, sizeIsPercentage: false, options: { createMipMaps: false, samples: s, types: [type], formats: [format], useSRGBBuffers: [false], labels: [`${name}${i}`] } });
    const effects = v.effects;
    const msaa = effects?.ambientOcclusion ? 1 : samples; // the geometry pass for AO can't share a multisampled depth
    const color = texture("color", Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTUREFORMAT_RGBA, msaa);
    // A render texture asset without depth (ADR 0109): the camera draws in order, with no depth test.
    const depth = v.target?.depth === false ? undefined : texture("depth", Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_DEPTH32_FLOAT, msaa);

    const clear = new FrameGraphClearTextureTask(`clear${i}`, graph);
    clear.targetTexture = color;
    clear.depthTexture = depth;
    clear.clearColor = true;
    clear.clearDepth = !!depth;
    clear.clearStencil = false;
    clear.convertColorToLinearSpace = true; // the finish pass encodes sRGB
    graph.addTask(clear);

    let geometryDepth: FrameGraphTextureHandle | null = null;
    if (cameraPasses(effects, this.depthConsumers.size > 0).includes("geometry")) {
      const gclear = new FrameGraphClearTextureTask(`geometryClear${i}`, graph);
      gclear.depthTexture = texture("geometryDepth", Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_DEPTH32_FLOAT, 1);
      gclear.clearColor = false;
      gclear.clearDepth = true;
      gclear.clearStencil = false;
      graph.addTask(gclear);
      geometryDepth = gclear.outputDepthTexture;
    }
    return { clear, geometryDepth };
  }

  private viewTasks(graph: FrameGraph, v: CameraView, i: number, samples: number, { clear, geometryDepth }: ViewTargets): ViewTasks {
    const tm = graph.textureManager;
    const size = this.viewSize(v);
    const texture = (name: string, type: number, format: number, s = samples): FrameGraphTextureHandle =>
      tm.createRenderTargetTexture(`${name}${i}`, { size, sizeIsPercentage: false, options: { createMipMaps: false, samples: s, types: [type], formats: [format], useSRGBBuffers: [false], labels: [`${name}${i}`] } });
    const effects = v.effects;

    // Frustum culling: Babylon's frame graph object renderer draws every mesh in its list, so without
    // this every mesh in the scene was drawn (and readied) by every camera, on screen or not.
    const cull = new FrameGraphCullObjectsTask(`cull${i}`, graph, this.scene);
    cull.camera = v.camera;
    cull.objectList = this.objects;
    graph.addTask(cull);

    // The geometry pass first (view depth and normals): ambient occlusion and depth of field read it after
    // the render pass, and what the render pass draws last (particles) may sample its depth (ADR 0109).
    let geometry: FrameGraphGeometryRendererTask | null = null;
    const plan = new Set(cameraPasses(effects, this.depthConsumers.size > 0));
    if (plan.has("geometry")) {
      geometry = new FrameGraphGeometryRendererTask(`geometry${i}`, graph, this.scene);
      geometry.camera = v.camera;
      geometry.objectList = cull.outputObjectList;
      geometry.size = { width: size.width, height: size.height };
      geometry.sizeIsPercentage = false; // the default reads the size as a percentage of the canvas
      geometry.samples = 1;
      if (geometryDepth) geometry.depthTexture = geometryDepth; // depth-tested, like the render pass
      geometry.textureDescriptions = [
        // Half float: WebGPU can't filter 32-bit float textures, and the AO and depth-of-field passes sample with filtering.
        { type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_R },
      ];
      if (plan.has("ao")) geometry.textureDescriptions.push({ type: Constants.PREPASS_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA });
      graph.addTask(geometry);
    }

    // Clustered lights (ADR 0079): the task runs the clustering pass before drawing. Babylon clusters
    // once a frame, for the first camera; first in line, this makes it cluster again for this one.
    const render = new FrameGraphObjectRendererTask(`render${i}`, graph, this.scene, { enableClusteredLights: true });
    render.objectRenderer.onInitRenderingObservable.add(() => reclusterForNextCamera(this.scene), undefined, true);
    render.objectRenderer.onBeforeRenderObservable.add(() => this.beforeView?.(v.camera));
    render.targetTexture = clear.outputTexture;
    if (clear.depthTexture) render.depthTexture = clear.outputDepthTexture;
    render.camera = v.camera;
    render.objectList = cull.outputObjectList;
    render.shadowGenerators = this.shadowTasks;
    render.isMainObjectRenderer = i === 0;
    render.forceLayerMaskCheck = true; // editor-only meshes (EDITOR_LAYER_MASK) show to editor cameras only
    render.disableImageProcessing = true; // linear HDR out; the finish pass tone maps
    render.resolveMSAAColors = true; // the passes after it sample the resolved colours
    graph.addTask(render);
    let source = render.outputTexture;

    let ao: FrameGraphSSAO2RenderingPipelineTask | null = null;
    if (plan.has("ao") && effects?.ambientOcclusion && geometry) {
      const ratio = AO_SETTINGS[effects.ambientOcclusion.quality as keyof typeof AO_SETTINGS]?.ratio ?? 1;
      ao = new FrameGraphSSAO2RenderingPipelineTask(`ao${i}`, graph, ratio, 1, Constants.TEXTURETYPE_HALF_FLOAT);
      ao.sourceTexture = source;
      ao.depthTexture = geometry.geometryViewDepthTexture;
      ao.normalTexture = geometry.geometryViewNormalTexture;
      ao.camera = v.camera;
      graph.addTask(ao);
      source = ao.outputTexture;
    }
    let dof: FrameGraphDepthOfFieldTask | null = null;
    if (plan.has("dof") && effects?.depthOfField && geometry) {
      dof = new FrameGraphDepthOfFieldTask(`dof${i}`, graph, ThinDepthOfFieldEffectBlurLevel.Medium, true);
      dof.sourceTexture = source;
      dof.depthTexture = geometry.geometryViewDepthTexture;
      dof.camera = v.camera;
      graph.addTask(dof);
      source = dof.outputTexture;
    }
    let bloom: FrameGraphBloomTask | null = null;
    if (plan.has("bloom") && effects?.bloom) {
      bloom = new FrameGraphBloomTask(`bloom${i}`, graph, 0.3, 64, effects.bloom.threshold, true, 0.5);
      bloom.sourceTexture = source;
      graph.addTask(bloom);
      source = bloom.outputTexture;
    }
    let ca: FrameGraphChromaticAberrationTask | null = null;
    if (plan.has("ca") && effects?.chromaticAberration) {
      ca = new FrameGraphChromaticAberrationTask(`ca${i}`, graph);
      ca.sourceTexture = source;
      graph.addTask(ca);
      source = ca.outputTexture;
    }

    const webgpu = this.scene.getEngine().isWebGPU;
    const finish = new FrameGraphCustomPostProcessTask(`finish${i}`, graph, {
      name: FINISH_SHADER,
      fragmentShader: FINISH_SHADER,
      useShaderStore: true,
      shaderLanguage: webgpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      uniforms: [...FINISH_UNIFORMS], // a copy: Babylon adds the vertex stage's "scale" to the list it's given
      samplers: [...FINISH_SAMPLERS],
    });
    const finishValues: Record<string, [number, number, number, number]> = {};
    const lutPath = () => this.views[i]?.lutPath ?? null;
    finish.onApplyObservable.add((effect: Effect) => {
      // The camera's colour lookup table once loaded (ADR 0111), else the identity table at intensity 0.
      const path = lutPath();
      const lut = path ? this.luts.get(path) : null;
      effect.setTexture(FINISH_SAMPLERS[0], lut?.texture ?? this.luts.identity());
      const l = finishValues.lut ?? [0, 2, 0, 0];
      effect.setFloat4("lut", lut ? l[0] : 0, lut?.size ?? 2, 0, 0);
      for (const u of FINISH_UNIFORMS) {
        if (u === "lut") continue;
        const [x, y, z, w] = finishValues[u] ?? [0, 0, 0, 0];
        effect.setFloat4(u, x, y, z, w);
      }
    });
    finish.sourceTexture = source;
    const fxaaWanted = plan.has("fxaa");
    // A render texture asset (ADR 0109) is the whole target; otherwise the camera's rectangle of the canvas.
    const output = v.target ? tm.importTexture(`target${i}`, v.target.texture) : backbufferColorTextureHandle;
    const viewport = { x: v.viewport.x, y: v.viewport.y, width: v.viewport.width, height: v.viewport.height };
    if (i > 0 && !v.clear) finish.postProcess.alphaMode = Constants.ALPHA_COMBINE; // an overlay camera blends over the ones before
    let fxaa: FrameGraphFXAATask | null = null;
    if (fxaaWanted) {
      finish.targetTexture = texture("ldr", Constants.TEXTURETYPE_UNSIGNED_BYTE, Constants.TEXTUREFORMAT_RGBA, 1);
      graph.addTask(finish);
      fxaa = new FrameGraphFXAATask(`fxaa${i}`, graph);
      fxaa.sourceTexture = finish.outputTexture;
      fxaa.targetTexture = output;
      if (!v.target) fxaa.viewport = viewport;
      if (i > 0 && !v.clear) fxaa.postProcess.alphaMode = Constants.ALPHA_COMBINE;
      graph.addTask(fxaa);
    } else {
      finish.targetTexture = output;
      if (!v.target) finish.viewport = viewport;
      graph.addTask(finish);
    }
    return { render, geometry, ao, dof, bloom, ca, finish, fxaa, clear, finishValues, depth: null, lutPath: null };
  }

  /** Values that change without changing the graph's layout. */
  private update(views: CameraView[], shadows: ShadowRequest[]): void {
    shadows.forEach((s, i) => {
      const task = this.shadowTasks[i];
      if (task instanceof FrameGraphCascadedShadowGeneratorTask) {
        task.shadowMaxZ = s.shadowMaxZ;
        cullCascades(task);
      }
    });
    views.forEach((v, i) => {
      const t = this.views[i];
      if (!t) return;
      if (v.overlay && this.overlayTask) this.overlayTask.view = v;
      const transparent = { r: 0, g: 0, b: 0, a: 0 };
      t.clear.color.copyFrom(v.backdrop ? (transparent as Color4) : (v.clear ?? (transparent as Color4)));
      const e = v.effects;
      if (t.ao && e?.ambientOcclusion) {
        t.ao.ssao.totalStrength = e.ambientOcclusion.intensity * 0.5;
        t.ao.ssao.radius = e.ambientOcclusion.radius;
        t.ao.ssao.samples = AO_SETTINGS[e.ambientOcclusion.quality as keyof typeof AO_SETTINGS]?.samples ?? 16;
      }
      if (t.dof && e?.depthOfField) {
        const d = t.dof.depthOfField;
        d.focusDistance = e.depthOfField.focusDistance * 1000; // Babylon's is in millimetres
        d.focalLength = 50;
        d.fStop = Math.max(0.5, e.depthOfField.focusRange / Math.max(0.1, e.depthOfField.bokehScale));
      }
      if (t.bloom && e?.bloom) {
        t.bloom.bloom.weight = e.bloom.intensity * 0.3;
        t.bloom.bloom.threshold = e.bloom.threshold;
        t.bloom.bloom.kernel = Math.max(8, Math.round(64 * e.bloom.radius));
      }
      if (t.ca && e?.chromaticAberration) {
        t.ca.postProcess.aberrationAmount = e.chromaticAberration.amount * this.viewSize(v).width;
      }
      const f = t.finishValues;
      const g = e?.colorGrading;
      f.grade = [g?.brightness ?? 0, Math.min(0.99, g?.contrast ?? 0), g?.saturation ?? 0, ((g?.hue ?? 0) * Math.PI) / 180];
      // An HDR render texture (ADR 0109) keeps linear colour: no tone mapping, clamp or sRGB encode.
      f.tone = [v.exposure, v.target?.hdr ? -1 : TONE_MAPPING_CODE[v.toneMapping], e?.vignette ? 1 : 0, 0];
      f.vignetteShape = [e?.vignette?.darkness ?? 0, e?.vignette?.offset ?? 0, 0, 0];
      t.lutPath = e?.lut?.path ?? null;
      f.lut = [e?.lut?.intensity ?? 0, 2, 0, 0];
      const b = v.backdrop;
      f.backdrop = b ? [b.r, b.g, b.b, 1] : [0, 0, 0, 0];
    });
  }

  /** Tests and the editor: whether the last frame's first camera ran any effect. */
  state(views: CameraView[]): { composed: boolean; loaded: boolean } {
    return { composed: !!views[0]?.effects, loaded: this.ready };
  }

  dispose(): void {
    this.luts.dispose();
    this.scene.frameGraph = null;
    this.graph?.dispose();
    this.graph = null;
  }
}

/** Each cascaded shadow generator's per-cascade caster list (see `shadowCulling.ts`). */
const cascadeLists = new WeakMap<CascadedShadowGenerator, CustomRenderList>();

/**
 * Draw into each cascade only the casters that reach it. The task makes its generator when built and
 * may make a new one when its settings change, so this checks every frame (a map lookup).
 */
function cullCascades(task: FrameGraphCascadedShadowGeneratorTask): void {
  const generator = (task as unknown as { _shadowGenerator?: CascadedShadowGenerator })._shadowGenerator;
  const map = generator?.getShadowMap();
  if (!generator || !map) return;
  let list = cascadeLists.get(generator);
  if (!list) cascadeLists.set(generator, (list = cascadeCasterList((layer) => generator.getCascadeTransformMatrix(layer))));
  if (map.getCustomRenderList !== list) map.getCustomRenderList = list as typeof map.getCustomRenderList;
}
