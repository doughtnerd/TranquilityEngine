// Internal (ADR 0057, 0060, 0075 stage 5): plays a World's ParticleSystem components on the Babylon
// backend. Our own CPU simulation (`../particles/simulation`) runs every emitter, because Babylon's
// particle features don't cover the effect format (trails, orbit, turbulence, rate over distance,
// sub-emitters…); Babylon only draws. Each emitter instance gets one Babylon CPU `ParticleSystem`
// whose particle list mirrors the simulation's every frame: Babylon's own emission, gravity and
// gradients are off (`emitRate` 0, an empty `updateFunction`). Loaded on demand by the renderer,
// so games without particles never load it. Babylon types stay inside this folder (ADR 0010).
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import { GameObject } from "../../scene/GameObject";
import { compileParticleGraph, type ParticleProgram } from "../../scene/particleCompile";
import { parseParticleGraph } from "../../scene/particleGraphFormat";
import type { ParticleSystem } from "../components";
import type { ParticlePreviewSettings, ParticleStats } from "../RenderSurface";
import { ProgramRunner } from "../particles/programRunner";
import { EffectSimulation, linearRGB, type SimEmitter } from "../particles/simulation";
import { copyParticles, createDotTexture, makeDraw as makeBabylonDraw, type Draw } from "./particleDraw";

/** What the particle player needs from the render backend. */
export interface BabylonParticleHost {
  /** Babylon scene (right-handed, +Y up). */
  readonly scene: Scene;
  /** An editor World: only selected systems (or all, with Simulate All) play, at the preview speed. */
  readonly editor: boolean;
  /** The node's world matrix (16 floats, column-major). */
  worldMatrix(c: ParticleSystem): ArrayLike<number>;
  /** Editor: whether the node is selected. */
  selected(c: ParticleSystem): boolean;
  /** Loads a texture asset (sRGB colour) for particles. */
  texture(path: string): Promise<BaseTexture>;
  /** The quality tier's particle scale (`PARTICLE_SCALE[Graphics.tier.particles]`); multiplies emission and the particle limit. */
  tierScale(): number;
}

type PlayState = "playing" | "paused" | "stopped";

interface Instance {
  /** The effect JSON it was built from, compared by identity (the asset's, or the embedded object). */
  raw: unknown;
  /** What the build depended on besides the effect: its textures. */
  key: string;
  program: ParticleProgram | null;
  runner: ProgramRunner | null;
  /** The overrides object last given to the runner (`setProperty` replaces it). */
  overrides: unknown;
  sim: EffectSimulation | null;
  draws: Draw[];
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
/** Seconds between checks of a built effect's textures. */
const KEY_CHECK_INTERVAL = 0.25;

export class BabylonParticles {
  private readonly instances = new Map<ParticleSystem, Instance>();
  private readonly warned = new Set<string>();
  private readonly textures = new Map<string, { tex: BaseTexture | null; failed: boolean }>();
  private dot: RawTexture | null = null;
  readonly preview: ParticlePreviewSettings = { playing: true, speed: 1, simulateAll: false };

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
      inst.runner = inst.program && new ProgramRunner(inst.program);
      inst.overrides = undefined;
      inst.key = "";
    }
    if (!inst) {
      const program = this.parse(c, raw);
      inst = {
        raw,
        key: "",
        program,
        runner: program && new ProgramRunner(program),
        overrides: undefined,
        sim: null,
        draws: [],
        scale: 1,
        tint: [1, 1, 1, 1],
        keyAge: 0,
        state: c.playOnAwake ? "playing" : "stopped",
        time: 0,
        shown: false,
        idle: 0,
        started: false,
      };
      this.instances.set(c, inst);
    }
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
    const key = checking ? this.buildKey(inst.program) : inst.key;
    // Bindings that aren't live (a shape's radius from a property, say) rebuild when their value changes.
    const stale = checking && !!inst.key && inst.runner.update(inst.time, 0, this.playTime(inst), true);
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
      inst.sim = new EffectSimulation(effect, { live: inst.runner.live });
      for (const e of inst.sim.emitters) this.warnRenderer(c, e);
      inst.draws = inst.sim.emitters.map((e) => this.makeDraw(`particles:${c.node.name}:${e.name}`, e, inst!.scale));
      const was = inst.state;
      this.applyState(inst, was === "stopped" ? "stopped" : "restart");
      if (was === "paused") this.applyState(inst, "pause");
    }
    const sim = inst.sim;
    if (!sim) return;

    sim.configure(this.host.worldMatrix(c), inst.scale, inst.tint);

    let dt: number;
    if (this.host.editor) {
      const shown = this.preview.simulateAll || this.host.selected(c);
      if (shown && !inst.shown) this.applyState(inst, "restart");
      if (!shown && inst.shown) this.applyState(inst, "clear");
      inst.shown = shown;
      dt = shown && this.preview.playing ? unscaledDeltaTime * this.preview.speed : 0;
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
      inst.runner.update(inst.time, dt, this.playTime(inst));
      sim.step(dt, this.host.worldMatrix(c), inst.scale, inst.tint);
    }

    for (const d of inst.draws) this.mirror(inst, d);

    const count = sim.count;
    const emitting = inst.state === "playing" && sim.emitting;
    if (inst.state === "playing" && !emitting) inst.state = "stopped"; // a one-shot effect finished emitting
    const alive = emitting || count > 0;
    if (inst.state === "playing") inst.started = true;
    c._state = { playing: inst.state === "playing", paused: inst.state === "paused", time: inst.time, count, alive };

    if (this.host.editor) {
      // Preview: a finished one-shot effect plays again after a moment.
      if (inst.shown && !alive && this.preview.playing) {
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
        sim?.restart();
        // Systems started by events (not On Play) wait for them.
        for (const e of sim?.emitters ?? []) if (!this.autoStarts(inst, e)) sim!.endEmit(e);
        this.route(inst, inst.program ? { start: [], stop: inst.program.onPlay.stop } : undefined);
        inst.time = 0;
        inst.idle = 0;
        inst.state = "playing";
        return;
      case "clear":
        sim?.clear();
        return;
      case "stopped":
      case "stopClear":
        sim?.endEmit();
        if (op === "stopClear") sim?.clear();
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

  /** Seconds into the current cycle, for Play Time nodes (by the first system's duration). */
  private playTime(inst: Instance): number {
    const d = inst.program?.effect.emitters[0]?.duration ?? 0;
    return d > 0 ? inst.time % d : inst.time;
  }

  private emit(inst: Instance, count: number): void {
    if (inst.sim && count > 0) inst.sim.emit(count);
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
    try {
      const { graph, problems } = parseParticleGraph(raw, where);
      const program = compileParticleGraph(graph);
      for (const p of [...problems, ...program.problems]) {
        const text = `${where}: ${p.message}${p.at ? ` (${p.at})` : ""}`;
        this.warnOnce(`${where}|${text}`, text);
      }
      return program;
    } catch (err) {
      this.warnOnce(`${where}|${(err as Error).message}`, (err as Error).message);
      return null;
    }
  }

  // --- textures -----------------------------------------------------------------------------------------

  /** A particle texture: null while it loads (the load starts), "failed" if it didn't. Re-asks the host, so a reimported texture is picked up. */
  private textureFor(path: string): BaseTexture | null | "failed" {
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

  /** The soft round dot particles use when they have no texture. */
  private dotTexture(): RawTexture {
    return (this.dot ??= createDotTexture(this.host.scene));
  }

  /** What the build depends on (each emitter's texture), or null while one still loads. */
  private buildKey(program: ParticleProgram): string | null {
    const parts: string[] = [];
    for (const e of program.effect.emitters) {
      if (!e.enabled) continue;
      if (!e.renderer.texture) {
        parts.push("dot");
        continue;
      }
      const t = this.textureFor(e.renderer.texture);
      if (t === null) return null;
      parts.push(t === "failed" ? `${e.renderer.texture}:failed` : `${e.renderer.texture}:${t.uniqueId}`);
    }
    return `k|${parts.join("|")}`;
  }

  private warnRenderer(c: ParticleSystem, e: SimEmitter): void {
    const where = `${c.node.name}'s emitter "${e.name}"`;
    const r = e.renderer;
    if (r.mode === "mesh" || r.mode === "trail") this.warnOnce(`mode|${where}|${r.mode}`, `${where}: the "${r.mode}" render mode isn't on the Babylon backend yet; drawing billboards.`);
    if (r.material) this.warnOnce(`material|${where}`, `${where}: material assets aren't used for particles on the Babylon backend yet; drawing with its texture and blending.`);
    if (r.blendTiles) this.warnOnce(`blend|${where}`, `${where}: blended flipbook tiles aren't on the Babylon backend yet; tiles switch without blending.`);
  }

  // --- drawing --------------------------------------------------------------------------------------------

  private makeDraw(name: string, e: SimEmitter, scale: number, capacity = Math.max(1, Math.ceil(e.settings.maxParticles * Math.max(1, scale)))): Draw {
    const path = e.renderer.texture;
    const found = path ? this.textureFor(path) : null;
    const texture = found && found !== "failed" ? found : this.dotTexture();
    return makeBabylonDraw(this.host.scene, name, e, capacity, texture, texture === this.dot);
  }

  /** Copy the simulation's particles into Babylon's list for drawing. */
  private mirror(inst: Instance, d: Draw): void {
    const e = d.emitter;
    const need = Math.max(1, Math.floor(e.settings.maxParticles * inst.scale));
    if (need > d.capacity) {
      // Babylon sizes its buffers at construction: rebuild bigger (the simulation keeps its state).
      const next = this.makeDraw(d.name, e, inst.scale, Math.ceil(need * 1.5));
      d.ps.dispose(false);
      Object.assign(d, next);
    }
    copyParticles(d);
  }

  private disposeDraws(inst: Instance): void {
    for (const d of inst.draws) d.ps.dispose(false);
    inst.draws = [];
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }

  /** Restart every previewed effect (the editor overlay's Restart). */
  restartAll(): void {
    for (const inst of this.instances.values()) if (inst.shown || !this.host.editor) this.applyState(inst, "restart");
  }

  release(c: ParticleSystem): void {
    const inst = this.instances.get(c);
    if (!inst) return;
    this.disposeDraws(inst);
    this.instances.delete(c);
  }

  /** @internal Tests and the editor overlay: what's playing. `batches` counts Babylon particle systems. */
  state(): ParticleStats {
    let emitters = 0;
    let particles = 0;
    let batches = 0;
    let previewed: { time: number; count: number } | null = null;
    for (const inst of this.instances.values()) {
      const count = inst.sim?.count ?? 0;
      emitters += inst.sim?.emitters.length ?? 0;
      batches += inst.draws.length;
      particles += count;
      if (inst.shown && !previewed) previewed = { time: inst.time, count };
    }
    return { systems: this.instances.size, emitters, particles, batches, previewed };
  }

  dispose(): void {
    for (const c of [...this.instances.keys()]) this.release(c);
    this.dot?.dispose();
    this.dot = null;
  }
}
