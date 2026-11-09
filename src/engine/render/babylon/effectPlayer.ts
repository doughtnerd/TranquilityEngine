// Internal (ADR 0057, 0060, 0094, 0153): the effect player. One particle effect at one transform on the
// Babylon backend: its ProgramRunner, our own CPU `EffectSimulation` for the systems the CPU runs, the
// `KernelEffect` for the ones a kernel executor runs, and the Babylon draws of both (`particleDraw.ts`,
// `gpuParticles.ts`, `kernelMaterial.ts`) with their fallbacks (the dot for a missing texture, the
// texture for a material asset that isn't there, a model still loading holds the build). It owns how an
// effect plays: restart (seeded effects repeat exactly), the systems that start on events rather than On
// Play, custom events, emit, stop and clear, and a finished one-shot effect playing again.
//
// Two callers drive it: `BabylonParticles` (a World's ParticleSystems, one player each; asset thumbnails
// draw through it too, ADR 0156) and the particle graph editor's `EffectPreview` (one player). What they
// share per scene (the texture cache, the dot, the scene depth, the kernel host, warnings) is an
// `EffectResources`.
// Babylon types stay inside this folder (ADR 0010).
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { meshesIfLoaded, type ModelMesh } from "../../scene/models";
import { compileParticleGraph, type ParticleProgram } from "../../scene/particleCompile";
import type { ParticleGraph } from "../../scene/particleGraph";
import { parseParticleGraph } from "../../scene/particleGraphFormat";
import { chooseBackend, compileParticleKernels, type KernelExecutor, type KernelOutput, type KernelProgram, type KernelSystem, type SystemBackend } from "../../scene/particleKernel";
import { expandParticleGraph, expansionDependencies, projectAssets } from "../../scene/particleSubgraphs";
import { KernelEffect } from "../particles/gpu/kernelEffect";
import { ProgramRunner, playTimes } from "../particles/programRunner";
import { randomForSeed } from "../particles/random";
import { EffectSimulation, type ParticleRaycast, type SimEmitter } from "../particles/simulation";
import { BabylonKernelHost, KernelDraw, SceneDepth, sortRunOnce, type BabylonRun } from "./gpuParticles";
import { heightFogOn } from "./heightFog";
import { KernelMaterialDraw, drawsKernelParticles } from "./kernelMaterial";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import { createDotTexture, makeDraw, usesSheet, type Draw } from "./particleDraw";

/** What an effect player needs from where it draws: the scene, textures, material assets, ray queries. */
export interface EffectHost {
  /** Babylon scene (right-handed, +Y up). */
  readonly scene: Scene;
  /**
   * Loads a texture asset (sRGB colour) for particles: flipped as other textures (V 1 is the image's
   * top), or with `sheet` unflipped (V 0 at the top), as Babylon's particle sprite sheets read it.
   */
  texture(path: string, sheet?: boolean): Promise<BaseTexture>;
  /**
   * A material asset (an emitter's `renderer.material`) as a Babylon material, or null (missing, not a
   * material, or still loading). Null draws with the emitter's texture and blending; the effect is
   * rebuilt when the material appears or changes. Optional: without it material assets are never used.
   */
  material?(path: string): Material | null;
  /**
   * An unshared copy of a material asset (soft CPU particles, kernel outputs, ADR 0126), disposed by the
   * caller; a shader graph's copy is a new graph material, not a clone. Optional: without it the shared
   * material is cloned.
   */
  materialCopy?(path: string, name: string): { material: Material; dispose(): void } | null;
  /** Force the kernel executors (tests, benchmarks); default: what the engine supports (ADR 0094). */
  readonly kernelExecutors?: readonly KernelExecutor[];
  /** A world-space ray cast for the `collisionColliders` behaviour. Optional: without it that behaviour does nothing. */
  raycast?: ParticleRaycast;
}

/** How an effect's systems run (ADR 0094): per emitter, the CPU or a kernel executor. */
export interface KernelPlan {
  kernels: KernelProgram;
  backends: SystemBackend[];
  /** The kernel systems that run (backend isn't "cpu"). */
  running: KernelSystem[];
}

/** An effect parsed, expanded and compiled, and the sub-graph and custom block assets it expanded from (ADR 0095). */
export interface CompiledEffect {
  program: ParticleProgram;
  deps: string[];
}

/** A kernel system's run in a `KernelEffect`. */
type SystemRun = KernelEffect["systems"][number];
type Rgba = readonly [number, number, number, number];

const WHITE: Rgba = [1, 1, 1, 1];
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * What every effect player in one scene shares: the texture cache, the dot texture, the scene depth and
 * the kernel host, kernel plans, and warnings (each said once).
 */
export class EffectResources {
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

  /** Parse, expand (ADR 0095) and compile an effect's JSON, warning once about its problems; null when it can't be. */
  compile(raw: unknown, where: string): CompiledEffect | null {
    try {
      const parsed = parseParticleGraph(raw, where);
      const expanded = expandParticleGraph(parsed.graph, projectAssets);
      const graph = expanded.graph;
      const problems = [...parsed.problems, ...expanded.problems];
      const deps = expansionDependencies(parsed.graph, projectAssets);
      const program = compileParticleGraph(graph);
      const plan = this.makePlan(graph, program, where);
      const onKernel = (at: string | undefined) => !!at && plan.running.some((k) => at === k.id || at.startsWith(`${k.id}.`));
      const kernelProblems = plan.kernels.problems.filter((p) => onKernel(p.at));
      for (const p of [...problems, ...program.problems.filter((q) => !(q.cpuOnly && onKernel(q.at))), ...kernelProblems]) {
        const text = `${where}: ${p.message}${p.at ? ` (${p.at})` : ""}`;
        this.warnOnce(`${where}|${text}`, text);
      }
      this.plans.set(program, plan);
      return { program, deps };
    } catch (err) {
      this.warnOnce(`${where}|${(err as Error).message}`, (err as Error).message);
      return null;
    }
  }

  /** Which systems of `program` run on a kernel (made from its source graph the first time it's asked). */
  plan(program: ParticleProgram): KernelPlan | null {
    let plan = this.plans.get(program);
    if (!plan && program.source) {
      plan = this.makePlan(program.source, program, "a particle effect");
      this.plans.set(program, plan);
    }
    return plan ?? null;
  }

  /** Which systems run on a kernel (ADR 0094): each system's choice, then events keep a parent and its child on the same side. */
  private makePlan(graph: ParticleGraph, program: ParticleProgram, where: string): KernelPlan {
    const kernels = compileParticleKernels(graph, program);
    const executors = this.kernelHost().executors;
    const systems = graph.systems.filter((s) => s.enabled !== false);
    const backends = kernels.systems.map((k, i) => chooseBackend(systems[i]?.settings.simulation, k, executors));
    for (const [i, k] of kernels.systems.entries()) {
      if (!k.event) continue;
      const p = k.event.parent;
      if (backends[p] === "cpu" && backends[i] !== "cpu") {
        this.warnOnce(`${where}|event|${k.id}`, `${where}: "${k.name}" is started by an event from a system on the CPU, so it runs on the CPU too.`);
        backends[i] = "cpu";
      } else if (backends[p] !== "cpu" && backends[i] === "cpu") backends[i] = backends[p];
    }
    return { kernels, backends, running: kernels.systems.filter((_, i) => backends[i] !== "cpu") };
  }

  // --- what effects draw with -----------------------------------------------------------------------

  sceneDepth(): SceneDepth {
    return (this.depth ??= new SceneDepth(this.host.scene));
  }

  kernelHost(): BabylonKernelHost {
    return (this.kernels ??= new BabylonKernelHost(this.host.scene, this.sceneDepth(), this.host.kernelExecutors));
  }

  /** The soft round dot particles use when they have no texture. */
  dotTexture(): RawTexture {
    return (this.dot ??= createDotTexture(this.host.scene));
  }

  /** A particle texture: null while it loads (the load starts), "failed" if it didn't. Re-asks the host, so a reimported texture is picked up. */
  textureFor(path: string, sheet: boolean): BaseTexture | null | "failed" {
    const key = sheet ? `${path}#sheet` : path;
    let entry = this.textures.get(key);
    if (!entry) {
      const made: { tex: BaseTexture | null; failed: boolean } = { tex: null, failed: false };
      entry = made;
      this.textures.set(key, made);
      this.host.texture(path, sheet).then(
        (t) => (made.tex = t),
        (err: Error) => {
          made.failed = true;
          this.warnOnce(`texture|${path}`, `failed to load particle texture "${path}": ${err.message}`);
        },
      );
    } else if (entry.tex) {
      const made = entry;
      this.host.texture(path, sheet).then(
        (t) => (made.tex = t),
        () => {},
      );
    }
    return entry.failed ? "failed" : entry.tex;
  }

  /** An emitter's material asset, or null (none, or not available yet). */
  materialFor(path: string | undefined): Material | null {
    return path ? (this.host.material?.(path) ?? null) : null;
  }

  /** An unshared copy of a material asset (the host's, else a clone of the shared one), or null. */
  copyMaterial(path: string, name: string): { material: Material; dispose(): void } | null {
    const fromHost = this.host.materialCopy?.(path, name);
    if (fromHost !== undefined) return fromHost;
    const shared = this.materialFor(path);
    const copy = shared?.clone(name) ?? null;
    return copy ? { material: copy, dispose: () => copy.dispose(false, false) } : null;
  }

  /** Mesh mode: the model mesh drawn (null while it loads, undefined when there's none to be had). */
  meshFor(ref: string): ModelMesh | null | undefined {
    const meshes = meshesIfLoaded(ref);
    return meshes === null ? null : meshes[0];
  }

  /** What a build of `program` depends on (each emitter's material, mesh and texture), or null while one still loads. */
  buildKey(program: ParticleProgram): string | null {
    // Height fog moves billboards to mesh quads (ADR 0126): rebuild when it's turned on or off.
    const fog = heightFogOn(this.host.scene);
    const parts: string[] = [fog ? "fog" : ""];
    for (const e of program.effect.emitters) {
      if (!e.enabled) continue;
      if (e.renderer.mode === "mesh") {
        const mesh = this.meshFor(e.renderer.mesh);
        if (mesh === null) return null; // a model still loading
        let id = mesh ? this.meshIds.get(mesh) : 0;
        if (mesh && !id) this.meshIds.set(mesh, (id = this.nextMeshId++));
        parts.push(`mesh:${id}`);
      }
      const material = this.materialFor(e.renderer.material);
      if (material) {
        parts.push(`mat:${material.uniqueId}`); // drawn with the material: the texture isn't needed
        continue;
      }
      if (!e.renderer.texture) {
        parts.push("dot");
        continue;
      }
      const t = this.textureFor(e.renderer.texture, usesSheet(e.renderer, fog));
      if (t === null) return null;
      parts.push(t === "failed" ? `${e.renderer.texture}:failed` : `${e.renderer.texture}:${t.uniqueId}`);
    }
    return `k|${parts.join("|")}`;
  }

  /** A CPU emitter's draw (`particleDraw.ts`): with its material asset, else its texture, else the dot. */
  makeDraw(name: string, e: SimEmitter, capacity: number, camera?: () => Camera | null): Draw {
    const r = e.renderer;
    const material = this.materialFor(r.material);
    const heightFog = heightFogOn(this.host.scene);
    const found = r.texture && !material ? this.textureFor(r.texture, usesSheet(r, heightFog)) : null;
    const texture = found && found !== "failed" ? found : this.dotTexture();
    const mesh = r.mode === "mesh" ? this.meshFor(r.mesh) : undefined;
    const depth = (r.softness ?? 0) > 0 ? this.sceneDepth() : null;
    return makeDraw(this.host.scene, name, e, capacity, texture, texture === this.dot, { material, mesh, camera, depth, heightFog, copyMaterial: (n) => this.copyMaterial(r.material, n) });
  }

  /** A kernel output's draw (ADR 0094, 0126): with its material asset where it can be, else its texture. */
  kernelDraw(name: string, s: SystemRun, k: number, o: KernelOutput): KernelDraw | KernelMaterialDraw {
    const found = o.settings.texture ? this.textureFor(o.settings.texture, false) : null;
    const texture = found && found !== "failed" ? found : this.dotTexture();
    const mesh = o.type === "mesh" ? (this.meshFor(o.settings.mesh) ?? undefined) : undefined;
    const softness = o.settings.softness ?? 0;
    const made = o.settings.material && o.type !== "trail" ? this.kernelMaterialDraw(name, s.kernel, k, s.run as BabylonRun, o.settings.material, { mesh, softness }) : null;
    if (o.settings.material && !made) this.warnOnce(`kmat|${name}|${o.settings.material}`, `${name}: the kernel output "${s.kernel.name}" draws with its texture: ${o.type === "trail" ? "trails don't take material assets yet" : `"${o.settings.material}" isn't a PBR material (or hasn't loaded)`}.`);
    return made ?? new KernelDraw(this.host.scene, name, s.kernel, k, s.run, texture, this.sceneDepth(), { mesh, softness });
  }

  /** A kernel output drawn with a material asset (ADR 0126), or null when the material can't (not PBR, not loaded). */
  private kernelMaterialDraw(name: string, kernel: KernelSystem, k: number, run: BabylonRun, path: string, opts: { mesh?: ModelMesh; softness: number }): KernelMaterialDraw | null {
    if (!drawsKernelParticles(this.materialFor(path))) return null;
    const copy = this.copyMaterial(path, `${name}:material`);
    if (!copy || !drawsKernelParticles(copy.material)) {
      copy?.dispose();
      return null;
    }
    const source = { textures: (sorted: boolean) => run.textures(sorted), sortFor: () => sortRunOnce(this.host.scene, run) };
    return new KernelMaterialDraw(this.host.scene, name, kernel, k, source, { material: copy.material, dispose: copy.dispose }, { ...opts, depth: opts.softness > 0 ? this.sceneDepth() : null, interleaved: run.kind === "webgpu" });
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
  /** Draw names start with this (`particles:<name>:<emitter>`). */
  name: string;
  /** The random seed (0: unseeded); a seeded effect repeats exactly on every restart. Default 0. */
  seed?: number;
  /** How it starts once built: playing (default) or stopped (a ParticleSystem without Play On Awake). */
  state?: PlayState;
}

/**
 * One effect at one transform (ADR 0153): the runner, the CPU simulation and kernel systems, their draws,
 * and how the effect plays. The caller builds it (`build`, again when what it draws with changes),
 * configures its transform, scale and tint, and steps it.
 */
export class EffectPlayer {
  readonly runner: ProgramRunner;
  /** The seed the next restart uses. */
  seed: number;
  /** Emission and particle limit scale (the quality tier times the component's scale). */
  scale = 1;
  /** The tint, linear RGBA. */
  tint: Rgba = WHITE;
  state: PlayState;
  /** Seconds played since the last restart. */
  time = 0;
  /** Has played at all (so `destroyOnFinish` waits for it to start). */
  started = false;
  private _sim: EffectSimulation | null = null;
  private _draws: Draw[] = [];
  private _kfx: KernelEffect | null = null;
  private _kdraws: (KernelDraw | KernelMaterialDraw)[] = [];
  /** What the current build depended on (`EffectResources.buildKey`); "" when unbuilt. */
  private key = "";
  /** The effect's random, swapped on restart; the simulation and runner call it through `rnd`. */
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

  get sim(): EffectSimulation | null {
    return this._sim;
  }

  get draws(): readonly Draw[] {
    return this._draws;
  }

  get kfx(): KernelEffect | null {
    return this._kfx;
  }

  get kdraws(): readonly (KernelDraw | KernelMaterialDraw)[] {
    return this._kdraws;
  }

  get built(): boolean {
    return this._sim !== null;
  }

  /** Particles alive (CPU and kernel). */
  get count(): number {
    return (this._sim?.count ?? 0) + (this._kfx?.count ?? 0);
  }

  /** Emitters (CPU) and kernel systems. */
  get emitters(): number {
    return (this._sim?.emitters.length ?? 0) + (this._kfx?.systems.length ?? 0);
  }

  /** Still emitting (playing, with a system that hasn't finished). */
  get emitting(): boolean {
    return this.state === "playing" && (!!this._sim?.emitting || !!this._kfx?.emitting);
  }

  /** Emitting, or with particles alive. */
  get alive(): boolean {
    return this.emitting || this.count > 0;
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
   * Build the simulation and draws, or rebuild them when `key` (what they draw with) changed or `force`
   * is set; keeps whether the effect plays. A null key (a texture or model still loading) leaves it
   * unbuilt, to try again. Returns whether it's built.
   */
  build(key: string | null = this.resources.buildKey(this.program), force = false): boolean {
    if (key !== null && key === this.key && !force) return this.built;
    this.disposeDraws();
    if (key === null) {
      this.key = "";
      return false;
    }
    this.key = key;
    const res = this.resources;
    const effect = this.runner.effect();
    const plan = res.plan(this.program);
    // Systems a kernel runs are left out of the CPU simulation (disabled, so emitter indices stay).
    const cpuEffect = plan?.running.length ? { ...effect, emitters: effect.emitters.map((e, i) => (plan.backends[i] === "cpu" ? e : { ...e, enabled: false })) } : effect;
    const sim = new EffectSimulation(cpuEffect, { live: this.runner.live, random: this.rnd, raycast: res.host.raycast });
    this._sim = sim;
    const name = this.options.name;
    this._draws = sim.emitters.map((e) => res.makeDraw(`particles:${name}:${e.name}`, e, Math.max(1, Math.ceil(e.settings.maxParticles * Math.max(1, this.scale)))));
    if (plan?.running.length) {
      const kfx = new KernelEffect(plan.running, effect.emitters, res.kernelHost(), { live: this.runner.live, random: this.rnd, seeds: this.program.seeds, seed: this.seed });
      this._kfx = kfx;
      for (const s of kfx.systems) s.kernel.outputs.forEach((o, k) => this._kdraws.push(res.kernelDraw(`particles:${name}:${s.kernel.id}:${k}`, s, k, o)));
    }
    const was = this.state;
    if (was === "stopped") this.stop();
    else {
      this.restart();
      if (was === "paused") this.pause();
    }
    return true;
  }

  /** Set where the effect is (the node's world matrix, 16 floats column-major), its scale and tint, before commands that spawn. */
  configure(world: ArrayLike<number> = IDENTITY): void {
    this._sim?.configure(world, this.scale, this.tint);
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
    const sim = this._sim;
    sim?.restart();
    this._kfx?.restart();
    for (const e of sim?.emitters ?? []) if (!this.autoStarts(e)) sim!.endEmit(e);
    for (const s of this._kfx?.systems ?? []) if (!s.parent && !(this.program.autoStart[s.kernel.emitter] ?? true)) this._kfx!.endEmit(s.kernel.emitter);
    this.route({ start: [], stop: this.program.onPlay.stop });
    this.time = 0;
    this.idle = 0;
    this.state = "playing";
  }

  /** Remove every particle alive, leaving emission as it is. */
  clear(): void {
    this._sim?.clear();
    this._kfx?.clear();
  }

  /** Stop emitting (particles alive finish their lives, or with `clear` go at once), and run the On Stop event's wiring. */
  stop(clear = false, onStop = false): void {
    this._sim?.endEmit();
    this._kfx?.endEmit();
    if (clear) this.clear();
    this.state = "stopped";
    if (onStop) this.route(this.program.onStop);
  }

  /** A custom event (`ParticleSystem.sendEvent`): start and stop the systems wired to it. */
  event(name: string): void {
    this.route(this.program.custom.get(name));
  }

  /** Spawn `count` particles now (the CPU systems, else the kernel ones). */
  emit(count: number): void {
    if (count <= 0) return;
    if (this._sim?.emitters.length) this._sim.emit(count);
    else this._kfx?.emit(count);
  }

  /** Advance `dt` seconds at `world` (unless paused), then refresh what draws. */
  step(dt: number, world: ArrayLike<number> = IDENTITY): void {
    const sim = this._sim;
    if (!sim) return;
    if (this.state !== "paused" && dt > 0) {
      this.time += dt;
      this.runner.update(this.time, dt, playTimes(this.program, this.time));
      sim.step(dt, world, this.scale, this.tint);
      this._kfx?.step(dt, world, this.scale, this.tint, this.runner.context, this.overrides, playTimes(this.program, this.time));
    }
    for (const d of this._draws) {
      d.ensure(Math.max(1, Math.floor(d.emitter.settings.maxParticles * this.scale))); // the particle limit may have gone up
      d.update();
    }
    for (const d of this._kdraws) d.update();
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

  private autoStarts(e: SimEmitter): boolean {
    const i = this.program.systems.indexOf(e.name);
    return i < 0 || (this.program.autoStart[i] ?? true);
  }

  /** Start and stop the systems an event is wired to. */
  private route(route: { start: number[]; stop: number[] } | undefined): void {
    const sim = this._sim;
    if (!route || !sim) return;
    for (const s of this._kfx?.systems ?? []) {
      const i = s.kernel.emitter;
      if (route.start.includes(i)) {
        this._kfx!.startEmitter(i);
        this.state = "playing";
      } else if (route.stop.includes(i)) this._kfx!.endEmit(i);
    }
    for (const e of sim.emitters) {
      const i = this.program.systems.indexOf(e.name);
      if (route.start.includes(i)) {
        sim.startEmitter(e);
        this.state = "playing";
      } else if (route.stop.includes(i)) sim.endEmit(e);
    }
  }

  private disposeDraws(): void {
    for (const d of this._draws) d.dispose();
    this._draws = [];
    for (const d of this._kdraws) d.dispose();
    this._kdraws = [];
    this._kfx?.dispose();
    this._kfx = null;
    this._sim = null;
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
    texture: (path, sheet) => library.texture(path, sheet ? "sheet" : "color"),
    material: (path) => library.material(path),
    materialCopy: (path, name) => library.copy(path, name),
  };
}
