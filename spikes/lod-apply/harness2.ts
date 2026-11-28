/** Helpers for the lod-apply spike on top of the lod-crossfade harness: a frame graph with optional geometry pass, stats. */
export * from "../lod-crossfade/harness";
import {
  backbufferColorTextureHandle, backbufferDepthStencilTextureHandle, Color4, FrameGraph, FrameGraphClearTextureTask, FrameGraphCullObjectsTask,
  FrameGraphObjectList, FrameGraphObjectRendererTask, MarkerTask, state, type AbstractMesh, type Env, type FreeCamera,
} from "../lod-crossfade/harness";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import "@babylonjs/core/Shaders/geometry.vertex.js";
import "@babylonjs/core/Shaders/geometry.fragment.js";
import "@babylonjs/core/ShadersWGSL/geometry.vertex.js";
import "@babylonjs/core/ShadersWGSL/geometry.fragment.js";

export interface View2 {
  name: string;
  camera: FreeCamera;
  /** Live array behind this view's cull `FrameGraphObjectList.meshes`; mutate in place each frame. */
  objects: AbstractMesh[];
  before?: () => void;
  after?: () => void;
  /** Also draw a depth + normals geometry pass fed with the cull output (the engine's shape). */
  geometry?: { width: number; height: number; onDepth?: (depth: Float32Array) => void; before?: () => void; after?: () => void };
}
export interface Graph2 { graph: FrameGraph; culls: FrameGraphCullObjectsTask[]; renders: FrameGraphObjectRendererTask[]; geoms: (FrameGraphGeometryRendererTask | null)[] }

/** clear -> per view [cull -> (geometry) -> render], views drawing into viewports of the back buffer. */
export async function buildGraph2(env: Env, views: View2[]): Promise<Graph2> {
  const { scene } = env;
  const graph = new FrameGraph(scene, false);
  const clear = new FrameGraphClearTextureTask("clear", graph);
  clear.targetTexture = backbufferColorTextureHandle;
  clear.depthTexture = backbufferDepthStencilTextureHandle;
  clear.clearColor = true; clear.clearDepth = true; clear.clearStencil = false;
  clear.color = new Color4(0, 0, 0, 1);
  graph.addTask(clear);
  const culls: FrameGraphCullObjectsTask[] = [], renders: FrameGraphObjectRendererTask[] = [], geoms: (FrameGraphGeometryRendererTask | null)[] = [];
  for (const v of views) {
    const cull = new FrameGraphCullObjectsTask(`cull:${v.name}`, graph, scene);
    cull.camera = v.camera;
    const list = new FrameGraphObjectList();
    list.meshes = v.objects; list.particleSystems = [];
    cull.objectList = list;
    graph.addTask(cull);
    culls.push(cull);
    let geom: FrameGraphGeometryRendererTask | null = null;
    if (v.geometry) {
      const g = v.geometry;
      geom = new FrameGraphGeometryRendererTask(`geometry:${v.name}`, graph, scene);
      geom.camera = v.camera;
      geom.objectList = cull.outputObjectList;
      geom.size = { width: g.width, height: g.height };
      geom.sizeIsPercentage = false;
      geom.samples = 1;
      geom.textureDescriptions = [
        { type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_R },
        { type: Constants.PREPASS_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
      ];
      graph.addTask(geom);
      const gr = (geom as unknown as { objectRenderer: { onBeforeRenderObservable: { add(f: () => void): void }; onAfterRenderObservable: { add(f: () => void): void } } }).objectRenderer;
      gr.onBeforeRenderObservable.add(() => { state.tag = `geom:${v.name}`; g.before?.(); });
      gr.onAfterRenderObservable.add(() => g.after?.());
      const gt = geom;
      if (g.onDepth) {
        graph.addTask(new MarkerTask(`mark:depth:${v.name}`, graph, () => {
          const tex = graph.textureManager.getTextureFromHandle(gt.geometryViewDepthTexture);
          const eng = env.engine as unknown as { _readTexturePixelsSync(t: unknown, w: number, h: number): Float32Array };
          g.onDepth!(eng._readTexturePixelsSync(tex, g.width, g.height));
        }));
      }
    }
    geoms.push(geom);
    const render = new FrameGraphObjectRendererTask(`render:${v.name}`, graph, scene);
    render.objectRenderer.onBeforeRenderObservable.add(() => { state.tag = `render:${v.name}`; v.before?.(); });
    render.objectRenderer.onAfterRenderObservable.add(() => v.after?.());
    render.targetTexture = backbufferColorTextureHandle;
    render.depthTexture = backbufferDepthStencilTextureHandle;
    render.camera = v.camera;
    render.objectList = cull.outputObjectList;
    render.disableImageProcessing = true;
    render.forceLayerMaskCheck = true;
    graph.addTask(render);
    renders.push(render);
  }
  await graph.buildAsync(false);
  await graph.whenReadyAsync(16, 60000);
  scene.frameGraph = graph;
  return { graph, culls, renders, geoms };
}

export const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
export const stats = (xs: number[]): { p50: number; p99: number; max: number; mean: number; n: number } => ({
  p50: +pct(xs, 50).toFixed(3), p99: +pct(xs, 99).toFixed(3), max: +Math.max(...xs).toFixed(3), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3), n: xs.length,
});
