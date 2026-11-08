/**
 * @internal Editor: a live preview of a particle effect (ADR 0060) on the Babylon backend (ADR 0075
 * stage 7), with the same API as `render/particles/EffectPreview.ts` (three.js): a canvas of its own, a
 * ground grid, an orbit camera (drag to turn, wheel to zoom), and our own `EffectSimulation` drawn as
 * in a World (`particleDraw.ts`: Babylon particle systems, or meshes for mesh and trail modes and
 * material assets). It mirrors what `BabylonParticles` does for a World's ParticleSystem (build, delays,
 * one-shot repeat) but without a World. Material assets are built here (`buildPreviewMaterial`), lit by
 * the preview's own soft lights.
 *
 * The engine starts asynchronously (WebGPU needs `initAsync`), so the constructor returns at once; a
 * program set before that is built when it's up.
 */
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { meshesIfLoaded } from "../../../scene/models";
import type { ParticleProgram } from "../../../scene/particleCompile";
import { ProgramRunner, playTimes } from "../../particles/programRunner";
import { EffectSimulation } from "../../particles/simulation";
import type { ParticleEffectPreviewApi, PreviewBackground } from "../../previewTypes";
import type { GraphShared } from "../graphMaterial";
import { copyParticles, createDotTexture, makeDraw, type Draw } from "../particleDraw";
import { chooseBackend, compileParticleKernels } from "../../../scene/particleKernel";
import { KernelEffect } from "../../particles/gpu/kernelEffect";
import { BabylonKernelHost, KernelDraw, SceneDepth } from "../gpuParticles";
import { addPreviewLights, aimCamera, buildPreviewMaterial, createPreviewEngine, createPreviewScene, loadTexture, renderFrame, type PreviewMaterial } from "./common";

export type { PreviewBackground } from "../../previewTypes";

const BACKGROUNDS: Record<PreviewBackground, { clear: string; grid: [string, string] | null }> = {
  dark: { clear: "#17191d", grid: null },
  light: { clear: "#c9cdd4", grid: null },
  grid: { clear: "#17191d", grid: ["#4a505a", "#2d3138"] },
};

/** A finished one-shot effect plays again after this many seconds (when looping is on). */
const REPEAT_GAP = 0.6;
/** Seconds between rebuild attempts while a texture is still loading. */
const RETRY_INTERVAL = 0.25;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const WHITE: [number, number, number, number] = [1, 1, 1, 1];

/** An emitter texture: loading, failed (the dot stands in), or ready. */
type TextureState = Promise<unknown> | "failed" | Texture;
/** An emitter's material asset: loading, failed (its texture and blending stand in), or built. */
type MaterialState = Promise<unknown> | "failed" | PreviewMaterial;

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
  private readonly textures = new Map<string, TextureState>();
  private readonly materials = new Map<string, MaterialState>();
  private readonly shared: GraphShared = { time: 0, resolution: [1, 1] };
  private dot: RawTexture | null = null;

  private runner: ProgramRunner | null = null;
  private sim: EffectSimulation | null = null;
  private draws: Draw[] = [];
  /** Kernel systems (ADR 0094), as the World player runs them. */
  private kfx: KernelEffect | null = null;
  private kdraws: KernelDraw[] = [];
  private depth: SceneDepth | null = null;
  private kernelHost: BabylonKernelHost | null = null;
  private retry = 0;
  private _playing = true;
  private time = 0;
  private idle = 0;
  private count = 0;
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
    return { particles: this.count, time: this.time };
  }

  /** Show a compiled effect graph (null clears). Rebuilds the emitters and plays from the start. */
  setProgram(program: ParticleProgram | null): void {
    this.runner = program && new ProgramRunner(program);
    this.clearEmitters();
    this.retry = 0;
    this.build();
  }

  /** Send a custom event (as `ParticleSystem.sendEvent`), starting and stopping the systems wired to it. */
  sendEvent(name: string): void {
    const route = this.runner?.program.custom.get(name);
    if (!route || !this.sim) return;
    for (const e of this.sim.emitters) {
      const i = this.runner!.program.systems.indexOf(e.name);
      if (route.start.includes(i)) this.sim.startEmitter(e);
      else if (route.stop.includes(i)) this.sim.endEmit(e);
    }
    for (const s of this.kfx?.systems ?? []) {
      if (route.start.includes(s.kernel.emitter)) this.kfx!.startEmitter(s.kernel.emitter);
      else if (route.stop.includes(s.kernel.emitter)) this.kfx!.endEmit(s.kernel.emitter);
    }
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
    this.restartEmitters();
    this._playing = true;
    this.onChange?.();
  }

  resize(w = this.container.clientWidth, h = this.container.clientHeight): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
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
    this.depth?.dispose();
    this.textures.clear();
    for (const m of this.materials.values()) if (typeof m === "object" && !(m instanceof Promise)) m.dispose();
    this.materials.clear();
    this.scene?.dispose(); // the grid, textures, particle systems and meshes go with it
    this.engine?.dispose();
    this.canvas.remove();
  }

  // --- building --------------------------------------------------------------------------------------

  private clearEmitters(): void {
    for (const d of this.draws) d.dispose();
    this.draws = [];
    for (const d of this.kdraws) d.dispose();
    this.kdraws = [];
    this.kfx?.dispose();
    this.kfx = null;
    this.sim = null;
    this.count = 0;
    this.time = 0;
    this.idle = 0;
  }

  /** An emitter's texture: undefined while it loads (the load starts), null if it failed, else the texture. */
  private texture(path: string): Texture | null | undefined {
    const scene = this.scene!;
    const have = this.textures.get(path);
    if (have === undefined) {
      const p = loadTexture(scene, path, "color").then(
        (tex) => this.textures.set(path, tex),
        (err: Error) => {
          console.warn(`[myco] preview: couldn't load particle texture "${path}": ${err.message}`);
          this.textures.set(path, "failed");
        },
      );
      this.textures.set(path, p);
      return undefined;
    }
    if (have === "failed") return null;
    if (have instanceof Promise) return undefined;
    return have;
  }

  /** An emitter's material asset: undefined while it builds (the build starts), null if it failed, else the material. */
  private material(path: string): PreviewMaterial | null | undefined {
    const have = this.materials.get(path);
    if (have === undefined) {
      const p = buildPreviewMaterial(this.scene!, path, this.shared).then(
        (m) => {
          if (this.disposed) m.dispose();
          else this.materials.set(path, m);
        },
        (err: Error) => {
          console.warn(`[myco] preview: couldn't build particle material "${path}": ${err.message}`);
          this.materials.set(path, "failed");
        },
      );
      this.materials.set(path, p);
      return undefined;
    }
    if (have === "failed") return null;
    if (have instanceof Promise) return undefined;
    return have;
  }

  private build(): void {
    const scene = this.scene;
    if (!scene || !this.runner || this.sim) return;
    const effect = this.runner.effect();
    // Wait for every material, model and texture the emitters draw with, so the build isn't redone.
    let waiting = false;
    for (const e of effect.emitters) {
      if (!e.enabled) continue;
      const r = e.renderer;
      const material = r.material ? this.material(r.material) : null;
      if (material === undefined) waiting = true;
      else if (!material && r.texture && this.texture(r.texture) === undefined) waiting = true;
      if (r.mode === "mesh" && meshesIfLoaded(r.mesh) === null) waiting = true;
    }
    if (waiting) {
      this.retry = RETRY_INTERVAL; // still loading something
      return;
    }
    // Kernel systems (ADR 0094) run as in the World; the rest on the CPU simulation.
    const program = this.runner.program;
    this.depth ??= new SceneDepth(scene);
    this.kernelHost ??= new BabylonKernelHost(scene, this.depth);
    const kernels = program.source ? compileParticleKernels(program.source, program).systems : [];
    const systems = program.source?.systems.filter((x) => x.enabled !== false) ?? [];
    const backends = kernels.map((k, i) => chooseBackend(systems[i]?.settings.simulation, k, this.kernelHost!.executors));
    for (const [i, k] of kernels.entries()) if (k.event) backends[i] = backends[k.event.parent] === "cpu" ? "cpu" : backends[i] === "cpu" ? backends[k.event.parent] : backends[i];
    const running = kernels.filter((_, i) => backends[i] !== "cpu");
    const cpuEffect = running.length ? { ...effect, emitters: effect.emitters.map((e, i) => (backends[i] === "cpu" ? e : { ...e, enabled: false })) } : effect;
    if (running.length) {
      this.kfx = new KernelEffect(running, effect.emitters, this.kernelHost, { live: this.runner.live, seeds: program.seeds });
      for (const sys of this.kfx.systems)
        sys.kernel.outputs.forEach((o, k) => {
          const tex = o.settings.texture ? this.texture(o.settings.texture) : null;
          const mesh = o.type === "mesh" ? meshesIfLoaded(o.settings.mesh)?.[0] : undefined;
          this.kdraws.push(new KernelDraw(scene, `particles:${sys.kernel.id}:${k}`, sys.kernel, k, sys.run, tex ?? (this.dot ??= createDotTexture(scene)), this.depth!, { mesh, softness: o.settings.softness ?? 0 }));
        });
    }
    const sim = new EffectSimulation(cpuEffect, { live: this.runner.live });
    this.sim = sim;
    this.draws = sim.emitters.map((e) => {
      const r = e.renderer;
      const material = (r.material ? this.material(r.material) : null)?.material ?? null;
      const tex = r.texture && !material ? this.texture(r.texture) : null;
      const mesh = r.mode === "mesh" ? meshesIfLoaded(r.mesh)?.[0] : undefined;
      return makeDraw(scene, `particles:${e.name}`, e, Math.max(1, Math.ceil(e.settings.maxParticles)), tex ?? (this.dot ??= createDotTexture(scene)), !tex, { material, mesh, depth: this.depth });
    });
    this.restartEmitters();
  }

  private restartEmitters(): void {
    const program = this.runner?.program;
    const sim = this.sim;
    if (sim) {
      sim.restart();
      for (const e of sim.emitters) {
        // Systems started by events (not On Play) wait for them.
        const i = program?.systems.indexOf(e.name) ?? -1;
        if (program && i >= 0 && !program.autoStart[i]) sim.endEmit(e);
      }
    }
    if (this.kfx) {
      this.kfx.restart();
      for (const s of this.kfx.systems) if (!s.parent && program && !(program.autoStart[s.kernel.emitter] ?? true)) this.kfx.endEmit(s.kernel.emitter);
    }
    this.time = 0;
    this.idle = 0;
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
    const sim = this.sim;
    if (!sim) {
      if (this.runner) {
        this.retry -= realDt;
        if (this.retry <= 0) this.build();
      }
      return;
    }
    const dt = this._playing ? realDt * Math.max(0, this.speed) : 0;
    if (dt > 0) {
      this.time += dt;
      if (this.runner) this.runner.update(this.time, dt, playTimes(this.runner.program, this.time));
      sim.step(dt, IDENTITY, 1, WHITE);
      if (this.kfx && this.runner) this.kfx.step(dt, IDENTITY, 1, WHITE, this.runner.context, null, playTimes(this.runner.program, this.time));
    }
    this.shared.time += realDt; // graph materials' Time node
    for (const d of this.draws) copyParticles(d);
    for (const d of this.kdraws) d.update();
    this.count = sim.count + (this.kfx?.count ?? 0);
    if (this._playing && this.looping) {
      if (!sim.emitting && !this.kfx?.emitting && this.count === 0) {
        this.idle += dt;
        if (this.idle >= REPEAT_GAP) this.restartEmitters();
      } else this.idle = 0;
    }
  }

  private draw(): void {
    const engine = this.engine, scene = this.scene, camera = this.camera;
    if (!engine || !scene || !camera) return;
    const r = this.distance;
    const t = this.target;
    aimCamera(camera, [t.x + Math.sin(this.yaw) * Math.cos(this.pitch) * r, t.y + Math.sin(this.pitch) * r, t.z + Math.cos(this.yaw) * Math.cos(this.pitch) * r], [t.x, t.y, t.z]);
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
