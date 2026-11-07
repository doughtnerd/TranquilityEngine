// Internal (ADR 0094): plays the kernel systems of one effect instance. Renderer-neutral: it spawns
// on the CPU, writes each system's uniforms and look-up table, and asks a `KernelRun` (made by the
// render backend: WebGPU compute, WebGL2 textures, or the JavaScript executor) to step the particles.
import { HEADER_VEC4, LUT_SAMPLES, U, bakeLuts, writeBindings, type KernelExecutor, type KernelSystem } from "../../../scene/particleKernel";
import type { EvalContext } from "../../../scene/particleNodes";
import type { ParticleEmitterSettings } from "../../../scene/particles";
import type { LiveBox } from "../simulation";
import { JsKernel } from "./kernelJs";
import { KernelSpawner } from "./spawner";

/** Camera data for depth collision (null when there's no depth texture). */
export interface KernelDepth {
  /** View-projection, column-major. */
  viewProj: ArrayLike<number>;
  /** The view matrix's z row. */
  viewZ: [number, number, number, number];
  width: number;
  height: number;
  near: number;
  far: number;
}

/** One kernel system running on an executor. */
export interface KernelRun {
  readonly kind: KernelExecutor;
  /**
   * Step one frame with `uniforms` (vec4s; header + bindings). `lut` is passed when it changed.
   * `parent` is the event parent's run, already stepped this frame.
   */
  step(uniforms: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void;
  clear(): void;
  dispose(): void;
}

/** Makes runs: the render backend's part. */
export interface KernelHost {
  /** Executors available, best first (`["webgpu"]`, `["webgl2", "js"]`, `["js"]`). */
  readonly executors: readonly KernelExecutor[];
  createRun(kernel: KernelSystem, kind: KernelExecutor): KernelRun;
  /** Camera data for depth collision, when the backend has a depth texture. */
  depth?(): KernelDepth | null;
}

/** The JavaScript executor as a run (also used by the GPU backends' uploads). */
export class JsRun implements KernelRun {
  readonly kind = "js" as const;
  readonly js: JsKernel;
  constructor(kernel: KernelSystem) {
    this.js = new JsKernel(kernel);
  }
  step(uniforms: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    this.js.uniforms.set(uniforms.subarray(0, this.js.uniforms.length));
    if (lut) this.js.lut.set(lut.subarray(0, this.js.lut.length));
    this.js.step(parent instanceof JsRun ? parent.js : parent && "js" in parent ? (parent as unknown as { js: JsKernel }).js : null);
  }
  clear(): void {
    this.js.clear();
  }
  dispose(): void {}
}

interface SystemRun {
  kernel: KernelSystem;
  run: KernelRun;
  spawner: KernelSpawner;
  uniforms: Float32Array;
  lut: Float32Array;
  lutDirty: boolean;
  /** Parent system (GPU events), stepped first. */
  parent: SystemRun | null;
  /** Emitting (started); event children follow their parent. */
  active: boolean;
  frame: number;
  extra: number;
  seed: number;
}

export interface KernelEffectOptions {
  /** Live value lookup (the program runner's): emitter index, settings path. */
  live?: (emitter: number, path: string) => LiveBox | undefined;
  random?: () => number;
  /** Per system: its own seed, else the effect's. */
  seeds?: readonly (number | null)[];
  seed?: number;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export class KernelEffect {
  readonly systems: SystemRun[] = [];
  private readonly rnd: () => number;
  private time = 0;
  private lastOverrides: unknown = null;

  constructor(
    kernels: readonly KernelSystem[],
    emitters: readonly ParticleEmitterSettings[],
    private readonly host: KernelHost,
    options: KernelEffectOptions = {},
  ) {
    this.rnd = options.random ?? Math.random;
    const kind = host.executors[0] ?? "js";
    const byIndex = new Map<number, SystemRun>();
    for (const k of kernels) {
      const settings = emitters[k.emitter];
      const run = host.createRun(k, kind);
      const sr: SystemRun = {
        kernel: k,
        run,
        spawner: new KernelSpawner(settings, k.capacity, (path) => options.live?.(k.emitter, path)),
        uniforms: new Float32Array(Math.max(HEADER_VEC4, k.uniformVec4) * 4),
        lut: new Float32Array(Math.max(1, k.luts.length) * LUT_SAMPLES * 4),
        lutDirty: true,
        parent: null,
        active: true,
        frame: 0,
        extra: 0,
        // 24 bits: the seed travels as a float uniform.
        seed: ((options.seeds?.[k.emitter] ?? options.seed ?? 0) & 0xffffff) || Math.floor(this.rnd() * 16777215) + 1,
      };
      bakeLuts(k, sr.lut, null);
      byIndex.set(kernels.indexOf(k), sr);
      this.systems.push(sr);
    }
    for (const [i, sr] of byIndex) {
      void i;
      if (sr.kernel.event) sr.parent = byIndex.get(sr.kernel.event.parent) ?? null;
    }
    // Parents step before their children.
    this.systems.sort((a, b) => depth(a) - depth(b));
  }

  /** The run of the system with emitter index `emitter`. */
  runOf(emitter: number): SystemRun | undefined {
    return this.systems.find((s) => s.kernel.emitter === emitter);
  }

  /** New baked settings (non-live bindings changed). */
  setSettings(emitters: readonly ParticleEmitterSettings[]): void {
    for (const s of this.systems) s.spawner.setSettings(emitters[s.kernel.emitter]);
  }

  /**
   * Step every system `dt` seconds. `world` is the node's matrix (column-major), `ctx` the program's
   * evaluation context (time, properties), `overrides` the instance's property overrides (identity
   * compared: curves and gradients from properties re-bake when it changes).
   */
  step(dt: number, world: ArrayLike<number>, scale: number, tint: readonly number[], ctx: EvalContext, overrides: unknown): void {
    if (overrides !== this.lastOverrides) {
      this.lastOverrides = overrides;
      for (const s of this.systems) {
        if (s.kernel.luts.some((l) => l.source)) {
          bakeLuts(s.kernel, s.lut, ctx);
          s.lutDirty = true;
        }
      }
    }
    this.time += dt;
    const inv = invert(world);
    const depthInfo = this.host.depth?.() ?? null;
    for (const s of this.systems) {
      if (s.spawner.prewarmPending && !s.parent) {
        s.spawner.prewarmPending = false;
        const step = 1 / 30;
        const d = s.spawner;
        for (let t = 0; t < d.settings.duration; t += step) this.stepOne(s, step, world, inv, scale, tint, ctx, null);
      }
      this.stepOne(s, dt, world, inv, scale, tint, ctx, depthInfo);
    }
  }

  private stepOne(s: SystemRun, dt: number, world: ArrayLike<number>, inv: number[], scale: number, tint: readonly number[], ctx: EvalContext, depth: KernelDepth | null): void {
    const u = s.uniforms;
    const k = s.kernel;
    const sp = s.parent
      ? { start: 0, count: 0, frac: 0, before: 0 }
      : s.active
        ? s.spawner.advance(dt, [world[12], world[13], world[14]], scale, this.rnd, s.extra)
        : { start: 0, count: 0, frac: 0, before: 0 };
    s.extra = 0;
    s.frame = (s.frame + 1) % 16777216;
    u.set([this.time, dt, ctx.playTime, sp.frac], U.time * 4);
    u.set([sp.start, sp.count, k.capacity, s.frame], U.spawn * 4);
    for (let i = 0; i < 16; i++) u[U.matrix * 4 + i] = world[i] ?? IDENTITY[i];
    u.set(inv, U.inverse * 4);
    u.set([tint[0] ?? 1, tint[1] ?? 1, tint[2] ?? 1, tint[3] ?? 1], U.tint * 4);
    const parent = s.parent;
    const slots = parent ? Math.max(1, Math.floor(k.capacity / parent.kernel.capacity)) : 1;
    u.set([sp.before, s.seed, slots, parent ? parent.kernel.capacity : 0], U.misc * 4);
    if (k.event && parent) {
      const settings = s.spawner.settings;
      const count = settings.emission.bursts.reduce((n, b) => n + (typeof b.count === "number" ? b.count : 0), 0) || 1;
      const rate = typeof settings.emission.rateOverTime === "number" ? settings.emission.rateOverTime : 0;
      u.set([count, s.active ? k.event.probability : 0, rate * dt, k.event.inheritVelocity ? 1 : 0], U.event * 4);
      u.set([k.event.trigger === "birth" ? 0 : k.event.trigger === "death" ? 1 : 2, 0, k.space === "world" ? 1 : 0, 0], U.flags * 4);
    } else {
      u.set([0, 0, 0, 0], U.event * 4);
      u.set([-1, 0, k.space === "world" ? 1 : 0, 0], U.flags * 4);
    }
    if (depth) {
      for (let i = 0; i < 16; i++) u[U.viewProj * 4 + i] = depth.viewProj[i];
      u.set([depth.width, depth.height, k.depth ? 1 : 0, depth.near], U.depth * 4);
      u.set(depth.viewZ, U.viewZ * 4);
      u.set([depth.far, 0, 0, 0], U.depth2 * 4);
    } else {
      u[U.depth * 4 + 2] = 0;
    }
    writeBindings(k, ctx, u);
    s.run.step(u, s.lutDirty ? s.lut : null, parent?.run ?? null);
    s.lutDirty = false;
  }

  restart(): void {
    for (const s of this.systems) {
      s.spawner.restart();
      s.run.clear();
      s.active = true;
    }
  }

  clear(): void {
    for (const s of this.systems) {
      s.run.clear();
      s.spawner.cleared();
    }
  }

  /** Stop one system's emission (or all). */
  endEmit(emitter?: number): void {
    for (const s of this.systems) if (emitter === undefined || s.kernel.emitter === emitter) {
      s.spawner.stop();
      s.active = false;
    }
  }

  startEmitter(emitter: number): void {
    const s = this.runOf(emitter);
    if (!s) return;
    s.spawner.restart();
    s.active = true;
  }

  /** `ParticleSystem.emit`: spread over the systems that spawn on their own. */
  emit(count: number): void {
    const own = this.systems.filter((s) => !s.parent);
    for (const s of own) s.extra += Math.ceil(count / Math.max(1, own.length));
  }

  /** Estimated live particles. */
  get count(): number {
    let n = 0;
    for (const s of this.systems) {
      if (s.parent) n += Math.min(s.kernel.capacity, s.parent.spawner.estimate * Math.max(1, Math.floor(s.kernel.capacity / s.parent.kernel.capacity)));
      else n += s.spawner.estimate;
    }
    return n;
  }

  get emitting(): boolean {
    return this.systems.some((s) => !s.parent && s.active && s.spawner.emitting);
  }

  dispose(): void {
    for (const s of this.systems) s.run.dispose();
  }
}

function depth(s: SystemRun): number {
  let d = 0;
  for (let p = s.parent; p && d < 16; p = p.parent) d++;
  return d;
}

/** Inverse of a column-major 4×4 matrix (identity when singular). */
export function invert(m: ArrayLike<number>): number[] {
  const a = Array.from({ length: 16 }, (_, i) => m[i] ?? IDENTITY[i]);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return [...IDENTITY];
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}
