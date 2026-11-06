/**
 * What the editor's Babylon preview renderers share (ADR 0061, 0075 stage 7): making an engine on a
 * canvas (WebGPU, else the WebGL2 fallback), a scene lit like the editor's default one, the studio
 * environment, loading project textures into a scene, and building material assets and shader graphs
 * as Babylon materials. Babylon types stay inside `render/babylon/` (ADR 0010).
 *
 * Previews draw straight into their engine's canvas and copy it (`drawImage`) into a 2D canvas in the
 * same task: a WebGPU canvas can't be read after it's presented, but it can be right after drawing.
 * Colours: the scene's own image processing converts linear light to sRGB with no tone mapping, like
 * the three.js previews' `WebGLRenderer` defaults.
 */
import "../register";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../../scene/Assets";
import type { ImportSettings } from "../../../scene/importSettings";
import { materialGraph, parseMaterial, type MaterialSettings } from "../../../scene/material";
import { parseShaderGraph, type GraphValue, type ShaderGraph } from "../../../scene/shaderGraph";
import { Graphics } from "../../Graphics";
import { compileShaderGraph } from "../../shaderGraph/compile";
import { createGraphMaterial, type GraphShared } from "../graphMaterial";
import { applyBuiltinSettings, pbr, tiledTexture } from "../materials";
import { studioHdrUrl } from "../studioEnvironment";

/** What a thumbnail's lights are (the editor's default scene: soft ambient, a sun, the studio room). */
export const LIGHT_AMBIENT = 0.45;
export const LIGHT_SUN = 1.6;
export const LIGHT_ENVIRONMENT = 0.5;

/**
 * A Babylon engine drawing into `canvas`: WebGPU where the browser has it, else the WebGL2 engine (loaded
 * only then). `alpha` keeps the canvas transparent where nothing is drawn.
 */
export async function createPreviewEngine(canvas: HTMLCanvasElement, antialias = true): Promise<AbstractEngine> {
  if (await WebGPUEngine.IsSupportedAsync) {
    try {
      const gpu = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: false });
      await gpu.initAsync();
      return gpu;
    } catch (err) {
      console.warn("[myco] preview: WebGPU couldn't start; using WebGL2:", err);
    }
  }
  const { Engine } = await import("@babylonjs/core/Engines/engine.js");
  return new Engine(canvas, antialias, { adaptToDeviceRatio: false, alpha: true, preserveDrawingBuffer: true });
}

/** A right-handed scene (the engine's convention, ADR 0014) that clears to transparent. */
export function createPreviewScene(engine: AbstractEngine): Scene {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.autoClear = true;
  scene.clearColor = new Color4(0, 0, 0, 0);
  return scene;
}

/** Soft ambient light and a sun from above and in front, like the editor's default scene. */
export function addPreviewLights(scene: Scene, ambient: number, sun: number): { ambient: HemisphericLight; sun: DirectionalLight } {
  const hemi = new HemisphericLight("preview.ambient", new Vector3(0, 1, 0), scene);
  hemi.intensity = ambient;
  hemi.groundColor = new Color3(1, 1, 1); // three's AmbientLight: the same from every direction
  hemi.specular = Color3.Black();
  const light = new DirectionalLight("preview.sun", new Vector3(-4, -10, -6).normalize(), scene);
  light.intensity = sun;
  return { ambient: hemi, sun: light };
}

/** The studio room's prefiltered cube, made in `scene` (see {@link useWhenReady}). */
export function createStudioTexture(scene: Scene): HDRCubeTexture {
  return new HDRCubeTexture(studioHdrUrl(), scene, 128, false, true, false, true);
}

/**
 * Give `scene` an environment texture once it's ready: prefiltering swaps a cube's GPU texture when it
 * finishes, and a material that bound the first one on WebGPU would keep drawing with it once it's
 * destroyed (ADR 0075, stage 2). Resolves true when it was set, false if it never got ready (or the
 * scene went first).
 */
export function useWhenReady(scene: Scene, texture: BaseTexture, intensity: number, timeoutMs = 4000): Promise<boolean> {
  scene.environmentIntensity = intensity;
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (scene.isDisposed) return resolve(false);
      if (texture.isReady()) {
        scene.environmentTexture = texture;
        return resolve(true);
      }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(poll, 16);
    };
    poll();
  });
}

/** Resolves true when everything in `scene` can draw (materials compiled, textures loaded), false after `timeoutMs`. */
export function sceneReady(scene: Scene, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    scene.whenReadyAsync().then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** Draw one frame of `scene` into the engine's canvas. */
export function renderFrame(engine: AbstractEngine, scene: Scene): void {
  engine.beginFrame();
  scene.render();
  engine.endFrame();
}

/** Make the engine's canvas `w` × `h` pixels (a no-op if it is already, or the engine has no canvas, as under tests). */
export function ensureCanvasSize(engine: AbstractEngine, w: number, h: number): void {
  const canvas = engine.getRenderingCanvas();
  if (!canvas || (canvas.width === w && canvas.height === h)) return;
  engine.setSize(w, h);
}

/**
 * The rotation that puts a camera at `eye` looking at `target`, +Y up, as the engine's cameras look
 * (down -Z): the quaternion of the basis the engine's world matrices decompose to.
 */
export function lookAtRotation(eye: readonly number[], target: readonly number[]): Quaternion {
  const z = new Vector3(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
  if (z.lengthSquared() < 1e-12) z.set(0, 0, 1);
  z.normalize();
  let x = Vector3.Cross(Vector3.Up(), z);
  if (x.lengthSquared() < 1e-12) x = new Vector3(1, 0, 0); // looking straight up or down
  x.normalize();
  const y = Vector3.Cross(z, x);
  const m = Matrix.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);
  const q = new Quaternion();
  m.decompose(undefined, q);
  return q;
}

/** Put `camera` at `eye` looking at `target`. */
export function aimCamera(camera: TargetCamera, eye: readonly number[], target: readonly number[]): void {
  camera.position.set(eye[0], eye[1], eye[2]);
  camera.rotationQuaternion = lookAtRotation(eye, target);
}

// --- project textures -------------------------------------------------------------------------------

function samplingMode(settings: ImportSettings): number {
  const point = settings.filter === "point";
  if (!settings.mipmaps) return point ? Texture.NEAREST_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE;
  return point ? Texture.NEAREST_NEAREST_MIPNEAREST : Texture.TRILINEAR_SAMPLINGMODE;
}

/**
 * How a project texture is read: `color` as a material's image (Babylon decodes sRGB in the shader),
 * `graphColor` for shader graph code, which samples it raw (sRGB decoded by the hardware), and
 * `graphData` for data (normal maps) left linear.
 */
export type TextureUse = "color" | "graphColor" | "graphData";

/** Load a project image into `scene`, with its import settings (ADR 0040). Rejects if it can't be read. */
export function loadTexture(scene: Scene, path: string, use: TextureUse = "color"): Promise<Texture> {
  return new Promise<Texture>((resolve, reject) => {
    let url: string;
    try {
      url = Assets.url(path);
    } catch (err) {
      reject(err);
      return;
    }
    const settings = Assets.importSettings(path);
    const graph = use !== "color";
    const tex: Texture = new Texture(url, scene, {
      noMipmap: !settings.mipmaps,
      invertY: true,
      samplingMode: samplingMode(settings),
      ...(graph ? { useSRGBBuffer: use === "graphColor", gammaSpace: false } : {}),
      onLoad: () => {
        const wrap = settings.wrap === "repeat" ? Texture.WRAP_ADDRESSMODE : settings.wrap === "mirror" ? Texture.MIRROR_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
        tex.wrapU = tex.wrapV = wrap;
        resolve(tex);
      },
      onError: (message) => {
        tex.dispose();
        reject(new Error(message ?? `couldn't load ${path}`));
      },
    });
  });
}

// --- assets -----------------------------------------------------------------------------------------

/** A material asset's settings, or null if it isn't a material. */
export function readMaterial(path: string): MaterialSettings | null {
  try {
    return parseMaterial(Assets.json(path), path).settings;
  } catch {
    return null;
  }
}

/** A shader graph asset, or null if it can't be read. */
export function readGraph(path: string): ShaderGraph | null {
  try {
    return parseShaderGraph(Assets.json(path), path).graph;
  } catch {
    return null;
  }
}

/** True if a shader graph reads the Time node, so its preview moves. */
export const usesTime = (graph: ShaderGraph | null): boolean => !!graph?.nodes.some((n) => n.type === "time");

/** A material built for a preview, and how to free it. */
export interface PreviewMaterial {
  material: BabylonMaterial;
  dispose(): void;
}

/** A material asset (by path), or a shader graph with property values. */
export type MaterialSource = string | { graph: string; properties: Record<string, GraphValue> };

let warnedWebGL = false;

/**
 * A material asset or shader graph built as a Babylon material in `scene`, its textures loaded (a
 * texture that can't be read leaves its slot empty). Graph materials are compiled to WGSL; on the WebGL2
 * fallback they draw as plain PBR (one warning). Throws if the asset isn't a material or graph.
 */
export async function buildPreviewMaterial(scene: Scene, source: MaterialSource, shared: GraphShared): Promise<PreviewMaterial> {
  let graphPath: string | null;
  let properties: Record<string, GraphValue>;
  let settings: MaterialSettings | null = null;
  if (typeof source === "string") {
    settings = readMaterial(source);
    if (!settings) throw new Error(`"${source}" isn't a material.`);
    graphPath = materialGraph(settings);
    properties = settings.properties;
  } else {
    graphPath = source.graph;
    properties = source.properties;
  }
  if (graphPath) {
    const where = graphPath.replace(/^asset:/, "");
    const graph = readGraph(where);
    if (!graph) throw new Error(`shader graph "${graphPath}" can't be read.`);
    if (!scene.getEngine().isWebGPU && !warnedWebGL) {
      warnedWebGL = true;
      console.warn("[myco] shader graph previews need WebGPU on the Babylon backend; on the WebGL2 fallback they draw as plain PBR.");
    }
    const compiled = compileShaderGraph(graph, { shaderLevel: Graphics.tier.shaderLevel, language: "wgsl" });
    const pending: Promise<unknown>[] = [];
    const made = createGraphMaterial(scene, `preview:${where}`, compiled, properties, shared, (p, linear) => {
      const t = loadTexture(scene, p, linear ? "graphData" : "graphColor");
      pending.push(t.catch(() => undefined));
      return t;
    });
    await Promise.all(pending);
    await Promise.resolve(); // the slots are set as their promises settle: give them a turn
    return { material: made.material, dispose: () => made.dispose() };
  }
  const s = settings!;
  const m = pbr(`preview:${typeof source === "string" ? source : "material"}`, scene);
  applyBuiltinSettings(m, s);
  const owned: Texture[] = [];
  const load = async (ref: string, apply: (t: Texture) => void) => {
    const image = ref.replace(/^asset:/, "");
    if (!image) return;
    try {
      const { texture, owned: own } = tiledTexture(await loadTexture(scene, image, "color"), s.tiling);
      if (own) owned.push(texture);
      apply(texture);
    } catch (err) {
      console.warn(`[myco] preview: couldn't load "${image}":`, (err as Error).message);
    }
  };
  await load(s.texture, (t) => (m.albedoTexture = t));
  if (s.shader !== "unlit") await load(s.normalMap, (t) => (m.bumpTexture = t));
  return {
    material: m,
    dispose: () => {
      m.dispose(false, true);
      owned.forEach((t) => t.dispose());
    },
  };
}

/** A default white-ish PBR material for meshes without one. */
export function defaultPreviewMaterial(scene: Scene): PBRMaterial {
  const m = pbr("preview.default", scene);
  m.albedoColor = new Color3(1, 1, 1);
  m.metallic = 0;
  m.roughness = 0.5;
  return m;
}
