/**
 * @internal Editor: a live preview of a particle effect (ADR 0060) in a canvas of its own: a ground
 * grid, an orbit camera (drag to turn, wheel to zoom) and one three.quarks BatchedRenderer. It
 * mirrors what ParticleRenderer does for a World's ParticleSystem (build, shape matrix, delays,
 * one-shot repeat) but without a World. Reached through `src/engine/editor`, never the public API.
 */
import {
  AdditiveBlending,
  Color,
  DataTexture,
  GridHelper,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  MeshBasicMaterial,
  NormalBlending,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  WebGLRenderer,
} from "three";
import { BatchedRenderer, type ParticleSystem as QuarksSystem } from "three.quarks";
import { Assets } from "../../scene/Assets";
import { meshesIfLoaded } from "../../scene/models";
import type { ParticleRenderer as RendererSettings } from "../../scene/particles";
import type { ParticleProgram } from "../../scene/particleCompile";
import { ProgramRunner } from "./programRunner";
import { buildEffect, type BuiltEmitter } from "./quarksEffect";

export type PreviewBackground = "dark" | "light" | "grid";

const BACKGROUNDS: Record<PreviewBackground, { clear: number; grid: [number, number] | null }> = {
  dark: { clear: 0x17191d, grid: null },
  light: { clear: 0xc9cdd4, grid: null },
  grid: { clear: 0x17191d, grid: [0x4a505a, 0x2d3138] },
};

/** A finished one-shot effect plays again after this many seconds (when looping is on). */
const REPEAT_GAP = 0.6;
/** Seconds between rebuild attempts while a texture or model is still loading. */
const RETRY_INTERVAL = 0.25;

/** A soft round dot: the default particle texture. */
function makeDot(): Texture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - d);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * a * (3 - 2 * a) * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const emitEnded = (s: QuarksSystem) => (s as unknown as { emitEnded: boolean }).emitEnded;

export class ParticleEffectPreview {
  readonly canvas: HTMLCanvasElement;
  /** Playback speed multiplier. */
  speed = 1;
  /** Force one-shot effects to repeat after a short gap. */
  looping = true;
  /** Called when the playing state changes (play, pause). */
  onChange: (() => void) | null = null;

  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(40, 1, 0.1, 200);
  private readonly batch = new BatchedRenderer();
  private grid: GridHelper | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly loader = new TextureLoader();
  private readonly textures = new Map<string, Texture | Promise<Texture | null>>();
  private readonly materials = new Map<string, MeshBasicMaterial>();
  private dot: Texture | null = null;

  private runner: ProgramRunner | null = null;
  private emitters: BuiltEmitter[] | null = null;
  private readonly scale = { value: 1 };
  private readonly tint = { value: [1, 1, 1, 1] as [number, number, number, number] };
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
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.batch.renderOrder = 0;
    this.scene.add(this.batch);
    this.background = "grid";
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.loop);
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
    const b = BACKGROUNDS[value];
    this.renderer.setClearColor(new Color(b.clear), 1);
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as Material).dispose();
      this.grid = null;
    }
    if (b.grid) {
      this.grid = new GridHelper(20, 20, b.grid[0], b.grid[1]);
      this.scene.add(this.grid);
    }
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
    if (!route) return;
    for (const e of this.emitters ?? []) {
      const i = this.runner!.program.systems.indexOf(e.name);
      if (route.start.includes(i)) {
        e.system.looping = e.looping;
        e.system.restart();
      } else if (route.stop.includes(i)) {
        e.system.looping = false;
        e.system.endEmit();
      }
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
    w = Math.max(1, w);
    h = Math.max(1, h);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.clearEmitters();
    this.scene.remove(this.batch);
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const t of this.textures.values()) {
      if (t instanceof Promise) void t.then((x) => x?.dispose(), () => undefined);
      else t.dispose();
    }
    this.textures.clear();
    this.dot?.dispose();
    this.grid?.geometry.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // free the context now, not at garbage collection (browsers cap live contexts)
    this.canvas.remove();
  }

  // --- building --------------------------------------------------------------------------------------

  private clearEmitters(): void {
    for (const e of this.emitters ?? []) {
      this.scene.remove(e.system.emitter);
      e.system.dispose();
    }
    this.emitters = null;
    this.count = 0;
    this.time = 0;
    this.idle = 0;
  }

  private build(): void {
    if (!this.runner || this.emitters) return;
    const built = buildEffect(this.runner.effect(), {
      material: (r) => this.material(r),
      geometry: (mesh) => meshesIfLoaded(mesh)?.[0]?.geometry ?? null,
      scale: this.scale,
      tint: this.tint,
      live: this.runner.live,
    });
    if (!built) {
      this.retry = RETRY_INTERVAL; // still loading something
      return;
    }
    this.emitters = built;
    for (const e of built) {
      e.system.emitter.matrixAutoUpdate = false;
      e.system.emitter.matrix.copy(e.shapeMatrix);
      e.system.emitter.matrixWorldNeedsUpdate = true;
      this.scene.add(e.system.emitter);
      this.batch.addSystem(e.system);
    }
    this.restartEmitters();
  }

  private restartEmitters(): void {
    const program = this.runner?.program;
    for (const e of this.emitters ?? []) {
      e.system.looping = e.looping;
      e.system.restart();
      // Systems started by events (not On Play) wait for them.
      const i = program?.systems.indexOf(e.name) ?? -1;
      if (program && i >= 0 && !program.autoStart[i]) {
        e.system.looping = false;
        e.system.endEmit();
      }
    }
    this.time = 0;
    this.idle = 0;
  }

  /** The unlit material an emitter draws with: its texture (a soft dot by default); null while the texture loads. Material assets aren't resolved in the preview. */
  private material(r: RendererSettings): Material | null {
    let map: Texture;
    if (r.texture) {
      const have = this.textures.get(r.texture);
      if (have instanceof Promise) return null;
      if (!have) {
        const p = this.loader.loadAsync(Assets.url(r.texture)).then(
          (tex) => {
            tex.colorSpace = SRGBColorSpace;
            this.textures.set(r.texture, tex);
            return tex;
          },
          (err) => {
            console.warn(`[myco] preview: couldn't load particle texture "${r.texture}": ${(err as Error).message}`);
            this.textures.set(r.texture, (this.dot ??= makeDot()));
            return null;
          },
        );
        this.textures.set(r.texture, p);
        return null;
      }
      map = have;
    } else map = this.dot ??= makeDot();
    const key = `${r.texture}|${r.blending}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: r.blending === "additive" ? AdditiveBlending : NormalBlending, premultipliedAlpha: r.blending === "premultiplied" });
      this.materials.set(key, m);
    }
    return m;
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
    if (!this.emitters) {
      if (this.runner) {
        this.retry -= realDt;
        if (this.retry <= 0) this.build();
      }
      return;
    }
    const dt = this._playing ? realDt * Math.max(0, this.speed) : 0;
    if (dt > 0) {
      this.time += dt;
      const d = this.runner?.program.effect.emitters[0]?.duration ?? 0;
      this.runner?.update(this.time, dt, d > 0 ? this.time % d : this.time);
      for (const e of this.emitters) {
        if (this.time < e.startDelay) continue;
        (e.system as unknown as { update(dt: number): void }).update(dt);
      }
    }
    for (const b of this.batch.batches) b.update();
    this.count = this.emitters.reduce((n, e) => n + e.system.particleNum, 0);
    if (this._playing && this.looping) {
      const emitting = this.emitters.some((e) => !e.subEmitter && (e.looping || this.time < e.startDelay || !emitEnded(e.system)));
      if (!emitting && this.count === 0) {
        this.idle += dt;
        if (this.idle >= REPEAT_GAP) this.restartEmitters();
      } else this.idle = 0;
    }
  }

  private draw(): void {
    const r = this.distance;
    const t = this.target;
    this.camera.position.set(t.x + Math.sin(this.yaw) * Math.cos(this.pitch) * r, t.y + Math.sin(this.pitch) * r, t.z + Math.cos(this.yaw) * Math.cos(this.pitch) * r);
    this.camera.lookAt(t.x, t.y, t.z);
    this.renderer.render(this.scene, this.camera);
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
