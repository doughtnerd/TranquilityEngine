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
import { hsv, krand, noise3, particleSeed, srgbToLinear, valueNoise } from "./kernelMath";

const DEG = Math.PI / 180;
const GRAVITY = 9.81;

type Fn = () => Float64Array;

/** What compiled closures read: the particle being run and the system's buffers. */
interface Frame {
  s: Float32Array;
  /** Float offset of the particle (index × 16). */
  o: number;
  idx: number;
  u: Float32Array;
  lut: Float32Array;
  loc: Record<KLocal, Float64Array>;
  /** Update: the time step this particle advances (shorter when it dies this frame). */
  step: number;
  dies: boolean;
  /** Init from an event: the parent's world position and velocity. */
  parent: Float64Array | null;
}

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

  constructor(readonly kernel: KernelSystem) {
    this.state = new Float32Array(kernel.capacity * KERNEL_FLOATS);
    this.uniforms = new Float32Array(kernel.uniformVec4 * 4);
    this.lut = new Float32Array(Math.max(1, kernel.luts.length) * LUT_SAMPLES * 4);
    const loc = {} as Record<KLocal, Float64Array>;
    for (const k of Object.keys(LOCAL_WIDTH) as KLocal[]) loc[k] = new Float64Array(LOCAL_WIDTH[k]);
    this.f = { s: this.state, o: 0, idx: 0, u: this.uniforms, lut: this.lut, loc, step: 0, dies: false, parent: null };
    this.init = kernel.init.map((s) => this.stmt(s));
    this.update = kernel.update.map((s) => this.stmt(s));
    this.outputs = kernel.outputs.map((o) => o.stmts.map((s) => this.stmt(s)));
    this.spawnMask = new Uint8Array(kernel.event ? kernel.capacity : 0);
  }

  /** Kill every particle. */
  clear(): void {
    this.state.fill(0);
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
    for (let idx = 0; idx < cap; idx++) {
      const o = idx * KERNEL_FLOATS;
      f.o = o;
      f.idx = idx;
      f.loc.index[0] = idx;
      const spawn = ev ? ev[idx] === 1 : count > 0 && (idx - start + cap) % cap < count;
      if (spawn) {
        for (let i = 0; i < KERNEL_FLOATS; i++) s[o + i] = 0;
        s[o + 15] = particleSeed(idx, frame, seed);
        f.parent = ev && parent ? parent.parentMotion(Math.floor(idx / Math.max(1, u[U.misc * 4 + 2])), u) : null;
        f.loc.t[0] = 0;
        for (const run of this.init) run();
        continue;
      }
      const life = s[o + 7];
      if (life < 0) {
        s[o + 7] = 0; // died last frame
        continue;
      }
      if (life === 0 || dt <= 0) continue;
      f.step = dt;
      f.dies = false;
      f.loc.speedMod[0] = 1;
      for (const run of this.update) run();
      if (f.dies) s[o + 7] = -s[o + 7];
    }
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
    const u = this.uniforms;
    switch (st.b) {
      case "shape":
        return this.shape(st, args);
      case "place":
        return () => this.place(args[0](), args[1]()[0], st);
      case "age":
        return () => {
          const s = f.s;
          const o = f.o;
          const life = s[o + 7];
          let step = f.step;
          if (s[o + 3] + step >= life) {
            step = Math.max(0, life - s[o + 3]);
            f.dies = true;
          }
          s[o + 3] += step;
          f.step = step;
          f.loc.t[0] = Math.min(1, s[o + 3] / life);
        };
      case "gravity":
        return () => {
          const g = args[0]()[0] * GRAVITY * f.step;
          if (g === 0) return;
          const s = f.s;
          const o = f.o;
          if (u[U.flags * 4 + 2] === 1) s[o + 5] -= g;
          else {
            // Down in the node's space: the inverse matrix's rotation of (0, -1, 0), normalised.
            const iv = U.inverse * 4;
            let x = -u[iv + 4];
            let y = -u[iv + 5];
            let z = -u[iv + 6];
            const len = Math.hypot(x, y, z) || 1;
            x /= len;
            y /= len;
            z /= len;
            s[o + 4] += x * g;
            s[o + 5] += y * g;
            s[o + 6] += z * g;
          }
        };
      case "force":
        return () => {
          const v = args[0]();
          for (let i = 0; i < 3; i++) f.s[f.o + 4 + i] += v[i] * f.step;
        };
      case "gpoint":
        return () => {
          const c = args[0]();
          const strength = args[1]()[0];
          const s = f.s;
          const o = f.o;
          const dx = c[0] - s[o];
          const dy = c[1] - s[o + 1];
          const dz = c[2] - s[o + 2];
          const len = Math.hypot(dx, dy, dz);
          if (len < 1e-6) return;
          const a = (strength / Math.max(len * len, 0.0625)) * f.step;
          s[o + 4] += (dx / len) * a;
          s[o + 5] += (dy / len) * a;
          s[o + 6] += (dz / len) * a;
        };
      case "turbulence":
        return () => {
          const sc = args[0]();
          const oct = Math.max(1, Math.min(4, Math.round(args[1]()[0])));
          const vel = args[2]();
          const ts = args[3]();
          const s = f.s;
          const o = f.o;
          const time = u[U.time * 4];
          const x = s[o] / (sc[0] || 1);
          const y = s[o + 1] / (sc[1] || 1);
          const z = s[o + 2] / (sc[2] || 1);
          let nx = 0;
          let ny = 0;
          let nz = 0;
          let lvl = 1;
          for (let i = 0; i < oct; i++) {
            nx += noise3(x * lvl + time * ts[0] * lvl, y * lvl, z * lvl) / lvl;
            ny += noise3(x * lvl + 31.7, y * lvl + time * ts[1] * lvl, z * lvl) / lvl;
            nz += noise3(x * lvl, y * lvl + 17.3, z * lvl + time * ts[2] * lvl) / lvl;
            lvl *= 2;
          }
          s[o + 4] += nx * vel[0] * f.step;
          s[o + 5] += ny * vel[1] * f.step;
          s[o + 6] += nz * vel[2] * f.step;
        };
      case "limit":
        return () => {
          const limit = args[0]()[0];
          const dampen = args[1]()[0];
          const s = f.s;
          const o = f.o;
          const speed = Math.hypot(s[o + 4], s[o + 5], s[o + 6]);
          if (speed <= limit || speed < 1e-9) return;
          const k = 1 - Math.pow(1 - Math.min(1, Math.max(0, dampen)), f.step * 60);
          const m = 1 + k * (Math.max(0, limit) / speed - 1);
          s[o + 4] *= m;
          s[o + 5] *= m;
          s[o + 6] *= m;
        };
      case "integrate":
        return () => {
          const k = f.loc.speedMod[0] * f.step;
          const s = f.s;
          const o = f.o;
          s[o] += s[o + 4] * k;
          s[o + 1] += s[o + 5] * k;
          s[o + 2] += s[o + 6] * k;
        };
      case "noise": {
        const index = st.index ?? 0;
        return () => {
          const freq = args[0]()[0];
          const power = args[1]()[0];
          const pa = args[2]()[0];
          const ra = args[3]()[0];
          const s = f.s;
          const o = f.o;
          const seed = s[o + 15];
          const now = s[o + 3] * freq;
          const before = (s[o + 3] - f.step) * freq;
          const off = (i: number) => krand(seed, 3000 + index * 8 + i) * 100;
          if (pa > 0) for (let i = 0; i < 3; i++) s[o + i] += (noise3(off(i) + now, 0.5, 0) - noise3(off(i) + before, 0.5, 0)) * power * pa;
          if (ra > 0) s[o + 13] += (noise3(off(3) + now, 0.5, 0) - noise3(off(3) + before, 0.5, 0)) * Math.PI * power * ra;
        };
      }
      case "orbit":
        return () => {
          let [ax, ay, az] = args[1]();
          let cx = 0;
          let cy = 0;
          let cz = 0;
          const m = U.matrix * 4;
          if (u[U.flags * 4 + 2] === 1) {
            const rx = u[m] * ax + u[m + 4] * ay + u[m + 8] * az;
            const ry = u[m + 1] * ax + u[m + 5] * ay + u[m + 9] * az;
            const rz = u[m + 2] * ax + u[m + 6] * ay + u[m + 10] * az;
            ax = rx;
            ay = ry;
            az = rz;
            cx = u[m + 12];
            cy = u[m + 13];
            cz = u[m + 14];
          }
          const len = Math.hypot(ax, ay, az);
          if (len < 1e-9) return;
          ax /= len;
          ay /= len;
          az /= len;
          const angle = args[0]()[0] * DEG * f.step;
          const s = f.s;
          const o = f.o;
          const rx = s[o] - cx;
          const ry = s[o + 1] - cy;
          const rz = s[o + 2] - cz;
          const dot = rx * ax + ry * ay + rz * az;
          const c = Math.cos(angle);
          const sn = Math.sin(angle);
          s[o] = cx + rx * c + (ay * rz - az * ry) * sn + ax * dot * (1 - c);
          s[o + 1] = cy + ry * c + (az * rx - ax * rz) * sn + ay * dot * (1 - c);
          s[o + 2] = cz + rz * c + (ax * ry - ay * rx) * sn + az * dot * (1 - c);
        };
      case "plane":
        return () => {
          const h = args[0]()[0];
          const s = f.s;
          const o = f.o;
          if (s[o + 1] >= h) return;
          if (args[2]()[0] > 0.5) {
            f.dies = true;
            s[o + 3] = s[o + 7];
            return;
          }
          s[o + 1] = h;
          if (s[o + 5] < 0) s[o + 5] = -s[o + 5] * args[1]()[0];
        };
      case "depth":
        return () => {}; // needs the scene's depth texture: GPU executors only
      case "spin":
        return () => {
          f.s[f.o + 13] += args[0]()[0] * DEG * f.step;
        };
    }
  }

  /** Init: sample the spawn shape into `spos`/`sdir` (as the CPU simulation's `sampleShape`). */
  private shape(st: Extract<KStmt, { s: "builtin" }>, args: Fn[]): () => void {
    const f = this.f;
    const type = st.shape?.type ?? "point";
    const mode = st.shape?.mode ?? "random";
    const u = this.uniforms;
    return () => {
      const [radius, angle, arc, thickness, width, height, donutRadius, columns, rows, spread] = args.map((g) => g()[0]);
      const seed = f.s[f.o + 15];
      const r = (k: number) => krand(seed, 900 + k);
      const p = f.loc.spos;
      const d = f.loc.sdir;
      p.fill(0);
      d[0] = 0;
      d[1] = 1;
      d[2] = 0;
      // u along the arc: random, or by spawn order for loop/ping-pong/burst.
      let uu = r(0);
      if (mode !== "random") {
        const cap = this.kernel.capacity;
        const ordinal = u[U.misc * 4] + ((f.idx - u[U.spawn * 4] + cap) % cap);
        const n = Math.max(1, u[U.spawn * 4 + 1]);
        if (mode === "burst") uu = ((f.idx - u[U.spawn * 4] + cap) % cap) / n;
        else {
          const x = spread > 0 ? ordinal * spread : ordinal / Math.max(1, cap);
          uu = mode === "loop" ? x - Math.floor(x) : ((m) => (m < 1 ? m : 2 - m))(x - 2 * Math.floor(x / 2));
        }
      }
      const theta = uu * arc * DEG;
      const th = Math.min(1, Math.max(0, thickness));
      const inner = 1 - th;
      switch (type) {
        case "sphere":
        case "hemisphere": {
          const cosP = type === "sphere" ? 2 * r(1) - 1 : r(1);
          const sinP = Math.sqrt(Math.max(0, 1 - cosP * cosP));
          const dx = sinP * Math.cos(theta);
          const dz = sinP * Math.sin(theta);
          const rr = radius * Math.cbrt(inner * inner * inner + r(2) * (1 - inner * inner * inner));
          p[0] = dx * rr;
          p[1] = cosP * rr;
          p[2] = dz * rr;
          d[0] = dx;
          d[1] = cosP;
          d[2] = dz;
          break;
        }
        case "cone": {
          const rr = Math.sqrt(inner * inner + r(1) * (1 - inner * inner));
          p[0] = Math.cos(theta) * radius * rr;
          p[2] = Math.sin(theta) * radius * rr;
          const ang = angle * DEG * (radius > 0 ? rr : Math.sqrt(r(2)));
          d[0] = Math.sin(ang) * Math.cos(theta);
          d[1] = Math.cos(ang);
          d[2] = Math.sin(ang) * Math.sin(theta);
          break;
        }
        case "circle": {
          const rr = Math.sqrt(inner * inner + r(1) * (1 - inner * inner));
          p[0] = Math.cos(theta) * radius * rr;
          p[2] = Math.sin(theta) * radius * rr;
          if (rr > 0 && radius > 0) {
            d[0] = Math.cos(theta);
            d[1] = 0;
            d[2] = Math.sin(theta);
          }
          break;
        }
        case "donut": {
          const cx = Math.cos(theta);
          const cz = Math.sin(theta);
          const psi = r(1) * Math.PI * 2;
          const tr = donutRadius * Math.sqrt(inner * inner + r(2) * (1 - inner * inner));
          const ox = tr * Math.cos(psi) * cx;
          const oy = tr * Math.sin(psi);
          const oz = tr * Math.cos(psi) * cz;
          p[0] = cx * radius + ox;
          p[1] = oy;
          p[2] = cz * radius + oz;
          const len = Math.hypot(ox, oy, oz);
          if (len > 1e-9) {
            d[0] = ox / len;
            d[1] = oy / len;
            d[2] = oz / len;
          } else {
            d[0] = cx;
            d[1] = 0;
            d[2] = cz;
          }
          break;
        }
        case "rectangle": {
          let x = uu - 0.5;
          let z = r(1) - 0.5;
          if (th < 1) {
            const ix = 0.5 * inner;
            if (Math.abs(x) < ix && Math.abs(z) < ix) {
              if (0.5 - Math.abs(x) < 0.5 - Math.abs(z)) x = Math.sign(x || 1) * 0.5;
              else z = Math.sign(z || 1) * 0.5;
            }
          }
          p[0] = x * width;
          p[2] = z * height;
          break;
        }
        case "grid": {
          const cols = Math.max(1, Math.round(columns));
          const rws = Math.max(1, Math.round(rows));
          const i = mode === "random" ? Math.floor(r(1) * cols * rws) : Math.min(cols * rws - 1, Math.floor(uu * cols * rws));
          p[0] = (((i % cols) + 0.5) / cols - 0.5) * width;
          p[2] = ((Math.floor(i / cols) + 0.5) / rws - 0.5) * height;
          break;
        }
        default:
      }
      if (st.rotation !== undefined) {
        const b = st.rotation * 4;
        const R = u;
        const rot = (v: Float64Array) => {
          const x = v[0];
          const y = v[1];
          const z = v[2];
          v[0] = R[b] * x + R[b + 1] * y + R[b + 2] * z;
          v[1] = R[b + 4] * x + R[b + 5] * y + R[b + 6] * z;
          v[2] = R[b + 8] * x + R[b + 9] * y + R[b + 10] * z;
        };
        rot(p);
        rot(d);
      }
    };
  }

  /** Init: position and velocity from the shape sample, the node (or the parent particle) and the space. */
  private place(offset: Float64Array, speed: number, _st: unknown): void {
    const f = this.f;
    const u = this.uniforms;
    const s = f.s;
    const o = f.o;
    const p = f.loc.spos;
    const d = f.loc.sdir;
    const nx = p[0] + offset[0];
    const ny = p[1] + offset[1];
    const nz = p[2] + offset[2];
    const world = u[U.flags * 4 + 2] === 1;
    if (!world && !f.parent) {
      s[o] = nx;
      s[o + 1] = ny;
      s[o + 2] = nz;
      s[o + 4] = d[0] * speed;
      s[o + 5] = d[1] * speed;
      s[o + 6] = d[2] * speed;
      return;
    }
    const m = U.matrix * 4;
    const ox = f.parent ? f.parent[0] : u[m + 12];
    const oy = f.parent ? f.parent[1] : u[m + 13];
    const oz = f.parent ? f.parent[2] : u[m + 14];
    const wx = u[m] * nx + u[m + 4] * ny + u[m + 8] * nz + ox;
    const wy = u[m + 1] * nx + u[m + 5] * ny + u[m + 9] * nz + oy;
    const wz = u[m + 2] * nx + u[m + 6] * ny + u[m + 10] * nz + oz;
    let vx = u[m] * d[0] + u[m + 4] * d[1] + u[m + 8] * d[2];
    let vy = u[m + 1] * d[0] + u[m + 5] * d[1] + u[m + 9] * d[2];
    let vz = u[m + 2] * d[0] + u[m + 6] * d[1] + u[m + 10] * d[2];
    const len = Math.hypot(vx, vy, vz);
    const k = len > 1e-9 ? speed / len : 0;
    vx *= k;
    vy *= k;
    vz *= k;
    if (f.parent && u[U.event * 4 + 3] === 1) {
      vx += f.parent[3];
      vy += f.parent[4];
      vz += f.parent[5];
    }
    if (world) {
      s[o] = wx;
      s[o + 1] = wy;
      s[o + 2] = wz;
      s[o + 4] = vx;
      s[o + 5] = vy;
      s[o + 6] = vz;
      return;
    }
    const iv = U.inverse * 4;
    s[o] = u[iv] * wx + u[iv + 4] * wy + u[iv + 8] * wz + u[iv + 12];
    s[o + 1] = u[iv + 1] * wx + u[iv + 5] * wy + u[iv + 9] * wz + u[iv + 13];
    s[o + 2] = u[iv + 2] * wx + u[iv + 6] * wy + u[iv + 10] * wz + u[iv + 14];
    s[o + 4] = u[iv] * vx + u[iv + 4] * vy + u[iv + 8] * vz;
    s[o + 5] = u[iv + 1] * vx + u[iv + 5] * vy + u[iv + 9] * vz;
    s[o + 6] = u[iv + 2] * vx + u[iv + 6] * vy + u[iv + 10] * vz;
  }
}
