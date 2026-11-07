/**
 * @internal Editor: asset thumbnails on the Babylon backend (ADR 0061, 0075 stage 7). The same API as
 * `render/ThumbnailRenderer.ts` (three.js): one offscreen engine renders still images of models,
 * materials, shader graphs, environments, particle effects and prefabs, with a transparent background so
 * tiles follow the editor theme, and animates one hovered tile at a time (particle effects, shader graphs
 * that use Time), plus the Inspector's orbitable preview. Every asset gets a Scene of its own on the shared
 * engine; the studio environment is made once, in a host scene, and handed to each.
 *
 * Reached through `src/engine/editor`, which loads this file only when the Babylon renderer is chosen.
 */
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { PointLight } from "@babylonjs/core/Lights/pointLight.js";
import { SpotLight } from "@babylonjs/core/Lights/spotLight.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { expandParticleGraph, projectAssets } from "../../../scene/particleSubgraphs";
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture.js";
import { EXRCubeTexture } from "@babylonjs/core/Materials/Textures/exrCubeTexture.js";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../../scene/Assets";
import { materialGraph } from "../../../scene/material";
import { compileParticleGraph } from "../../../scene/particleCompile";
import { parseParticleGraph } from "../../../scene/particleGraphFormat";
import { loadMeshes, materialSlots, meshesIfLoaded, type ModelMesh, type SurfaceInfo } from "../../../scene/models";
import { flattenSceneNodes } from "../../sceneFlatten";
import { ProgramRunner, playTimes } from "../../particles/programRunner";
import { EffectSimulation } from "../../particles/simulation";
import { colorFromHex, frameView, moveOrbit, orbitOf, orbitPosition, previewPixels, seededRandom, type Bounds, type Orbit } from "../../thumbnailMath";
import type { ThumbnailKind, ThumbnailPreview, ThumbnailRendererApi } from "../../previewTypes";
import type { GraphShared } from "../graphMaterial";
import { environmentKind, ENV_SIZE } from "../lighting";
import { SkyBaker, SkyDrawable } from "../sky/BabylonSky";
import { cubemapReady, loadCubemap } from "../sky/cubemaps";
import { parseSky } from "../../../sky/skyFormat";
import { copyParticles, createDotTexture, makeDraw, type Draw } from "../particleDraw";
import { meshOf, modelMaterial, pbr } from "../materials";
import {
  addPreviewLights,
  aimCamera,
  buildPreviewMaterial,
  createPreviewEngine,
  createPreviewScene,
  createStudioTexture,
  defaultPreviewMaterial,
  ensureCanvasSize,
  LIGHT_AMBIENT,
  LIGHT_ENVIRONMENT,
  LIGHT_SUN,
  loadTexture,
  readGraph,
  readMaterial,
  renderFrame,
  sceneReady,
  useWhenReady,
  usesTime,
  type PreviewMaterial,
} from "./common";

export { frameView, seededRandom } from "../../thumbnailMath";
export type { ThumbnailKind, ThumbnailPreview } from "../../previewTypes";

/**
 * What draws each material slot (ADR 0089) of `sources` in a preview: the renderer's `materials[i]`,
 * then its `material`, then the model's import settings, as the World renderer does; null leaves a
 * slot to the model's own material.
 */
async function slotPicker(scene: Scene, shared: GraphShared, ref: string, sources: readonly ModelMesh[], materials: readonly string[], all: string): Promise<(surface: SurfaceInfo) => Material | null> {
  const built = new Map<string, Promise<PreviewMaterial | null>>();
  const build = (path: string) => {
    const key = path.replace(/^asset:/, "");
    let p = built.get(key);
    if (!p) built.set(key, (p = buildPreviewMaterial(scene, key, shared).catch(() => null)));
    return p;
  };
  let remap: Record<string, string> = {};
  if (!ref.startsWith("builtin:")) {
    try {
      remap = Assets.importSettings(ref.replace(/^asset:/, "").split("#")[0]).materials;
    } catch {
      // no sidecar
    }
  }
  const bySurface = new Map<SurfaceInfo, Material | null>();
  for (const [i, slot] of materialSlots(sources).entries()) {
    const path = materials[i] || all || remap[slot.surface.name] || "";
    bySurface.set(slot.surface, path ? ((await build(path))?.material ?? null) : null);
  }
  return (surface) => bySurface.get(surface) ?? null;
}

/** Thumbnails are this many pixels square: about twice the Assets panel's largest tile. */
export const THUMBNAIL_SIZE = 256;

/** Hover animation: frames per second, and the longest step a slow frame simulates. */
const ANIMATION_FPS = 30;
const MAX_STEP = 0.1;
/** Particle effects are shown this many seconds in, simulated at this rate. */
const PARTICLE_TIME = 1;
const PARTICLE_DT = 1 / 30;
/** Sprites without a size: pixels per unit (the project default, ADR 0014). */
const SPRITE_PPU = 100;
/** Previews draw at most this many pixels across, so a large Inspector doesn't cost a large buffer. */
const MAX_PREVIEW_PIXELS = 768;
const FOV = 30;

const DIRECTION_3D: [number, number, number] = norm([1, 0.75, 1.15]);
const DIRECTION_FRONT: [number, number, number] = [0, 0, 1];
const DIRECTION_MATERIAL: [number, number, number] = norm([0, 0.35, 1]);
const UNIT: Bounds = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const WHITE: [number, number, number, number] = [1, 1, 1, 1];

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** A scene ready to draw: what to render, from where, what to free, and how to advance it (animations). */
export interface Prepared {
  scene: Scene;
  camera: TargetCamera;
  /** What a preview orbits around. */
  target: [number, number, number];
  /** Advance by `dt` seconds (time-based graphs, particles) and refresh what draws. */
  step?: (dt: number) => void;
  /**
   * Recover transparency by drawing over black and over white (particle effects): additive blending
   * leaves a transparent target's alpha at 0, so its light would be lost in the copy.
   */
  matte?: boolean;
  dispose(): void;
}

/** What to build the renderer on; tests pass a headless engine and switch the studio room off. */
export interface ThumbnailOptions {
  /** The studio environment reflections (default on). */
  studio?: boolean;
  /** Longest wait, in ms, for a scene's shaders and textures before drawing it anyway (default: a few seconds per kind). */
  readyTimeout?: number;
}

export class ThumbnailRenderer implements ThumbnailRendererApi {
  private readonly studio: HDRCubeTexture | null;
  /** Resolves once the studio room can light a scene (or after giving up on it). */
  private studioReady: Promise<boolean> | null = null;
  private studioOk = false;
  private readonly host: Scene;
  private animation: { stop(): void } | null = null;
  private live: { stop(): void } | null = null;
  /** A `size` x `size` 2D canvas thumbnails are copied into for encoding. */
  private still: HTMLCanvasElement | null = null;
  /** Where particle thumbnails are drawn twice and combined. */
  private scratch: HTMLCanvasElement | null = null;
  private disposed = false;
  private lostListeners: (() => void)[] = [];
  /** True once the browser has taken the GPU context away (too many contexts, a GPU reset). */
  lost = false;

  private readonly readyTimeout: number | undefined;

  /** A renderer on its own offscreen engine (WebGPU where there is, else WebGL2). Rejects if no engine starts. */
  static async create(size = THUMBNAIL_SIZE, options: ThumbnailOptions = {}): Promise<ThumbnailRenderer> {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const engine = await createPreviewEngine(canvas, true);
    return new ThumbnailRenderer(engine, size, options);
  }

  /** @internal Tests: a renderer on an engine of the caller's (Babylon's NullEngine). */
  static forEngine(engine: AbstractEngine, size = THUMBNAIL_SIZE, options: ThumbnailOptions = {}): ThumbnailRenderer {
    return new ThumbnailRenderer(engine, size, options);
  }

  private constructor(
    private readonly engine: AbstractEngine,
    readonly size: number,
    options: ThumbnailOptions,
  ) {
    this.readyTimeout = options.readyTimeout;
    this.host = createPreviewScene(engine);
    this.studio = options.studio === false ? null : createStudioTexture(this.host);
    engine.onContextLostObservable.add(() => {
      this.lost = true;
      this.live?.stop();
      this.animation?.stop();
      for (const f of this.lostListeners.splice(0)) f();
    });
  }

  /** Run `f` once if the GPU context is lost (the renderer is then useless: make another). */
  onContextLost(f: () => void): void {
    if (this.lost) f();
    else this.lostListeners.push(f);
  }

  /**
   * Draw `prepared` into the engine's canvas at `w` x `h` (resizing it if it isn't), then copy it into
   * `target`, filling it. Two frames, so anything that bound late is in the second.
   */
  private draw(prepared: Prepared, w: number, h: number, target: HTMLCanvasElement | null, frames = 1): void {
    ensureCanvasSize(this.engine, w, h);
    prepared.scene.activeCamera = prepared.camera;
    const source = this.engine.getRenderingCanvas();
    const ctx = target?.getContext("2d");
    if (prepared.matte && target && ctx && source) return this.drawMatted(prepared, w, h, target, ctx, source, frames);
    for (let i = 0; i < frames; i++) renderFrame(this.engine, prepared.scene);
    if (!target || !ctx || !source) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(source, 0, 0, w, h, 0, 0, target.width, target.height);
  }

  /** Draw over black and over white, and work out the colour and transparency that gives both (difference matting). */
  private drawMatted(prepared: Prepared, w: number, h: number, target: HTMLCanvasElement, ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, frames: number): void {
    const scratch = (this.scratch ??= document.createElement("canvas"));
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    const sctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    const scene = prepared.scene;
    const grab = (value: number): Uint8ClampedArray => {
      scene.clearColor = new Color4(value, value, value, 1);
      renderFrame(this.engine, scene);
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(source, 0, 0, w, h, 0, 0, w, h);
      return sctx.getImageData(0, 0, w, h).data;
    };
    for (let i = 1; i < frames; i++) renderFrame(this.engine, scene);
    const onBlack = grab(0);
    const onWhite = grab(1);
    scene.clearColor = new Color4(0, 0, 0, 0);
    const out = sctx.createImageData(w, h);
    for (let i = 0; i < onBlack.length; i += 4) {
      // Over black a pixel is c·α; over white it is c·α + (1 − α): so α is one minus how much brighter white made it.
      const lift = (onWhite[i] - onBlack[i] + onWhite[i + 1] - onBlack[i + 1] + onWhite[i + 2] - onBlack[i + 2]) / (3 * 255);
      const alpha = Math.min(1, Math.max(0, 1 - lift));
      if (alpha < 1 / 255) continue;
      out.data[i] = Math.min(255, onBlack[i] / alpha);
      out.data[i + 1] = Math.min(255, onBlack[i + 1] / alpha);
      out.data[i + 2] = Math.min(255, onBlack[i + 2] / alpha);
      out.data[i + 3] = Math.round(alpha * 255);
    }
    sctx.putImageData(out, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(scratch, 0, 0, w, h, 0, 0, target.width, target.height);
  }

  /** A still image of the asset (WebP where the browser encodes it, else PNG), or null if it can't be shown. */
  async render(kind: ThumbnailKind, path: string): Promise<Blob | null> {
    const prepared = await this.prepare(kind, path, false);
    if (!prepared || this.disposed || this.lost) {
      prepared?.dispose();
      return null;
    }
    try {
      const still = (this.still ??= Object.assign(document.createElement("canvas"), { width: this.size, height: this.size }));
      this.draw(prepared, this.size, this.size, still, 2);
      // toBlob takes its snapshot now, before any other render can draw over the canvas.
      return await new Promise<Blob | null>((resolve) => still.toBlob(resolve, "image/webp", 0.9));
    } finally {
      prepared.dispose();
    }
  }

  /** Whether the asset animates on hover: particle effects, and shader graphs (or their materials) that use Time. */
  canAnimate(kind: ThumbnailKind, path: string): boolean {
    if (kind === "particles") return true;
    if (kind === "sky") return true; // clouds drift and stars twinkle
    if (kind === "shadergraph") return usesTime(readGraph(path));
    if (kind === "material") {
      const settings = readMaterial(path);
      const graph = settings && materialGraph(settings);
      return !!graph && usesTime(readGraph(graph));
    }
    return false;
  }

  /**
   * Draw the asset live into `target` (a 2D canvas) at about 30 fps, until the returned function
   * is called, another animation starts, or `target` leaves the document. One at a time.
   * `onFrame` runs after the first frame is drawn (nothing is drawn while a preview is open).
   */
  animate(kind: ThumbnailKind, path: string, target: HTMLCanvasElement, onFrame?: () => void): () => void {
    if (this.live || this.lost) return () => undefined; // the Inspector's preview has the renderer: tiles stay stills
    this.animation?.stop();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let prepared: Prepared | null = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      prepared?.dispose();
      prepared = null;
      if (this.animation === handle) this.animation = null;
    };
    const handle = { stop };
    this.animation = handle;
    void this.prepare(kind, path, true).then((p) => {
      if (stopped || !p) {
        p?.dispose();
        return;
      }
      prepared = p;
      let last = performance.now();
      let first = true;
      const frame = () => {
        if (stopped || !prepared) return;
        if (!target.isConnected) return stop();
        const now = performance.now();
        prepared.step?.(Math.min(MAX_STEP, (now - last) / 1000));
        last = now;
        this.draw(prepared, this.size, this.size, target);
        if (first) {
          first = false;
          onFrame?.();
        }
        timer = setTimeout(frame, 1000 / ANIMATION_FPS);
      };
      frame();
    });
    return stop;
  }

  /**
   * An orbitable preview of the asset in `target` (a 2D canvas, sized by the caller to its pixels).
   * It takes the renderer from any hover animation, and replaces another preview.
   */
  preview(kind: ThumbnailKind, path: string, target: HTMLCanvasElement): ThumbnailPreview {
    this.live?.stop();
    this.animation?.stop();
    let stopped = false;
    let prepared: Prepared | null = null;
    let center: [number, number, number] = [0, 0, 0];
    let start: Orbit = { yaw: 0, pitch: 0, distance: 1 };
    let view: Orbit = start;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let queued = false;
    let last = performance.now();
    const animates = this.canAnimate(kind, path);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      prepared?.dispose();
      prepared = null;
      if (this.live === handle) {
        this.live = null;
        if (!this.lost) ensureCanvasSize(this.engine, this.size, this.size); // back to the tiles' size
      }
    };
    const handle = { stop };
    this.live = handle;
    const draw = () => {
      queued = false;
      if (stopped || !prepared) return;
      if (!target.isConnected) return stop();
      const [w, h] = previewPixels(target.width, target.height, MAX_PREVIEW_PIXELS);
      const camera = prepared.camera;
      aimCamera(camera, orbitPosition(center, view), center);
      camera.minZ = Math.max(1e-3, view.distance / 100);
      camera.maxZ = view.distance * 100;
      const now = performance.now();
      if (animates) prepared.step?.(Math.min(MAX_STEP, (now - last) / 1000));
      last = now;
      this.draw(prepared, w, h, target);
      // Animated assets keep drawing; others wait for the next change.
      if (animates) timer = setTimeout(draw, 1000 / ANIMATION_FPS);
    };
    const request = () => {
      if (queued || stopped || !prepared || animates) return; // animating: the next frame picks it up
      queued = true;
      (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16))(draw);
    };
    const ready = this.prepare(kind, path, true).then((p) => {
      if (stopped || !p || this.lost) {
        p?.dispose();
        stop(); // nothing to show: hovered tiles may animate again
        return false;
      }
      prepared = p;
      center = p.target;
      start = view = orbitOf([p.camera.position.x, p.camera.position.y, p.camera.position.z], center);
      draw();
      return true;
    });
    const near = () => start.distance * 0.25, far = () => start.distance * 4;
    return {
      ready,
      orbit: (dyaw, dpitch) => {
        view = moveOrbit(view, dyaw, dpitch, 1, near(), far());
        request();
      },
      zoom: (factor) => {
        view = moveOrbit(view, 0, 0, factor, near(), far());
        request();
      },
      reset: () => {
        view = start;
        request();
      },
      redraw: request,
      stop,
    };
  }

  /**
   * Forget every loaded texture (another project opened: the same path can be another file). Textures
   * live in each thumbnail's own scene and are freed with it, so there is nothing kept to forget.
   */
  clearCaches(): void {}

  dispose(): void {
    this.disposed = true;
    this.live?.stop();
    this.animation?.stop();
    this.studio?.dispose();
    this.host.dispose();
    this.engine.dispose();
    this.lostListeners = [];
  }

  // --- scenes ---------------------------------------------------------------------------------------

  /** @internal Tests: the scene a thumbnail of this asset draws, or null if it can't be made (warned). */
  async prepare(kind: ThumbnailKind, path: string, live: boolean): Promise<Prepared | null> {
    try {
      await this.loadStudio();
      switch (kind) {
        case "model":
          return await this.prepareModel(path);
        case "material":
        case "shadergraph":
          return await this.prepareMaterial(kind, path);
        case "environment":
          return await this.prepareEnvironment(path, live);
        case "sky":
          return await this.prepareSky(path, live);
        case "particles":
          return await this.prepareParticles(path, live);
        case "prefab":
          return await this.preparePrefab(path);
        case "scene":
          return await this.prepareScene(path);
      }
    } catch (err) {
      console.warn(`[myco] thumbnail: couldn't draw ${path}:`, err);
      return null;
    }
  }

  /** Wait until `scene` can draw (shaders compiled, textures loaded), at most `ms`. */
  private ready(scene: Scene, ms: number): Promise<boolean> {
    return sceneReady(scene, this.readyTimeout ?? ms);
  }

  /** A scene lit like the editor's default: soft ambient, a sun, and the studio room's reflections. */
  private litScene(): Scene {
    const scene = createPreviewScene(this.engine);
    addPreviewLights(scene, LIGHT_AMBIENT, LIGHT_SUN);
    if (this.studioOk && this.studio) {
      scene.environmentTexture = this.studio;
      scene.environmentIntensity = LIGHT_ENVIRONMENT;
    }
    return scene;
  }

  private camera(scene: Scene, bounds: Bounds | null, direction: readonly number[], fallback: Bounds): { camera: TargetCamera; target: [number, number, number] } {
    const camera = new TargetCamera("preview.camera", Vector3.Zero(), scene, false);
    camera.fov = (FOV * Math.PI) / 180; // vertical, like three's
    camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
    const view = frameView(bounds ?? fallback, FOV, direction);
    camera.minZ = view.near;
    camera.maxZ = view.far;
    aimCamera(camera, view.position, view.target);
    scene.activeCamera = camera;
    return { camera, target: view.target };
  }

  private async prepareModel(path: string): Promise<Prepared> {
    const sources = await loadMeshes(path);
    const scene = this.litScene();
    const cache = new WeakMap<object, Material>();
    const fallback = defaultPreviewMaterial(scene);
    const box = new BoundsBox();
    const pick = await slotPicker(scene, { time: 0, resolution: [this.size, this.size] }, path, sources, [], "");
    for (const src of sources) {
      const mesh = meshOf(scene, `model:${src.name}`, src);
      mesh.material = modelMaterial(scene, cache, src, mesh, pick) ?? fallback;
      box.add(src.data.positions, null);
    }
    await this.ready(scene, 3000); // the models' textures load on their own
    return { scene, ...this.camera(scene, box.bounds(), DIRECTION_3D, UNIT), dispose: () => scene.dispose() };
  }

  private async prepareMaterial(kind: "material" | "shadergraph", path: string): Promise<Prepared> {
    const scene = this.litScene();
    const shared: GraphShared = { time: 0, resolution: [this.size, this.size] };
    try {
      const built = await buildPreviewMaterial(scene, kind === "shadergraph" ? { graph: path, properties: {} } : path, shared);
      const sphere = meshesIfLoaded("builtin:sphere")![0];
      meshOf(scene, "preview.sphere", sphere).material = built.material;
      await this.ready(scene, 5000);
      let time = 0;
      return {
        scene,
        ...this.camera(scene, UNIT, DIRECTION_MATERIAL, UNIT),
        step: (dt) => {
          time += dt;
          shared.time = time;
          const canvas = this.engine.getRenderingCanvas();
          shared.resolution = [canvas?.width ?? this.size, canvas?.height ?? this.size];
        },
        dispose: () => scene.dispose(),
      };
    } catch (err) {
      scene.dispose();
      throw err;
    }
  }

  /** A chrome sphere reflecting the map; a live preview also shows the map itself behind it. */
  private async prepareEnvironment(path: string, live: boolean): Promise<Prepared> {
    const scene = createPreviewScene(this.engine);
    try {
      const url = Assets.url(path);
      const kind = environmentKind(path);
      if (!kind || kind === "sky") throw new Error(`"${path}" isn't an .hdr, .exr, .png, .jpg, .env, .dds or .cubemap.json file.`);
      const fail = (message?: string) => console.warn(`[myco] thumbnail: couldn't load environment "${path}": ${message ?? "unknown error"}`);
      const map: BaseTexture =
        kind === "cube" || kind === "faces"
          ? loadCubemap(path, kind, scene, fail)
          : kind === "hdr"
          ? new HDRCubeTexture(url, scene, ENV_SIZE, false, true, false, true, null, fail)
          : kind === "exr"
            ? new EXRCubeTexture(url, scene, ENV_SIZE, false, true, false, true, null, fail)
            : new EquiRectangularCubeTexture(url, scene, ENV_SIZE, false, true, null, fail);
      if (!(await waitFor(() => cubemapReady(map), 8000)) || !(await useWhenReady(scene, map, 1, 8000))) throw new Error("the map didn't load.");
      const chrome = pbr("preview.chrome", scene);
      chrome.albedoColor = new Color3(1, 1, 1);
      chrome.metallic = 1;
      chrome.roughness = 0.05;
      meshOf(scene, "preview.sphere", meshesIfLoaded("builtin:sphere")![0]).material = chrome;
      if (live) {
        // The map itself behind the sphere: a copy of the prefiltered cube drawn as a sky box.
        const sky = map.clone();
        if (sky) sky.coordinatesMode = Texture.SKYBOX_MODE;
        const box = CreateBox("preview.sky", { size: 1 }, scene);
        box.infiniteDistance = true;
        box.isPickable = false;
        box.scaling.setAll(40); // inside the preview camera's far plane at every zoom
        const material = new PBRMaterial("preview.sky", scene);
        material.backFaceCulling = false;
        material.disableLighting = true;
        material.sideOrientation = PBRMaterial.CounterClockWiseSideOrientation;
        material.reflectionTexture = sky;
        material.microSurface = 1;
        box.material = material;
      }
      await this.ready(scene, 5000);
      return { scene, ...this.camera(scene, UNIT, DIRECTION_FRONT, UNIT), dispose: () => scene.dispose() };
    } catch (err) {
      scene.dispose();
      throw err;
    }
  }

  /**
   * A procedural sky (ADR 0112). Stills (tiles) draw the sky alone, quickly; live previews add a
   * chrome sphere reflecting the sky's bake, and animate the clouds and stars.
   */
  private async prepareSky(path: string, live: boolean): Promise<Prepared> {
    const scene = createPreviewScene(this.engine);
    const sky = new SkyDrawable(scene);
    const baker = new SkyBaker(scene);
    const dispose = () => {
      baker.dispose();
      sky.dispose();
      scene.dispose();
    };
    try {
      const { settings } = parseSky(Assets.json(path), path);
      const frame = { settings, time: settings.sun.timeOfDay, seconds: 0, rotation: 0, intensity: 1, fog: null, baking: false };
      sky.update({ ...frame, baking: true });
      const uniforms = sky.uniforms.slice();
      sky.update(frame);
      if (live) {
        if (await waitFor(() => baker.ready(), 3000)) {
          const bake = baker.bake(64, uniforms, (set) => sky.bindTextures(set));
          if (bake && (await waitFor(() => bake.filtered, 3000))) {
            scene.environmentTexture = bake.texture;
            scene.environmentIntensity = 1;
          }
        }
        const chrome = pbr("preview.chrome", scene);
        chrome.albedoColor = new Color3(1, 1, 1);
        chrome.metallic = 1;
        chrome.roughness = 0.1;
        meshOf(scene, "preview.sphere", meshesIfLoaded("builtin:sphere")![0]).material = chrome;
      }
      const view = this.camera(scene, UNIT, DIRECTION_FRONT, UNIT);
      scene.onBeforeRenderObservable.add(() => sky.fit(scene.activeCamera as TargetCamera)); // the sky stays centred as the view orbits
      await this.ready(scene, 5000);
      let seconds = 0;
      return {
        scene,
        ...view,
        step: live
          ? (dt) => {
              seconds += dt;
              sky.update({ ...frame, seconds });
            }
          : undefined,
        dispose,
      };
    } catch (err) {
      dispose();
      throw err;
    }
  }

  private async prepareParticles(path: string, live: boolean): Promise<Prepared> {
    const program = compileParticleGraph(expandParticleGraph(parseParticleGraph(Assets.json(path), path).graph, projectAssets).graph);
    const scene = createPreviewScene(this.engine);
    try {
      addPreviewLights(scene, LIGHT_AMBIENT, LIGHT_SUN);
      // Everything the emitters draw with, loaded first, so the build doesn't wait on a texture.
      const textures = new Map<string, Texture | null>();
      const materials = new Map<string, PreviewMaterial | null>();
      const shared: GraphShared = { time: 0, resolution: [this.size, this.size] };
      for (const e of program.effect.emitters) {
        const r = e.renderer;
        if (r.texture && !textures.has(r.texture)) textures.set(r.texture, await loadTexture(scene, r.texture, "color").catch(() => null));
        if (r.mode === "mesh" && r.mesh) await loadMeshes(r.mesh).catch(() => undefined);
        // A material asset draws instead of the texture (as in a World); one that can't be built falls back to the texture.
        if (r.material && !materials.has(r.material)) materials.set(r.material, await buildPreviewMaterial(scene, r.material.replace(/^asset:/, ""), shared).catch(() => null));
      }
      const dot = createDotTexture(scene);
      const random = seededRandom(1);
      const runner = withRandom(random, () => new ProgramRunner(program, random));
      const sim = new EffectSimulation(withRandom(random, () => runner.effect()), { live: runner.live, random });
      const draws: Draw[] = sim.emitters.map((e) => {
        const r = e.renderer;
        const material = (r.material ? materials.get(r.material) : null)?.material ?? null;
        const tex = r.texture && !material ? textures.get(r.texture) : null;
        const mesh = r.mode === "mesh" ? meshesIfLoaded(r.mesh)?.[0] : undefined;
        return makeDraw(scene, `particles:${e.name}`, e, Math.max(1, Math.ceil(e.settings.maxParticles)), tex ?? dot, !tex, { material, mesh });
      });
      const autoStart = program.autoStart;
      let time = 0;
      const restart = () => {
        time = 0;
        sim.restart();
        // Systems started by events (not On Play) wait for them.
        for (const e of sim.emitters) {
          const index = program.systems.indexOf(e.name);
          if (index >= 0 && !autoStart[index]) sim.endEmit(e);
        }
      };
      const mirror = () => draws.forEach(copyParticles);
      const step = (dt: number) => {
        time += dt;
        shared.time += dt; // graph materials' Time node
        runner.update(time, dt, playTimes(program, time));
        sim.step(dt, IDENTITY, 1, WHITE);
        // A finished one-shot effect starts again, so a hovered tile keeps showing something.
        if (live && sim.count === 0 && !sim.emitting && time > 0.5) restart();
        mirror();
      };
      withRandom(random, () => {
        restart();
        for (let t = 0; t < PARTICLE_TIME; t += PARTICLE_DT) step(PARTICLE_DT);
      });
      // Frame what's alive now (emitters sit at the origin, so local and world space agree).
      const box = new BoundsBox();
      const pts: number[] = [];
      for (const e of sim.emitters) for (let i = 0; i < e.count; i++) pts.push(e.pool[i].wx, e.pool[i].wy, e.pool[i].wz);
      box.add(Float32Array.from(pts), null);
      const bounds = box.bounds();
      await this.ready(scene, 3000);
      return {
        scene,
        ...this.camera(scene, bounds && padded(bounds, 0.4), DIRECTION_3D, { min: [-1, 0, -1], max: [1, 2, 1] }),
        step: live ? (dt) => withRandom(random, () => step(dt)) : undefined,
        matte: true,
        dispose: () => {
          for (const d of draws) d.dispose();
          for (const m of materials.values()) m?.dispose();
          scene.dispose();
        },
      };
    } catch (err) {
      scene.dispose();
      throw err;
    }
  }

  private async preparePrefab(path: string): Promise<Prepared> {
    return this.prepareNodes(path, false);
  }

  /** A scene seen from its main camera, with its own lights; framed like a prefab when it has no camera (ADR 0117). */
  private async prepareScene(path: string): Promise<Prepared> {
    return this.prepareNodes(path, true);
  }

  /** The meshes and sprites of a prefab's or scene's nodes (instances expanded), drawn as a prefab or from the scene's camera. */
  private async prepareNodes(path: string, asScene: boolean): Promise<Prepared> {
    const nodes: PrefabNode[] = flattenSceneNodes(path, (p) => {
      try {
        return Assets.json(p.replace(/^asset:/, ""));
      } catch {
        return undefined;
      }
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const worlds = new Map<string, number[]>();
    const worldOf = (n: PrefabNode, depth = 0): number[] => {
      const have = worlds.get(n.id);
      if (have) return have;
      const local = localMatrix(n);
      const parent = n.parent ? byId.get(n.parent) : undefined;
      const m = parent && depth < 64 ? multiply(worldOf(parent, depth + 1), local) : local;
      worlds.set(n.id, m);
      return m;
    };
    const scene = this.litScene();
    const cache = new WeakMap<object, Material>();
    const box = new BoundsBox();
    let meshes = 0;
    let sprites = 0;
    try {
      const shared: GraphShared = { time: 0, resolution: [this.size, this.size] };
      for (const n of nodes) {
        for (const c of n.components ?? []) {
          const data = (c.data ?? {}) as Record<string, unknown>;
          if (c.type === "engine.MeshRenderer") {
            const ref = typeof data.mesh === "string" ? data.mesh : "builtin:cube";
            const parts: readonly ModelMesh[] = await loadMeshes(ref).catch(() => []);
            const list = Array.isArray(data.materials) ? data.materials.map((m) => (typeof m === "string" ? m : "")) : [];
            const pick = await slotPicker(scene, shared, ref, parts, list, typeof data.material === "string" ? data.material : "");
            for (const part of parts) {
              const mesh = meshOf(scene, `prefab:${n.id}:${part.name}`, part);
              mesh.material = modelMaterial(scene, cache, part, mesh, pick) ?? defaultPreviewMaterial(scene);
              const world = worldOf(n);
              mesh.freezeWorldMatrix(Matrix.FromArray(world));
              box.add(part.data.positions, world);
              meshes++;
            }
          } else if (c.type === "engine.SpriteRenderer" && typeof data.sprite === "string" && data.sprite) {
            const texture = await loadTexture(scene, data.sprite.split("#")[0].replace(/^asset:/, ""), "color").catch(() => null);
            if (!texture) continue;
            const image = texture.getBaseSize();
            const size = Array.isArray(data.size) ? (data.size as number[]) : [(image.width || SPRITE_PPU) / SPRITE_PPU, (image.height || SPRITE_PPU) / SPRITE_PPU];
            const world = worldOf(n);
            const sprite = spriteMesh(scene, size[0], size[1], texture, typeof data.color === "string" ? colorFromHex(data.color) : 0xffffff);
            sprite.freezeWorldMatrix(Matrix.FromArray(world));
            box.add(Float32Array.from([-size[0] / 2, -size[1] / 2, 0, size[0] / 2, size[1] / 2, 0]), world);
            sprites++;
          }
        }
      }
      if (!meshes && !sprites) throw new Error("it has nothing to draw.");
      const view = asScene ? this.sceneView(scene, nodes, worldOf) : null;
      await this.ready(scene, 3000);
      // A scene is seen from its camera; otherwise (and for prefabs) from three-quarters above, or the front for sprites only.
      return { scene, ...(view ?? this.camera(scene, box.bounds(), meshes ? DIRECTION_3D : DIRECTION_FRONT, UNIT)), dispose: () => scene.dispose() };
    } catch (err) {
      scene.dispose();
      throw err;
    }
  }

  /**
   * Put the scene's own lights in `scene` (replacing the default ones, if it has any) and aim a camera
   * like its main one: the lowest depth, the first in the file on a tie. Null when it has no camera.
   */
  private sceneView(scene: Scene, nodes: readonly PrefabNode[], worldOf: (n: PrefabNode) => number[]): { camera: TargetCamera; target: [number, number, number] } | null {
    const lights = nodes.flatMap((n) => (n.components ?? []).filter((c) => c.type === "engine.Light").map((c) => ({ n, data: (c.data ?? {}) as Record<string, unknown> })));
    if (lights.length) {
      for (const l of [...scene.lights]) l.dispose();
      for (const { n, data } of lights) {
        const m = worldOf(n);
        const type = typeof data.type === "string" ? data.type : "directional";
        const rgb = colorOfData(data.color) ?? [1, 1, 1];
        const intensity = typeof data.intensity === "number" ? Math.max(0, data.intensity) : 1;
        const range = typeof data.range === "number" && data.range > 0 ? data.range : Number.MAX_VALUE;
        const color = new Color3(rgb[0], rgb[1], rgb[2]).toLinearSpace();
        const position = new Vector3(m[12], m[13], m[14]);
        const direction = new Vector3(-m[8], -m[9], -m[10]).normalize(); // -Z, where cameras look too
        let light;
        if (type === "ambient") {
          const h = new HemisphericLight("scene.ambient", new Vector3(0, 1, 0), scene);
          h.groundColor = color.clone();
          h.specular = Color3.Black();
          light = h;
        } else if (type === "point") {
          const pl = new PointLight("scene.point", position, scene);
          pl.range = range;
          light = pl;
        } else if (type === "spot") {
          const angle = (Math.min(Math.max(typeof data.spotAngle === "number" ? data.spotAngle : 30, 1), 179) * Math.PI) / 180;
          const sl = new SpotLight("scene.spot", position, direction, angle, 2, scene);
          sl.range = range;
          light = sl;
        } else light = new DirectionalLight("scene.sun", direction, scene);
        light.diffuse = color;
        if (!(light instanceof HemisphericLight)) light.specular = color;
        light.intensity = intensity;
      }
    }
    let best: { n: PrefabNode; data: Record<string, unknown>; depth: number } | null = null;
    for (const n of nodes) {
      for (const c of n.components ?? []) {
        if (c.type !== "engine.Camera") continue;
        const data = (c.data ?? {}) as Record<string, unknown>;
        const depth = typeof data.depth === "number" ? data.depth : 0;
        if (!best || depth < best.depth) best = { n, data, depth };
      }
    }
    if (!best) return null;
    const { n, data } = best;
    const m = worldOf(n);
    const eye: [number, number, number] = [m[12], m[13], m[14]];
    const target: [number, number, number] = [eye[0] - m[8] * 10, eye[1] - m[9] * 10, eye[2] - m[10] * 10];
    const camera = new TargetCamera("scene.camera", Vector3.Zero(), scene, false);
    const near = typeof data.near === "number" && data.near > 0 ? data.near : 0.1;
    const far = typeof data.far === "number" && data.far > near ? data.far : 1000;
    camera.minZ = near;
    camera.maxZ = far;
    if (data.projection === "perspective") {
      camera.fov = (((typeof data.fieldOfView === "number" ? data.fieldOfView : 60) as number) * Math.PI) / 180;
      camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
    } else {
      // The thumbnail is square: show the camera's full height, as wide.
      const half = typeof data.orthographicSize === "number" && data.orthographicSize > 0 ? data.orthographicSize : 5;
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -half;
      camera.orthoRight = half;
      camera.orthoTop = half;
      camera.orthoBottom = -half;
    }
    aimCamera(camera, eye, target);
    scene.activeCamera = camera;
    const bg = colorOfData(data.backgroundColor);
    if (bg) scene.clearColor = new Color4(bg[0], bg[1], bg[2], 1).toLinearSpace();
    return { camera, target };
  }

  /** The studio room, once per renderer: ready for every scene, or not at all (thumbnails then have no reflections). */
  private loadStudio(): Promise<boolean> {
    this.studioReady ??= !this.studio
      ? Promise.resolve(false)
      : new Promise<boolean>((resolve) => {
          const started = Date.now();
          const poll = () => {
            if (this.disposed) return resolve(false);
            if (this.studio!.isReady()) {
              this.studioOk = true;
              return resolve(true);
            }
            if (Date.now() - started > 4000) return resolve(false);
            setTimeout(poll, 16);
          };
          poll();
        });
    return this.studioReady;
  }
}

// --- helpers ------------------------------------------------------------------------------------------

/** A colour field's `[r, g, b(, a)]` (0 to 1) or `#rrggbb`, as 0 to 1 sRGB components; null when it is neither. */
function colorOfData(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number")) return [v[0], v[1], v[2]];
  if (typeof v === "string") {
    const hex = colorFromHex(v);
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }
  return null;
}

interface PrefabNode {
  id: string;
  parent?: string;
  components?: { type: string; data?: unknown }[];
}

const padded = (b: Bounds, by: number): Bounds => ({ min: [b.min[0] - by, b.min[1] - by, b.min[2] - by], max: [b.max[0] + by, b.max[1] + by, b.max[2] + by] });

/** Run `fn` with `Math.random` replaced, so particle effects simulate the same way every time. */
function withRandom<T>(random: () => number, fn: () => T): T {
  const original = Math.random;
  Math.random = random;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

/** The box around points (optionally moved by a column-major matrix). */
class BoundsBox {
  private min = [Infinity, Infinity, Infinity];
  private max = [-Infinity, -Infinity, -Infinity];

  add(positions: ArrayLike<number>, world: readonly number[] | null): void {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      let x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (world) {
        const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
        const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
        const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
        x = wx;
        y = wy;
        z = wz;
      }
      if (x < this.min[0]) this.min[0] = x;
      if (y < this.min[1]) this.min[1] = y;
      if (z < this.min[2]) this.min[2] = z;
      if (x > this.max[0]) this.max[0] = x;
      if (y > this.max[1]) this.max[1] = y;
      if (z > this.max[2]) this.max[2] = z;
    }
  }

  bounds(): Bounds | null {
    return this.min[0] > this.max[0] ? null : { min: [...this.min], max: [...this.max] };
  }
}

/** A textured quad (`w` x `h`, facing +Z, centred) drawn unlit, tinted by an sRGB `0xRRGGBB` colour. */
function spriteMesh(scene: Scene, w: number, h: number, texture: Texture, color: number): Mesh {
  const mesh = new Mesh("preview.sprite", scene);
  const data = new VertexData();
  data.positions = [-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0];
  data.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  data.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  data.indices = [0, 1, 2, 0, 2, 3];
  data.applyToMesh(mesh, false);
  const material: PBRMaterial = pbr("preview.sprite", scene);
  material.unlit = true;
  material.backFaceCulling = false;
  texture.hasAlpha = true; // Babylon reads a texture's alpha only when told it has one
  material.albedoTexture = texture;
  material.useAlphaFromAlbedoTexture = true;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  material.albedoColor = Color3.FromInts((color >> 16) & 255, (color >> 8) & 255, color & 255).toLinearSpace();
  mesh.material = material;
  return mesh;
}

/** A node's local matrix (column-major) from its Transform data: position, rotation (Euler degrees, or a quaternion) and scale. */
function localMatrix(n: PrefabNode): number[] {
  const t = n.components?.find((c) => c.type === "engine.Transform")?.data as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
  const p = t?.position ?? [0, 0, 0];
  const r = t?.rotation ?? [0, 0, 0];
  const s = t?.scale ?? [1, 1, 1];
  const q = r.length === 4 ? [r[0], r[1], r[2], r[3]] : quaternionOf(((r[0] ?? 0) * Math.PI) / 180, ((r[1] ?? 0) * Math.PI) / 180, ((r[2] ?? 0) * Math.PI) / 180);
  return compose([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], q, [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1]);
}

/** A rotation from Euler angles in radians, applied in three.js's default XYZ order, as [x, y, z, w]. */
function quaternionOf(x: number, y: number, z: number): number[] {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

/** A column-major matrix from a position, a quaternion [x, y, z, w] and a scale. */
function compose(p: number[], q: number[], s: number[]): number[] {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    p[0], p[1], p[2], 1,
  ];
}

/** `a` times `b` (column-major). */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return out;
}

/** Resolve true once `done()` holds (polled each frame), false after `ms`. */
function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (done()) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(poll, 16);
    };
    poll();
  });
}
