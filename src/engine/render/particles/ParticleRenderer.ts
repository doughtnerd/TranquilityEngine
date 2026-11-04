// Internal (ADR 0057, 0060): plays a World's ParticleSystem components through one three.quarks
// BatchedRenderer. Each effect graph is compiled once per change; its bindings run every frame. Loaded on demand by the render backend, so games without particles never load
// quarks. three.js and quarks types stay inside src/engine/render (ADR 0010).
import { type BufferGeometry, type Material, Matrix4, type Object3D, type Scene } from "three";
import { BatchedRenderer, type ParticleSystem as QuarksSystem } from "three.quarks";
import { PARTICLE_SCALE } from "../../core/graphics";
import { Assets } from "../../scene/Assets";
import { GameObject } from "../../scene/GameObject";
import { compileParticleGraph, type ParticleProgram } from "../../scene/particleCompile";
import { parseParticleGraph } from "../../scene/particleGraphFormat";
import type { ParticleRenderer as RendererSettings } from "../../scene/particles";
import type { ParticleSystem } from "../components";
import { Graphics } from "../Graphics";
import { ProgramRunner } from "./programRunner";
import { buildEffect, linearRGB, type BuiltEmitter } from "./quarksEffect";

/** What the particle renderer needs from the render backend. */
export interface ParticleHost {
  readonly scene: Scene;
  /** An editor World: only selected systems (or all, with Simulate All) play, at the preview speed. */
  readonly editor: boolean;
  material(renderer: RendererSettings): Material | null;
  geometry(mesh: string): BufferGeometry | null;
  /** The node's world matrix. */
  worldMatrix(c: ParticleSystem, out: Matrix4): void;
  /** Editor: whether the node is selected. */
  selected(c: ParticleSystem): boolean;
}

/** Editor preview settings (the scene view's particle overlay). */
export interface ParticlePreview {
  playing: boolean;
  speed: number;
  simulateAll: boolean;
}

interface Instance {
  /** The effect JSON it was built from, compared by identity (the asset's, or the embedded object). */
  raw: unknown;
  /** What the build depended on besides the effect: tint and materials. */
  key: string;
  program: ParticleProgram | null;
  runner: ProgramRunner | null;
  /** The overrides object last given to the runner (`setProperty` replaces it). */
  overrides: unknown;
  emitters: BuiltEmitter[] | null;
  scale: { value: number };
  /** The component's tint (linear), read by the start colours as particles are born. */
  tint: { value: [number, number, number, number] };
  /** Seconds since the build key was last checked (it's checked a few times a second, not every frame). */
  keyAge: number;
  state: "playing" | "paused" | "stopped";
  time: number;
  /** Editor: simulated last frame (selected, or Simulate All). */
  shown: boolean;
  /** Editor: seconds since a finished one-shot effect ended, before it plays again. */
  idle: number;
  /** Runtime: has played at all (so `destroyOnFinish` waits for it to start). */
  started: boolean;
}

const tmp = new Matrix4();
/** Editor preview: a finished one-shot effect plays again after this many seconds. */
const PREVIEW_REPEAT_GAP = 0.6;
/** Seconds between checks of a built effect's materials. */
const KEY_CHECK_INTERVAL = 0.25;

export class ParticleRenderer {
  private readonly batch = new BatchedRenderer();
  private readonly instances = new Map<ParticleSystem, Instance>();
  private readonly warned = new Set<string>();
  readonly preview: ParticlePreview = { playing: true, speed: 1, simulateAll: false };

  constructor(private readonly host: ParticleHost) {
    this.batch.renderOrder = 0;
    host.scene.add(this.batch);
  }

  /** Step 8: build, steer and simulate every ParticleSystem, then refresh the batches. */
  sync(systems: readonly ParticleSystem[], deltaTime: number, unscaledDeltaTime: number): void {
    const seen = new Set<ParticleSystem>();
    for (const c of systems) {
      if (!c.isActiveAndEnabled) continue;
      seen.add(c);
      this.syncOne(c, deltaTime, unscaledDeltaTime);
    }
    for (const c of [...this.instances.keys()]) if (!seen.has(c)) this.release(c);
    for (const b of this.batch.batches) b.update();
  }

  private syncOne(c: ParticleSystem, deltaTime: number, unscaledDeltaTime: number): void {
    const raw = this.effectJSON(c);
    let inst = this.instances.get(c);
    if (inst && inst.raw !== raw) {
      // The effect changed (edited, or another asset): rebuild, keeping whether it plays.
      this.disposeEmitters(inst);
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
        emitters: null,
        scale: { value: 1 },
        tint: { value: [1, 1, 1, 1] },
        keyAge: 0,
        state: c.playOnAwake ? "playing" : "stopped",
        time: 0,
        shown: false,
        idle: 0,
        started: false,
      };
      this.instances.set(c, inst);
    }
    inst.scale.value = PARTICLE_SCALE[Graphics.tier.particles] * Math.max(0, c.emissionScale);
    const t = c.tint;
    inst.tint.value = [...linearRGB(t.r, t.g, t.b), t.a];
    if (!inst.program || !inst.runner) return;
    if (inst.overrides !== c.overrides) {
      inst.overrides = c.overrides;
      inst.runner.setOverrides(c.overrides ?? {});
    }

    // Rebuild when a material changes (a texture finishing loading, a material asset edited), checked
    // at once while unbuilt and a few times a second after.
    inst.keyAge += unscaledDeltaTime;
    const checking = !inst.key || inst.keyAge >= KEY_CHECK_INTERVAL;
    let key = checking ? this.buildKey(inst.program) : inst.key;
    // Bindings that aren't live (a shape's radius from a property, say) rebuild when their value changes.
    if (checking && inst.key && inst.runner.update(inst.time, 0, this.playTime(inst), true)) key = "";
    if (key === inst.key) inst.keyAge = inst.keyAge >= KEY_CHECK_INTERVAL ? 0 : inst.keyAge;
    if (key !== inst.key) {
      inst.keyAge = 0;
      this.disposeEmitters(inst);
      inst.key = key;
      if (!key) inst.key = key = this.buildKey(inst.program);
      inst.emitters = buildEffect(inst.runner.effect(), {
        material: (r) => this.host.material(r),
        geometry: (m) => this.host.geometry(m),
        scale: inst.scale,
        tint: inst.tint,
        live: inst.runner.live,
      });
      if (!inst.emitters) {
        inst.key = ""; // something is still loading: try again next frame
        return;
      }
      for (const e of inst.emitters) {
        e.system.emitter.matrixAutoUpdate = false;
        this.host.scene.add(e.system.emitter);
        this.batch.addSystem(e.system);
      }
      const was = inst.state;
      this.applyState(inst, was === "stopped" ? "stopped" : "restart");
      if (was === "paused") this.applyState(inst, "pause");
    }
    if (!inst.emitters) return;

    this.host.worldMatrix(c, tmp);
    for (const e of inst.emitters) {
      e.system.emitter.matrix.multiplyMatrices(tmp, e.shapeMatrix);
      e.system.emitter.matrixWorldNeedsUpdate = true;
      e.system.emitter.updateMatrixWorld(true);
    }

    let dt: number;
    if (this.host.editor) {
      const shown = this.preview.simulateAll || this.host.selected(c);
      if (shown && !inst.shown) this.applyState(inst, "restart");
      if (!shown && inst.shown) this.applyState(inst, "clear");
      inst.shown = shown;
      dt = shown && this.preview.playing ? unscaledDeltaTime * this.preview.speed : 0;
      for (const e of inst.emitters) e.system.emitter.visible = shown;
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
      for (const e of inst.emitters) {
        if (inst.time < e.startDelay) continue;
        (e.system as unknown as { update(dt: number): void }).update(dt);
      }
    }

    const count = inst.emitters.reduce((n, e) => n + e.system.particleNum, 0);
    const emitting = inst.state === "playing" && inst.emitters.some((e) => !e.subEmitter && (e.looping || inst.time < e.startDelay || !emitEnded(e.system)));
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
    const emitters = inst.emitters ?? [];
    switch (op) {
      case "play":
        if (inst.state === "stopped") return this.applyState(inst, "restart");
        for (const e of emitters) e.system.play();
        inst.state = "playing";
        return;
      case "pause":
        if (inst.state !== "playing") return;
        for (const e of emitters) e.system.pause();
        inst.state = "paused";
        return;
      case "restart":
        for (const e of emitters) {
          e.system.looping = e.looping;
          e.system.restart();
          // Systems started by events (not On Play) wait for them.
          if (!this.autoStarts(inst, e)) {
            e.system.looping = false;
            e.system.endEmit();
          }
        }
        this.route(inst, inst.program ? { start: [], stop: inst.program.onPlay.stop } : undefined);
        inst.time = 0;
        inst.idle = 0;
        inst.state = "playing";
        return;
      case "clear":
        for (const e of emitters) e.system.particleNum = 0;
        return;
      case "stopped":
      case "stopClear":
        for (const e of emitters) {
          e.system.play(); // a paused system has to update for its particles to finish
          e.system.looping = false; // or quarks starts the next cycle's bursts
          e.system.endEmit();
          if (op === "stopClear") e.system.particleNum = 0;
        }
        inst.state = "stopped";
        return;
    }
  }

  private autoStarts(inst: Instance, e: BuiltEmitter): boolean {
    const i = inst.program?.systems.indexOf(e.name) ?? -1;
    return i < 0 || (inst.program?.autoStart[i] ?? true);
  }

  /** Start and stop the systems an event is wired to. */
  private route(inst: Instance, route: { start: number[]; stop: number[] } | undefined): void {
    if (!route || !inst.emitters || !inst.program) return;
    for (const e of inst.emitters) {
      const i = inst.program.systems.indexOf(e.name);
      if (route.start.includes(i)) {
        e.system.looping = e.looping;
        e.system.restart();
        if (inst.state !== "playing") inst.state = "playing";
      } else if (route.stop.includes(i)) {
        e.system.looping = false;
        e.system.endEmit();
      }
    }
  }

  /** Seconds into the current cycle, for Play Time nodes (by the first system's duration). */
  private playTime(inst: Instance): number {
    const d = inst.program?.effect.emitters[0]?.duration ?? 0;
    return d > 0 ? inst.time % d : inst.time;
  }

  private emit(inst: Instance, count: number): void {
    if (!inst.emitters || count <= 0) return;
    for (const e of inst.emitters) {
      if (e.subEmitter) continue;
      const s = e.system as unknown as { spawn(n: number, state: unknown, m: Matrix4): void; emissionState: unknown };
      s.spawn(count, s.emissionState, e.system.emitter.matrixWorld);
    }
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

  private buildKey(program: ParticleProgram): string {
    const parts: string[] = [];
    for (const e of program.effect.emitters) {
      if (!e.enabled) continue;
      const m = this.host.material(e.renderer);
      const map = (m as (Material & { map?: { uuid: string } | null }) | null)?.map;
      parts.push(m ? `${m.uuid}:${map?.uuid ?? ""}` : "-");
      if (e.renderer.mode === "mesh") parts.push(this.host.geometry(e.renderer.mesh)?.uuid ?? "-");
    }
    return parts.join("|");
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }

  private disposeEmitters(inst: Instance): void {
    for (const e of inst.emitters ?? []) e.system.dispose();
    inst.emitters = null;
  }

  /** The batches' parent, for passes that must leave particles out. */
  get root(): Object3D {
    return this.batch;
  }

  /** Restart every previewed effect (the editor overlay's Restart). */
  restartAll(): void {
    for (const inst of this.instances.values()) if (inst.shown || !this.host.editor) this.applyState(inst, "restart");
  }

  release(c: ParticleSystem): void {
    const inst = this.instances.get(c);
    if (!inst) return;
    this.disposeEmitters(inst);
    this.instances.delete(c);
  }

  /** @internal Tests and the editor overlay: what's playing. */
  state(): { systems: number; emitters: number; particles: number; batches: number; previewed: { time: number; count: number } | null } {
    let emitters = 0;
    let particles = 0;
    let previewed: { time: number; count: number } | null = null;
    for (const inst of this.instances.values()) {
      const count = (inst.emitters ?? []).reduce((n, e) => n + e.system.particleNum, 0);
      emitters += inst.emitters?.length ?? 0;
      particles += count;
      if (inst.shown && !previewed) previewed = { time: inst.time, count };
    }
    return { systems: this.instances.size, emitters, particles, batches: this.batch.batches.length, previewed };
  }

  dispose(): void {
    for (const c of [...this.instances.keys()]) this.release(c);
    this.host.scene.remove(this.batch);
  }
}

const emitEnded = (s: QuarksSystem) => (s as unknown as { emitEnded: boolean }).emitEnded;
