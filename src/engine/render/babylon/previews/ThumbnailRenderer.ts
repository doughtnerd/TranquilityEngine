/**
 * @internal Editor: asset thumbnails on the Babylon backend (ADR 0061, 0075 stage 7): one offscreen engine
 * draws still images of models, materials, shader graphs, environments, skies, particle effects, prefabs and
 * scenes, with a transparent background so tiles follow the editor theme, and animates one hovered tile at a
 * time (particle effects, skies, shader graphs that use Time), plus the Inspector's orbitable preview.
 *
 * What each asset draws is built by `ThumbnailScenes` (`thumbnailScenes.ts`): prefabs, scenes, environment
 * maps and skies through the real render features in a headless World (ADR 0153, 0189). This module draws
 * and captures those scenes: canvas sizing, matting, encoding, the hover animation and the preview's orbit (the one
 * orbit model of `thumbnailMath`, ADR 0300). Its engine and context loss are a preview stage's (ADR 0300) with no
 * scene of its own: each asset's scene is made on the stage's engine.
 *
 * Reached through `src/engine/editor`, which loads this file only when the Babylon renderer is chosen.
 */
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { materialGraph } from "../../../scene/material";
import { moveOrbit, orbitOf, orbitPosition, previewPixels, type Orbit } from "../../thumbnailMath";
import type { PosedPreviewSpec, ThumbnailKind, ThumbnailPreview, ThumbnailRendererApi } from "../../previewTypes";
import { aimCamera, ensureCanvasSize, readGraph, readMaterial, renderFrame, usesTime } from "./common";
import { PreviewStage } from "./previewStage";
import { ThumbnailScenes, type ThumbnailOptions, type ThumbnailScene } from "./thumbnailScenes";

export { frameView, seededRandom } from "../../thumbnailMath";
export type { ThumbnailKind, ThumbnailPreview } from "../../previewTypes";
export type { ThumbnailOptions } from "./thumbnailScenes";

/** Thumbnails are this many pixels square: about twice the Assets panel's largest tile. */
export const THUMBNAIL_SIZE = 256;

/** Hover animation: frames per second, and the longest step a slow frame simulates. */
const ANIMATION_FPS = 30;
const MAX_STEP = 0.1;
/** Previews draw at most this many pixels across, so a large Inspector doesn't cost a large buffer. */
const MAX_PREVIEW_PIXELS = 768;

/** Draws and captures the scenes `ThumbnailScenes` builds: stills, the hover animation and the Inspector's preview. */
export class ThumbnailRenderer implements ThumbnailRendererApi {
  private readonly scenes: ThumbnailScenes;
  private animation: { stop(): void } | null = null;
  /** The open orbitable previews (the Inspector's, the Sky panel's…): several at once, each drawing its own scene in turn. */
  private readonly live = new Set<{ stop(): void }>();
  /** A `size` x `size` 2D canvas thumbnails are copied into for encoding. */
  private still: HTMLCanvasElement | null = null;
  /** Where particle thumbnails are drawn twice and combined. */
  private scratch: HTMLCanvasElement | null = null;
  private disposed = false;
  private readonly engine: AbstractEngine;
  /** True once the browser has taken the GPU context away (too many contexts, a GPU reset). */
  lost = false;

  /** A renderer on its own offscreen engine (WebGPU where there is, else WebGL2). Rejects if no engine starts. */
  static async create(size = THUMBNAIL_SIZE, options: ThumbnailOptions = {}): Promise<ThumbnailRenderer> {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const stage = new PreviewStage(canvas, { scene: "none" });
    if (!(await stage.ready)) throw new Error("thumbnails: no GPU engine (WebGPU or WebGL2) started");
    return new ThumbnailRenderer(stage, size, options);
  }

  /** A renderer on `stage` (up, with no scene of its own), which it then owns (disposes); `size` is the thumbnails' pixels. */
  private constructor(
    private readonly stage: PreviewStage,
    readonly size: number = THUMBNAIL_SIZE,
    options: ThumbnailOptions = {},
  ) {
    this.engine = stage.engine!;
    this.scenes = new ThumbnailScenes(this.engine, size, options);
    stage.onContextLost(() => {
      this.lost = true;
      for (const preview of [...this.live]) preview.stop();
      this.animation?.stop();
    });
  }

  /** Run `f` once if the GPU context is lost (the renderer is then useless: make another). */
  onContextLost(f: () => void): void {
    if (this.lost) f();
    else this.stage.onContextLost(f);
  }

  /**
   * Draw `prepared` into the engine's canvas at `w` x `h` (resizing it if it isn't), then copy it into
   * `target`, filling it. Two frames, so anything that bound late is in the second.
   */
  private draw(prepared: ThumbnailScene, w: number, h: number, target: HTMLCanvasElement | null, frames = 1): void {
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
  private drawMatted(prepared: ThumbnailScene, w: number, h: number, target: HTMLCanvasElement, ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, frames: number): void {
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
    const prepared = await this.scenes.prepare(kind, path, false);
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
    if (this.live.size || this.lost) return () => undefined; // a live preview has the renderer: tiles stay stills
    this.animation?.stop();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let prepared: ThumbnailScene | null = null;
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
    void this.scenes.prepare(kind, path, true).then((p) => {
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
   * It takes the renderer from any hover animation; other open previews keep drawing beside it.
   */
  preview(kind: ThumbnailKind, path: string, target: HTMLCanvasElement): ThumbnailPreview {
    return this.startPreview(() => this.scenes.prepare(kind, path, true), this.canAnimate(kind, path), target);
  }

  /** An orbitable preview of the World `spec` describes, drawn continuously: its World steps every frame (ADR 0373, T18b). */
  previewPosed(spec: PosedPreviewSpec, target: HTMLCanvasElement): ThumbnailPreview {
    return this.startPreview(() => this.scenes.prepareWorld(spec), true, target);
  }

  private startPreview(prepare: () => Promise<ThumbnailScene | null>, animates: boolean, target: HTMLCanvasElement): ThumbnailPreview {
    // Other open previews keep going (the Inspector's and the Sky panel's of the same sky, say): each one
    // draws its own scene into the shared engine and copies it out in the same task, so they take turns.
    this.animation?.stop();
    let stopped = false;
    let prepared: ThumbnailScene | null = null;
    let center: [number, number, number] = [0, 0, 0];
    let start: Orbit = { yaw: 0, pitch: 0, distance: 1 };
    let view: Orbit = start;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let queued = false;
    let last = performance.now();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      prepared?.dispose();
      prepared = null;
      if (this.live.delete(handle) && this.live.size === 0 && !this.lost) ensureCanvasSize(this.engine, this.size, this.size); // back to the tiles' size
    };
    const handle = { stop };
    this.live.add(handle);
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
    const ready = prepare().then((p) => {
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
        view = moveOrbit(view, -dyaw, dpitch, 1, near(), far()); // left-handed: yaw turns the other way on screen
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
    for (const preview of [...this.live]) preview.stop();
    this.animation?.stop();
    this.scenes.dispose();
    this.stage.dispose();
  }
}
