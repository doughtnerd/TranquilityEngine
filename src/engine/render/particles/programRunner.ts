// Internal (ADR 0060): runs a compiled particle program's bindings for one playing effect, for the
// particle renderer and the editor's effect preview. Live bindings write boxes the quarks
// generators read every frame; the others are baked into the settings the effect is built from,
// and a change asks for a rebuild.
import type { GraphInputValue } from "../../scene/particleGraph";
import type { ParticleBinding, ParticleProgram } from "../../scene/particleCompile";
import type { EvalContext, NodeValue } from "../../scene/particleNodes";
import { hexColor, type ParticleEffect } from "../../scene/particles";
import { linearRGB, type LiveBox } from "./quarksEffect";

export class ProgramRunner {
  private readonly boxes = new Map<string, LiveBox>();
  /** Each non-live binding's value as baked into the last built effect (JSON). */
  private readonly baked = new Map<ParticleBinding, string>();
  private properties = new Map<string, GraphInputValue>();
  private readonly ctx: EvalContext = { time: 0, deltaTime: 0, playTime: 0, properties: this.properties, random: Math.random };

  constructor(readonly program: ParticleProgram) {
    for (const b of program.bindings) if (b.live) this.boxes.set(`${b.emitter}:${b.path}`, { value: b.kind === "color" ? [1, 1, 1, 1] : 0 });
  }

  /** An instance's property overrides (`ParticleSystem.overrides`); applied on the next `update`. */
  setOverrides(overrides: Readonly<Record<string, unknown>>): void {
    const next = new Map<string, GraphInputValue>();
    for (const name of this.program.properties) if (overrides[name] !== undefined) next.set(name, overrides[name] as GraphInputValue);
    this.properties = next;
    this.ctx.properties = next;
  }

  /** For `EffectContext.live`. */
  live = (emitter: number, path: string): LiveBox | undefined => this.boxes.get(`${emitter}:${path}`);

  /** The settings to build from: the program's, with the non-live bindings' current values. */
  effect(): ParticleEffect {
    const effect = structuredClone(this.program.effect);
    for (const b of this.program.bindings) {
      if (b.live) continue;
      const value = this.value(b);
      this.baked.set(b, JSON.stringify(value));
      if (value !== undefined) setPath(effect.emitters[b.emitter], b.path, value);
    }
    this.update(0, 0, 0);
    return effect;
  }

  /**
   * Evaluate the live bindings into their boxes; with `checkBaked`, also the others, returning true
   * when one changed since the effect was built (so it needs rebuilding).
   */
  update(time: number, deltaTime: number, playTime: number, checkBaked = false): boolean {
    this.ctx.time = time;
    this.ctx.deltaTime = deltaTime;
    this.ctx.playTime = playTime;
    let stale = false;
    for (const b of this.program.bindings) {
      if (b.live) {
        const v = this.evaluate(b);
        if (v === undefined) continue;
        const box = this.boxes.get(`${b.emitter}:${b.path}`)!;
        if (b.kind === "color" && Array.isArray(v)) box.value = [...linearRGB(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1), v[3] ?? 1];
        else if (typeof v === "number") box.value = v;
      } else if (checkBaked && JSON.stringify(this.value(b)) !== this.baked.get(b)) {
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

  /** A binding's value as a settings value: colours as `#rrggbbaa`. */
  private value(b: ParticleBinding): unknown {
    const v = this.evaluate(b);
    if (b.kind === "color" && Array.isArray(v)) return hexColor(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1, v[3] ?? 1);
    return v;
  }
}

/** Set `path` (`shape.radius`, `behaviors.2.size`, `emission.bursts.0.count`) in `target`. */
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
