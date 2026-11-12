// One AudioWorkletProcessor carrying a synthetic three-section load (voices, buses, spatial) of known size.
// Per quantum it records, for the whole body and for each section: the truth (a spinning worker's
// performance.now() in a SAB), a Date.now() delta, and a tick-counter delta (a second spinning worker).
const QUANTUM_US = 128 / sampleRate * 1e6;
const SECTIONS = 3;
const LEN = [128, 64, 256]; // samples per unit: voices, buses, spatial
const SHARE = [0.5, 0.3, 0.2];
let sink = 0;
const buf = new Float32Array(256);
for (let i = 0; i < 256; i++) buf[i] = Math.sin(i * 0.1);
function kernel(section, n) {
  const len = LEN[section];
  let y1 = 0, y2 = 0, acc = 0;
  for (let u = 0; u < n; u++) {
    const b0 = 0.2 + u * 1e-4, a1 = -0.5, a2 = 0.25;
    for (let i = 0; i < len; i++) { const x = buf[i]; const y = b0 * x - a1 * y1 - a2 * y2; y2 = y1; y1 = y; acc += y; }
  }
  sink += acc;
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

class Proc extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.done = true;
    try { this.init(o.processorOptions); } catch (e) { this.port.postMessage({ error: String(e && e.stack || e) }); }
  }
  init(p) {
    this.p = p;
    this.tr = new Float64Array(p.sabTruth);
    this.ct = new Float64Array(p.sabCount);
    this.q = this.tr, this.cn = this.ct;
    // Clock read costs (ns per read).
    const N = 20000; let s = 0;
    let a = this.tr[0]; for (let i = 0; i < N; i++) s += this.tr[0]; const tr0 = this.tr[0];
    const t0 = this.tr[0]; for (let i = 0; i < N; i++) s += Date.now(); const t1 = this.tr[0];
    const t2 = this.tr[0]; for (let i = 0; i < N; i++) s += this.tr[0]; const t3 = this.tr[0];
    const t4 = this.tr[0]; for (let i = 0; i < N; i++) s += this.ct[0]; const t5 = this.tr[0];
    let step = Infinity, prev = this.tr[0];
    for (let i = 0; i < 400000; i++) { const x = this.tr[0]; if (x > prev) { step = Math.min(step, x - prev); prev = x; } }
    this.truthStepUs = step * 1000;
    sink += s;
    this.readCostNs = { dateNow: (t1 - t0) * 1e6 / N, truthSab: (t3 - t2) * 1e6 / N, counterSab: (t5 - t4) * 1e6 / N };
    // Counter calibration: ticks per ms against Date.now over CAL_MS.
    const CAL_MS = p.calMs;
    let d0 = Date.now(); while (Date.now() === d0); d0 = Date.now();
    const c0 = this.ct[0], tt0 = this.tr[0];
    while (Date.now() - d0 < CAL_MS) {}
    const c1 = this.ct[0], tt1 = this.tr[0];
    const dMs = Date.now() - d0; // integer ms, +-1 ms
    this.ticksPerMsDate = (c1 - c0) / dMs;
    this.ticksPerMsTruth = (c1 - c0) / (tt1 - tt0); // only to report the calibration error
    this.usPerTick = 1000 / this.ticksPerMsDate;
    // Section costs (the "lab fit": us per unit), after a JIT warm-up.
    for (let r = 0; r < 300; r++) for (let s2 = 0; s2 < SECTIONS; s2++) kernel(s2, 4);
    this.unitUs = [];
    for (let s2 = 0; s2 < SECTIONS; s2++) {
      const ta = this.tr[0]; kernel(s2, 400); const tb = this.tr[0];
      this.unitUs.push((tb - ta) * 1000 / 400);
    }
    this.levels = p.levels; // fractions of a quantum
    this.n0 = this.levels.map((f) => this.unitUs.map((u, i) => (f * SHARE[i] * QUANTUM_US) / u));
    this.scale = this.levels.map(() => 1);
    this.perLevel = p.warm + p.quanta;
    this.total = this.perLevel * this.levels.length;
    const T = this.levels.length * (p.warm + p.quanta);
    this.rec = { truth: new Float64Array(T), dnow: new Float64Array(T), cnt: new Float64Array(T), units: new Float64Array(T * SECTIONS), strue: new Float64Array(T * SECTIONS), scnt: new Float64Array(T * SECTIONS), model: new Float64Array(T), sdn: new Float64Array(T * SECTIONS) };
    this.i = 0;
    this.rand = rng(12345);
    this.done = false;
  }
  process() {
    if (this.done) return true;
    const p = this.p, tr = this.tr, ct = this.ct, rec = this.rec;
    const lvl = (this.i / this.perLevel) | 0, k = this.i - lvl * this.perLevel;
    if (k === 0 && lvl > 0) this.port.postMessage({ boundary: lvl });
    const n0 = this.n0[lvl];
    const u = this.rand();
    const jit = 0.5 + u; // work varies +-50 % quantum to quantum (mean 1)
    const sc = this.scale[lvl];
    const n = [Math.round(n0[0] * jit * sc), Math.round(n0[1] * (1.5 - u) * sc), Math.round(n0[2] * (0.5 + this.rand()) * sc)];
    const D0 = Date.now(), C0 = ct[0], T0 = tr[0];
    kernel(0, n[0]);
    const T1 = tr[0], C1 = ct[0], D1a = Date.now();
    kernel(1, n[1]);
    const T2 = tr[0], C2 = ct[0], D2a = Date.now();
    kernel(2, n[2]);
    const T3 = tr[0], C3 = ct[0], D1 = Date.now();
    {
      const j = lvl * this.perLevel + k, j3 = j * SECTIONS;
      rec.truth[j] = (T3 - T0) * 1000; rec.dnow[j] = D1 - D0; rec.cnt[j] = C3 - C0;
      rec.units[j3] = n[0]; rec.units[j3 + 1] = n[1]; rec.units[j3 + 2] = n[2];
      rec.strue[j3] = (T1 - T0) * 1000; rec.strue[j3 + 1] = (T2 - T1) * 1000; rec.strue[j3 + 2] = (T3 - T2) * 1000;
      rec.scnt[j3] = C1 - C0; rec.scnt[j3 + 1] = C2 - C1; rec.scnt[j3 + 2] = C3 - C2;
      rec.sdn[j3] = D1a - D0; rec.sdn[j3 + 1] = D2a - D1a; rec.sdn[j3 + 2] = D1 - D2a;
      rec.model[j] = n[0] * this.unitUs[0] + n[1] * this.unitUs[1] + n[2] * this.unitUs[2];
    }
    // Closed-loop level targeting during the first half of the warm-up (the constructor's cold fit is only a start).
    if (k < p.warm / 2 && k % 10 === 9 && this.levels[lvl] > 0) {
      let m = 0; for (let q = k - 9; q <= k; q++) m += rec.truth[lvl * this.perLevel + q] / 10;
      this.scale[lvl] *= Math.min(2, Math.max(0.5, this.levels[lvl] * QUANTUM_US / Math.max(m, 1)));
    }
    if (++this.i === this.total) {
      this.done = true;
      this.port.postMessage({ rec, quantumUs: QUANTUM_US, perLevel: this.perLevel, warm: p.warm, truthStepUs: this.truthStepUs, levels: this.levels, usPerTick: this.usPerTick, calErrPct: (this.ticksPerMsDate / this.ticksPerMsTruth - 1) * 100, ticksPerMsTruth: this.ticksPerMsTruth, unitUs: this.unitUs, readCostNs: this.readCostNs, sampleRate });
    }
    return true;
  }
}
registerProcessor('load', Proc);
