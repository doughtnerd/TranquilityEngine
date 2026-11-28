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
 * Each view culls its own object list (ADR 0446 §3: the levels and visibility chosen for it), by default every mesh.
 *
 * Each camera's tasks follow its pass plan (`render/passPlan.ts`, ADR 0274). The graph is rebuilt only
 * when its layout changes (cameras, their sizes and pass plan keys, shadow lights, MSAA); every value,
 * the finish pass's uniforms included, is updated in place each frame.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
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
import type { Scene } from "@babylonjs/core/scene.js";
import { ThinDepthOfFieldEffectBlurLevel } from "@babylonjs/core/PostProcesses/thinDepthOfFieldEffect.js";
import { refillIfChanged } from "../changeDetection";
import { AO_SETTINGS, type PostEffects, type ToneMappingName } from "../postEffects";
import { planCameraPasses, type CameraPassPlan } from "../passPlan";
import { FINISH_SAMPLERS, FINISH_SHADER, FINISH_UNIFORMS, TONE_MAPPING_CODE } from "./finishShader";
import { reclusterForNextCamera } from "./lighting";
import { cascadeCasterList, type CascadeExpander, type CustomRenderList } from "./shadowCulling";
import type { RenderTarget } from "./renderTextures";
import { BabylonLuts } from "./lutTextures";
import type { BabylonLights2D } from "./lights2D";

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
  /**
   * ADR 0446 §3: the meshes this view draws (its cull task's object list, so its geometry pass and render pass draw the
   * same set), or absent for every mesh in the scene.
   */
  objects?: readonly AbstractMesh[];
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

/** A camera's 2D light textures (ADR 0399): handles per layer batch and style slot, and their wrapped textures once built. */
interface ViewLights2D {
  flat: FrameGraphTextureHandle[][];
  dirColor: FrameGraphTextureHandle[][];
  dirVec: FrameGraphTextureHandle[][];
  shadows: FrameGraphTextureHandle[];
  /** The camera's colour target size (what lit fragments' screen positions divide by). */
  size: [number, number];
  /** The light and shadow textures' size. */
  lightSize: [number, number];
  wrapped: Lights2DTextures | null;
}

/** @internal A camera's 2D light textures this frame, for the lit layered-quad material (`lights2DMaterial.ts`). */
export interface Lights2DTextures {
  /** The camera's colour target size in pixels. */
  size: [number, number];
  /** Per layer batch, per style slot: the flat light texture, and the directional colour and direction textures (empty without). */
  batches: { flat: ThinTexture[]; dirColor: ThinTexture[]; dirVec: ThinTexture[] }[];
  /** The shadow textures (a channel per shadowed light), for accurate lights in the lit material (ADR 0415). */
  shadows: ThinTexture[];
  /** The light and shadow textures' size in pixels. */
  lightSize: [number, number];
}

/** The frame graph task drawing a camera's 2D shadow and light textures (ADR 0399, 0413) through the rig. */
class FrameGraphLights2DTask extends FrameGraphTask {
  readonly outputTexture: FrameGraphTextureHandle;
  constructor(
    name: string,
    graph: FrameGraph,
    private readonly rig: BabylonLights2D,
    private readonly camera: TargetCamera,
    private readonly lights: ViewLights2D,
    private readonly lightSize: [number, number],
  ) {
    super(name, graph);
    this.outputTexture = this._frameGraph.textureManager.createDanglingHandle();
  }

  getClassName(): string {
    return "FrameGraphLights2DTask";
  }

  record(): void {
    const l = this.lights;
    const first = l.flat[0]?.[0] ?? l.shadows[0];
    if (first !== undefined) this._frameGraph.textureManager.resolveDanglingHandle(this.outputTexture, first);
    const engine = this._frameGraph.engine;
    const zero = { r: 0, g: 0, b: 0, a: 0 };
    const prepare = (context: { _applyRenderTarget(): void; clear(color: typeof zero, backBuffer: boolean, depth: boolean): void }) => {
      context._applyRenderTarget();
      engine.setViewport(FULL_VIEWPORT);
      context.clear(zero, true, false); // `true`: the colour buffer (Babylon calls it the back buffer)
    };
    l.shadows.forEach((handle, k) => {
      const pass = this._frameGraph.addRenderPass(`${this.name}_shadow${k}`);
      pass.setRenderTarget(handle);
      pass.setExecuteFunc((context) => {
        prepare(context as unknown as Parameters<typeof prepare>[0]);
        this.rig.drawShadows(k, this.camera.getTransformationMatrix());
      });
    });
    l.flat.forEach((row, b) =>
      row.forEach((flat, s) => {
        const pass = this._frameGraph.addRenderPass(`${this.name}_light${b}_${s}`);
        const directional = l.dirColor[b]?.length ? [flat, l.dirColor[b]![s]!, l.dirVec[b]![s]!] : null;
        pass.setRenderTarget(directional ?? flat);
        if (l.shadows.length) pass.addDependencies(l.shadows);
        pass.setExecuteFunc((context) => {
          prepare(context as unknown as Parameters<typeof prepare>[0]);
          this.rig.drawLights(b, s, this.camera.getTransformationMatrix(), this.lightSize, (effect, name, k) => {
            const h = l.shadows[k];
            if (h === undefined) return false;
            context.bindTextureHandle(effect, name, h);
            return true;
          });
        });
      }),
    );
    const disabled = this._frameGraph.addRenderPass(this.name + "_disabled", true);
    if (first !== undefined) disabled.setRenderTarget(first);
    disabled.setExecuteFunc(() => {});
  }
}

interface ViewTasks {
  render: FrameGraphObjectRendererTask;
  /** The object list its cull task reads (ADR 0446 §3). */
  objects: FrameGraphObjectList;
  /** The camera's 2D light textures (ADR 0399), or null without the pass. */
  lights2D: ViewLights2D | null;
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

/**
 * @internal ADR 0399: `camera`'s 2D light textures this frame, or null when it has none (no 2D lights, the graph
 * rebuilding, the camera not drawn). Call it while drawing (a material's bind); don't keep the result across frames.
 */
export function lights2DTextures(scene: Scene, camera: Camera): Lights2DTextures | null {
  return frames.get(scene)?.lights2DTextures(camera) ?? null;
}

/** @internal Whether `scene` is drawn by a frame graph (a World's renderer), so `sceneDepth` can serve it; previews and tools draw their own scenes. */
export function hasSceneFrame(scene: Scene): boolean {
  return frames.has(scene);
}

/** @internal The frame graph of one Babylon scene (ADR 0075 stage 3). */
export class BabylonFrame {
  private graph: FrameGraph | null = null;
  private key = "";
  private building = false;
  /** Disposed: a graph whose build finishes now is freed, not installed. */
  private disposed = false;
  private views: ViewTasks[] = [];
  /** The views of the frame being drawn (`beforeView` hands each its own). */
  private current: CameraView[] = [];
  private readonly expander = (): CascadeExpander | null => this.cascades;
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
  /** Called just before each camera draws its objects (the renderer fits the skybox to it), with its view when in a frame. */
  beforeView: ((camera: TargetCamera, view?: CameraView) => void) | null = null;
  /**
   * ADR 0446 §3: casters that stand for many (thin batches' casters), compacted per shadow cascade, or null. Read
   * while the shadow maps draw.
   */
  cascades: CascadeExpander | null = null;
  /** The meshes that cast shadows, refilled each frame. */
  private readonly casterList = new FrameGraphObjectList();
  private readonly casterMeshes: AbstractMesh[] = [];
  /** What asked for the scene depth (ADR 0109); while any is left, every camera gets a depth pass. */
  private readonly depthConsumers = new Set<object>();
  /** Colour lookup tables for the finish pass (ADR 0111). */
  private readonly luts: BabylonLuts;
  /** The 2D lighting rig this frame draws through (ADR 0399), or null. */
  private lights2D: BabylonLights2D | null = null;

  constructor(private readonly scene: Scene) {
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

  /** @internal ADR 0399: a camera's 2D light textures this frame (see `Lights2DTextures`), or null. */
  lights2DTextures(camera: Camera): Lights2DTextures | null {
    if (!this.graph || this.building) return null;
    const t = this.views.find((v) => v.render.camera === camera);
    const l = t?.lights2D;
    if (!l) return null;
    if (!l.wrapped) {
      const wrap = (h: FrameGraphTextureHandle): ThinTexture | null => {
        const internal = this.graph!.textureManager.getTextureFromHandle(h);
        return internal ? new ThinTexture(internal) : null;
      };
      const batches: Lights2DTextures["batches"] = [];
      for (let b = 0; b < l.flat.length; b++) {
        const flat = l.flat[b]!.map(wrap), dirColor = (l.dirColor[b] ?? []).map(wrap), dirVec = (l.dirVec[b] ?? []).map(wrap);
        if ([...flat, ...dirColor, ...dirVec].some((x) => !x)) return null;
        batches.push({ flat: flat as ThinTexture[], dirColor: dirColor as ThinTexture[], dirVec: dirVec as ThinTexture[] });
      }
      const shadows = l.shadows.map(wrap);
      if (shadows.some((x) => !x)) return null;
      l.wrapped = { size: l.size, batches, shadows: shadows as ThinTexture[], lightSize: l.lightSize };
    }
    return l.wrapped;
  }

  /** The drawing-buffer size of a camera's rectangle (or its render texture). */
  private viewSize(v: CameraView): { width: number; height: number } {
    if (v.target) return { width: v.target.width, height: v.target.height };
    const engine = this.scene.getEngine();
    return { width: Math.max(1, Math.round(v.viewport.width * engine.getRenderWidth())), height: Math.max(1, Math.round(v.viewport.height * engine.getRenderHeight())) };
  }

  /** Draw a frame: rebuild the graph if its layout changed, update every value, run it. */
  render(views: CameraView[], shadows: ShadowRequest[], casters: readonly AbstractMesh[], samples: number, lights2D: BabylonLights2D | null = null): void {
    refillIfChanged(this.casterMeshes, casters);
    const depth = this.depthConsumers.size > 0;
    const layout = lights2D?.layout() ?? null;
    this.lights2D = lights2D;
    const plans = views.map((v) => planCameraPasses(v.effects, depth, layout));
    // A view's position and "clear"/"over" decide whether its finish pass blends over the views before it.
    const key = JSON.stringify({
      samples,
      shadows: shadows.map((s) => [s.light.uniqueId, s.cascaded, s.mapSize, s.numCascades]),
      views: views.map((v, i) => [v.camera.uniqueId, this.viewSize(v), v.clear ? "clear" : "over", plans[i].key, !!v.overlay && !!this.overlay, !!v.ui && !!this.ui, !!v.previewUI && !!this.previewUI, v.target?.key ?? "", !!v.backdrop]),
    });
    if (key !== this.key && !this.building) this.rebuild(key, views, plans, shadows, samples);
    if (!this.graph || this.building) return;
    this.update(views, shadows);
    this.scene.render();
  }

  private rebuild(key: string, views: CameraView[], plans: CameraPassPlan[], shadows: ShadowRequest[], samples: number): void {
    this.key = key;
    this.scene.frameGraph = null;
    this.graph?.dispose();
    this.graph = null;
    this.views = [];
    this.shadowTasks = [];
    this.overlayTask = null;
    if (!views.length) return;
    const graph = new FrameGraph(this.scene, false);
    // The lit 2D material samples the 2D light textures in the render pass, behind the graph's back (ADR 0399): don't
    // let the graph reuse their memory for a texture made after the light pass.
    if (plans.some((p) => p.lights2D)) graph.optimizeTextureAllocation = false;
    // Every camera's clear runs before the shadow maps: a shadow map renders through Babylon's own render
    // target, behind the frame graph's back, and a clear right after it lands on the wrong target.
    const targets = views.map((v, i) => this.viewTargets(graph, v, plans[i], i, samples));
    this.shadowTasks = shadows.map((s, i) => this.shadowTask(graph, s, i, views[0].camera));
    this.views = views.map((v, i) => {
      const tasks = this.viewTasks(graph, v, plans[i], i, targets[i]);
      if (v.overlay && this.overlay && !this.overlayTask) {
        const task = new FrameGraphOverlayTask(`overlay${i}`, graph, this.overlay, v);
        task.targetTexture = backbufferColorTextureHandle;
        graph.addTask(task);
        this.overlayTask = task;
      }
      // The game's UI covers the editor's helpers.
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
        if (this.disposed || this.key !== key) return graph.dispose(); // disposed or replaced meanwhile
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
   * A camera's colour and depth textures and the task that clears them, plus, when its plan has a
   * geometry pass, that pass's own depth buffer and its clear. Without a depth buffer the geometry
   * pass draws with no depth test: the last mesh drawn wins, so ambient occlusion read the depth and
   * normals of meshes behind nearer ones and drew their edges through them.
   */
  private viewTargets(graph: FrameGraph, v: CameraView, plan: CameraPassPlan, i: number, samples: number): ViewTargets {
    const tm = graph.textureManager;
    const size = this.viewSize(v);
    const texture = (name: string, type: number, format: number, s = samples): FrameGraphTextureHandle =>
      tm.createRenderTargetTexture(`${name}${i}`, { size, sizeIsPercentage: false, options: { createMipMaps: false, samples: s, types: [type], formats: [format], useSRGBBuffers: [false], labels: [`${name}${i}`] } });
    const msaa = plan.multisample ? samples : 1;
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
    if (plan.geometry) {
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

  private viewTasks(graph: FrameGraph, v: CameraView, plan: CameraPassPlan, i: number, { clear, geometryDepth }: ViewTargets): ViewTasks {
    const tm = graph.textureManager;
    const size = this.viewSize(v);
    const has = (pass: CameraPassPlan["passes"][number]) => plan.passes.includes(pass);

    // Frustum culling: Babylon's frame graph object renderer draws every mesh in its list, so without
    // this every mesh in the scene was drawn (and readied) by every camera, on screen or not.
    // ADR 0446 §3: each view culls its own object list (`CameraView.objects`, set each frame in `update`); by default
    // every mesh in the scene (the scene's own list, so new meshes join at once).
    const objects = new FrameGraphObjectList();
    objects.meshes = this.scene.meshes;
    objects.particleSystems = this.scene.particleSystems;
    const cull = new FrameGraphCullObjectsTask(`cull${i}`, graph, this.scene);
    cull.camera = v.camera;
    cull.objectList = objects;
    graph.addTask(cull);

    // The geometry pass first (view depth and normals): ambient occlusion and depth of field read it after
    // the render pass, and what the render pass draws last (particles) may sample its depth (ADR 0109).
    let geometry: FrameGraphGeometryRendererTask | null = null;
    if (plan.geometry) {
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
      if (plan.geometry.normals) geometry.textureDescriptions.push({ type: Constants.PREPASS_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA });
      graph.addTask(geometry);
    }

    // The 2D light textures (ADR 0399): drawn before the render pass, which samples them in the lit 2D material.
    let lights2D: ViewLights2D | null = null;
    if (plan.lights2D && this.lights2D) {
      const l = plan.lights2D;
      const lightSize: [number, number] = [Math.max(1, Math.round(size.width * l.scale)), Math.max(1, Math.round(size.height * l.scale))];
      const make = (name: string, type: number) =>
        tm.createRenderTargetTexture(`${name}${i}`, { size: { width: lightSize[0], height: lightSize[1] }, sizeIsPercentage: false, options: { createMipMaps: false, samples: 1, types: [type], formats: [Constants.TEXTUREFORMAT_RGBA], useSRGBBuffers: [false], labels: [`${name}${i}`] } });
      const lightType = l.lowPrecision ? Constants.TEXTURETYPE_UNSIGNED_BYTE : Constants.TEXTURETYPE_HALF_FLOAT;
      lights2D = {
        flat: l.batches.map((b, bi) => Array.from({ length: b.styles }, (_, s) => make(`light2d_${bi}_${s}_`, lightType))),
        dirColor: l.batches.map((b, bi) => (b.directional ? Array.from({ length: b.styles }, (_, s) => make(`light2dDirColor_${bi}_${s}_`, lightType)) : [])),
        dirVec: l.batches.map((b, bi) => (b.directional ? Array.from({ length: b.styles }, (_, s) => make(`light2dDirVec_${bi}_${s}_`, lightType)) : [])),
        shadows: Array.from({ length: l.shadowTextures }, (_, k) => make(`shadow2d_${k}_`, Constants.TEXTURETYPE_UNSIGNED_BYTE)),
        size: [size.width, size.height],
        lightSize,
        wrapped: null,
      };
      graph.addTask(new FrameGraphLights2DTask(`lights2d${i}`, graph, this.lights2D, v.camera, lights2D, lightSize));
    }

    // Clustered lights (ADR 0079): the task runs the clustering pass before drawing. Babylon clusters
    // once a frame, for the first camera; first in line, this makes it cluster again for this one.
    const render = new FrameGraphObjectRendererTask(`render${i}`, graph, this.scene, { enableClusteredLights: true });
    render.objectRenderer.onInitRenderingObservable.add(() => reclusterForNextCamera(this.scene), undefined, true);
    render.objectRenderer.onBeforeRenderObservable.add(() => {
      this.beforeView?.(v.camera, this.current[i]);
      // The frame graph doesn't raise the scene's before-camera-render observable, which scene.render() without one
      // does for each camera: raise it here, before this camera draws (ADR 0444: quad batches' per-camera matrices).
      this.scene.onBeforeCameraRenderObservable.notifyObservers(v.camera);
    });
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
    if (plan.aoRatio !== null && geometry) {
      ao = new FrameGraphSSAO2RenderingPipelineTask(`ao${i}`, graph, plan.aoRatio, 1, Constants.TEXTURETYPE_HALF_FLOAT);
      ao.sourceTexture = source;
      ao.depthTexture = geometry.geometryViewDepthTexture;
      ao.normalTexture = geometry.geometryViewNormalTexture;
      ao.camera = v.camera;
      graph.addTask(ao);
      source = ao.outputTexture;
    }
    let dof: FrameGraphDepthOfFieldTask | null = null;
    if (has("dof") && geometry) {
      dof = new FrameGraphDepthOfFieldTask(`dof${i}`, graph, ThinDepthOfFieldEffectBlurLevel.Medium, true);
      dof.sourceTexture = source;
      dof.depthTexture = geometry.geometryViewDepthTexture;
      dof.camera = v.camera;
      graph.addTask(dof);
      source = dof.outputTexture;
    }
    let bloom: FrameGraphBloomTask | null = null;
    if (has("bloom")) {
      // Its weight, threshold and kernel are set each frame (`update`), before the graph first runs.
      bloom = new FrameGraphBloomTask(`bloom${i}`, graph, 0.3, 64, 0.9, true, 0.5);
      bloom.sourceTexture = source;
      graph.addTask(bloom);
      source = bloom.outputTexture;
    }
    let ca: FrameGraphChromaticAberrationTask | null = null;
    if (has("ca")) {
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
    // A render texture asset (ADR 0109) is the whole target; otherwise the camera's rectangle of the canvas.
    const output = v.target ? tm.importTexture(`target${i}`, v.target.texture) : backbufferColorTextureHandle;
    const viewport = { x: v.viewport.x, y: v.viewport.y, width: v.viewport.width, height: v.viewport.height };
    if (i > 0 && !v.clear) finish.postProcess.alphaMode = Constants.ALPHA_COMBINE; // an overlay camera blends over the ones before
    let fxaa: FrameGraphFXAATask | null = null;
    if (plan.finishToLdr) {
      finish.targetTexture = tm.createRenderTargetTexture(`ldr${i}`, { size, sizeIsPercentage: false, options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_UNSIGNED_BYTE], formats: [Constants.TEXTUREFORMAT_RGBA], useSRGBBuffers: [false], labels: [`ldr${i}`] } });
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
    return { render, objects, lights2D, geometry, ao, dof, bloom, ca, finish, fxaa, clear, finishValues, depth: null, lutPath: null };
  }

  /** Values that change without changing the graph's layout. */
  private update(views: CameraView[], shadows: ShadowRequest[]): void {
    this.current = views;
    shadows.forEach((s, i) => {
      const task = this.shadowTasks[i];
      if (task instanceof FrameGraphCascadedShadowGeneratorTask) {
        task.shadowMaxZ = s.shadowMaxZ;
        cullCascades(task, this.expander);
      }
    });
    views.forEach((v, i) => {
      const t = this.views[i];
      if (!t) return;
      t.objects.meshes = (v.objects as AbstractMesh[] | undefined) ?? this.scene.meshes;
      if (v.overlay && this.overlayTask) this.overlayTask.view = v;
      const transparent = { r: 0, g: 0, b: 0, a: 0 };
      t.clear.color.copyFrom(v.backdrop ? (transparent as Color4) : (v.clear ?? (transparent as Color4)));
      const e = v.effects;
      if (t.ao && e?.ambientOcclusion) {
        t.ao.ssao.totalStrength = e.ambientOcclusion.intensity * 0.5;
        t.ao.ssao.radius = e.ambientOcclusion.radius;
        // Only on a change: Babylon's setter recompiles and draws a new random kernel (the AO noise shimmered every frame).
        const samples = AO_SETTINGS[e.ambientOcclusion.quality].samples;
        if (t.ao.ssao.samples !== samples) t.ao.ssao.samples = samples;
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

  dispose(): void {
    this.disposed = true;
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
function cullCascades(task: FrameGraphCascadedShadowGeneratorTask, expander: () => CascadeExpander | null): void {
  const generator = (task as unknown as { _shadowGenerator?: CascadedShadowGenerator })._shadowGenerator;
  const map = generator?.getShadowMap();
  if (!generator || !map) return;
  let list = cascadeLists.get(generator);
  if (!list) cascadeLists.set(generator, (list = cascadeCasterList((layer) => generator.getCascadeTransformMatrix(layer), expander)));
  if (map.getCustomRenderList !== list) map.getCustomRenderList = list as typeof map.getCustomRenderList;
}
