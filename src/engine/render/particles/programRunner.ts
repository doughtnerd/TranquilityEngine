// Internal (ADR 0060, 0251): runs a compiled particle program's spawn bindings for one playing effect,
// and keeps the evaluation context (time, properties) the kernels evaluate their own bindings with.
// Live bindings write boxes the spawners read every frame; the others are baked into the spawn
// settings the effect is built from, and a change asks for a rebuild.
import type { GraphInputValue } from "../../scene/particleGraph";
import type { ParticleBinding, ParticleProgram, SpawnSettings } from "../../scene/particleCompile";
import type { EvalContext, NodeValue } from "../../scene/particleNodes";
import type { LiveBox } from "./gpu/spawner";

export class ProgramRunner {
  private readonly boxes = new Map<string, LiveBox>();
  /** Each non-live binding's value as baked into the last built effect (JSON). */
  private readonly baked = new Map<ParticleBinding, string>();
  private properties = new Map<string, GraphInputValue>();
  private readonly ctx: EvalContext;

  /** `random` feeds the graph's random nodes (default `Math.random`); pass the effect's seeded generator for deterministic runs. */
  constructor(
    readonly program: ParticleProgram,
    random: () => number = Math.random,
  ) {
    this.ctx = { time: 0, deltaTime: 0, playTime: 0, properties: this.properties, random };
    for (const b of program.bindings) if (b.live) this.boxes.set(`${b.emitter}:${b.path}`, { value: 0 });
  }

  /** An instance's property overrides (`ParticleSystem.overrides`); applied on the next `update`. */
  setOverrides(overrides: Readonly<Record<string, unknown>>): void {
    const next = new Map<string, GraphInputValue>();
    for (const name of this.program.properties) if (overrides[name] !== undefined) next.set(name, overrides[name] as GraphInputValue);
    this.properties = next;
    this.ctx.properties = next;
  }

  /** The evaluation context of the last `update` (time, properties): kernel backends evaluate their own bindings with it (ADR 0094). */
  get context(): EvalContext {
    return this.ctx;
  }

  /** The live value of system `emitter`'s spawn setting `path`, for its spawner. */
  live = (emitter: number, path: string): LiveBox | undefined => this.boxes.get(`${emitter}:${path}`);

  /** The spawn settings to build from: the program's, with the non-live bindings' current values. */
  spawns(): SpawnSettings[] {
    const spawns = structuredClone(this.program.spawns);
    for (const b of this.program.bindings) {
      if (b.live) continue;
      const value = this.evaluate(b);
      this.baked.set(b, JSON.stringify(value));
      if (value !== undefined) setPath(spawns[b.emitter], b.path, value);
    }
    this.update(0, 0, () => 0);
    return spawns;
  }

  /**
   * Evaluate the live bindings into their boxes; with `checkBaked`, also the others, returning true
   * when one changed since the effect was built (so it needs rebuilding). `playTime` gives the Play
   * Time node's value for a system (an index into `program.spawns`): see `playTimes`.
   */
  update(time: number, deltaTime: number, playTime: (emitter: number) => number, checkBaked = false): boolean {
    this.ctx.time = time;
    this.ctx.deltaTime = deltaTime;
    let stale = false;
    for (const b of this.program.bindings) {
      this.ctx.playTime = playTime(b.emitter);
      if (b.live) {
        const v = this.evaluate(b);
        if (typeof v === "number") this.boxes.get(`${b.emitter}:${b.path}`)!.value = v;
      } else if (checkBaked && JSON.stringify(this.evaluate(b)) !== this.baked.get(b)) {
        stale = true;
      }
    }
    return stale;
  }

  private evaluate(b: ParticleBinding): NodeValue | undefined {
    try {
      return b.evaluate(this.ctx);
    } catch {
      return undefined; // an override of the wrong type: keep the last value
    }
  }
}

/** Each system's Play Time at `time`: seconds into its own cycle (`time` modulo its duration, or `time` itself when it has none). */
export function playTimes(program: ParticleProgram, time: number): (emitter: number) => number {
  return (emitter) => {
    const d = program.spawns[emitter]?.duration ?? 0;
    return d > 0 ? time % d : time;
  };
}

/** Set `path` (`emission.rateOverTime`, `emission.bursts.0.count`) in `target`. */
function setPath(target: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = target as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    const next = o?.[k];
    if (!next || typeof next !== "object") return;
    o = next as Record<string, unknown>;
  }
  if (o) o[keys[keys.length - 1]] = value;
}
