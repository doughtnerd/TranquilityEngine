// Internal (ADR 0057, 0060, 0075 stage 5): plays a World's ParticleSystem components on the Babylon
// backend. Our own CPU simulation (`../particles/simulation`) runs every emitter, because Babylon's
// particle features don't cover the effect format (trails, orbit, turbulence, rate over distance,
// sub-emitters…); Babylon only draws. Each emitter instance gets one Babylon CPU `ParticleSystem`
// whose particle list mirrors the simulation's every frame: Babylon's own emission, gravity and
// gradients are off (`emitRate` 0, an empty `updateFunction`). Mesh and trail modes and emitters
// with a material asset draw as meshes instead (`particleDraw.ts`, `particleMeshes.ts`). Loaded on
// demand by the renderer, so games without particles never load it. Babylon types stay inside this
// folder (ADR 0010).
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { ParticleEmitterSettings } from "../../scene/particles";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import { GameObject } from "../../scene/GameObject";
import { meshesIfLoaded, type ModelMesh } from "../../scene/models";
import { compileParticleGraph, type ParticleProgram } from "../../scene/particleCompile";
import { parseParticleGraph } from "../../scene/particleGraphFormat";
import { expandParticleGraph, expansionDependencies, projectAssets } from "../../scene/particleSubgraphs";
import type { ParticleSystem } from "../components";
import type { ParticleStats } from "../RenderSurface";
import type { ParticlePreview } from "../renderPolicy";
import { ProgramRunner, playTimes } from "../particles/programRunner";
import { randomForSeed } from "../particles/random";
import { EffectSimulation, linearRGB, type ParticleRaycast, type SimEmitter } from "../particles/simulation";
import { createDotTexture, makeDraw as makeBabylonDraw, usesSheet, type Draw } from "./particleDraw";
import { heightFogOn } from "./heightFog";
import { KernelMaterialDraw, drawsKernelParticles } from "./kernelMaterial";
import { chooseBackend, compileParticleKernels, type KernelProgram, type KernelSystem, type SystemBackend } from "../../scene/particleKernel";
import type { ParticleGraph } from "../../scene/particleGraph";
import { KernelEffect } from "../particles/gpu/kernelEffect";
import { BabylonKernelHost, KernelDraw, SceneDepth, sortRunOnce, type BabylonRun } from "./gpuParticles";

/** How an effect's systems run (ADR 0094): per emitter, the CPU or a kernel executor. */
interface KernelPlan {
  kernels: KernelProgram;
  backends: SystemBackend[];
  /** The kernel systems that run (backend isn't "cpu"). */
  running: KernelSystem[];
}

/** What the particle player needs from the render backend. */
export interface BabylonParticleHost {
  /** Babylon scene (right-handed, +Y up). */
  readonly scene: Scene;
  /** The node's world matrix (16 floats, column-major). */
  worldMatrix(c: ParticleSystem): ArrayLike<number>;
  /**
   * Preview mode (ADR 0057, 0129 `RenderPolicy.particlePreview`): script commands are ignored and only
   * systems on selected nodes (all with Simulate All) play, at the preview speed. Null: game rules.
   * The playback settings are part of it (ADR 0154): the player keeps no copy.
   */
  particlePreview(): ParticlePreview | null;
  /**
   * Loads a texture asset (sRGB colour) for particles: flipped as other textures (V 1 is the image's
   * top), or with `sheet` unflipped (V 0 at the top), as Babylon's particle sprite sheets read it.
   */
  texture(path: string, sheet?: boolean): Promise<BaseTexture>;
  /** The quality tier's particle scale (`PARTICLE_SCALE[Graphics.tier.particles]`); multiplies emission and the particle limit. */
  tierScale(): number;
  /**
   * A material asset (an emitter's `renderer.material`) as a Babylon material, shared with the
   * renderer, or null (missing, not a material, or still loading). Null draws with the emitter's
   * texture and blending; the effect is rebuilt when the material appears or changes. Optional:
   * without it material assets are never used.
   */
  material?(path: string): Material | null;
  /**
   * An unshared copy of a material asset (soft CPU particles, kernel outputs, ADR 0126), disposed by the
   * caller; a shader graph's copy is a new graph material, not a clone. Optional: without it the shared
   * material is cloned.
   */
  materialCopy?(path: string, name: string): { material: Material; dispose(): void } | null;
  /** Force the kernel executors (tests, benchmarks); default: what the engine supports (ADR 0094). */
  readonly kernelExecutors?: readonly import("../../scene/particleKernel").KernelExecutor[];
  /**
   * A world-space ray cast against the World's physics colliders, for the `collisionColliders`
   * behaviour. Optional: without it that behaviour does nothing.
   */
  raycast?: ParticleRaycast;
}

type PlayState = "playing" | "paused" | "stopped";

interface Instance {
  /** The effect JSON it was built from, compared by identity (the asset's, or the embedded object). */
  raw: unknown;
  /** What the build depended on besides the effect: its textures. */
  key: string;
  program: ParticleProgram | null;
  runner: ProgramRunner | null;
  /** The component's `seed` (read each frame; used when the effect next restarts). */
  seed: number;
  /** The effect's random: the simulation and the runner call it, so it can be swapped on restart (seeded: `randomForSeed(seed)` again, so every restart repeats). */
  random: () => number;
  /** What the simulation and the runner are given: forwards to `random`. */
  readonly rnd: () => number;
  /** The overrides object last given to the runner (`setProperty` replaces it). */
  overrides: unknown;
  sim: EffectSimulation | null;
  draws: Draw[];
  /** Kernel systems (ADR 0094) and their draws, one per output. */
  kfx: KernelEffect | null;
  kdraws: (KernelDraw | KernelMaterialDraw)[];
  /** Quality tier × the component's emission scale. */
  scale: number;
  /** The component's tint (linear). */
  tint: [number, number, number, number];
  /** Seconds since the build key was last checked (a few times a second, not every frame). */
  keyAge: number;
  state: PlayState;
  time: number;
  /** Editor: simulated last frame (selected, or Simulate All). */
  shown: boolean;
  /** Editor: seconds since a finished one-shot effect ended, before it plays again. */
  idle: number;
  /** Runtime: has played at all (so `destroyOnFinish` waits for it to start). */
  started: boolean;
}

/** Editor preview: a finished one-shot effect plays again after this many seconds. */
const PREVIEW_REPEAT_GAP = 0.6;
/** A warm-up particle's size in metres: drawn, but covering no pixel. */
const WARM_PARTICLE_SIZE = 1e-5;
/** Seconds between checks of a built effect's textures. */
const KEY_CHECK_INTERVAL = 0.25;

export class BabylonParticles {
  private readonly instances = new Map<ParticleSystem, Instance>();
  private readonly warned = new Set<string>();
  private readonly textures = new Map<string, { tex: BaseTexture | null; failed: boolean }>();
  private dot: RawTexture | null = null;
  /** Model meshes' ids in build keys. */
  private readonly meshIds = new WeakMap<ModelMesh, number>();
  private nextMeshId = 1;

  constructor(private readonly host: BabylonParticleHost) {}

  /** Step 8: build, steer and simulate every ParticleSystem, then refresh the drawn particles. */
  sync(systems: readonly ParticleSystem[], deltaTime: number, unscaledDeltaTime: number): void {
    const seen = new Set<ParticleSystem>();
    for (const c of systems) {
      if (!c.isActiveAndEnabled) continue;
      seen.add(c);
      this.syncOne(c, deltaTime, unscaledDeltaTime);
    }
    for (const c of [...this.instances.keys()]) if (!seen.has(c)) this.release(c);
  }

  private syncOne(c: ParticleSystem, deltaTime: number, unscaledDeltaTime: number): void {
    const raw = this.effectJSON(c);
    let inst = this.instances.get(c);
    if (inst && inst.raw !== raw) {
      // The effect changed (edited, or another asset): rebuild, keeping whether it plays.
      this.disposeDraws(inst);
      inst.sim = null;
      inst.raw = raw;
      inst.program = this.parse(c, raw);
      inst.runner = inst.program && new ProgramRunner(inst.program, inst.rnd);
      inst.overrides = undefined;
      inst.key = "";
    }
    if (!inst) {
      const program = this.parse(c, raw);
      const made: Instance = {
        raw,
        key: "",
        program,
        runner: null,
        seed: c.seed,
        random: randomForSeed(c.seed),
        rnd: () => made.random(),
        overrides: undefined,
        sim: null,
        draws: [],
        kfx: null,
        kdraws: [],
        scale: 1,
        tint: [1, 1, 1, 1],
        keyAge: 0,
        state: c.playOnAwake ? "playing" : "stopped",
        time: 0,
        shown: false,
        idle: 0,
        started: false,
      };
      made.runner = program && new ProgramRunner(program, made.rnd);
      inst = made;
      this.instances.set(c, inst);
    }
    inst.seed = c.seed;
    inst.scale = this.host.tierScale() * Math.max(0, c.emissionScale);
    const t = c.tint;
    const [lr, lg, lb] = linearRGB(t.r, t.g, t.b);
    inst.tint = [lr, lg, lb, t.a];
    if (!inst.program || !inst.runner) return;
    if (inst.overrides !== c.overrides) {
      inst.overrides = c.overrides;
      inst.runner.setOverrides(c.overrides ?? {});
    }

    // Rebuild when a texture changes (finishing loading, or reimported), checked at once while
    // unbuilt and a few times a second after.
    inst.keyAge += unscaledDeltaTime;
    const checking = !inst.key || inst.keyAge >= KEY_CHECK_INTERVAL;
    if (checking && this.depsChanged(c)) {
      inst.raw = undefined; // re-parse next frame with the changed sub-graph or block
      inst.keyAge = KEY_CHECK_INTERVAL;
      return;
    }
    const key = checking ? this.buildKey(inst.program) : inst.key;
    // Bindings that aren't live (a shape's radius from a property, say) rebuild when their value changes.
    const stale = checking && !!inst.key && inst.runner.update(inst.time, 0, playTimes(inst.program, inst.time), true);
    if (key === inst.key && !stale) {
      if (inst.keyAge >= KEY_CHECK_INTERVAL) inst.keyAge = 0;
    } else {
      inst.keyAge = 0;
      this.disposeDraws(inst);
      inst.sim = null;
      if (key === null) {
        inst.key = ""; // a texture is still loading: try again next frame
        return;
      }
      inst.key = key;
      const effect = inst.runner.effect();
      const plan = this.plans.get(inst.program);
      // Systems a kernel runs are left out of the CPU simulation (disabled, so emitter indices stay).
      const cpuEffect = plan?.running.length ? { ...effect, emitters: effect.emitters.map((e, i) => (plan.backends[i] === "cpu" ? e : { ...e, enabled: false })) } : effect;
      inst.sim = new EffectSimulation(cpuEffect, { live: inst.runner.live, random: inst.rnd, raycast: this.host.raycast });
      for (const e of inst.sim.emitters) this.warnRenderer(c, e);
      inst.draws = inst.sim.emitters.map((e) => this.makeDraw(`particles:${c.node.name}:${e.name}`, e, inst!.scale));
      if (plan?.running.length) {
        inst.kfx = new KernelEffect(plan.running, effect.emitters, this.kernelHost(), { live: inst.runner.live, random: inst.rnd, seeds: inst.program.seeds, seed: inst.seed });
        for (const s of inst.kfx.systems) {
          s.kernel.outputs.forEach((o, k) => {
            const found = o.settings.texture ? this.textureFor(o.settings.texture, false) : null;
            const texture = found && found !== "failed" ? found : this.dotTexture();
            const mesh = o.type === "mesh" ? (this.meshFor(o.settings.mesh) ?? undefined) : undefined;
            const name = `particles:${c.node.name}:${s.kernel.id}:${k}`;
            const softness = o.settings.softness ?? 0;
            const made = o.settings.material && o.type !== "trail" ? this.kernelMaterialDraw(name, s.kernel, k, s.run as BabylonRun, o.settings.material, { mesh, softness }) : null;
            if (o.settings.material && !made) this.warnOnce(`kmat|${name}|${o.settings.material}`, `${c.node.name}: the kernel output "${s.kernel.name}" draws with its texture: ${o.type === "trail" ? "trails don't take material assets yet" : `"${o.settings.material}" isn't a PBR material (or hasn't loaded)`}.`);
            inst!.kdraws.push(made ?? new KernelDraw(this.host.scene, name, s.kernel, k, s.run, texture, this.sceneDepth(), { mesh, softness }));
          });
        }
      }
      const was = inst.state;
      this.applyState(inst, was === "stopped" ? "stopped" : "restart");
      if (was === "paused") this.applyState(inst, "pause");
    }
    const sim = inst.sim;
    if (!sim) return;

    sim.configure(this.host.worldMatrix(c), inst.scale, inst.tint);

    let dt: number;
    const previewing = this.host.particlePreview();
    if (previewing) {
      const shown = previewing.simulateAll || previewing.selected(c.node);
      if (shown && !inst.shown) this.applyState(inst, "restart");
      if (!shown && inst.shown) this.applyState(inst, "clear");
      inst.shown = shown;
      dt = shown && previewing.playing ? unscaledDeltaTime * previewing.speed : 0;
    } else {
      for (const cmd of c._commands.splice(0)) {
        if (cmd.op === "emit") this.emit(inst, cmd.count);
        else if (cmd.op === "event") this.route(inst, inst.program.custom.get(cmd.name));
        else if (cmd.op === "stop") {
          this.applyState(inst, cmd.clear ? "stopClear" : "stopped");
          this.route(inst, inst.program.onStop);
        } else this.applyState(inst, cmd.op);
      }
      dt = deltaTime * Math.max(0, c.timeScale);
    }

    if (inst.state !== "paused" && dt > 0) {
      inst.time += dt;
      inst.runner.update(inst.time, dt, playTimes(inst.program, inst.time));
      sim.step(dt, this.host.worldMatrix(c), inst.scale, inst.tint);
      inst.kfx?.step(dt, this.host.worldMatrix(c), inst.scale, inst.tint, inst.runner.context, inst.overrides, playTimes(inst.program, inst.time));
    }

    for (const d of inst.draws) this.mirror(inst, d);
    for (const d of inst.kdraws) d.update();

    const count = sim.count + (inst.kfx?.count ?? 0);
    const emitting = inst.state === "playing" && (sim.emitting || !!inst.kfx?.emitting);
    if (inst.state === "playing" && !emitting) inst.state = "stopped"; // a one-shot effect finished emitting
    const alive = emitting || count > 0;
    if (inst.state === "playing") inst.started = true;
    c._state = { playing: inst.state === "playing", paused: inst.state === "paused", time: inst.time, count, alive };

    if (previewing) {
      // Preview: a finished one-shot effect plays again after a moment.
      if (inst.shown && !alive && previewing.playing) {
        inst.idle += dt;
        if (inst.idle >= PREVIEW_REPEAT_GAP) this.applyState(inst, "restart");
      } else inst.idle = 0;
    } else if (c.destroyOnFinish && inst.started && !alive) {
      GameObject.destroy(c.node);
    }
  }

  private applyState(inst: Instance, op: "play" | "pause" | "restart" | "clear" | "stopped" | "stopClear"): void {
    const sim = inst.sim;
    switch (op) {
      case "play":
        if (inst.state === "stopped") return this.applyState(inst, "restart");
        inst.state = "playing";
        return;
      case "pause":
        if (inst.state !== "playing") return;
        inst.state = "paused";
        return;
      case "restart":
        inst.random = randomForSeed(inst.seed); // a seeded effect repeats exactly on every restart
        sim?.restart();
        inst.kfx?.restart();
        // Systems started by events (not On Play) wait for them.
        for (const e of sim?.emitters ?? []) if (!this.autoStarts(inst, e)) sim!.endEmit(e);
        for (const s of inst.kfx?.systems ?? []) if (!s.parent && inst.program && !(inst.program.autoStart[s.kernel.emitter] ?? true)) inst.kfx!.endEmit(s.kernel.emitter);
        this.route(inst, inst.program ? { start: [], stop: inst.program.onPlay.stop } : undefined);
        inst.time = 0;
        inst.idle = 0;
        inst.state = "playing";
        return;
      case "clear":
        sim?.clear();
        inst.kfx?.clear();
        return;
      case "stopped":
      case "stopClear":
        sim?.endEmit();
        inst.kfx?.endEmit();
        if (op === "stopClear") {
          sim?.clear();
          inst.kfx?.clear();
        }
        inst.state = "stopped";
        return;
    }
  }

  private autoStarts(inst: Instance, e: SimEmitter): boolean {
    const i = inst.program?.systems.indexOf(e.name) ?? -1;
    return i < 0 || (inst.program?.autoStart[i] ?? true);
  }

  /** Start and stop the systems an event is wired to. */
  private route(inst: Instance, route: { start: number[]; stop: number[] } | undefined): void {
    if (!route || !inst.sim || !inst.program) return;
    for (const s of inst.kfx?.systems ?? []) {
      const i = s.kernel.emitter;
      if (route.start.includes(i)) {
        inst.kfx!.startEmitter(i);
        if (inst.state !== "playing") inst.state = "playing";
      } else if (route.stop.includes(i)) inst.kfx!.endEmit(i);
    }
    for (const e of inst.sim.emitters) {
      const i = inst.program.systems.indexOf(e.name);
      if (route.start.includes(i)) {
        inst.sim.startEmitter(e);
        if (inst.state !== "playing") inst.state = "playing";
      } else if (route.stop.includes(i)) {
        inst.sim.endEmit(e);
      }
    }
  }

  private emit(inst: Instance, count: number): void {
    if (count <= 0) return;
    if (inst.sim?.emitters.length) inst.sim.emit(count);
    else inst.kfx?.emit(count);
  }

  /** The effect's JSON: the asset's (identity changes when the file does), or the embedded object. */
  private effectJSON(c: ParticleSystem): unknown {
    if (c.effect) {
      try {
        return Assets.has(c.effect) ? Assets.json(c.effect) : undefined;
      } catch {
        return undefined;
      }
    }
    return c.embeddedEffect ?? undefined;
  }

  private parse(c: ParticleSystem, raw: unknown): ParticleProgram | null {
    const where = c.effect ? c.effect.replace(/^asset:/, "") : `${c.node.name}'s particle effect`;
    if (raw === undefined) {
      if (c.effect) this.warnOnce(`missing|${c.effect}`, `particle effect "${where}" isn't in the project.`);
      return null;
    }
    return this.compile(raw, where, c);
  }

  /** Parse and compile an effect; `c`, when it's a system's, has the files it expands from recorded (to rebuild when they change). */
  private compile(raw: unknown, where: string, c?: ParticleSystem): ParticleProgram | null {
    try {
      const parsed = parseParticleGraph(raw, where);
      // Sub-graphs and custom blocks are inlined first (ADR 0095).
      const expanded = expandParticleGraph(parsed.graph, projectAssets);
      const graph = expanded.graph;
      const problems = [...parsed.problems, ...expanded.problems];
      if (c) this.deps.set(c, expansionDependencies(parsed.graph, projectAssets));
      const program = compileParticleGraph(graph);
      const plan = this.plan(graph, program, where);
      const onKernel = (at: string | undefined) => !!at && plan.running.some((k) => at === k.id || at.startsWith(`${k.id}.`));
      const kernelProblems = plan.kernels.problems.filter((p) => onKernel(p.at));
      for (const p of [...problems, ...program.problems.filter((q) => !(q.cpuOnly && onKernel(q.at))), ...kernelProblems]) {
        const text = `${where}: ${p.message}${p.at ? ` (${p.at})` : ""}`;
        this.warnOnce(`${where}|${text}`, text);
      }
      this.plans.set(program, plan);
      return program;
    } catch (err) {
      this.warnOnce(`${where}|${(err as Error).message}`, (err as Error).message);
      return null;
    }
  }

  /** Which systems run on a kernel (ADR 0094): each system's choice, then events keep a parent and its child on the same side. */
  private plan(graph: ParticleGraph, program: ParticleProgram, where: string): KernelPlan {
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

  private kernels: BabylonKernelHost | null = null;
  private depth: SceneDepth | null = null;
  private readonly plans = new WeakMap<ParticleProgram, KernelPlan>();
  /** Sub-graph and custom block assets each effect was expanded with, and their JSON when it was (ADR 0095). */
  private readonly deps = new WeakMap<ParticleSystem, string[]>();
  private readonly depJson = new WeakMap<ParticleSystem, unknown[]>();

  /** True when a sub-graph or custom block asset the effect uses changed since it was built. */
  private depsChanged(c: ParticleSystem): boolean {
    const refs = this.deps.get(c);
    if (!refs?.length) return false;
    const now = refs.map(projectAssets);
    const before = this.depJson.get(c);
    this.depJson.set(c, now);
    return !!before && now.some((v, i) => v !== before[i]);
  }

  /** An unshared copy of a material asset (the host's, else a clone of the shared one), or null. */
  private copyMaterial(path: string, name: string): { material: Material; dispose(): void } | null {
    const fromHost = this.host.materialCopy?.(path, name);
    if (fromHost !== undefined) return fromHost;
    const shared = this.materialFor(path);
    const copy = shared?.clone(name) ?? null;
    return copy ? { material: copy, dispose: () => copy.dispose(false, false) } : null;
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

  private sceneDepth(): SceneDepth {
    return (this.depth ??= new SceneDepth(this.host.scene));
  }

  private kernelHost(): BabylonKernelHost {
    return (this.kernels ??= new BabylonKernelHost(this.host.scene, this.sceneDepth(), this.host.kernelExecutors));
  }

  /** @internal Tests and the editor: the backend each system of `c`'s effect runs on. */
  backendsOf(c: ParticleSystem): SystemBackend[] {
    const program = this.instances.get(c)?.program;
    return (program && this.plans.get(program)?.backends) ?? [];
  }

  /** @internal Tests: a system's kernel draws. */
  kernelDrawsOf(c: ParticleSystem): readonly (KernelDraw | KernelMaterialDraw)[] {
    return this.instances.get(c)?.kdraws ?? [];
  }

  /** @internal Tests: the kernel effect playing `c`. */
  kernelEffectOf(c: ParticleSystem): KernelEffect | null {
    return this.instances.get(c)?.kfx ?? null;
  }

  // --- textures -----------------------------------------------------------------------------------------

  /** A particle texture: null while it loads (the load starts), "failed" if it didn't. Re-asks the host, so a reimported texture is picked up. */
  private textureFor(path: string, sheet: boolean): BaseTexture | null | "failed" {
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

  /** The soft round dot particles use when they have no texture. */
  private dotTexture(): RawTexture {
    return (this.dot ??= createDotTexture(this.host.scene));
  }

  /** An emitter's material asset, or null (none, or not available yet). */
  private materialFor(path: string): Material | null {
    return path ? (this.host.material?.(path) ?? null) : null;
  }

  /** Mesh mode: the model mesh drawn (null while it loads, undefined when there's none to be had). */
  private meshFor(ref: string): ModelMesh | null | undefined {
    const meshes = meshesIfLoaded(ref);
    return meshes === null ? null : meshes[0];
  }

  /** What the build depends on (each emitter's material, mesh and texture), or null while one still loads. */
  private buildKey(program: ParticleProgram): string | null {
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

  private warnRenderer(c: ParticleSystem, e: SimEmitter): void {
    const where = `${c.node.name}'s emitter "${e.name}"`;
    const r = e.renderer;
    if (r.mode === "mesh" && r.tiles[0] * r.tiles[1] > 1) this.warnOnce(`meshTiles|${where}`, `${where}: flipbook tiles aren't applied to mesh particles on the Babylon backend.`);
  }

  // --- drawing --------------------------------------------------------------------------------------------

  private makeDraw(name: string, e: SimEmitter, scale: number): Draw {
    const capacity = Math.max(1, Math.ceil(e.settings.maxParticles * Math.max(1, scale)));
    const r = e.renderer;
    const material = this.materialFor(r.material);
    const heightFog = heightFogOn(this.host.scene);
    const found = r.texture && !material ? this.textureFor(r.texture, usesSheet(e.renderer, heightFog)) : null;
    const texture = found && found !== "failed" ? found : this.dotTexture();
    const mesh = r.mode === "mesh" ? this.meshFor(r.mesh) : undefined;
    const depth = (r.softness ?? 0) > 0 ? this.sceneDepth() : null;
    return makeBabylonDraw(this.host.scene, name, e, capacity, texture, texture === this.dot, { material, mesh, depth, heightFog, copyMaterial: (n) => this.copyMaterial(r.material, n) });
  }

  /** Copy the simulation's particles into the draw (growing it when the particle limit went up). */
  private mirror(inst: Instance, d: Draw): void {
    d.ensure(Math.max(1, Math.floor(d.emitter.settings.maxParticles * inst.scale)));
    d.update();
  }

  private disposeDraws(inst: Instance): void {
    for (const d of inst.draws) d.dispose();
    inst.draws = [];
    for (const d of inst.kdraws) d.dispose();
    inst.kdraws = [];
    inst.kfx?.dispose();
    inst.kfx = null;
  }

  // --- warm-up (ADR 0080) ---------------------------------------------------------------------------------

  /**
   * @internal The draws an effect makes, as `syncOne` would build them, each holding one particle at
   * `at` too small to see, so drawing them once makes their shaders' pipelines. `effect` is an asset
   * path or an embedded effect object. Null while a texture, material or model it needs is loading
   * (ask again later); empty when it can't be built (missing or broken: the load reports it).
   */
  warmDraws(effect: string | object, name: string, at: { x: number; y: number; z: number }, camera: () => Camera | null): Draw[] | null {
    let raw: unknown = effect;
    let where = "a particle effect";
    if (typeof effect === "string") {
      where = effect.replace(/^asset:/, "");
      try {
        raw = Assets.has(effect) ? Assets.json(effect) : Assets.has(where) ? Assets.json(where) : undefined;
      } catch {
        raw = undefined;
      }
      if (raw === undefined) return [];
    }
    const program = this.compile(raw, where);
    if (!program) return [];
    const key = this.buildKey(program);
    if (key === null) return null;
    const runner = new ProgramRunner(program);
    const played = runner.effect();
    const plan = this.plans.get(program);
    // Kernel systems warm their own pipelines below; the CPU warms the rest (ADR 0126).
    const cpuEffect = plan?.running.length ? { ...played, emitters: played.emitters.map((e, i) => (plan.backends[i] === "cpu" ? e : { ...e, enabled: false })) } : played;
    const sim = new EffectSimulation(cpuEffect, { live: runner.live });
    const kernelDraws = plan?.running.length ? this.warmKernels(plan.running, played.emitters, runner, name, camera) : [];
    if (kernelDraws === null) return null;
    const cpuDraws = sim.emitters.map((e) => {
      const r = e.renderer;
      const material = this.materialFor(r.material);
      const heightFog = heightFogOn(this.host.scene);
      const found = r.texture && !material ? this.textureFor(r.texture, usesSheet(r, heightFog)) : null;
      const texture = found && found !== "failed" ? found : this.dotTexture();
      const mesh = r.mode === "mesh" ? this.meshFor(r.mesh) : undefined;
      const depth = (r.softness ?? 0) > 0 ? this.sceneDepth() : null;
      const d = makeBabylonDraw(this.host.scene, `${name}:${e.name}`, e, 1, texture, texture === this.dot, { material, mesh, camera, depth, heightFog, copyMaterial: (n) => this.copyMaterial(r.material, n) });
      const p = e.alloc();
      p.wx = at.x;
      p.wy = at.y;
      p.wz = at.z;
      p.size = p.length = WARM_PARTICLE_SIZE;
      p.tileBlend = 0;
      if (r.mode === "trail") {
        // Two trail points, so the ribbon has a segment to draw.
        p.trail = new Float32Array([at.x, at.y, at.z, at.x, at.y + WARM_PARTICLE_SIZE, at.z]);
        p.trailCap = 2;
        p.trailCount = 2;
        p.trailHead = 0;
      }
      d.update();
      return d;
    });
    return [...cpuDraws, ...kernelDraws];
  }

  /**
   * Kernel systems' warm draws (ADR 0080, 0126): a kernel effect stepped once with nothing spawned, which
   * builds each system's simulation pipeline (WebGPU compute, WebGL2 program; the dead list's spawn pass
   * and the trail history pass with it), and each output's draw, updated once so a sorted output's sort
   * passes are built too. The draws are meshes the warmer draws like the CPU's mesh draws; disposing them
   * disposes the runs. Null while a texture or model they need is loading.
   */
  private warmKernels(kernels: KernelSystem[], emitters: readonly ParticleEmitterSettings[], runner: ProgramRunner, name: string, camera: () => Camera | null): Draw[] | null {
    const fx = new KernelEffect(kernels, emitters, this.kernelHost(), { live: runner.live, seed: 1 });
    const out: Draw[] = [];
    for (const s of fx.systems) {
      for (const [k, o] of s.kernel.outputs.entries()) {
        const found = o.settings.texture ? this.textureFor(o.settings.texture, false) : null;
        if (o.settings.texture && found === null) {
          for (const d of out) d.dispose();
          fx.dispose();
          return null;
        }
        const texture = found && found !== "failed" ? found : this.dotTexture();
        const mesh = o.type === "mesh" ? (this.meshFor(o.settings.mesh) ?? undefined) : undefined;
        const dname = `${name}:${s.kernel.id}:${k}`;
        const softness = o.settings.softness ?? 0;
        const d = (o.settings.material && o.type !== "trail" ? this.kernelMaterialDraw(dname, s.kernel, k, s.run as BabylonRun, o.settings.material, { mesh, softness }) : null) ?? new KernelDraw(this.host.scene, dname, s.kernel, k, s.run, texture, this.sceneDepth(), { mesh, softness });
        out.push({ name: dname, kind: "instances", mesh: d.mesh, ps: { dispose: () => d.dispose() }, emitter: null as never, capacity: 0, ensure: () => {}, update: () => d.update(), dispose: () => d.dispose() } as Draw & { mesh: Mesh });
      }
    }
    fx.endEmit();
    const cam = camera();
    fx.step(1 / 60, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 1, [1, 1, 1, 1], runner.context, undefined);
    const prev = this.host.scene.activeCamera;
    if (cam) this.host.scene.activeCamera = cam;
    for (const d of out) d.update();
    if (cam) this.host.scene.activeCamera = prev;
    // The runs belong to the draws now: the last one disposed takes the effect with it.
    let left = out.length;
    for (const d of out) {
      const dispose = d.dispose;
      d.dispose = () => {
        dispose();
        if (--left === 0) fx.dispose();
      };
    }
    if (!out.length) fx.dispose();
    return out;
  }

  /** @internal The variant report: the ParticleSystem a draw's Babylon particle system or mesh belongs to, if any. */
  ownerOf(drawn: object): ParticleSystem | null {
    for (const [c, inst] of this.instances) {
      for (const d of inst.draws) if (d.ps === drawn || (d as { mesh?: unknown }).mesh === drawn) return c;
    }
    return null;
  }

  /** @internal Tests: a system's draws. */
  drawsOf(c: ParticleSystem): readonly Draw[] {
    return this.instances.get(c)?.draws ?? [];
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }

  /** Restart every previewed effect (the editor overlay's Restart). */
  restartAll(): void {
    for (const inst of this.instances.values()) if (inst.shown || !this.host.particlePreview()) this.applyState(inst, "restart");
  }

  release(c: ParticleSystem): void {
    const inst = this.instances.get(c);
    if (!inst) return;
    this.disposeDraws(inst);
    this.instances.delete(c);
  }

  /** @internal Tests and the editor overlay: what's playing. `batches` counts draws (a Babylon particle system or a mesh each). */
  state(): ParticleStats {
    let emitters = 0;
    let particles = 0;
    let batches = 0;
    let previewed: { time: number; count: number } | null = null;
    for (const inst of this.instances.values()) {
      const count = (inst.sim?.count ?? 0) + (inst.kfx?.count ?? 0);
      emitters += (inst.sim?.emitters.length ?? 0) + (inst.kfx?.systems.length ?? 0);
      batches += inst.draws.length + inst.kdraws.length;
      particles += count;
      if (inst.shown && !previewed) previewed = { time: inst.time, count };
    }
    return { systems: this.instances.size, emitters, particles, batches, previewed };
  }

  dispose(): void {
    for (const c of [...this.instances.keys()]) this.release(c);
    this.dot?.dispose();
    this.dot = null;
    this.depth?.dispose();
    this.depth = null;
  }
}
