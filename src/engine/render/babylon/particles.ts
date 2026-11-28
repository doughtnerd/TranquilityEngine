// Internal (ADR 0057, 0060, 0075 stage 5, 0153, 0251): plays a World's ParticleSystem components on the
// Babylon backend. Each ParticleSystem gets an effect player (`effectPlayer.ts`: its systems on kernel
// executors, drawn through Babylon; Babylon's own particle features don't cover the effect format), and this
// adapter does what is about the World: it reads each component's effect, seed, scale, tint and
// overrides, rebuilds a player when the effect or what it draws with changes, runs scripts' commands, the
// editor's preview rules and `destroyOnFinish`, reports `_state`, and asks a player for the warm-up's
// state of an effect (ADR 0080). Loaded on demand with the Particles plugin's feature, so games without
// particles never load it. Babylon types stay inside this folder (ADR 0010).
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Assets } from "../../scene/Assets";
import { GameObject } from "../../scene/GameObject";
import type { ParticleProgram } from "../../scene/particleCompile";
import { projectAssets } from "../../scene/particleSubgraphs";
import type { ParticleSystem } from "../components";
import type { ParticleStats } from "../RenderSurface";
import type { ParticlePreview } from "../renderPolicy";
import { srgbToLinear } from "../particles/gpu/kernelMath";
import { EffectPlayer, EffectResources, type EffectHost, type PlayState } from "./effectPlayer";
import type { BabylonMaterials2D } from "./materials2D";
import type { ParticleLayer2D } from "./particleDraw";
import type { WarmParts } from "./warmUp";

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
  /**
   * Draw place for a sorting layer and order in layer (ADR 0014, 0415: 2D particles), as sprites have it, with the
   * system's world height `y` for a y-sorted layer (ADR 0440, `drawPlace`): the renderer's one place rule, which quad
   * batches and sprites use too (`BabylonQuadBatches.place`, ADR 0450). Optional: without it, 2D systems draw as 3D.
   */
  sortOrder?(sortingLayer: string, orderInLayer: number, y: number): number;
  /** The 2D materials (ADR 0418): a 2D system's lighting. Optional: without them, 2D systems draw unlit. */
  readonly materials2D?: BabylonMaterials2D;
  /** Logs a warning once per key. Optional. */
  warnOnce?(key: string, message: string): void;
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
    player.tint = [srgbToLinear(t.r), srgbToLinear(t.g), srgbToLinear(t.b), t.a];
    player.setOverrides(c.overrides);
    player.setLayer2D(this.layer2D(c));

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

  /** A 2D system's place and lighting (ADR 0415), or null for 3D particles. */
  private layer2D(c: ParticleSystem): ParticleLayer2D | null {
    if (!c.sortingLayer || !this.host.sortOrder) return null;
    const order = this.host.sortOrder(c.sortingLayer, c.orderInLayer, this.host.worldMatrix(c)[13] ?? 0); // its node's height (ADR 0440)
    return { order, lit: this.host.materials2D?.litSetup(c.material, c.sortingLayer) ?? null };
  }

  /** A player for `c`'s effect JSON, or null when it's missing or broken (warned once). */
  private player(c: ParticleSystem, raw: unknown, state: PlayState): EffectPlayer | null {
    const program = this.parse(c, raw);
    return program && new EffectPlayer(this.resources, program, { name: `particles:${c.node.name}`, seed: c.seed, state });
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

  // --- warm-up (ADR 0080) ---------------------------------------------------------------------------------

  /**
   * @internal What warming an effect draws: an effect player's warm state (`EffectPlayer.warm`), whose
   * draws, drawn once, make their shaders' pipelines; disposing the parts disposes the player. `effect`
   * is an asset path or an embedded effect
   * object; draw names start with `name`. Null while a texture, material or model it needs is loading
   * (ask again later); nothing to draw when it can't be built (missing or broken: the load reports it).
   */
  warm(effect: string | object, name: string, camera: Camera): WarmParts | null {
    let raw: unknown = effect;
    let where = "a particle effect";
    if (typeof effect === "string") {
      where = effect.replace(/^asset:/, "");
      try {
        raw = Assets.has(effect) ? Assets.json(effect) : Assets.has(where) ? Assets.json(where) : undefined;
      } catch {
        raw = undefined;
      }
    }
    const program = raw === undefined ? null : this.resources.compile(raw, where)?.program;
    if (!program) return { meshes: [], ready: () => true, dispose: () => {} };
    const player = new EffectPlayer(this.resources, program, { name, camera: () => camera });
    if (!player.warm()) {
      player.dispose();
      return null;
    }
    return {
      meshes: player.draws.flatMap((d) => d.meshes),
      ready: () => player.ready,
      dispose: () => player.dispose(),
    };
  }

  /** @internal The variant report: the ParticleSystem a Babylon mesh draws for, if any. */
  ownerOf(drawn: object): ParticleSystem | null {
    for (const [c, inst] of this.instances) if (inst.player?.owns(drawn)) return c;
    return null;
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

  /** @internal What's playing (the particle feature's diagnostics, which the editor overlay shows). `batches` counts draws (a mesh each). */
  state(): ParticleStats {
    let emitters = 0;
    let particles = 0;
    let batches = 0;
    let previewed: { time: number; count: number } | null = null;
    for (const inst of this.instances.values()) {
      const p = inst.player;
      const count = p?.count ?? 0;
      emitters += p?.emitters ?? 0;
      batches += p?.draws.length ?? 0;
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
