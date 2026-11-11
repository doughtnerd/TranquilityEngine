/**
 * @internal Editor: a live preview of a particle effect (ADR 0060) on the Babylon backend (ADR 0075
 * stage 7): a canvas of its own, a ground grid, an orbit camera (drag to turn, wheel to zoom), and one
 * effect player (`effectPlayer.ts`, ADR 0153) at the origin, the same player a World's ParticleSystems
 * play through: CPU and kernel systems, their draws and fallbacks, delays, events and restarts. Material
 * assets and textures come from the preview scene's material library (ADR 0127), lit by the preview's own
 * soft lights.
 *
 * The engine starts asynchronously (WebGPU needs `initAsync`), so the constructor returns at once; a
 * program set before that is built when it's up.
 */
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ParticleProgram } from "../../../scene/particleCompile";
import type { ParticleEffectPreviewApi, PreviewBackground } from "../../previewTypes";
import { appliedPixelRatio } from "../../RenderSurface";
import type { GraphShared } from "../graphMaterial";
import { EffectPlayer, EffectResources, libraryEffectHost } from "../effectPlayer";
import { addPreviewLights, aimCamera, createPreviewEngine, createPreviewScene, previewMaterials, renderFrame } from "./common";
import type { BabylonMaterialLibrary } from "../materialLibrary";

export type { PreviewBackground } from "../../previewTypes";

const BACKGROUNDS: Record<PreviewBackground, { clear: string; grid: [string, string] | null }> = {
  dark: { clear: "#17191d", grid: null },
  light: { clear: "#c9cdd4", grid: null },
  grid: { clear: "#17191d", grid: ["#4a505a", "#2d3138"] },
};

/** A finished one-shot effect plays again after this many seconds (when looping is on). */
const REPEAT_GAP = 0.6;
/** Seconds between checks of what the effect draws with (a texture or model loading, a material appearing). */
const RETRY_INTERVAL = 0.25;

/** A GridHelper(20, 20): a line every unit over [-10, 10] on the ground, the two through the origin in `center`. */
function gridLines(scene: Scene, center: string, other: string): LinesMesh {
  const lines: Vector3[][] = [];
  const colors: Color4[][] = [];
  const c = Color4.FromColor3(Color3.FromHexString(center), 1);
  const o = Color4.FromColor3(Color3.FromHexString(other), 1);
  for (let i = 0; i <= 20; i++) {
    const v = i - 10;
    const color = i === 10 ? c : o;
    lines.push([new Vector3(-10, 0, v), new Vector3(10, 0, v)], [new Vector3(v, 0, -10), new Vector3(v, 0, 10)]);
    colors.push([color, color], [color, color]);
  }
  const grid = CreateLineSystem("preview.grid", { lines, colors }, scene);
  grid.isPickable = false;
  return grid;
}

export class ParticleEffectPreview implements ParticleEffectPreviewApi {
  readonly canvas: HTMLCanvasElement;
  /** Playback speed multiplier. */
  speed = 1;
  /** Force one-shot effects to repeat after a short gap. */
  looping = true;
  /** Called when the playing state changes (play, pause). */
  onChange: (() => void) | null = null;

  private engine: AbstractEngine | null = null;
  private scene: Scene | null = null;
  private camera: TargetCamera | null = null;
  private grid: LinesMesh | null = null;
  private readonly resizeObserver: ResizeObserver;
  /** The scene's materials and textures (ADR 0127). */
  private library: BabylonMaterialLibrary | null = null;
  private resources: EffectResources | null = null;
  private readonly shared: GraphShared = { time: 0, resolution: [1, 1] };

  private program: ParticleProgram | null = null;
  private player: EffectPlayer | null = null;
  private retry = 0;
  private _playing = true;
  private frame = 0;
  private last = 0;
  private disposed = false;
  private _background: PreviewBackground = "grid";
  private yaw = 0.6;
  private pitch = 0.4;
  private distance = 6;
  private readonly target = { x: 0, y: 1, z: 0 };

  constructor(private readonly container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { display: "block", width: "100%", height: "100%", touchAction: "none" });
    container.appendChild(this.canvas);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.last = performance.now();
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const engine = await createPreviewEngine(this.canvas, true);
      if (this.disposed) {
        engine.dispose();
        return;
      }
      this.engine = engine;
      const scene = createPreviewScene(engine);
      const camera = new TargetCamera("preview.camera", Vector3.Zero(), scene, false);
      camera.fov = (40 * Math.PI) / 180;
      camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
      camera.minZ = 0.1;
      camera.maxZ = 200;
      camera.rotationQuaternion = Quaternion.Identity();
      scene.activeCamera = camera;
      addPreviewLights(scene, 0.35, 1); // for lit material assets (Babylon's particle systems and the unlit material ignore them)
      this.scene = scene;
      this.library = previewMaterials(scene, this.shared);
      this.resources = new EffectResources(libraryEffectHost(scene, this.library), (message) => console.warn(`[myco] preview: ${message}`));
      this.camera = camera;
      this.background = this._background;
      this.resize();
      this.build();
      this.frame = requestAnimationFrame(this.loop);
    } catch (err) {
      console.warn("[myco] particle preview couldn't start:", err);
    }
  }

  // --- public ----------------------------------------------------------------------------------------

  get playing(): boolean {
    return this._playing;
  }

  get background(): PreviewBackground {
    return this._background;
  }

  set background(value: PreviewBackground) {
    this._background = value;
    const scene = this.scene;
    if (!scene) return; // applied when the scene is made
    const b = BACKGROUNDS[value];
    scene.clearColor = Color4.FromColor3(Color3.FromHexString(b.clear), 1); // sRGB, written as it is
    this.grid?.dispose();
    this.grid = b.grid ? gridLines(scene, b.grid[0], b.grid[1]) : null;
  }

  /** Particles alive and seconds played. */
  get stats(): { particles: number; time: number } {
    return { particles: this.player?.count ?? 0, time: this.player?.time ?? 0 };
  }

  /** Show a compiled effect graph (null clears). Rebuilds the emitters and plays from the start. */
  setProgram(program: ParticleProgram | null): void {
    this.program = program;
    this.clearEmitters();
    this.retry = 0;
    this.build();
  }

  /** Send a custom event (as `ParticleSystem.sendEvent`), starting and stopping the systems wired to it. */
  sendEvent(name: string): void {
    if (this.player?.built) this.player.event(name);
  }

  play(): void {
    if (this._playing) return;
    this._playing = true;
    this.onChange?.();
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    this.onChange?.();
  }

  restart(): void {
    this.player?.restart();
    this._playing = true;
    this.onChange?.();
  }

  resize(w = this.container.clientWidth, h = this.container.clientHeight): void {
    const ratio = appliedPixelRatio(); // the World surface's pixel ratio, at render scale 1 (ADR 0154)
    this.engine?.setSize(Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.clearEmitters();
    this.resources?.dispose();
    this.library?.dispose();
    this.scene?.dispose(); // the grid, textures, particle systems and meshes go with it
    this.engine?.dispose();
    this.canvas.remove();
  }

  // --- building --------------------------------------------------------------------------------------

  private clearEmitters(): void {
    this.player?.dispose();
    this.player = null;
  }

  /** Make the effect's player once the scene is up, and build it (again when what it draws with has changed). */
  private build(): void {
    if (!this.resources || !this.program) return;
    this.player ??= new EffectPlayer(this.resources, this.program, { name: "preview" });
    this.player.build();
    this.retry = RETRY_INTERVAL;
  }

  // --- loop ------------------------------------------------------------------------------------------

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    // Detached or hidden (a closed tab, zero size): neither simulate nor draw.
    if (!this.canvas.isConnected || !this.canvas.clientWidth || !this.canvas.clientHeight) return;
    this.step(dt);
    this.draw();
  };

  private step(realDt: number): void {
    this.retry -= realDt;
    if (this.retry <= 0) this.build(); // a texture or model finished loading, a material appeared
    const player = this.player;
    if (!player?.built) return;
    const dt = this._playing ? realDt * Math.max(0, this.speed) : 0;
    player.step(dt);
    this.shared.time += realDt; // graph materials' Time node
    player.repeatWhenFinished(dt, REPEAT_GAP, this._playing && this.looping);
  }

  private draw(): void {
    const engine = this.engine, scene = this.scene, camera = this.camera;
    if (!engine || !scene || !camera) return;
    const r = this.distance;
    const t = this.target;
    aimCamera(camera, [t.x + Math.sin(this.yaw) * Math.cos(this.pitch) * r, t.y + Math.sin(this.pitch) * r, t.z - Math.cos(this.yaw) * Math.cos(this.pitch) * r], [t.x, t.y, t.z]); // yaw 0 in front, at -Z (ADR 0164)
    renderFrame(engine, scene);
  }

  // --- orbit -----------------------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY, yaw = this.yaw, pitch = this.pitch;
    this.canvas.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      this.yaw = yaw - (m.clientX - x0) * 0.01;
      this.pitch = Math.max(-1.4, Math.min(1.4, pitch + (m.clientY - y0) * 0.01));
    };
    const up = () => {
      this.canvas.removeEventListener("pointermove", move);
      this.canvas.removeEventListener("pointerup", up);
      this.canvas.removeEventListener("pointercancel", up);
    };
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.distance = Math.max(0.5, Math.min(60, this.distance * Math.exp(e.deltaY * 0.001)));
  };
}
