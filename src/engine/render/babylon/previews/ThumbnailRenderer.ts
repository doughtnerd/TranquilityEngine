/**
 * @internal Editor: asset thumbnails on the Babylon backend (ADR 0061, 0075 stage 7, 0153, 0156). One
 * offscreen engine renders still images with a transparent background, so tiles follow the editor theme,
 * animates one hovered tile at a time, and draws the Inspector's orbitable preview.
 *
 * What it draws is a stage (`ThumbnailStage`, ADR 0156) its asset kind supplies: a made-up node set (a
 * model's MeshRenderer, a material's sphere, a sky's Environment, an effect's ParticleSystem; a prefab or
 * scene is its own file). It is loaded into a headless World of its own and drawn by a thumbnail
 * `BabylonRenderer` with the enabled plugins' render features, as a World draws it. What's left here is
 * framing (`thumbnailMath`, the stage's view) and capture (the clear, matting, encoding). The studio room is
 * made once, in a host scene, and shared by every thumbnail's lighting rig.
 *
 * Reached through `src/engine/editor`, which loads this file only when the Babylon renderer is chosen.
 */
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import "../prefilterGuard";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { World } from "../../../core/World";
import type { ProjectSettings, ProjectSettingsInput } from "../../../core/settings";
import { instantiateDocument } from "../../../editor";
import { MeshRenderer, ParticleSystem } from "../../components";
import type { ParticlePreview } from "../../renderPolicy";
import { BabylonRenderer, loadPluginFeatures } from "../BabylonRenderer";
import { createBabylonEngine } from "../createEngine";
import { frameView, moveOrbit, orbitOf, orbitPosition, previewPixels, type Bounds, type Orbit } from "../../thumbnailMath";
import type { ThumbnailPreview, ThumbnailRendererApi, ThumbnailStage } from "../../previewTypes";
import { aimCamera, createPreviewScene, createStudioTexture, ensureCanvasSize, renderFrame, sceneReady } from "./common";

export { frameView, seededRandom } from "../../thumbnailMath";
export type { ThumbnailPreview, ThumbnailStage } from "../../previewTypes";

/** Thumbnails are this many pixels square: about twice the Assets panel's largest tile. */
export const THUMBNAIL_SIZE = 256;

/** Hover animation: frames per second, and the longest step a slow frame simulates. */
const ANIMATION_FPS = 30;
const MAX_STEP = 0.1;
/** Particle effects are shown this many seconds in, simulated at this rate. */
const PARTICLE_TIME = 1;
const PARTICLE_DT = 1 / 30;
/** Previews draw at most this many pixels across, so a large Inspector doesn't cost a large buffer. */
const MAX_PREVIEW_PIXELS = 768;
const FOV = 30;

const DIRECTIONS: Record<"above" | "front" | "level", [number, number, number]> = {
  above: norm([1, 0.75, 1.15]),
  front: [0, 0, 1],
  level: norm([0, 0.35, 1]),
};
const UNIT: Bounds = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };

/**
 * A live stage's particle effects as the editor previews them (ADR 0057, 0154): every one plays, and a
 * finished one-shot effect plays again after a moment, so a hovered tile keeps showing something.
 */
const LIVE_PARTICLES: ParticlePreview = { selected: () => true, playing: true, speed: 1, simulateAll: true, restarts: 0 };

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** A stage ready to draw: what to render, from where, what to free, and how to advance it (animations). */
export interface Prepared {
  scene: Scene;
  camera: TargetCamera;
  /** What a preview orbits around. */
  target: [number, number, number];
  /** Before each draw with `camera` (a thumbnail renderer's sky box fits it). */
  beforeDraw?: (camera: TargetCamera) => void;
  /** A live stage that animates: advance its World by `dt` seconds and sync what draws (particles, the sky, graphs' Time). */
  step?: (dt: number) => void;
  /** @internal Tests: the stage's World and its thumbnail renderer. */
  world: World;
  renderer: BabylonRenderer;
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
  /**
   * The project settings prefabs and scenes load with (pixels per unit, sorting layers). Default: the
   * active World's, which in the editor are the open project's.
   */
  settings?: () => ProjectSettingsInput | ProjectSettings;
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
  private readonly settings: () => ProjectSettingsInput | ProjectSettings;

  /** A renderer on its own offscreen engine (WebGPU where there is, else WebGL2). Rejects if no engine starts. */
  static async create(size = THUMBNAIL_SIZE, options: ThumbnailOptions = {}): Promise<ThumbnailRenderer> {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const engine = await createBabylonEngine(canvas, { transparent: true });
    return new ThumbnailRenderer(engine, size, options);
  }

  /** @internal Tests outside the Babylon backend (which never import Babylon, ADR 0075): a renderer on Babylon's headless NullEngine. */
  static async headless(size = THUMBNAIL_SIZE, options: ThumbnailOptions = {}): Promise<ThumbnailRenderer> {
    const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
    return new ThumbnailRenderer(new NullEngine(), size, options);
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
    this.settings = options.settings ?? (() => World.active?.settings ?? {});
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
    const camera = prepared.camera;
    prepared.scene.activeCamera = camera;
    if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
      // A scene's orthographic camera: its full height, as wide as the target is.
      camera.orthoLeft = -camera.orthoTop! * (w / h);
      camera.orthoRight = camera.orthoTop! * (w / h);
    }
    prepared.beforeDraw?.(camera);
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

  /** A still image of a stage (WebP where the browser encodes it, else PNG), or null if it can't be shown. */
  async render(stage: ThumbnailStage): Promise<Blob | null> {
    const prepared = await this.prepare(stage, false);
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

  /**
   * Draw a live stage into `target` (a 2D canvas) at about 30 fps, until the returned function
   * is called, another animation starts, or `target` leaves the document. One at a time.
   * `onFrame` runs after the first frame is drawn (nothing is drawn while a preview is open).
   */
  animate(stage: ThumbnailStage, target: HTMLCanvasElement, onFrame?: () => void): () => void {
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
    void this.prepare(stage, true).then((p) => {
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
   * An orbitable preview of a live stage in `target` (a 2D canvas, sized by the caller to its pixels).
   * It takes the renderer from any hover animation, and replaces another preview.
   */
  preview(stage: ThumbnailStage, target: HTMLCanvasElement): ThumbnailPreview {
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
    const animates = !!stage.animates;
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
      if (timer !== null) clearTimeout(timer); // one chain of redraws, whoever asked
      timer = null;
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
      // Animated assets keep drawing; others wait for the next change, or, if the scene wasn't ready
      // yet (its readiness wait gave up on a slow machine), draw again until it is, so the preview
      // isn't left with a blank or half-loaded frame.
      if (animates || !prepared.scene.isReady()) timer = setTimeout(draw, 1000 / ANIMATION_FPS);
    };
    const request = () => {
      if (queued || stopped || !prepared || animates) return; // animating: the next frame picks it up
      queued = true;
      (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16))(draw);
    };
    const ready = this.prepare(stage, true).then((p) => {
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

  // --- stages ---------------------------------------------------------------------------------------

  /**
   * @internal Tests: a stage ready to draw, or null if it can't be (warned). Its nodes are loaded into a
   * headless World of their own and drawn by a thumbnail renderer with the render features of the enabled
   * plugins, as a World draws them (ADR 0153, 0156). A stage that draws nothing (a disabled plugin's
   * Components) can't be.
   */
  async prepare(stage: ThumbnailStage, live: boolean): Promise<Prepared | null> {
    try {
      await this.loadStudio();
      return await this.prepareStage(stage, live);
    } catch (err) {
      console.warn(`[myco] thumbnail: couldn't draw ${stage.source ?? stage.scene.nodes[0]?.name ?? "an asset"}:`, err);
      return null;
    }
  }

  /** Wait until `scene` can draw (shaders compiled, textures loaded), at most `ms`. */
  private ready(scene: Scene, ms: number): Promise<boolean> {
    return sceneReady(scene, this.readyTimeout ?? ms);
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

  private async prepareStage(stage: ThumbnailStage, live: boolean): Promise<Prepared> {
    const world = new World("editor", this.settings());
    const root = World._runIn(world, () => instantiateDocument(world, stage.scene, stage.source ?? "thumbnail", { onProblem: () => undefined }));
    // The nodes are the World's own, so its cameras are canvas cameras; nothing runs, as the World never steps.
    world.setEditMode(root.entity, false);
    if (stage.dress) World._runIn(world, () => stage.dress!(root));
    const renderer = BabylonRenderer.forThumbnail(this.engine, world.settings, await loadPluginFeatures(world), { studio: this.studioOk ? this.studio : null });
    const dispose = () => {
      renderer.dispose();
      world._destroyAll();
    };
    try {
      // A mesh per MeshRenderer and sprite, framed by their bounds; live effects play and repeat as the editor previews them.
      renderer.setPolicy({ drawPolicy: "perObject", particlePreview: live ? LIVE_PARTICLES : null });
      await this.settle(world, renderer);
      const scene = renderer.scene;
      scene.clearColor = new Color4(0, 0, 0, 0); // tiles follow the editor theme
      if (!renderer.drawsAnything()) throw new Error("it has nothing to draw.");
      const view = stage.view ?? {};
      const main = view.mainCamera ? renderer.mainView() : null;
      let framed: { camera: TargetCamera; target: [number, number, number] };
      if (main) {
        // Seen as its main camera sees it (the renderer set it up from the Camera), over its background.
        const camera = main.babylon;
        const bg = main.camera.backgroundColor;
        if (bg) scene.clearColor = new Color4(bg.r, bg.g, bg.b, 1);
        const forward = new Vector3(0, 0, -1).applyRotationQuaternion(camera.rotationQuaternion ?? Quaternion.Identity());
        const p = camera.position;
        framed = { camera, target: [p.x + forward.x * 10, p.y + forward.y * 10, p.z + forward.z * 10] };
      } else {
        const bounds = renderer.contentBounds();
        const from = view.from && view.from !== "auto" ? view.from : this.autoDirection(world, renderer);
        framed = this.camera(scene, bounds && view.pad ? padded(bounds, view.pad) : bounds, DIRECTIONS[from], view.fallback ?? UNIT);
      }
      await this.ready(scene, 3000);
      const step = live && stage.animates ? (dt: number) => this.advance(world, renderer, dt) : undefined;
      return { scene, ...framed, beforeDraw: (camera) => renderer.beforeStill(camera), step, matte: stage.matte, world, renderer, dispose };
    } catch (err) {
      dispose();
      throw err;
    }
  }

  /** Three-quarters above, or the front when the stage draws only sprites. */
  private autoDirection(world: World, renderer: BabylonRenderer): "above" | "front" {
    const meshes = world._componentsOfType(MeshRenderer).some((c) => c.isActiveAndEnabled);
    return meshes || !renderer.contentMeshes().length ? "above" : "front";
  }

  /** Move a live stage's World on by `dt` seconds, as a frame would, and sync what draws. */
  private advance(world: World, renderer: BabylonRenderer, dt: number): void {
    const time = world.time;
    time.deltaTime = time.unscaledDeltaTime = dt;
    time.time += dt;
    time.realtimeSinceStartup += dt;
    World._runIn(world, () => renderer.sync(world));
    time.deltaTime = time.unscaledDeltaTime = 0;
  }

  /**
   * Sync `world` into `renderer` until what it draws with has loaded (at most the ready timeout), then, if
   * it has particle effects, a second more of frames, as an effect's own thumbnail shows it.
   */
  private async settle(world: World, renderer: BabylonRenderer): Promise<void> {
    const sync = () => World._runIn(world, () => renderer.sync(world));
    sync();
    const deadline = Date.now() + (this.readyTimeout ?? 3000);
    while (!renderer.contentReady() && Date.now() < deadline && !this.disposed) {
      await new Promise((r) => setTimeout(r, 16));
      sync();
    }
    if (!world._componentsOfType(ParticleSystem).length) return;
    for (let t = 0; t < PARTICLE_TIME; t += PARTICLE_DT) {
      world.advanceClock(PARTICLE_DT); // the World never steps: only its clock moves (ADR 0160)
      sync();
    }
    world.advanceClock(0);
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

const padded = (b: Bounds, by: number): Bounds => ({ min: [b.min[0] - by, b.min[1] - by, b.min[2] - by], max: [b.max[0] + by, b.max[1] + by, b.max[2] + by] });
