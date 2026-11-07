// Internal (ADR 0094): spawning for kernel systems stays on the CPU. Each frame a spawner turns an
// emitter's rate, rate over distance, bursts, start delay, duration, looping and prewarm into a count;
// the new particles take the next slots of a ring over the capacity. It mirrors the CPU
// simulation's `advanceEmission`, without per-particle spawn times (a frame's particles all start
// at its end) and with a ring instead of a free list (a full system replaces its oldest slots).
import { evalCurve, type ParticleEmitterSettings, type ParticleNumber } from "../../../scene/particles";
import type { LiveBox } from "../simulation";

export interface SpawnResult {
  /** First slot of this frame's spawn (in the ring). */
  start: number;
  count: number;
  /** Fraction through the spawn cycle at the frame's start (start values are read there). */
  frac: number;
  /** Particles spawned before this frame (shape loop and ping-pong modes). */
  before: number;
}

/** A number value at cycle fraction `t` (a random range takes `u`). */
function evalNumber(v: ParticleNumber, t: number, u: number): number {
  if (typeof v === "number") return v;
  if ("random" in v) return v.random[0] + (v.random[1] - v.random[0]) * u;
  if ("curve" in v) return evalCurve(v.curve, t);
  const a = evalCurve(v.randomCurves[0], t);
  return a + (evalCurve(v.randomCurves[1], t) - a) * u;
}

/** The largest a number value can be (for the alive estimate). */
export function maxOf(v: ParticleNumber): number {
  if (typeof v === "number") return v;
  if ("random" in v) return Math.max(v.random[0], v.random[1]);
  const keys = "curve" in v ? v.curve : [...v.randomCurves[0], ...v.randomCurves[1]];
  return keys.reduce((m, k) => Math.max(m, k[1]), 0);
}

export class KernelSpawner {
  private time = 0;
  private accum = 0;
  private distAccum = 0;
  private burstNext: Int32Array;
  private delayLeft: number;
  private last: [number, number, number] | null = null;
  private head = 0;
  private spawned = 0;
  /** Recent spawns (age in seconds, count) for the alive estimate. */
  private history: { age: number; count: number }[] = [];
  /** No more emission (a one-shot cycle ended, or stopped). */
  done = false;
  /** Prewarm still to run (looping systems with prewarm). */
  prewarmPending: boolean;

  constructor(
    public settings: ParticleEmitterSettings,
    readonly capacity: number,
    /** Live values (`emission.rateOverTime`…) the program's bindings update each frame. */
    private readonly live: (path: string) => LiveBox | undefined = () => undefined,
  ) {
    this.burstNext = new Int32Array(settings.emission.bursts.length);
    this.delayLeft = settings.startDelay;
    this.prewarmPending = settings.looping && settings.prewarm;
  }

  /** New settings (non-live bindings rebaked) without losing the cycle. */
  setSettings(settings: ParticleEmitterSettings): void {
    this.settings = settings;
    if (this.burstNext.length !== settings.emission.bursts.length) this.burstNext = new Int32Array(settings.emission.bursts.length);
  }

  restart(): void {
    this.time = 0;
    this.accum = 0;
    this.distAccum = 0;
    this.burstNext.fill(0);
    this.delayLeft = this.settings.startDelay;
    this.last = null;
    this.done = false;
    this.history = [];
    this.prewarmPending = this.settings.looping && this.settings.prewarm;
  }

  /** Stop emitting (live particles finish). */
  stop(): void {
    this.done = true;
  }

  /** Everything died at once (`clear`). */
  cleared(): void {
    this.history = [];
  }

  private value(path: string, v: ParticleNumber, t: number, rnd: () => number): number {
    const box = this.live(path);
    if (box) return typeof box.value === "number" ? box.value : (box.value[0] ?? 0);
    return evalNumber(v, t, rnd());
  }

  /** Advance `dt` seconds with the node at `origin` (world); `extra` particles are added (`ParticleSystem.emit`). */
  advance(dt: number, origin: readonly number[], scale: number, rnd: () => number, extra = 0): SpawnResult {
    const s = this.settings;
    const dur = Math.max(1e-3, s.duration);
    const frac = this.time / dur;
    let count = extra;
    const o: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const dist = this.last ? Math.hypot(o[0] - this.last[0], o[1] - this.last[1], o[2] - this.last[2]) : 0;
    this.last = o;
    let left = dt;
    if (this.delayLeft > 0) {
      const used = Math.min(this.delayLeft, left);
      this.delayLeft -= used;
      left -= used;
    }
    for (let guard = 0; !this.done && left > 1e-9 && guard < 256; guard++) {
      const t0 = this.time;
      const seg = Math.min(left, Math.max(1e-9, dur - t0));
      const t1 = t0 + seg;
      const f = t0 / dur;
      const rate = this.value("emission.rateOverTime", s.emission.rateOverTime, f, rnd) * scale;
      if (rate > 0) {
        this.accum += rate * seg;
        const n = Math.floor(this.accum);
        this.accum -= n;
        count += n;
      }
      if (dist > 0) {
        const rod = this.value("emission.rateOverDistance", s.emission.rateOverDistance, f, rnd) * scale;
        if (rod > 0) {
          this.distAccum += rod * dist * (seg / Math.max(1e-9, dt));
          const n = Math.floor(this.distAccum);
          this.distAccum -= n;
          count += n;
        }
      }
      s.emission.bursts.forEach((b, bi) => {
        let k = this.burstNext[bi];
        while (k < b.cycles) {
          const ft = b.time + k * b.interval;
          if (ft >= t1) break;
          k++;
          if (!(b.probability >= 1 || rnd() < b.probability)) continue;
          count += Math.max(0, Math.round(this.value(`emission.bursts.${bi}.count`, b.count, ft / dur, rnd) * scale));
        }
        this.burstNext[bi] = k;
      });
      this.time = t1;
      left -= seg;
      if (this.time >= dur - 1e-9) {
        if (s.looping) {
          this.time = 0;
          this.burstNext.fill(0);
        } else this.done = true;
      }
    }
    count = Math.min(count, this.capacity);
    const start = this.head;
    const before = this.spawned;
    this.head = (this.head + count) % this.capacity;
    this.spawned += count;
    // Alive estimate history.
    for (const h of this.history) h.age += dt;
    if (count > 0) this.history.push({ age: 0, count });
    const maxLife = Math.max(0.001, maxOf(s.startLife));
    while (this.history.length && this.history[0].age > maxLife) this.history.shift();
    return { start, count, frac, before };
  }

  /** About how many particles are alive (spawned within the longest lifetime), at most the capacity. */
  get estimate(): number {
    let n = 0;
    for (const h of this.history) n += h.count;
    return Math.min(n, this.capacity);
  }

  /** Can still emit (not done, or particles may be alive). */
  get emitting(): boolean {
    return !this.done;
  }
}
