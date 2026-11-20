// Internal (ADR 0094): the JavaScript kernel executor. Runs a `KernelSystem` over a Float32Array of
// particle state with closures (no `eval`, so it works under a strict CSP). It is the reference the
// WebGPU and WebGL2 executors are tested against, and the fallback when neither is available.
import {
  ATTR,
  KERNEL_FLOATS,
  LOCAL_WIDTH,
  LUT_SAMPLES,
  U,
  widthOf,
  type KExpr,
  type KLocal,
  type KStmt,
  type KernelSystem,
} from "../../../scene/particleKernel";
import { hsv, krand, particleSeed, srgbToLinear, valueNoise } from "./kernelMath";
import { KERNEL_STEPS, type StepFrame } from "./kernelSteps";

type Fn = () => Float64Array;

/** What compiled closures read: the particle being run and the system's buffers (the steps' frame). */
type Frame = StepFrame;

/** Drawn values of one particle and output. */
export interface OutputValues {
  color: number[];
  size: number;
  tile: number;
}

export class JsKernel {
  readonly state: Float32Array;
  readonly uniforms: Float32Array;
  readonly lut: Float32Array;
  private readonly f: Frame;
  private readonly init: (() => void)[];
  private readonly update: (() => void)[];
  private readonly outputs: (() => void)[][];
  private readonly spawnMask: Uint8Array;
  /**
   * Dead list (ADR 0126): free slots, a stack (`free[0..freeCount)`), when the system keeps one (not an
   * event child). Spawning pops; finished particles push. Null: 0094's ring.
   */
  private readonly free: Int32Array | null;
  private freeCount = 0;
  /**
   * Trail history (ADR 0126): `kernel.trail` blocks of the capacity, each slot's (position, seed) written
   * into block `frame % points` every step. Null without trail outputs.
   */
  readonly history: Float32Array | null;
  /** Particles alive after the last step (counted while stepping). */
  private aliveAfter = 0;

  constructor(
    readonly kernel: KernelSystem,
    opts: { deadList?: boolean } = {},
  ) {
    this.state = new Float32Array(kernel.capacity * KERNEL_FLOATS);
    this.uniforms = new Float32Array(kernel.uniformVec4 * 4);
    this.lut = new Float32Array(Math.max(1, kernel.luts.length) * LUT_SAMPLES * 4);
    const loc = {} as Record<KLocal, Float64Array>;
    for (const k of Object.keys(LOCAL_WIDTH) as KLocal[]) loc[k] = new Float64Array(LOCAL_WIDTH[k]);
    this.f = { s: this.state, o: 0, idx: 0, rel: 0, u: this.uniforms, lut: this.lut, loc, step: 0, dies: false, parent: null, capacity: kernel.capacity };
    this.init = kernel.init.map((s) => this.stmt(s));
    this.update = kernel.update.map((s) => this.stmt(s));
    this.outputs = kernel.outputs.map((o) => o.stmts.map((s) => this.stmt(s)));
    this.spawnMask = new Uint8Array(kernel.event ? kernel.capacity : 0);
    this.free = opts.deadList && !kernel.event ? new Int32Array(kernel.capacity) : null;
    this.history = kernel.trail ? new Float32Array(kernel.trail * kernel.capacity * 4) : null;
    this.clear();
  }

  /** Kill every particle. */
  clear(): void {
    this.state.fill(0);
    this.aliveAfter = 0;
    const free = this.free;
    if (!free) return;
    // Popped from the top, so slots fill from 0 up.
    const cap = this.kernel.capacity;
    for (let i = 0; i < cap; i++) free[i] = cap - 1 - i;
    this.freeCount = cap;
  }

  /** Whether spawning uses a dead list (else the ring). */
  get deadList(): boolean {
    return this.free !== null;
  }

  /** Particles alive (lifetime left) after the last step: exact. */
  get aliveCount(): number {
    return this.aliveAfter;
  }

  /** Advance one frame with the uniforms already written. `parent`: the event parent's executor, stepped this frame. */
  step(parent: JsKernel | null = null): void {
    const { state: s, uniforms: u, f } = this;
    const cap = this.kernel.capacity;
    const start = u[U.spawn * 4];
    const count = u[U.spawn * 4 + 1];
    const frame = u[U.spawn * 4 + 3];
    const seed = u[U.misc * 4 + 1];
    const dt = u[U.time * 4 + 1];
    const ev = this.kernel.event && parent ? this.eventMask(parent) : null;
    if (this.free) {
      this.stepDeadList(count, frame, seed, dt);
      this.writeHistory(frame);
      return;
    }
    let alive = 0;
    for (let idx = 0; idx < cap; idx++) {
      const o = idx * KERNEL_FLOATS;
      f.o = o;
      f.idx = idx;
      f.loc.index[0] = idx;
      f.rel = ev ? idx : (idx - start + cap) % cap;
      const spawn = ev ? ev[idx] === 1 : count > 0 && f.rel < count;
      if (spawn) {
        for (let i = 0; i < KERNEL_FLOATS; i++) s[o + i] = 0;
        s[o + 15] = particleSeed(idx, frame, seed);
        f.parent = ev && parent ? parent.parentMotion(Math.floor(idx / Math.max(1, u[U.misc * 4 + 2])), u) : null;
        f.loc.t[0] = 0;
        for (const run of this.init) run();
        if (s[o + 7] > 0) alive++;
        continue;
      }
      const life = s[o + 7];
      if (life < 0) {
        s[o + 7] = 0; // died last frame
        continue;
      }
      if (life === 0) continue;
      if (dt > 0) {
        f.step = dt;
        f.dies = false;
        f.loc.speedMod[0] = 1;
        for (const run of this.update) run();
        if (f.dies) s[o + 7] = -s[o + 7];
      }
      if (s[o + 7] > 0) alive++;
    }
    this.aliveAfter = alive;
    this.writeHistory(frame);
  }

  /** Trails: this frame's (position, seed) of every slot into the history. */
  private writeHistory(frame: number): void {
    const h = this.history;
    if (!h) return;
    const cap = this.kernel.capacity;
    const s = this.state;
    const base = (frame % this.kernel.trail!) * cap * 4;
    for (let i = 0; i < cap; i++) {
      const o = i * KERNEL_FLOATS;
      const d = base + i * 4;
      h[d] = s[o];
      h[d + 1] = s[o + 1];
      h[d + 2] = s[o + 2];
      h[d + 3] = s[o + 15];
    }
  }

  /** A step with the dead list: update every slot (finished ones go back on the list), then spawn into free slots. */
  private stepDeadList(count: number, frame: number, seed: number, dt: number): void {
    const { state: s, f } = this;
    const free = this.free!;
    const cap = this.kernel.capacity;
    let alive = 0;
    for (let idx = 0; idx < cap; idx++) {
      const o = idx * KERNEL_FLOATS;
      const life = s[o + 7];
      if (life < 0) {
        s[o + 7] = 0; // died last frame: free now
        free[this.freeCount++] = idx;
        continue;
      }
      if (life === 0) continue;
      if (dt > 0) {
        f.o = o;
        f.idx = idx;
        f.loc.index[0] = idx;
        f.step = dt;
        f.dies = false;
        f.loc.speedMod[0] = 1;
        for (const run of this.update) run();
        if (f.dies) s[o + 7] = -s[o + 7];
      }
      if (s[o + 7] > 0) alive++;
    }
    // A full system drops the rest of the frame's spawns (no oldest particle is replaced).
    for (let t = 0; t < count && this.freeCount > 0; t++) {
      const idx = free[--this.freeCount];
      const o = idx * KERNEL_FLOATS;
      f.o = o;
      f.idx = idx;
      f.rel = t;
      f.loc.index[0] = idx;
      for (let i = 0; i < KERNEL_FLOATS; i++) s[o + i] = 0;
      s[o + 15] = particleSeed(t, frame, seed);
      f.parent = null;
      f.loc.t[0] = 0;
      for (const run of this.init) run();
      if (s[o + 7] > 0) alive++;
      else s[o + 7] = -1e-20; // born without a lifetime: freed by the next step, as on the GPU
    }
    this.aliveAfter = alive;
  }

  /** The drawn values of particle `idx` through output `k` (what the draw shader computes). */
  output(idx: number, k: number, out: OutputValues = { color: [0, 0, 0, 0], size: 0, tile: 0 }): OutputValues {
    const { f, state: s } = this;
    const o = idx * KERNEL_FLOATS;
    f.o = o;
    f.idx = idx;
    f.loc.index[0] = idx;
    const life = s[o + 7];
    f.loc.t[0] = life > 0 ? Math.min(1, s[o + 3] / life) : 1;
    f.loc.speedMod[0] = 1;
    f.loc.oColor.set([s[o + 8], s[o + 9], s[o + 10], s[o + 11]]);
    f.loc.oSize[0] = s[o + 12];
    f.loc.oTile[0] = s[o + 14];
    for (const run of this.outputs[k] ?? []) run();
    out.color = Array.from(f.loc.oColor);
    out.size = Math.max(0, f.loc.oSize[0]);
    out.tile = f.loc.oTile[0];
    return out;
  }

  /** Alive (not dead, not dying). */
  alive(idx: number): boolean {
    const o = idx * KERNEL_FLOATS;
    return this.state[o + 7] > 0 && this.state[o + 3] < this.state[o + 7];
  }

  /** World position and velocity of particle `p` (for a child's event spawn). */
  private parentMotion(p: number, childU: Float32Array): Float64Array {
    const s = this.state;
    const o = p * KERNEL_FLOATS;
    const out = new Float64Array(6);
    const world = this.uniforms[U.flags * 4 + 2] === 1;
    const m = childU.subarray(U.matrix * 4, U.matrix * 4 + 16);
    for (let i = 0; i < 3; i++) {
      out[i] = world ? s[o + i] : m[i] * s[o] + m[4 + i] * s[o + 1] + m[8 + i] * s[o + 2] + m[12 + i];
      out[3 + i] = world ? s[o + 4 + i] : m[i] * s[o + 4] + m[4 + i] * s[o + 5] + m[8 + i] * s[o + 6];
    }
    return out;
  }

  /** Which child slots spawn from a parent's events this frame, decided on the state at the frame's start. */
  private eventMask(parent: JsKernel): Uint8Array {
    const u = this.uniforms;
    const mask = this.spawnMask;
    mask.fill(0);
    const k = Math.max(1, u[U.misc * 4 + 2]);
    const pcap = parent.kernel.capacity;
    const trigger = u[U.flags * 4];
    const n0 = u[U.event * 4];
    const prob = u[U.event * 4 + 1];
    const rate = u[U.event * 4 + 2];
    const frame = u[U.spawn * 4 + 3];
    const ps = parent.state;
    const s = this.state;
    for (let p = 0; p < pcap && p * k < this.kernel.capacity; p++) {
      const po = p * KERNEL_FLOATS;
      const life = ps[po + 7];
      const pseed = ps[po + 15];
      const fired = trigger === 0 ? life > 0 && ps[po + 3] === 0 : trigger === 1 ? life < 0 : life > 0;
      if (!fired || krand(pseed, trigger === 2 ? 7001 + frame : 7001) >= prob) continue;
      let n = n0;
      if (trigger === 2) n = Math.floor(rate) + (krand(pseed, 9001 + frame) < rate - Math.floor(rate) ? 1 : 0);
      for (let j = p * k; j < (p + 1) * k && j < this.kernel.capacity && n > 0; j++) {
        if (s[j * KERNEL_FLOATS + 7] <= 0) {
          mask[j] = 1;
          n--;
        }
      }
    }
    return mask;
  }

  // --- compiling ------------------------------------------------------------------------------------

  private expr(e: KExpr): Fn {
    const f = this.f;
    const w = widthOf(e);
    const out = new Float64Array(w);
    switch (e.k) {
      case "const":
        out.set(e.v);
        return () => out;
      case "uniform": {
        const base = e.slot * 4;
        return () => {
          for (let i = 0; i < w; i++) out[i] = f.u[base + i];
          return out;
        };
      }
      case "attr": {
        const [slot, comp] = ATTR[e.name];
        const off = slot * 4 + comp;
        return () => {
          for (let i = 0; i < w; i++) out[i] = f.s[f.o + off + i];
          return out;
        };
      }
      case "local": {
        if (e.name === "speed") {
          return () => {
            const s = f.s;
            const o = f.o;
            out[0] = Math.hypot(s[o + 4], s[o + 5], s[o + 6]) * f.loc.speedMod[0];
            return out;
          };
        }
        const name = e.name;
        return () => f.loc[name];
      }
      case "rand": {
        const salt = e.salt;
        return () => {
          out[0] = krand(f.s[f.o + 15], salt);
          return out;
        };
      }
      case "lut": {
        const t = this.expr(e.t);
        const base = e.row * LUT_SAMPLES * 4;
        return () => {
          const x = Math.min(1, Math.max(0, t()[0])) * (LUT_SAMPLES - 1);
          const i0 = Math.floor(x);
          const i1 = Math.min(LUT_SAMPLES - 1, i0 + 1);
          const fr = x - i0;
          for (let i = 0; i < w; i++) {
            const a = f.lut[base + i0 * 4 + i];
            out[i] = a + (f.lut[base + i1 * 4 + i] - a) * fr;
          }
          return out;
        };
      }
      case "swz": {
        const inner = this.expr(e.e);
        const i = e.i;
        return () => {
          const v = inner();
          out[0] = v[Math.min(i, v.length - 1)];
          return out;
        };
      }
      case "op":
        return this.op(e, out);
    }
  }

  private op(e: Extract<KExpr, { k: "op" }>, out: Float64Array): Fn {
    const args = e.args.map((a) => this.expr(a));
    const w = out.length;
    const at = (v: Float64Array, i: number) => (v.length === 1 ? v[0] : v[i]);
    const lift = (fn: (...x: number[]) => number): Fn => {
      if (args.length === 1) {
        const [a] = args;
        return () => {
          const x = a();
          for (let i = 0; i < w; i++) out[i] = fn(at(x, i));
          return out;
        };
      }
      if (args.length === 2) {
        const [a, b] = args;
        return () => {
          const x = a();
          const y = b();
          for (let i = 0; i < w; i++) out[i] = fn(at(x, i), at(y, i));
          return out;
        };
      }
      return () => {
        const vs = args.map((g) => g());
        for (let i = 0; i < w; i++) out[i] = fn(...vs.map((v) => at(v, i)));
        return out;
      };
    };
    switch (e.op) {
      case "add":
        return lift((a, b) => a + b);
      case "sub":
        return lift((a, b) => a - b);
      case "mul":
        return lift((a, b) => a * b);
      case "div":
        return lift((a, b) => (b === 0 ? 0 : a / b));
      case "neg":
        return lift((a) => -a);
      case "abs":
        return lift(Math.abs);
      case "min":
        return lift(Math.min);
      case "max":
        return lift(Math.max);
      case "clamp":
        return lift((x, lo, hi) => Math.min(Math.max(x, lo), hi));
      case "lerp":
        return lift((a, b, t) => a + (b - a) * t);
      case "remap":
        return lift((x, a, b, c, d) => (b === a ? c : c + ((x - a) / (b - a)) * (d - c)));
      case "step":
        return lift((edge, x) => (x >= edge ? 1 : 0));
      case "smoothstep":
        return lift((e0, e1, x) => {
          if (e0 === e1) return x >= e0 ? 1 : 0;
          const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
          return t * t * (3 - 2 * t);
        });
      case "sin":
        return lift(Math.sin);
      case "cos":
        return lift(Math.cos);
      case "noise1": {
        const seed = e.seed ?? 0;
        return lift((x) => valueNoise(x, seed));
      }
      case "toLinear":
        return () => {
          const v = args[0]();
          for (let i = 0; i < w; i++) out[i] = i < 3 ? srgbToLinear(v[i]) : v[i];
          return out;
        };
      case "vec":
        return () => {
          let k = 0;
          for (const g of args) for (const x of g()) out[k++] = x;
          return out;
        };
      case "length":
        return () => {
          const v = args[0]();
          let s = 0;
          for (const x of v) s += x * x;
          out[0] = Math.sqrt(s);
          return out;
        };
      case "normalize":
        return () => {
          const v = args[0]();
          let s = 0;
          for (const x of v) s += x * x;
          const len = Math.sqrt(s);
          for (let i = 0; i < w; i++) out[i] = len === 0 ? 0 : v[i] / len;
          return out;
        };
      case "hsv":
        return () => {
          const [h, s, v, a] = args.map((g) => g()[0]);
          out.set(hsv(h, s, v, a));
          return out;
        };
    }
  }

  private stmt(st: KStmt): () => void {
    const f = this.f;
    if (st.s === "set") {
      const e = this.expr(st.e);
      const mode = st.mode;
      if ("attr" in st.target) {
        const [slot, comp, w] = ATTR[st.target.attr];
        const off = slot * 4 + comp;
        return () => {
          const v = e();
          const s = f.s;
          for (let i = 0; i < w; i++) {
            const x = v.length === 1 ? v[0] : (v[i] ?? 0);
            const j = f.o + off + i;
            s[j] = mode === "set" ? x : mode === "add" ? s[j] + x : s[j] * x;
          }
        };
      }
      const name = st.target.local;
      return () => {
        const v = e();
        const t = f.loc[name];
        for (let i = 0; i < t.length; i++) {
          const x = v.length === 1 ? v[0] : (v[i] ?? 0);
          t[i] = mode === "set" ? x : mode === "add" ? t[i] + x : t[i] * x;
        }
      };
    }
    const args = st.args.map((a) => this.expr(a));
    if (st.b === "depth") return () => {}; // needs the scene's depth texture: GPU executors only
    const step = KERNEL_STEPS[st.b];
    const vals: Float64Array[] = new Array(args.length);
    const n = args.length;
    return () => {
      for (let i = 0; i < n; i++) vals[i] = args[i]();
      step.js(f, vals, st);
    };
  }
}
