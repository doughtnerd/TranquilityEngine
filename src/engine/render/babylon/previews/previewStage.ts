/**
 * @internal The stage every Babylon preview draws on (ADR 0300): the material and node previews, the particle preview
 * and the thumbnails. It owns, for one canvas, the engine's start-up through the engine factory (`createEngine`, ADR
 * 0244) and the preview disposed while it was starting; the scene, lit by the default rig (ADR 0277); one orbit model
 * (`thumbnailMath`'s `Orbit`: yaw 0 at +Z, drag and wheel through `draggedOrbit` and `wheeledOrbit`); the
 * animation-frame loop; fitting the drawing buffer to its host; and GPU context loss. A preview keeps only what it
 * puts on the stage. Babylon types stay inside `render/babylon/` (ADR 0010).
 */
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { appliedPixelRatio } from "../../RenderSurface";
import { draggedOrbit, orbitPosition, wheeledOrbit, type Orbit } from "../../thumbnailMath";
import { createEngine } from "../createEngine";
import { addDefaultLights } from "../lighting";
import { aimCamera, createPreviewScene, renderFrame, renderFrameChecked } from "./common";

/** A stage's perspective camera, orbiting a point. */
export interface StageOrbit {
  /** Vertical field of view, degrees. */
  readonly fov: number;
  readonly near: number;
  readonly far: number;
  /** The point the camera turns around and looks at. */
  readonly target: readonly [number, number, number];
  /** Where the camera starts. */
  readonly start: Orbit;
  /** Zoom limits (default: the start's distance, no zoom); the wheel zooms when they differ. */
  readonly minDistance?: number;
  readonly maxDistance?: number;
}

export interface PreviewStageOptions {
  /** What the preview is called in the warning when it can't start (`"particle preview"`); absent: no warning. */
  readonly name?: string;
  /** Multisampling (default on). */
  readonly antialias?: boolean;
  /**
   * What the stage's scene is: `"lit"` (default) by the default light rig, `"unlit"` with no lights, or `"none"`: no
   * scene, for a caller that makes its own scenes on the stage's engine (the thumbnails, one per asset).
   */
  readonly scene?: "lit" | "unlit" | "none";
  /**
   * The element the canvas fills (it is put in it when not in the document, and taken out on dispose): the drawing
   * buffer follows its size at the World surface's pixel ratio (ADR 0154). Absent: the canvas keeps its own size.
   */
  readonly host?: HTMLElement;
  /** A camera orbiting a point, turned by dragging the canvas (and zoomed with the wheel within its limits). */
  readonly orbit?: StageOrbit;
  /** Runs once the engine and scene are up, before the first frame: put what the preview shows on the stage. */
  readonly onUp?: (stage: PreviewStage) => void;
  /** Runs on every animation frame while the canvas is shown, with the seconds since the last (at most 0.1); absent: no loop. */
  readonly frame?: (dt: number) => void;
}

/** The longest step one slow frame reports. */
const MAX_STEP = 0.1;

export class PreviewStage {
  /** Resolves true once the engine (and scene) are up; false when no engine started or the stage was disposed first. */
  readonly ready: Promise<boolean>;
  private _engine: AbstractEngine | null = null;
  private _scene: Scene | null = null;
  private _camera: TargetCamera | null = null;
  private view: Orbit;
  private _lost = false;
  private lostListeners: (() => void)[] = [];
  private disposed = false;
  private looping = false;
  private frameId = 0;
  private last = 0;
  private readonly resizeObserver: ResizeObserver | null = null;
  private endDrag: (() => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly options: PreviewStageOptions = {},
  ) {
    const { host, orbit } = options;
    this.view = orbit?.start ?? { yaw: 0, pitch: 0, distance: 1 };
    if (host) {
      Object.assign(canvas.style, { display: "block", width: "100%", height: "100%", touchAction: "none" });
      if (!canvas.isConnected) host.appendChild(canvas);
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(host);
      }
    }
    if (orbit) {
      canvas.addEventListener("pointerdown", this.onPointerDown);
      if (this.zoomLimits()[0] < this.zoomLimits()[1]) canvas.addEventListener("wheel", this.onWheel, { passive: false });
    }
    this.ready = this.start();
  }

  /** The engine, once up (null before, and if it never starts). */
  get engine(): AbstractEngine | null {
    return this._engine;
  }

  /** The stage's scene, once up (never, for `scene: "none"`). */
  get scene(): Scene | null {
    return this._scene;
  }

  /** The orbit camera, once up (only with `orbit`). */
  get camera(): TargetCamera | null {
    return this._camera;
  }

  /** True while the browser has taken the GPU context away (too many contexts, a GPU reset). */
  get lost(): boolean {
    return this._lost;
  }

  /** Run `f` once when the GPU context is lost (at once if it is now). */
  onContextLost(f: () => void): void {
    if (this._lost) f();
    else this.lostListeners.push(f);
  }

  /**
   * Draw one frame of the stage's scene into the canvas, the orbit camera aimed first. With `onShaderError`, the frame
   * is watched for a WGSL shader that didn't compile (`renderFrameChecked`).
   */
  draw(onShaderError?: (message: string) => void): void {
    const engine = this._engine, scene = this._scene, camera = this._camera, orbit = this.options.orbit;
    if (!engine || !scene || this.disposed || this._lost) return;
    if (camera && orbit) aimCamera(camera, orbitPosition(orbit.target, this.view), orbit.target);
    if (onShaderError) renderFrameChecked(engine, scene, onShaderError);
    else renderFrame(engine, scene);
  }

  /** Size the drawing buffer for `w` x `h` CSS pixels (default: the host's size) at the World surface's pixel ratio. */
  resize(w = this.options.host?.clientWidth, h = this.options.host?.clientHeight): void {
    const engine = this._engine;
    if (!engine || w === undefined || h === undefined) return;
    const ratio = appliedPixelRatio(); // at render scale 1 (ADR 0154)
    engine.setSize(Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio)));
  }

  /** Stop the loop and free the scene and engine (and take the canvas out of its host). Safe to call twice, or while starting. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.endDrag?.();
    this.resizeObserver?.disconnect();
    if (this.options.orbit) {
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("wheel", this.onWheel);
    }
    this.lostListeners = [];
    this._scene?.dispose();
    this._engine?.dispose();
    if (this.options.host) this.canvas.remove();
  }

  // --- start-up --------------------------------------------------------------------------------------

  private async start(): Promise<boolean> {
    const { name, orbit } = this.options;
    try {
      const engine = await createEngine(this.canvas, { antialias: this.options.antialias ?? true, transparent: true });
      if (this.disposed) {
        engine.dispose(); // the preview went while the engine was starting
        return false;
      }
      this._engine = engine;
      engine.onContextLostObservable.add(this.onLost);
      engine.onContextRestoredObservable.add(this.onRestored);
      const kind = this.options.scene ?? "lit";
      if (kind !== "none") {
        const scene = createPreviewScene(engine);
        if (kind === "lit") addDefaultLights(scene, "preview"); // the default rig, a World's own (ADR 0277)
        if (orbit) {
          const camera = new TargetCamera("preview.camera", Vector3.Zero(), scene, false);
          camera.fov = (orbit.fov * Math.PI) / 180;
          camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
          camera.minZ = orbit.near;
          camera.maxZ = orbit.far;
          camera.rotationQuaternion = Quaternion.Identity();
          scene.activeCamera = camera;
          this._camera = camera;
        }
        this._scene = scene;
      }
      this.resize();
      this.options.onUp?.(this);
      this.startLoop();
      return true;
    } catch (err) {
      if (name) console.warn(`[myco] ${name} couldn't start:`, err);
      return false;
    }
  }

  // --- loop ------------------------------------------------------------------------------------------

  private startLoop(): void {
    if (!this.options.frame || this.looping || this.disposed || this._lost || !this._engine) return;
    this.looping = true;
    this.last = performance.now();
    this.frameId = requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    this.looping = false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frameId);
  }

  private readonly tick = (now: number): void => {
    if (!this.looping) return;
    this.frameId = requestAnimationFrame(this.tick);
    const dt = Math.min(MAX_STEP, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    // Detached or hidden (a closed tab, zero size): no frame.
    if (!this.canvas.isConnected || !this.canvas.clientWidth || !this.canvas.clientHeight) return;
    this.options.frame!(dt);
  };

  // --- context loss ----------------------------------------------------------------------------------

  private readonly onLost = (): void => {
    this._lost = true;
    this.stopLoop();
    for (const f of this.lostListeners.splice(0)) f();
  };

  private readonly onRestored = (): void => {
    if (this.disposed) return;
    this._lost = false;
    this.startLoop();
  };

  // --- orbit -----------------------------------------------------------------------------------------

  private zoomLimits(): [number, number] {
    const orbit = this.options.orbit!;
    return [orbit.minDistance ?? orbit.start.distance, orbit.maxDistance ?? orbit.start.distance];
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.endDrag?.();
    const x0 = e.clientX, y0 = e.clientY, from = this.view;
    const [min, max] = this.zoomLimits();
    this.canvas.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      this.view = draggedOrbit(from, m.clientX - x0, m.clientY - y0, min, max);
    };
    // A drag ends however the pointer goes: released, cancelled (a touch taken by the browser), or its capture lost.
    const end = () => {
      this.canvas.removeEventListener("pointermove", move);
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) this.canvas.removeEventListener(type, end);
      this.endDrag = null;
    };
    this.canvas.addEventListener("pointermove", move);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) this.canvas.addEventListener(type, end);
    this.endDrag = end;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [min, max] = this.zoomLimits();
    this.view = wheeledOrbit(this.view, e.deltaY, min, max);
  };
}
