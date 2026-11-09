// Internal (ADR 0057, 0060, 0075 stage 5, 0153): plays a World's ParticleSystem components on the Babylon
// backend. Each ParticleSystem gets an effect player (`effectPlayer.ts`: our own CPU simulation and kernel
// systems, drawn through Babylon; Babylon's own particle features don't cover the effect format), and this
// adapter does what is about the World: it reads each component's effect, seed, scale, tint and
// overrides, rebuilds a player when the effect or what it draws with changes, runs scripts' commands, the
// editor's preview rules and `destroyOnFinish`, reports `_state`, and builds the warm-up's draws (ADR
// 0080). Loaded on demand with the Particles plugin's feature, so games without particles never load it.
// Babylon types stay inside this folder (ADR 0010).
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { ParticleEmitterSettings } from "../../scene/particles";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Assets } from "../../scene/Assets";
import { GameObject } from "../../scene/GameObject";
import type { ParticleProgram } from "../../scene/particleCompile";
import { projectAssets } from "../../scene/particleSubgraphs";
import type { ParticleSystem } from "../components";
import type { ParticleStats } from "../RenderSurface";
import type { ParticlePreview } from "../renderPolicy";
import { ProgramRunner } from "../particles/programRunner";
import { EffectSimulation, linearRGB } from "../particles/simulation";
import type { Draw } from "./particleDraw";
import type { KernelDraw } from "./gpuParticles";
import type { KernelMaterialDraw } from "./kernelMaterial";
import type { KernelSystem, SystemBackend } from "../../scene/particleKernel";
import { KernelEffect } from "../particles/gpu/kernelEffect";
import { EffectPlayer, EffectResources, type EffectHost, type PlayState } from "./effectPlayer";

/** What the particle player needs from the render backend: an effect host, plus the World's matrices and rules. */
export interface BabylonParticleHost extends EffectHost {
  /** The node's world matrix (16 floats, column-major). */
  worldMatrix(c: ParticleSystem): ArrayLike<number>;
  /**
   * Preview mode (ADR 0057, 0129 `RenderPolicy.particlePreview`): script commands are ignored and only
   * systems on selected nodes (all with Simulate All) play, at the preview speed. Null: game rules.
   * The playback settings are part of it (ADR 0154): the player keeps no copy.
   */
  particlePreview(): ParticlePreview | null;
  /** The quality tier's particle scale (`PARTICLE_SCALE[Graphics.tier.particles]`); multiplies emission and the particle limit. */
  tierScale(): number;
}

interface Instance {
  /** The effect JSON it was built from, compared by identity (the asset's, or the embedded object). */
  raw: unknown;
  /** Its player, or null when the effect is missing or broken (warned). */
  player: EffectPlayer | null;
  /** Seconds since the build key was last checked (a few times a second, not every frame). */
  keyAge: number;
  /** Editor: simulated last frame (selected, or Simulate All). */
  shown: boolean;
}

/** Editor preview: a finished one-shot effect plays again after this many seconds. */
const PREVIEW_REPEAT_GAP = 0.6;
/** A warm-up particle's size in metres: drawn, but covering no pixel. */
const WARM_PARTICLE_SIZE = 1e-5;
/** Seconds between checks of a built effect's textures. */
const KEY_CHECK_INTERVAL = 0.25;

export class BabylonParticles {
  private readonly instances = new Map<ParticleSystem, Instance>();
  /** The texture cache, dot, scene depth, kernel host and warnings every player here shares. */
  private readonly resources: EffectResources;
  /** Sub-graph and custom block assets each effect was expanded with, and their JSON when it was (ADR 0095). */
  private readonly deps = new WeakMap<ParticleSystem, string[]>();
  private readonly depJson = new WeakMap<ParticleSystem, unknown[]>();

  constructor(private readonly host: BabylonParticleHost) {
    this.resources = new EffectResources(host);
  }

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
      // The effect changed (edited, or another asset): a new player, keeping whether it plays.
      const state = inst.player?.state ?? (c.playOnAwake ? "playing" : "stopped");
      inst.player?.dispose();
      inst.raw = raw;
      inst.player = this.player(c, raw, state);
    }
    if (!inst) {
      inst = { raw, player: this.player(c, raw, c.playOnAwake ? "playing" : "stopped"), keyAge: 0, shown: false };
      this.instances.set(c, inst);
    }
    const player = inst.player;
    if (!player) return;
    player.seed = c.seed;
    player.scale = this.host.tierScale() * Math.max(0, c.emissionScale);
    const t = c.tint;
    const [lr, lg, lb] = linearRGB(t.r, t.g, t.b);
    player.tint = [lr, lg, lb, t.a];
    player.setOverrides(c.overrides);

    // Rebuild when a texture changes (finishing loading, or reimported), checked at once while
    // unbuilt and a few times a second after.
    inst.keyAge += unscaledDeltaTime;
    const checking = !player.built || inst.keyAge >= KEY_CHECK_INTERVAL;
    if (checking && this.depsChanged(c)) {
      inst.raw = undefined; // re-parse next frame with the changed sub-graph or block
      inst.keyAge = KEY_CHECK_INTERVAL;
      return;
    }
    if (checking) {
      inst.keyAge = 0;
      // Bindings that aren't live (a shape's radius from a property, say) rebuild when their value changes.
      if (!player.build(this.resources.buildKey(player.program), player.bindingsStale())) return; // a texture is still loading: try again next frame
    }
    if (!player.built) return;
    const world = this.host.worldMatrix(c);
    player.configure(world);

    let dt: number;
    const previewing = this.host.particlePreview();
    if (previewing) {
      const shown = previewing.simulateAll || previewing.selected(c.node);
      if (shown && !inst.shown) player.restart();
      if (!shown && inst.shown) player.clear();
      inst.shown = shown;
      dt = shown && previewing.playing ? unscaledDeltaTime * previewing.speed : 0;
    } else {
      for (const cmd of c._commands.splice(0)) {
        if (cmd.op === "emit") player.emit(cmd.count);
        else if (cmd.op === "event") player.event(cmd.name);
        else if (cmd.op === "stop") player.stop(cmd.clear, true);
        else if (cmd.op === "play") player.play();
        else if (cmd.op === "pause") player.pause();
        else if (cmd.op === "restart") player.restart();
        else if (cmd.op === "clear") player.clear();
      }
      dt = deltaTime * Math.max(0, c.timeScale);
    }

    player.step(dt, world);
    const alive = player.alive;
    c._state = { playing: player.state === "playing", paused: player.state === "paused", time: player.time, count: player.count, alive };

    if (previewing) {
      // Preview: a finished one-shot effect plays again after a moment.
      player.repeatWhenFinished(dt, PREVIEW_REPEAT_GAP, inst.shown && previewing.playing);
    } else if (c.destroyOnFinish && player.started && !alive) {
      GameObject.destroy(c.node);
    }
  }

  /** A player for `c`'s effect JSON, or null when it's missing or broken (warned once). */
  private player(c: ParticleSystem, raw: unknown, state: PlayState): EffectPlayer | null {
    const program = this.parse(c, raw);
    return program && new EffectPlayer(this.resources, program, { name: c.node.name, seed: c.seed, state });
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
      if (c.effect) this.resources.warnOnce(`missing|${c.effect}`, `particle effect "${where}" isn't in the project.`);
      return null;
    }
    const compiled = this.resources.compile(raw, where);
    if (compiled) this.deps.set(c, compiled.deps); // to rebuild when they change
    return compiled?.program ?? null;
  }

  /** True when a sub-graph or custom block asset the effect uses changed since it was built. */
  private depsChanged(c: ParticleSystem): boolean {
    const refs = this.deps.get(c);
    if (!refs?.length) return false;
    const now = refs.map(projectAssets);
    const before = this.depJson.get(c);
    this.depJson.set(c, now);
    return !!before && now.some((v, i) => v !== before[i]);
  }

  /** @internal Tests and the editor: the backend each system of `c`'s effect runs on. */
  backendsOf(c: ParticleSystem): SystemBackend[] {
    const program = this.instances.get(c)?.player?.program;
    return (program && this.resources.plan(program)?.backends) ?? [];
  }

  /** @internal Tests: a system's kernel draws. */
  kernelDrawsOf(c: ParticleSystem): readonly (KernelDraw | KernelMaterialDraw)[] {
    return this.instances.get(c)?.player?.kdraws ?? [];
  }

  /** @internal Tests: the kernel effect playing `c`. */
  kernelEffectOf(c: ParticleSystem): KernelEffect | null {
    return this.instances.get(c)?.player?.kfx ?? null;
  }

  // --- warm-up (ADR 0080) ---------------------------------------------------------------------------------

  /**
   * @internal The draws an effect makes, as a player would build them, each holding one particle at
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
    const program = this.resources.compile(raw, where)?.program;
    if (!program) return [];
    const key = this.resources.buildKey(program);
    if (key === null) return null;
    const runner = new ProgramRunner(program);
    const played = runner.effect();
    const plan = this.resources.plan(program);
    // Kernel systems warm their own pipelines below; the CPU warms the rest (ADR 0126).
    const cpuEffect = plan?.running.length ? { ...played, emitters: played.emitters.map((e, i) => (plan.backends[i] === "cpu" ? e : { ...e, enabled: false })) } : played;
    const sim = new EffectSimulation(cpuEffect, { live: runner.live });
    const kernelDraws = plan?.running.length ? this.warmKernels(plan.running, played.emitters, runner, name, camera) : [];
    if (kernelDraws === null) return null;
    const cpuDraws = sim.emitters.map((e) => {
      const d = this.resources.makeDraw(`${name}:${e.name}`, e, 1, camera);
      const p = e.alloc();
      p.wx = at.x;
      p.wy = at.y;
      p.wz = at.z;
      p.size = p.length = WARM_PARTICLE_SIZE;
      p.tileBlend = 0;
      if (e.renderer.mode === "trail") {
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
    const res = this.resources;
    const fx = new KernelEffect(kernels, emitters, res.kernelHost(), { live: runner.live, seed: 1 });
    const out: Draw[] = [];
    for (const s of fx.systems) {
      for (const [k, o] of s.kernel.outputs.entries()) {
        if (o.settings.texture && res.textureFor(o.settings.texture, false) === null) {
          for (const d of out) d.dispose();
          fx.dispose();
          return null;
        }
        const dname = `${name}:${s.kernel.id}:${k}`;
        const d = res.kernelDraw(dname, s, k, o);
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
      for (const d of inst.player?.draws ?? []) if (d.ps === drawn || (d as { mesh?: unknown }).mesh === drawn) return c;
    }
    return null;
  }

  /** @internal Tests: a system's draws. */
  drawsOf(c: ParticleSystem): readonly Draw[] {
    return this.instances.get(c)?.player?.draws ?? [];
  }

  /** Restart every previewed effect (the editor overlay's Restart). */
  restartAll(): void {
    for (const inst of this.instances.values()) if (inst.shown || !this.host.particlePreview()) inst.player?.restart();
  }

  release(c: ParticleSystem): void {
    const inst = this.instances.get(c);
    if (!inst) return;
    inst.player?.dispose();
    this.instances.delete(c);
  }

  /** @internal Tests and the editor overlay: what's playing. `batches` counts draws (a Babylon particle system or a mesh each). */
  state(): ParticleStats {
    let emitters = 0;
    let particles = 0;
    let batches = 0;
    let previewed: { time: number; count: number } | null = null;
    for (const inst of this.instances.values()) {
      const p = inst.player;
      const count = p?.count ?? 0;
      emitters += p?.emitters ?? 0;
      batches += (p?.draws.length ?? 0) + (p?.kdraws.length ?? 0);
      particles += count;
      if (inst.shown && !previewed) previewed = { time: p?.time ?? 0, count };
    }
    return { systems: this.instances.size, emitters, particles, batches, previewed };
  }

  dispose(): void {
    for (const c of [...this.instances.keys()]) this.release(c);
    this.resources.dispose();
  }
}
