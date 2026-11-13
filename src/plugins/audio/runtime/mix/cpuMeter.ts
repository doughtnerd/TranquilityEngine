// `CpuMeter` (ADR 0171 amended by 0172 §1.10, task Cp2; architecture §4.3 "The CPU figure", R18; api-and-models §1.3, §10).
// The worklet shell counts busy milliseconds and quanta cumulatively (`busyMsTotal`, `quantaTotal`, f64; Cp1) and the core
// counts five cumulative work-unit totals; the wire's `loadPermille` stays 0. Main computes the figure here, from the
// STATUS blocks the mirror applies, with a window chosen by quantum count so cadence switches and skipped posts change
// only how many samples a window spans, never its bias. Pure TypeScript, allocation-free per `feed`, tested with a fake
// `Date.now` (the meter never reads a clock: the shell's counters are its only input).
import type { AudioCpuDebug } from "../backend";

/** @internal Architecture §4.3: the window, in quanta, at a clock step of 1 ms or less (256 ms at 48 kHz). */
export const CPU_WINDOW_QUANTA = 96;
/** @internal §4.3: the window at a 2 ms step (Firefox resistFingerprinting): 4 times longer, 1 s at 48 kHz. */
export const CPU_WINDOW_QUANTA_COARSE = 384;
/** @internal §4.3 `CPU_COARSE_STEP_MS`: a step above this hides the figure ("clock too coarse (n ms)"). */
export const CPU_COARSE_STEP_MS = 2;
/** @internal §4.3: "no step after 1 s": quanta worth this many seconds with `clockStepMs` still 0 hide the figure. */
export const CPU_NO_STEP_SECONDS = 1;
/** @internal The sample ring holds this many STATUS samples of the current epoch (§4.3 says 32; 128 covers the 384-quantum window at the 6-quantum cadence, 64 samples, with slack; interpretation noted in the Cp2 report). */
export const CPU_RING_SAMPLES = 128;
/** @internal §4.3: the refit keeps this many windows (16 s at 256 ms each). */
export const CPU_FIT_WINDOWS = 64;
/** @internal Fewest windows before the refit reports (and `sections` is non-null). */
export const CPU_FIT_MIN_WINDOWS = 8;
/** @internal Frames per quantum (the Web Audio render quantum). */
export const CPU_QUANTUM_FRAMES = 128;

/** What `feed` reads of a STATUS block (a `StatusBlock` satisfies it; the mirror passes the block itself). */
export interface CpuFeed {
  /** Shell: cumulative busy ms (f64); restarts at 0 with the driver (an epoch). */
  busyMsTotal: number;
  /** Shell: cumulative quanta (f64). */
  quantaTotal: number;
  /** Core: cumulative work units by section. */
  wuVoices: number;
  wuBuses: number;
  wuSpatial: number;
  wuMusic: number;
  wuLoudness: number;
  /** Shell: the smallest non-zero `Date.now` step, ms; 0 = none yet. */
  clockStepMs: number;
  /** Shell: wall-clock steps clamped (u16, saturating). */
  clockSteps: number;
}

/** The `Audio.debug().cpu` object's sections value. */
export type CpuSections = NonNullable<AudioCpuDebug["sections"]>;

const SECTIONS = 5;
/** Pull of the refit toward the scalar fit, as a share of each column's own energy. */
const FIT_RIDGE = 0.05;
/** A pair of used sections more correlated than this makes the fit ill-conditioned: one scalar instead. */
const FIT_MAX_CORRELATION = 0.999;
/** A section whose energy is below this share of the largest is unused: it keeps the prior. */
const FIT_USED_SHARE = 1e-3;
const FIT_SWEEPS = 40;
/** The shell's per-quantum cap (`CPU_DELTA_MAX_MS`), reused to clamp a window's busy ms per quantum. */
const BUSY_PER_QUANTUM_MAX_MS = 1_000;

export class CpuMeter {
  private quantumMs = 0;
  private sampleRate = 0;
  // The sample ring of the current epoch: quanta, busy ms, five work-unit totals.
  private readonly rq = new Float64Array(CPU_RING_SAMPLES);
  private readonly rb = new Float64Array(CPU_RING_SAMPLES);
  private readonly rw = new Float64Array(CPU_RING_SAMPLES * SECTIONS);
  private head = 0; // next write
  private count = 0;
  private firstQuanta = 0;
  // Newest block's shell fields.
  private clockStepMs = 0;
  private clockSteps = 0;
  private hidden: string | null = null;
  private window = CPU_WINDOW_QUANTA;
  // The figure and the newest window's work-unit deltas.
  private figure = Number.NaN;
  private windowDq = 0;
  private readonly windowWu = new Float64Array(SECTIONS);
  // The refit: an anchor, 64 observations (busy ms, five unit deltas), the coefficients (ms per unit).
  private anchored = false;
  private aq = 0;
  private ab = 0;
  private readonly aw = new Float64Array(SECTIONS);
  private readonly oy = new Float64Array(CPU_FIT_WINDOWS);
  private readonly ox = new Float64Array(CPU_FIT_WINDOWS * SECTIONS);
  private obsHead = 0;
  private obsCount = 0;
  private fitted = false;
  private residual = 0;
  private readonly coef = new Float64Array(SECTIONS);
  private readonly gram = new Float64Array(SECTIONS * SECTIONS);
  private readonly rhs = new Float64Array(SECTIONS);
  private readonly mult = new Float64Array(SECTIONS);

  /**
   * `sampleRate` fixes the quantum's duration (`128 / sampleRate` s). A hard rebuild into a new context calls
   * `setSampleRate`.
   */
  constructor(sampleRate: number = 48000) {
    this.setSampleRate(sampleRate);
  }

  /** The new context's rate: restarts the meter (a new core restarts its counters). */
  setSampleRate(sampleRate: number): void {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) sampleRate = 48000;
    this.sampleRate = sampleRate;
    this.quantumMs = (CPU_QUANTUM_FRAMES * 1000) / sampleRate;
    this.epoch();
  }

  /**
   * Takes one STATUS block's cumulative totals (§4.3). A `quantaTotal` or `busyMsTotal` that went back is an epoch (a
   * driver restart reads as the counters returning to 0): the ring restarts and no delta is ever negative. A block with
   * no new quanta changes nothing but `clockStepMs` and `clockSteps`. No allocation.
   */
  feed(status: CpuFeed): void {
    this.clockStepMs = status.clockStepMs;
    this.clockSteps = status.clockSteps;
    const q = status.quantaTotal;
    const b = status.busyMsTotal;
    if (!Number.isFinite(q) || !Number.isFinite(b) || q < 0 || b < 0) return;
    if (this.count > 0) {
      const last = (this.head + CPU_RING_SAMPLES - 1) % CPU_RING_SAMPLES;
      if (q < this.rq[last]! || b < this.rb[last]!) this.epoch();
      else if (q === this.rq[last]) {
        this.updateHidden(q);
        if (this.hidden) this.figure = Number.NaN;
        return;
      }
    }
    const i = this.head;
    this.rq[i] = q;
    this.rb[i] = b;
    const o = i * SECTIONS;
    this.rw[o] = status.wuVoices;
    this.rw[o + 1] = status.wuBuses;
    this.rw[o + 2] = status.wuSpatial;
    this.rw[o + 3] = status.wuMusic;
    this.rw[o + 4] = status.wuLoudness;
    this.head = (i + 1) % CPU_RING_SAMPLES;
    if (this.count < CPU_RING_SAMPLES) this.count++;
    if (this.count === 1) this.firstQuanta = q;
    this.updateHidden(q);
    if (this.hidden) {
      this.figure = Number.NaN;
      return;
    }
    this.measure(i, q, b);
    this.observe(i, q, b);
  }

  /** An EPOCH from outside (a rebuild, the capture's marker): forgets the ring and the window, keeps the sample rate. */
  epoch(): void {
    this.head = 0;
    this.count = 0;
    this.figure = Number.NaN;
    this.windowDq = 0;
    this.anchored = false;
    this.obsHead = 0;
    this.obsCount = 0;
    this.fitted = false;
    this.residual = 0;
    this.hidden = null;
  }

  /**
   * The figure, permille of a quantum: 1000 x delta busy / (delta quanta x quantum ms) over the newest window of at
   * least W quanta (W 96, 384 at a 2 ms step). `null` before the first window fills, and while hidden.
   */
  get loadPermille(): number | null {
    return this.hidden || Number.isNaN(this.figure) ? null : this.figure;
  }

  /** §1.3 `Audio.debug().cpu`: a fresh object. `hidden` carries "clock too coarse (n ms)" when the clock is above 2 ms. */
  debug(): AudioCpuDebug {
    const fig = this.loadPermille;
    let sections: CpuSections | null = null;
    if (fig !== null && this.fitted && this.windowDq > 0) {
      const k = 1000 / (this.windowDq * this.quantumMs);
      const w = this.windowWu;
      const c = this.coef;
      sections = { voices: k * c[0]! * w[0]!, buses: k * c[1]! * w[1]!, spatial: k * c[2]! * w[2]!, music: k * c[3]! * w[3]!, loudness: k * c[4]! * w[4]! };
    }
    return {
      loadPermille: fig,
      windowMs: this.hidden ? 0 : this.window * this.quantumMs,
      clockStepMs: this.clockStepMs,
      clockSteps: this.clockSteps,
      refitResidual: this.fitted ? this.residual : null,
      sections,
      hidden: this.hidden,
    };
  }

  /** §4.3's table: the hide reasons and the window the clock step allows. */
  private updateHidden(q: number): void {
    const step = this.clockStepMs;
    if (step > CPU_COARSE_STEP_MS) this.hidden = `clock too coarse (${step} ms)`;
    else if (step === 0 && q - this.firstQuanta >= (CPU_NO_STEP_SECONDS * this.sampleRate) / CPU_QUANTUM_FRAMES) this.hidden = "clock too coarse (no step in 1 s)";
    else this.hidden = null;
    this.window = step > 1 ? CPU_WINDOW_QUANTA_COARSE : CPU_WINDOW_QUANTA;
  }

  /** The newest sample back to the newest sample at least W quanta older. */
  private measure(newest: number, q: number, b: number): void {
    const W = this.window;
    let n = this.count - 1;
    let j = newest;
    while (n-- > 0) {
      j = (j + CPU_RING_SAMPLES - 1) % CPU_RING_SAMPLES;
      if (q - this.rq[j]! >= W) {
        const dq = q - this.rq[j]!;
        const db = Math.min(Math.max(0, b - this.rb[j]!), dq * BUSY_PER_QUANTUM_MAX_MS);
        this.figure = (1000 * db) / (dq * this.quantumMs);
        this.windowDq = dq;
        for (let k = 0; k < SECTIONS; k++) this.windowWu[k] = Math.max(0, this.rw[newest * SECTIONS + k]! - this.rw[j * SECTIONS + k]!);
        return;
      }
    }
    this.figure = Number.NaN;
  }

  /** One refit observation per W quanta of progress (non-overlapping windows), then the refit. */
  private observe(newest: number, q: number, b: number): void {
    const o = newest * SECTIONS;
    if (!this.anchored) {
      this.aq = q;
      this.ab = b;
      for (let k = 0; k < SECTIONS; k++) this.aw[k] = this.rw[o + k]!;
      this.anchored = true;
      return;
    }
    const dq = q - this.aq;
    if (dq < this.window) return;
    const at = this.obsHead * SECTIONS;
    this.oy[this.obsHead] = Math.min(Math.max(0, b - this.ab), dq * BUSY_PER_QUANTUM_MAX_MS);
    for (let k = 0; k < SECTIONS; k++) {
      this.ox[at + k] = Math.max(0, this.rw[o + k]! - this.aw[k]!);
      this.aw[k] = this.rw[o + k]!;
    }
    this.obsHead = (this.obsHead + 1) % CPU_FIT_WINDOWS;
    if (this.obsCount < CPU_FIT_WINDOWS) this.obsCount++;
    this.aq = q;
    this.ab = b;
    this.refit();
  }

  /**
   * Non-negative least squares of busy ms on the five unit deltas, pulled toward one scalar (ms per unit over all
   * windows) by a ridge, by projected Gauss-Seidel; the scalar alone when two used sections are collinear.
   */
  private refit(): void {
    const n = this.obsCount;
    if (n < CPU_FIT_MIN_WINDOWS) return;
    let sy = 0;
    let sx = 0;
    for (let i = 0; i < n; i++) {
      sy += this.oy[i]!;
      for (let k = 0; k < SECTIONS; k++) sx += this.ox[i * SECTIONS + k]!;
    }
    if (!(sx > 0) || !(sy > 0)) {
      this.fitted = false;
      return;
    }
    const s = sy / sx;
    const G = this.gram;
    const g = this.rhs;
    G.fill(0);
    g.fill(0);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < SECTIONS; a++) {
        const ua = this.ox[i * SECTIONS + a]! * s;
        g[a] = g[a]! + ua * this.oy[i]!;
        for (let c = a; c < SECTIONS; c++) G[a * SECTIONS + c] = G[a * SECTIONS + c]! + ua * this.ox[i * SECTIONS + c]! * s;
      }
    }
    for (let a = 0; a < SECTIONS; a++) for (let c = 0; c < a; c++) G[a * SECTIONS + c] = G[c * SECTIONS + a]!;
    let maxDiag = 0;
    for (let a = 0; a < SECTIONS; a++) maxDiag = Math.max(maxDiag, G[a * SECTIONS + a]!);
    const m = this.mult;
    m.fill(1);
    let collinear = false;
    for (let a = 0; a < SECTIONS && !collinear; a++) {
      const da = G[a * SECTIONS + a]!;
      if (da < FIT_USED_SHARE * maxDiag) continue;
      for (let c = a + 1; c < SECTIONS; c++) {
        const dc = G[c * SECTIONS + c]!;
        if (dc < FIT_USED_SHARE * maxDiag) continue;
        if (G[a * SECTIONS + c]! / Math.sqrt(da * dc) > FIT_MAX_CORRELATION) {
          collinear = true;
          break;
        }
      }
    }
    if (!collinear) {
      const floor = FIT_USED_SHARE * maxDiag;
      for (let sweep = 0; sweep < FIT_SWEEPS; sweep++) {
        for (let a = 0; a < SECTIONS; a++) {
          const lambda = FIT_RIDGE * Math.max(G[a * SECTIONS + a]!, floor);
          let num = g[a]! + lambda;
          for (let c = 0; c < SECTIONS; c++) if (c !== a) num -= G[a * SECTIONS + c]! * m[c]!;
          const v = num / (G[a * SECTIONS + a]! + lambda);
          m[a] = v > 0 ? v : 0;
        }
      }
    }
    for (let a = 0; a < SECTIONS; a++) this.coef[a] = m[a]! * s;
    let rr = 0;
    let yy = 0;
    for (let i = 0; i < n; i++) {
      let pred = 0;
      for (let k = 0; k < SECTIONS; k++) pred += this.coef[k]! * this.ox[i * SECTIONS + k]!;
      const e = this.oy[i]! - pred;
      rr += e * e;
      yy += this.oy[i]! * this.oy[i]!;
    }
    this.residual = yy > 0 ? Math.sqrt(rr / yy) : 0;
    this.fitted = true;
  }
}
