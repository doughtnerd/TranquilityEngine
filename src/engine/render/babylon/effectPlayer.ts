// Internal (ADR 0057, 0060, 0080, 0094, 0153, 0251): the effect player, the only thing that builds a
// particle effect. One effect at one transform on the Babylon backend: its ProgramRunner, the
// `KernelEffect` that runs every system on a kernel executor (the JavaScript one for "cpu" and most
// "auto" systems, a GPU one where a system wants it), and the Babylon draw of each output, made by the
// draw factory (`particleDraw.ts`), with its fallbacks (the dot for a missing texture, the texture for
// a material asset that isn't there, a texture or model still loading holds the build). It owns how an
// effect plays: restart (seeded effects repeat exactly), the systems that start on events rather than
// On Play, custom events, emit, stop and clear, a finished one-shot effect playing again, and the
// warm-up's state (ADR 0080).
//
// Four callers drive it: `BabylonParticles` (a World's ParticleSystems, one player each, and the
// warm-up's effects), the particle graph editor's `EffectPreview` and the asset thumbnails (one player
// each). What they share per scene (the texture cache, the dot, the scene depth, the kernel host,
// warnings) is an `EffectResources`.
// Babylon types stay inside this folder (ADR 0010).
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { loadMeshes, meshesIfLoaded, type ModelMesh } from "../../scene/models";
import type { ParticleProgram } from "../../scene/particleCompile";
import { compileParticleEffect } from "../../scene/particleEffect";
import { chooseBackend, type KernelExecutor, type KernelProgram } from "../../scene/particleKernel";
import { projectAssets } from "../../scene/particleSubgraphs";
import { KernelEffect } from "../particles/gpu/kernelEffect";
import type { ParticleRaycast } from "../particles/gpu/kernelSteps";
import { ProgramRunner, playTimes } from "../particles/programRunner";
import { randomForSeed } from "../particles/random";
import { BabylonKernelHost, SceneDepth } from "./gpuParticles";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import { cloneMaterial } from "./materialClone";
import { createDotTexture, createDraw, type Draw, type DrawResources, type ParticleLayer2D } from "./particleDraw";
import { placeInLayer } from "./layeredQuads";

/** What an effect player needs from where it draws: the scene, textures, material assets, ray queries. */
export interface EffectHost {
  /** Babylon scene (left-handed, +Y up, +Z forward). */
  readonly scene: Scene;
  /** Loads a texture asset (sRGB colour) for particles, flipped as other textures (V 1 is the image's top). */
  texture(path: string): Promise<BaseTexture>;
  /**
   * A material asset (an output's `material`) as a Babylon material, or null (missing, not a material,
   * or still loading). Null draws with the output's texture and blending; the effect is rebuilt when the
   * material appears or changes. Optional: without it material assets are never used.
   */
  material?(path: string): Material | null;
  /**
   * An unshared copy of a material asset (each output draws with its own, ADR 0126), disposed by the
   * caller; a shader graph's copy is a new graph material, not a clone. Optional: without it the shared
   * material is cloned.
   */
  materialCopy?(path: string, name: string): { material: Material; dispose(): void } | null;
  /** Force the kernel executors (tests, benchmarks); default: what the engine supports (ADR 0094). */
  readonly kernelExecutors?: readonly KernelExecutor[];
  /** A world-space ray cast for Collide with colliders (the JavaScript executor). Optional: without it that block does nothing. */
  raycast?: ParticleRaycast;
}

/** How an effect's systems run (ADR 0094, 0251): each system's kernel and the executor it runs on. */
export interface KernelPlan {
  kernels: KernelProgram;
  executors: KernelExecutor[];
}

/** An effect parsed, expanded and compiled (ADR 0315), and the sub-graph and custom block assets it expanded from (ADR 0095). */
export interface CompiledEffect {
  program: ParticleProgram;
  deps: string[];
}

type Rgba = readonly [number, number, number, number];

const WHITE: Rgba = [1, 1, 1, 1];
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * What every effect player in one scene shares: the texture cache, the dot texture, the scene depth and
 * the kernel host, the plans, and warnings (each said once). It is what the draw factory draws with.
 */
export class EffectResources implements DrawResources {
  private readonly warned = new Set<string>();
  private readonly textures = new Map<string, { tex: BaseTexture | null; failed: boolean }>();
  private readonly plans = new WeakMap<ParticleProgram, KernelPlan>();
  /** Model meshes' ids in build keys. */
  private readonly meshIds = new WeakMap<ModelMesh, number>();
  private nextMeshId = 1;
  private dot: RawTexture | null = null;
  private depth: SceneDepth | null = null;
  private kernels: BabylonKernelHost | null = null;

  constructor(
    readonly host: EffectHost,
    /** Where warnings go (default: the console, prefixed). */
    private readonly warn: (message: string) => void = (message) => console.warn(`[myco] ${message}`),
  ) {}

  get scene(): Scene {
    return this.host.scene;
  }

  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  // --- compiling ------------------------------------------------------------------------------------

  /**
   * The particle-effect compile (ADR 0315: parse, expand with the project's assets, compile) plus this
   * scene's kernel plan, warning once about its problems; null when it can't be planned.
   */
  compile(raw: unknown, where: string): CompiledEffect | null {
    const effect = compileParticleEffect({ raw, where }, projectAssets);
    for (const p of effect.problems) {
      const text = `${where}: ${p.message}${p.at ? ` (${p.at})` : ""}`;
      this.warnOnce(`${where}|${text}`, text);
    }
    try {
      this.plans.set(effect.program, this.makePlan(effect.program, where));
    } catch (err) {
      this.warnOnce(`${where}|${(err as Error).message}`, (err as Error).message);
      return null;
    }
    return { program: effect.program, deps: effect.dependencies };
  }

  /** The executor each system of `program` runs on (planned the first time it's asked). */
  plan(program: ParticleProgram): KernelPlan {
    let plan = this.plans.get(program);
    if (!plan) {
      plan = this.makePlan(program, "a particle effect");
      this.plans.set(program, plan);
    }
    return plan;
  }

  /** Each system's executor (ADR 0094, 0251): its choice, then an event child runs on its parent's (events pass between runs of one executor). */
  private makePlan(program: ParticleProgram, where: string): KernelPlan {
    const kernels = program.kernels;
    const available = this.kernelHost().executors;
    const executors = kernels.systems.map((k, i) => chooseBackend(program.simulation[i], k, available));
    for (const [i, k] of kernels.systems.entries()) {
      if (!k.event) continue;
      const p = executors[k.event.parent];
      if (executors[i] !== p && program.simulation[i] && program.simulation[i] !== "auto") {
        this.warnOnce(`${where}|event|${k.id}`, `${where}: "${k.name}" is started by an event from "${kernels.systems[k.event.parent].name}", so it runs on the same executor (${p}).`);
      }
      executors[i] = p;
    }
    for (const [i, k] of kernels.systems.entries()) {
      if (executors[i] === "js" || !k.jsOnly.length) continue;
      this.warnOnce(`${where}|jsOnly|${k.id}`, `${where}: "${k.name}" runs on the GPU, which skips ${k.jsOnly.join(", ")} (it ray casts the World's colliders, which only the JavaScript executor can; use Collide with depth buffer).`);
    }
    return { kernels, executors };
  }

  // --- what effects draw with -----------------------------------------------------------------------

  sceneDepth(): SceneDepth {
    return (this.depth ??= new SceneDepth(this.host.scene));
  }

  kernelHost(): BabylonKernelHost {
    return (this.kernels ??= new BabylonKernelHost(this.host.scene, this.sceneDepth(), this.host.kernelExecutors, this.host.raycast));
  }

  /** The soft round dot particles use when they have no texture. */
  dotTexture(): RawTexture {
    return (this.dot ??= createDotTexture(this.host.scene));
  }

  /** A particle texture: null while it loads (the load starts), "failed" if it didn't. Re-asks the host, so a reimported texture is picked up. */
  textureFor(path: string): BaseTexture | null | "failed" {
    let entry = this.textures.get(path);
    if (!entry) {
      const made: { tex: BaseTexture | null; failed: boolean } = { tex: null, failed: false };
      entry = made;
      this.textures.set(path, made);
      this.host.texture(path).then(
        (t) => (made.tex = t),
        (err: Error) => {
          made.failed = true;
          this.warnOnce(`texture|${path}`, `failed to load particle texture "${path}": ${err.message}`);
        },
      );
    } else if (entry.tex) {
      const made = entry;
      this.host.texture(path).then(
        (t) => (made.tex = t),
        () => {},
      );
    }
    return entry.failed ? "failed" : entry.tex;
  }

  /** An output's material asset, or null (none, or not available yet). */
  materialFor(path: string | undefined): Material | null {
    return path ? (this.host.material?.(path) ?? null) : null;
  }

  /** An unshared copy of a material asset (the host's, else a clone of the shared one), or null. */
  copyMaterial(path: string, name: string): { material: Material; dispose(): void } | null {
    const fromHost = this.host.materialCopy?.(path, name);
    if (fromHost !== undefined) return fromHost;
    const shared = this.materialFor(path);
    return shared ? cloneMaterial(shared, name) : null; // freed with the texture copies the clone made
  }

  /** Mesh mode: the model mesh drawn (null while it loads, undefined when there's none to be had). */
  meshFor(ref: string): ModelMesh | null | undefined {
    const meshes = meshesIfLoaded(ref);
    return meshes === null ? null : meshes[0];
  }

  /** What a build of `program` depends on (each output's material, mesh and texture), or null while one still loads. */
  buildKey(program: ParticleProgram): string | null {
    const parts: string[] = [];
    for (const k of program.kernels.systems) {
      for (const o of k.outputs) {
        if (o.type === "mesh") {
          const mesh = this.meshFor(o.settings.mesh);
          if (mesh === null) return null; // a model still loading
          let id = mesh ? this.meshIds.get(mesh) : 0;
          if (mesh && !id) this.meshIds.set(mesh, (id = this.nextMeshId++));
          parts.push(`mesh:${id}`);
        }
        const material = this.materialFor(o.settings.material);
        if (material) parts.push(`mat:${material.uniqueId}`);
        if (!o.settings.texture) {
          parts.push("dot");
          continue;
        }
        const t = this.textureFor(o.settings.texture);
        if (t === null) return null;
        parts.push(t === "failed" ? `${o.settings.texture}:failed` : `${o.settings.texture}:${t.uniqueId}`);
      }
    }
    return `k|${parts.join("|")}`;
  }

  /**
   * Start loading everything `program` draws with (textures, models), and resolve once they have loaded
   * or failed: the thumbnails build an effect once, with everything there.
   */
  async preload(program: ParticleProgram): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const k of program.kernels.systems) {
      for (const o of k.outputs) {
        if (o.settings.texture) {
          this.textureFor(o.settings.texture);
          waits.push(this.host.texture(o.settings.texture).catch(() => undefined));
        }
        if (o.type === "mesh" && o.settings.mesh) waits.push(loadMeshes(o.settings.mesh).catch(() => undefined));
      }
    }
    await Promise.all(waits);
  }

  dispose(): void {
    this.dot?.dispose();
    this.dot = null;
    this.depth?.dispose();
    this.depth = null;
  }
}

/** How an effect plays: emitting, paused, or stopped (finished emitting, or told to stop). */
export type PlayState = "playing" | "paused" | "stopped";

export interface EffectPlayerOptions {
  /** Draw names start with this (`<name>:<emitter>`, `<name>:<kernel system>:<output>`). */
  name: string;
  /** The random seed (0: unseeded); a seeded effect repeats exactly on every restart. Default 0. */
  seed?: number;
  /** How it starts once built: playing (default) or stopped (a ParticleSystem without Play On Awake). */
  state?: PlayState;
  /** The warm-up's camera (a sorted output builds its sort passes for it). Default: the scene's active camera. */
  camera?: () => Camera | null;
}

/**
 * One effect at one transform (ADR 0153): the runner, the kernel systems, their draws, and how the
 * effect plays. The caller builds it (`build`, again when what it draws with changes), sets its scale
 * and tint, and steps it at the node's world matrix.
 */
export class EffectPlayer {
  readonly runner: ProgramRunner;
  /** The seed the next restart uses. */
  seed: number;
  /** Emission scale (the quality tier times the component's scale). */
  scale = 1;
  /** The tint, linear RGBA. */
  tint: Rgba = WHITE;
  state: PlayState;
  /** Seconds played since the last restart. */
  time = 0;
  /** Has played at all (so `destroyOnFinish` waits for it to start). */
  started = false;
  private _kfx: KernelEffect | null = null;
  /** Every kernel output's draw. */
  private _draws: Draw[] = [];
  /** A 2D system's layer and lighting (ADR 0415), or null for 3D particles. */
  private layer2D: ParticleLayer2D | null = null;

  /**
   * Draw as 2D content (ADR 0415): at `layer`'s order, lit by its lighting; null: 3D. A new order moves the draws; new
   * lighting (or 2D to 3D) makes them again, keeping the simulation (the particles don't restart).
   */
  setLayer2D(layer: ParticleLayer2D | null): void {
    const was = this.layer2D;
    this.layer2D = layer;
    if (!this._kfx) return;
    if ((was === null) !== (layer === null) || was?.lit !== layer?.lit) {
      for (const d of this._draws) d.dispose();
      this._draws = [];
      this.makeDraws(this._kfx);
    } else if (layer && was?.order !== layer.order) for (const d of this._draws) for (const m of d.meshes) placeInLayer(m, layer.order);
  }

  /** What the current build depended on (`EffectResources.buildKey`); "" when unbuilt. */
  private key = "";
  /** The effect's random, swapped on restart; the spawners and runner call it through `rnd`. */
  private random: () => number;
  private readonly rnd = (): number => this.random();
  private overrides: unknown = undefined;
  /** Seconds a finished effect has been idle (`repeatWhenFinished`). */
  private idle = 0;

  constructor(
    readonly resources: EffectResources,
    readonly program: ParticleProgram,
    private readonly options: EffectPlayerOptions,
  ) {
    this.seed = options.seed ?? 0;
    this.random = randomForSeed(this.seed);
    this.state = options.state ?? "playing";
    this.runner = new ProgramRunner(program, this.rnd);
  }

  /** What it draws with: each kernel output's draw (one batch each). */
  get draws(): readonly Draw[] {
    return this._draws;
  }

  /** Whether every draw is ready to draw (shaders compiled, textures loaded). */
  get ready(): boolean {
    for (const d of this._draws) if (!d.isReady()) return false;
    return true;
  }

  /** Whether `drawn` (a Babylon mesh) is one of its draws'. */
  owns(drawn: object): boolean {
    for (const d of this._draws) if ((d.meshes as readonly object[]).includes(drawn)) return true;
    return false;
  }

  get built(): boolean {
    return this._kfx !== null;
  }

  /** Particles alive (exact on the JavaScript executor, else as the executor knows). */
  get count(): number {
    return this._kfx?.count ?? 0;
  }

  /** Systems. */
  get emitters(): number {
    return this._kfx?.systems.length ?? 0;
  }

  /** Still emitting (playing, with a system that hasn't finished). */
  get emitting(): boolean {
    return this.state === "playing" && !!this._kfx?.emitting;
  }

  /** Emitting, or with particles alive. */
  get alive(): boolean {
    return this.emitting || this.count > 0;
  }

  /**
   * The world positions of the particles alive (x, y, z each), where the executor keeps them on the CPU
   * (the JavaScript executor; a GPU executor's particles aren't read back): what the thumbnails frame.
   */
  points(): number[] {
    return this._kfx?.points() ?? [];
  }

  /** The overrides object scripts set (`ParticleSystem.setProperty`); compared by identity. */
  setOverrides(overrides: unknown): void {
    if (overrides === this.overrides) return;
    this.overrides = overrides;
    this.runner.setOverrides((overrides ?? {}) as Parameters<ProgramRunner["setOverrides"]>[0]);
  }

  /** True when a binding that isn't live changed value since the build (it needs a rebuild). */
  bindingsStale(): boolean {
    return this.built && this.runner.update(this.time, 0, playTimes(this.program, this.time), true);
  }

  /**
   * Build the kernel systems and draws, or rebuild them when `key` (what they draw with) changed or
   * `force` is set; keeps whether the effect plays. A null key (a texture or model still loading) leaves
   * it unbuilt, to try again. Returns whether it's built.
   */
  build(key: string | null = this.resources.buildKey(this.program), force = false): boolean {
    if (key !== null && key === this.key && !force) return this.built;
    this.disposeDraws();
    if (key === null) {
      this.key = "";
      return false;
    }
    this.make(key);
    const was = this.state;
    if (was === "stopped") this.stop();
    else {
      this.restart();
      if (was === "paused") this.pause();
    }
    return true;
  }

  /**
   * The warm-up's state (ADR 0080): built as `build` builds it, with the kernel systems stepped once with
   * nothing spawned, so drawing it once makes every pipeline the effect's draws use (each output's draw,
   * and a kernel's simulation pass, with its spawn, trail history and sort passes). Stopped: it doesn't
   * play. False while a texture or model it draws with is loading (ask again later).
   */
  warm(): boolean {
    this.disposeDraws();
    this.key = "";
    const key = this.resources.buildKey(this.program);
    if (key === null) return false;
    this.make(key);
    this.stop();
    this._kfx?.step(1 / 60, IDENTITY, 1, WHITE, this.runner.context, undefined);
    // Drawn for the warm-up's camera: a sorted kernel output builds its sort passes for it.
    const scene = this.resources.scene;
    const cam = this.options.camera?.() ?? null;
    const prev = scene.activeCamera;
    if (cam) scene.activeCamera = cam;
    for (const d of this._draws) d.update();
    if (cam) scene.activeCamera = prev;
    return true;
  }

  /** Make the kernel effect and every draw for build `key`. */
  private make(key: string): void {
    this.key = key;
    const res = this.resources;
    const plan = res.plan(this.program);
    const kfx = new KernelEffect(plan.kernels.systems, this.runner.spawns(), res.kernelHost(), {
      executor: (k) => plan.executors[k.emitter],
      live: this.runner.live,
      random: this.rnd,
      seeds: this.program.seeds,
      seed: this.seed,
    });
    this._kfx = kfx;
    this.makeDraws(kfx);
  }

  /** Every kernel output's draw, for this player's 2D layer (or 3D). */
  private makeDraws(kfx: KernelEffect): void {
    const { name } = this.options;
    for (const s of kfx.systems) for (let k = 0; k < s.kernel.outputs.length; k++) this._draws.push(createDraw(this.resources, `${name}:${s.kernel.id}:${k}`, { system: s, output: k }, this.layer2D));
  }

  // --- playing --------------------------------------------------------------------------------------

  /** Play: from the start when stopped, else carry on (from a pause). */
  play(): void {
    if (this.state === "stopped") this.restart();
    else this.state = "playing";
  }

  pause(): void {
    if (this.state === "playing") this.state = "paused";
  }

  /** Play from the start: a seeded effect repeats exactly; systems started by events (not On Play) wait for them. */
  restart(): void {
    this.random = randomForSeed(this.seed);
    const kfx = this._kfx;
    kfx?.restart();
    for (const s of kfx?.systems ?? []) if (!s.parent && !(this.program.autoStart[s.kernel.emitter] ?? true)) kfx!.endEmit(s.kernel.emitter);
    this.route({ start: [], stop: this.program.onPlay.stop });
    this.time = 0;
    this.idle = 0;
    this.state = "playing";
  }

  /** Remove every particle alive, leaving emission as it is. */
  clear(): void {
    this._kfx?.clear();
  }

  /** Stop emitting (particles alive finish their lives, or with `clear` go at once), and run the On Stop event's wiring. */
  stop(clear = false, onStop = false): void {
    this._kfx?.endEmit();
    if (clear) this.clear();
    this.state = "stopped";
    if (onStop) this.route(this.program.onStop);
  }

  /** A custom event (`ParticleSystem.sendEvent`): start and stop the systems wired to it. */
  event(name: string): void {
    this.route(this.program.custom.get(name));
  }

  /** Spawn `count` particles on the next step, spread over the systems that spawn on their own. */
  emit(count: number): void {
    if (count > 0) this._kfx?.emit(count);
  }

  /** Advance `dt` seconds at `world` (unless paused), then refresh what draws. */
  step(dt: number, world: ArrayLike<number> = IDENTITY): void {
    const kfx = this._kfx;
    if (!kfx) return;
    if (this.state !== "paused" && dt > 0) {
      this.time += dt;
      this.runner.update(this.time, dt, playTimes(this.program, this.time));
      kfx.step(dt, world, this.scale, this.tint, this.runner.context, this.overrides, playTimes(this.program, this.time));
    }
    for (const d of this._draws) d.update();
    if (this.state === "playing" && !this.emitting) this.state = "stopped"; // a one-shot effect finished emitting
    if (this.state === "playing") this.started = true;
  }

  /** Previews: once a finished effect has had nothing alive for `gap` seconds, play it again (while `looping`). */
  repeatWhenFinished(dt: number, gap: number, looping = true): void {
    if (looping && this.built && !this.alive) {
      this.idle += dt;
      if (this.idle >= gap) this.restart();
    } else this.idle = 0;
  }

  /** Start and stop the systems an event is wired to. */
  private route(route: { start: number[]; stop: number[] } | undefined): void {
    const kfx = this._kfx;
    if (!route || !kfx) return;
    for (const s of kfx.systems) {
      const i = s.kernel.emitter;
      if (route.start.includes(i)) {
        kfx.startEmitter(i);
        this.state = "playing";
      } else if (route.stop.includes(i)) kfx.endEmit(i);
    }
  }

  private disposeDraws(): void {
    for (const d of this._draws) d.dispose();
    this._draws = [];
    this._kfx?.dispose();
    this._kfx = null;
  }

  dispose(): void {
    this.disposeDraws();
    this.key = "";
  }
}

/** An effect host over a material library (the editor's previews and thumbnails, ADR 0127): its textures and material assets. */
export function libraryEffectHost(scene: Scene, library: BabylonMaterialLibrary): EffectHost {
  return {
    scene,
    texture: (path) => library.loadTexture(path),
    material: (path) => library.material(path),
    materialCopy: (path, name) => library.copy(path, name),
  };
}
