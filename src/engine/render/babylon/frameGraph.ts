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
 * The editor's overlay (a utility layer: outlines, icons, gizmos; stage 8) draws right after the camera
 * marked `overlay`, straight onto the canvas without post-processing, so a camera preview inset drawn
 * after it covers it.
 *
 * The graph is rebuilt only when its layout changes (cameras, their sizes and effects, shadow
 * lights, MSAA); every value is updated in place each frame.
 */
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph.js";
import { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList.js";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import type { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import { backbufferColorTextureHandle, type FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes.js";
import { FrameGraphBloomTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask.js";
import { FrameGraphChromaticAberrationTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/chromaticAberrationTask.js";
import { FrameGraphCustomPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/customPostProcessTask.js";
import { FrameGraphDepthOfFieldTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/depthOfFieldTask.js";
import { FrameGraphFXAATask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/fxaaTask.js";
import { FrameGraphSSAO2RenderingPipelineTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/ssao2RenderingPipelineTask.js";
import { FrameGraphCascadedShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/csmShadowGeneratorTask.js";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask.js";
import { FrameGraphShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/shadowGeneratorTask.js";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js";
import type { IShadowLight } from "@babylonjs/core/Lights/shadowLight.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import type { Effect } from "@babylonjs/core/Materials/effect.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { Color4 } from "@babylonjs/core/Maths/math.color.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { ThinDepthOfFieldEffectBlurLevel } from "@babylonjs/core/PostProcesses/thinDepthOfFieldEffect.js";
import { stackKey, type PostEffects, type ToneMappingName } from "../PostProcessStack";
import { FINISH_SHADER, FINISH_UNIFORMS, TONE_MAPPING_CODE } from "./finishShader";

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
}

const FULL_VIEWPORT = new Viewport(0, 0, 1, 1);

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
}

/** A camera's clear task, and the geometry pass's depth buffer (cleared) when it has one. */
interface ViewTargets {
  clear: FrameGraphClearTextureTask;
  geometryDepth: FrameGraphTextureHandle | null;
}

const AO_SAMPLES = { low: 8, medium: 16, high: 32 } as const;

/** @internal One kind of pass in a camera's part of the frame. */
export type PassKind = "clear" | "render" | "geometry" | "ao" | "dof" | "bloom" | "ca" | "finish" | "fxaa";

/**
 * @internal A camera's passes, in order, for its effects (null: none). The builder follows this list;
 * it's separate so the layout is tested without a GPU.
 */
export function cameraPasses(effects: PostEffects | null): PassKind[] {
  const passes: PassKind[] = ["clear", "render"];
  if (effects?.ambientOcclusion || effects?.depthOfField) passes.push("geometry"); // view depth and normals
  if (effects?.ambientOcclusion) passes.push("ao");
  if (effects?.depthOfField) passes.push("dof");
  if (effects?.bloom) passes.push("bloom");
  if (effects?.chromaticAberration) passes.push("ca");
  passes.push("finish");
  // Babylon's frame graph has no SMAA: FXAA stands in for it.
  if (effects?.antialias === "fxaa" || effects?.antialias === "smaa") passes.push("fxaa");
  return passes;
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
  /** Every mesh in the scene, drawn by each camera (the scene's own list, so new meshes join at once). */
  private readonly objects = new FrameGraphObjectList();
  /** The meshes that cast shadows, refilled each frame. */
  private readonly casterList = new FrameGraphObjectList();
  private readonly casterMeshes: Mesh[] = [];

  constructor(private readonly scene: Scene) {
    this.objects.meshes = scene.meshes;
    this.objects.particleSystems = scene.particleSystems;
    this.casterList.meshes = this.casterMeshes;
    this.casterList.particleSystems = [];
  }

  /** Whether a graph is ready to draw. */
  get ready(): boolean {
    return !!this.graph && !this.building;
  }

  /** The drawing-buffer size of a camera's rectangle. */
  private viewSize(v: CameraView): { width: number; height: number } {
    const engine = this.scene.getEngine();
    return { width: Math.max(1, Math.round(v.viewport.width * engine.getRenderWidth())), height: Math.max(1, Math.round(v.viewport.height * engine.getRenderHeight())) };
  }

  /** Draw a frame: rebuild the graph if its layout changed, update every value, run it. */
  render(views: CameraView[], shadows: ShadowRequest[], casters: readonly Mesh[], samples: number): void {
    this.casterMeshes.length = 0;
    this.casterMeshes.push(...casters);
    const key = JSON.stringify({
      samples,
      shadows: shadows.map((s) => [s.light.uniqueId, s.cascaded, s.mapSize, s.numCascades]),
      views: views.map((v, i) => [v.camera.uniqueId, this.viewSize(v), v.clear ? "clear" : "over", v.effects ? stackKey(v.effects, i > 0 && !v.clear) : "plain", !!v.overlay && !!this.overlay]),
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
    const depth = texture("depth", Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_DEPTH32_FLOAT, msaa);

    const clear = new FrameGraphClearTextureTask(`clear${i}`, graph);
    clear.targetTexture = color;
    clear.depthTexture = depth;
    clear.clearColor = true;
    clear.clearDepth = true;
    clear.clearStencil = false;
    clear.convertColorToLinearSpace = true; // the finish pass encodes sRGB
    graph.addTask(clear);

    let geometryDepth: FrameGraphTextureHandle | null = null;
    if (cameraPasses(effects).includes("geometry")) {
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

    const render = new FrameGraphObjectRendererTask(`render${i}`, graph, this.scene);
    render.targetTexture = clear.outputTexture;
    render.depthTexture = clear.outputDepthTexture;
    render.camera = v.camera;
    render.objectList = this.objects;
    render.shadowGenerators = this.shadowTasks;
    render.isMainObjectRenderer = i === 0;
    render.forceLayerMaskCheck = true; // editor-only meshes (EDITOR_LAYER_MASK) show to editor cameras only
    render.disableImageProcessing = true; // linear HDR out; the finish pass tone maps
    render.resolveMSAAColors = true; // the passes after it sample the resolved colours
    graph.addTask(render);
    let source = render.outputTexture;

    let geometry: FrameGraphGeometryRendererTask | null = null;
    const plan = new Set(cameraPasses(effects));
    if (plan.has("geometry")) {
      geometry = new FrameGraphGeometryRendererTask(`geometry${i}`, graph, this.scene);
      geometry.camera = v.camera;
      geometry.objectList = this.objects;
      geometry.size = { width: size.width, height: size.height };
      geometry.sizeIsPercentage = false; // the default reads the size as a percentage of the canvas
      geometry.samples = 1;
      if (geometryDepth) geometry.depthTexture = geometryDepth; // depth-tested, like the render pass
      geometry.textureDescriptions = [
        // Half float: WebGPU can't filter 32-bit float textures, and the AO and depth-of-field passes sample with filtering.
        { type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_R },
        { type: Constants.PREPASS_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
      ];
      graph.addTask(geometry);
    }
    let ao: FrameGraphSSAO2RenderingPipelineTask | null = null;
    if (plan.has("ao") && effects?.ambientOcclusion && geometry) {
      ao = new FrameGraphSSAO2RenderingPipelineTask(`ao${i}`, graph, 1, 1, Constants.TEXTURETYPE_HALF_FLOAT);
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
    });
    const finishValues: Record<string, [number, number, number, number]> = {};
    finish.onApplyObservable.add((effect: Effect) => {
      for (const u of FINISH_UNIFORMS) {
        const [x, y, z, w] = finishValues[u] ?? [0, 0, 0, 0];
        effect.setFloat4(u, x, y, z, w);
      }
    });
    finish.sourceTexture = source;
    const fxaaWanted = plan.has("fxaa");
    const viewport = { x: v.viewport.x, y: v.viewport.y, width: v.viewport.width, height: v.viewport.height };
    if (i > 0 && !v.clear) finish.postProcess.alphaMode = Constants.ALPHA_COMBINE; // an overlay camera blends over the ones before
    let fxaa: FrameGraphFXAATask | null = null;
    if (fxaaWanted) {
      finish.targetTexture = texture("ldr", Constants.TEXTURETYPE_UNSIGNED_BYTE, Constants.TEXTUREFORMAT_RGBA, 1);
      graph.addTask(finish);
      fxaa = new FrameGraphFXAATask(`fxaa${i}`, graph);
      fxaa.sourceTexture = finish.outputTexture;
      fxaa.targetTexture = backbufferColorTextureHandle;
      fxaa.viewport = viewport;
      if (i > 0 && !v.clear) fxaa.postProcess.alphaMode = Constants.ALPHA_COMBINE;
      graph.addTask(fxaa);
    } else {
      finish.targetTexture = backbufferColorTextureHandle;
      finish.viewport = viewport;
      graph.addTask(finish);
    }
    return { render, geometry, ao, dof, bloom, ca, finish, fxaa, clear, finishValues };
  }

  /** Values that change without changing the graph's layout. */
  private update(views: CameraView[], shadows: ShadowRequest[]): void {
    shadows.forEach((s, i) => {
      const task = this.shadowTasks[i];
      if (task instanceof FrameGraphCascadedShadowGeneratorTask) task.shadowMaxZ = s.shadowMaxZ;
    });
    views.forEach((v, i) => {
      const t = this.views[i];
      if (!t) return;
      if (v.overlay && this.overlayTask) this.overlayTask.view = v;
      const transparent = { r: 0, g: 0, b: 0, a: 0 };
      t.clear.color.copyFrom(v.clear ?? (transparent as Color4));
      const e = v.effects;
      if (t.ao && e?.ambientOcclusion) {
        t.ao.ssao.totalStrength = e.ambientOcclusion.intensity * 0.5;
        t.ao.ssao.radius = e.ambientOcclusion.radius;
        t.ao.ssao.samples = AO_SAMPLES[e.ambientOcclusion.quality as keyof typeof AO_SAMPLES] ?? 16;
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
      f.tone = [v.exposure, TONE_MAPPING_CODE[v.toneMapping], e?.vignette ? 1 : 0, 0];
      f.vignetteShape = [e?.vignette?.darkness ?? 0, e?.vignette?.offset ?? 0, 0, 0];
    });
  }

  /** Tests and the editor: whether the last frame's first camera ran any effect. */
  state(views: CameraView[]): { composed: boolean; loaded: boolean } {
    return { composed: !!views[0]?.effects, loaded: this.ready };
  }

  dispose(): void {
    this.scene.frameGraph = null;
    this.graph?.dispose();
    this.graph = null;
  }
}


