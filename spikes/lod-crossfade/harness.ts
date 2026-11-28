/** Shared helpers for the LOD-crossfade spike: engine, scene, frame graph, pixel reads, draw-call log. */
import "@babylonjs/core/Engines/Extensions/engine.alpha.js";
import "@babylonjs/core/Engines/Extensions/engine.alphaToCoverage.js";
import "@babylonjs/core/Engines/Extensions/engine.cubeTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.multiRender.js";
import "@babylonjs/core/Engines/Extensions/engine.query.js";
import "@babylonjs/core/Engines/Extensions/engine.rawTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.readTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.renderTarget.js";
import "@babylonjs/core/Engines/Extensions/engine.renderTargetCube.js";
import "@babylonjs/core/Engines/Extensions/engine.renderTargetTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.uniformBuffer.js";
import "@babylonjs/core/Engines/Extensions/engine.dynamicBuffer.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import "@babylonjs/core/Meshes/instancedMesh.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Effect } from "@babylonjs/core/Materials/effect.js";
import { Scene } from "@babylonjs/core/scene.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph.js";
import { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList.js";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask.js";
import { backbufferColorTextureHandle, backbufferDepthStencilTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes.js";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask.js";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask.js";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js";
import { FrameGraphShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/shadowGeneratorTask.js";
import { FrameGraphCascadedShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/csmShadowGeneratorTask.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import type { IShadowLight } from "@babylonjs/core/Lights/shadowLight.js";

Effect.PersistentMode = true; // as the engine does

export { Engine, Scene, FreeCamera, Camera, Vector3, Matrix, Color3, Color4, Viewport, PBRMaterial, CreateBox, CreatePlane, FrameGraph, FrameGraphObjectList, FrameGraphTask, FrameGraphCullObjectsTask, FrameGraphObjectRendererTask, FrameGraphClearTextureTask, FrameGraphShadowGeneratorTask, FrameGraphCascadedShadowGeneratorTask, ShadowGenerator, DirectionalLight, backbufferColorTextureHandle, backbufferDepthStencilTextureHandle };
export type { Mesh, AbstractMesh, IShadowLight };

// ---- draw-call log: wraps the WebGL2 draw functions, tagged by whoever is "current" ----------------------
export interface DrawRecord { tag: string; fn: string; instances: number }
export const drawLog: DrawRecord[] = [];
export const state = { tag: "none" };
let patched = false;
export function patchGl(): void {
  if (patched) return;
  patched = true;
  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const fn of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
    const orig = proto[fn];
    proto[fn] = function (this: unknown, ...a: unknown[]) {
      const instanced = fn.endsWith("Instanced");
      drawLog.push({ tag: state.tag, fn, instances: instanced ? (a[4] as number) ?? 1 : 1 });
      return orig.apply(this, a);
    };
  }
}
/** Draw calls and instances logged under a tag since `drawLog` was last cleared. */
export const drawsOf = (tag: string): { calls: number; instances: number } => {
  const r = drawLog.filter((d) => d.tag === tag);
  return { calls: r.length, instances: r.reduce((s, d) => s + d.instances, 0) };
};

// ---- engine / scene ---------------------------------------------------------------------------------------
export interface Env { canvas: HTMLCanvasElement; engine: Engine; scene: Scene; gl: WebGL2RenderingContext; dispose(): void }

export function makeEnv(width: number, height: number): Env {
  patchGl();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  document.body.appendChild(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, antialias: false, disableWebGL2Support: false }, false);
  engine.setSize(width, height);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  scene.imageProcessingConfiguration.isEnabled = false;
  scene.autoClear = true;
  const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
  return {
    canvas, engine, scene, gl,
    dispose() { scene.dispose(); engine.dispose(); canvas.remove(); },
  };
}

/** Unlit flat-colour PBR material (linear albedo straight out, no image processing). */
export function flat(scene: Scene, name: string, r: number, g: number, b: number): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.unlit = true;
  m.albedoColor = new Color3(r, g, b);
  m.disableLighting = true;
  return m;
}

/** Orthographic camera looking down +z from z = -10 over [-half, half] horizontally and vertically. */
export function orthoCamera(scene: Scene, name: string, half: number, viewport?: Viewport): FreeCamera {
  const c = new FreeCamera(name, new Vector3(0, 0, -10), scene);
  c.setTarget(new Vector3(0, 0, 0));
  c.mode = Camera.ORTHOGRAPHIC_CAMERA;
  c.orthoLeft = -half; c.orthoRight = half; c.orthoTop = half; c.orthoBottom = -half;
  c.minZ = 0.1; c.maxZ = 50;
  if (viewport) c.viewport = viewport;
  return c;
}

/** RGBA pixels of the whole canvas (row 0 = top, as displayed). */
export function readCanvas(env: Env): Uint8Array {
  const { gl, canvas } = env;
  const w = canvas.width, h = canvas.height;
  const raw = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

/** Pixels in a rectangle [x0,x1) x [y0,y1) whose predicate holds. */
export function count(px: Uint8Array, w: number, rect: [number, number, number, number], pred: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0]; x < rect[2]; x++) {
    const i = (y * w + x) * 4;
    if (pred(px[i], px[i + 1], px[i + 2])) n++;
  }
  return n;
}
/** A boolean mask of the pixels satisfying `pred`. */
export function mask(px: Uint8Array, pred: (r: number, g: number, b: number) => boolean): Uint8Array {
  const m = new Uint8Array(px.length / 4);
  for (let i = 0; i < m.length; i++) m[i] = pred(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) ? 1 : 0;
  return m;
}
export const isLit = (r: number, g: number, b: number): boolean => r > 128 || g > 128 || b > 128;
export const isRed = (r: number, g: number, b: number): boolean => r > 128 && g < 64 && b < 64;
export const isGreen = (r: number, g: number, b: number): boolean => g > 128 && r < 64 && b < 64;

// ---- frame graph ------------------------------------------------------------------------------------------
/** A task that runs a callback at its place in the graph (for hook-order tracing). */
export class MarkerTask extends FrameGraphTask {
  constructor(name: string, graph: FrameGraph, private readonly fn: () => void) { super(name, graph); }
  getClassName(): string { return "MarkerTask"; }
  record(): void {
    const pass = this._frameGraph.addPass(this.name);
    pass.setExecuteFunc(() => this.fn());
  }
}

export interface ViewSpec {
  name: string;
  camera: FreeCamera;
  /** Meshes the view's cull task starts from (default: every scene mesh at graph-build time). */
  objects?: AbstractMesh[];
  before?: () => void;
  after?: () => void;
}
export interface ShadowSpec { light: IShadowLight; camera: FreeCamera; casters: AbstractMesh[]; cascaded?: boolean; mapSize?: number; cascades?: number; filter?: number }

export interface BuiltGraph {
  graph: FrameGraph;
  log: string[];
  culls: FrameGraphCullObjectsTask[];
  renders: FrameGraphObjectRendererTask[];
  shadows: (FrameGraphShadowGeneratorTask | FrameGraphCascadedShadowGeneratorTask)[];
  ready: boolean;
}

/**
 * The engine's frame graph shape (frameGraph.ts): clear, shadow tasks, then per view a cull task and an object
 * renderer whose `onBeforeRenderObservable` runs the view hook. Views draw into viewports of the back buffer.
 */
export async function buildGraph(env: Env, views: ViewSpec[], shadows: ShadowSpec[] = [], onShadowBefore?: () => void, readyTimeout = 30000): Promise<BuiltGraph> {
  const { scene } = env;
  const graph = new FrameGraph(scene, false);
  const log: string[] = [];
  const clear = new FrameGraphClearTextureTask("clear", graph);
  clear.targetTexture = backbufferColorTextureHandle;
  clear.depthTexture = backbufferDepthStencilTextureHandle;
  clear.clearColor = true;
  clear.clearDepth = true;
  clear.clearStencil = false;
  clear.color = new Color4(0, 0, 0, 1);
  graph.addTask(clear);
  graph.addTask(new MarkerTask("mark:clear-done", graph, () => { state.tag = "pre-shadow"; log.push("clear"); }));

  const shadowTasks: BuiltGraph["shadows"] = shadows.map((s, i) => {
    const t = s.cascaded ? new FrameGraphCascadedShadowGeneratorTask(`shadow${i}`, graph) : new FrameGraphShadowGeneratorTask(`shadow${i}`, graph);
    t.light = s.light;
    t.camera = s.camera;
    const list = new FrameGraphObjectList();
    list.meshes = s.casters;
    list.particleSystems = [];
    t.objectList = list;
    t.mapSize = s.mapSize ?? 512;
    t.filter = s.filter ?? ShadowGenerator.FILTER_NONE;
    t.bias = 0.002;
    t.darkness = 0;
    if (t instanceof FrameGraphCascadedShadowGeneratorTask) { t.numCascades = s.cascades ?? 2; t.shadowMaxZ = 40; }
    graph.addTask(t);
    const sm = t.shadowGenerator.getShadowMap()!;
    sm.onBeforeRenderObservable.add((layer: number) => { state.tag = `shadow`; log.push(`shadow-map-before(${layer})`); onShadowBefore?.(); });
    sm.onAfterRenderObservable.add((layer: number) => { log.push(`shadow-map-after(${layer})`); });
    return t;
  });
  graph.addTask(new MarkerTask("mark:shadows-done", graph, () => { state.tag = "post-shadow"; log.push("shadows-done"); }));

  const culls: FrameGraphCullObjectsTask[] = [];
  const renders: FrameGraphObjectRendererTask[] = [];
  for (const v of views) {
    const cull = new FrameGraphCullObjectsTask(`cull:${v.name}`, graph, scene);
    cull.camera = v.camera;
    const list = new FrameGraphObjectList();
    list.meshes = v.objects ?? scene.meshes.slice();
    list.particleSystems = [];
    cull.objectList = list;
    graph.addTask(cull);
    graph.addTask(new MarkerTask(`mark:cull-done:${v.name}`, graph, () => log.push(`cull-done(${v.name}) visible=${cull.outputObjectList.meshes?.length}`)));
    culls.push(cull);

    const render = new FrameGraphObjectRendererTask(`render:${v.name}`, graph, scene);
    render.objectRenderer.onBeforeRenderObservable.add(() => {
      state.tag = v.name;
      log.push(`before(${v.name})`);
      v.before?.();
    });
    render.objectRenderer.onAfterRenderObservable.add(() => {
      v.after?.();
      log.push(`after(${v.name})`);
    });
    render.targetTexture = backbufferColorTextureHandle;
    render.depthTexture = backbufferDepthStencilTextureHandle;
    render.camera = v.camera;
    render.objectList = cull.outputObjectList;
    render.shadowGenerators = shadowTasks;
    render.disableImageProcessing = true;
    render.forceLayerMaskCheck = true;
    graph.addTask(render);
    renders.push(render);
  }
  await graph.buildAsync(false);
  let ready = true;
  try {
    await graph.whenReadyAsync(16, readyTimeout);
  } catch {
    ready = false; // some task (typically a shadow task) never became ready
  }
  scene.frameGraph = graph;
  return { graph, log, culls, renders, shadows: shadowTasks, ready };
}

/** Wait until every material of the scene is ready (shaders compiled), then render `frames` frames. */
export async function settle(env: Env, frames = 3): Promise<boolean> {
  for (let i = 0; i < frames; i++) {
    env.scene.render();
    await new Promise((r) => setTimeout(r, 30));
  }
  // `whenReadyAsync` can retry for a long time when some mesh never becomes ready: cap it.
  return Promise.race([env.scene.whenReadyAsync().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
}

export function effectCount(env: Env): number {
  return Object.keys((env.engine as unknown as { _compiledEffects: object })._compiledEffects).length;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
