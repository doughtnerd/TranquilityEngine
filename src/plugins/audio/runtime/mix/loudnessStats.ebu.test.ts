import { describe, expect, it } from "vitest";
import { LoudnessStats } from "./loudnessStats";

// G7d (ADR 0171 amended by 0172; Ld6's L-Ld6a fixtures): the synthesised EBU Tech 3341 / 3342 set read through
// `LoudnessStats`. Each fixture under `runtime/golden/loudness/` (written by
// `native/audio/crates/audio-dsp/tests/loudness_ebu.rs`) carries its signal as segments, the Tech's expected values
// and what the Rust meter plus exact gating measured. The signal is synthesised here as the Rust side does (f32
// samples, the same channel left and right), K-weighted with Ld1's filters (`audio_dsp::loudness::KCoef`,
// libebur128's formulas, f64 state) into round(0.1 x rate)-frame sub-blocks of L + R mean square stored as f32 (the
// core's ring), and fed to `LoudnessStats`. The Tech's values must hold within the fixture's tolerance (±0.1 LU),
// and the Rust measurement within 1e-3 LU. True peak is the core's (`notePeak` only folds it), so it isn't read here.

interface Segment {
  kind: "sine" | "fs4_45";
  freqHz?: number;
  ampDb?: number;
  amp?: number;
  secs: number;
}
interface Readings {
  I: number | null;
  M: number | null;
  S: number | null;
  LRA: number | null;
}
interface Fixture {
  name: string;
  rate: number;
  segments: Segment[];
  expected: Readings & { toleranceLU: number };
  measured: Readings;
}

const fixtures = Object.entries(import.meta.glob<Fixture>("../golden/loudness/*.json", { eager: true, import: "default" }))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, f]) => f);

/** The signal, one channel (both channels carry it), as `loudness_ebu.rs`'s `render`. */
function render(rate: number, segments: readonly Segment[]): Float32Array {
  let n = 0;
  for (const s of segments) n += Math.floor(rate * s.secs);
  const out = new Float32Array(n);
  let o = 0;
  for (const s of segments) {
    const len = Math.floor(rate * s.secs);
    if (s.kind === "sine") {
      const a = 10 ** (s.ampDb! / 20);
      for (let i = 0; i < len; i++) out[o++] = a * Math.sin((2 * Math.PI * s.freqHz! * i) / rate);
    } else {
      for (let i = 0; i < len; i++) out[o++] = s.amp! * Math.sin(Math.PI / 4 + (i * Math.PI) / 2);
    }
  }
  return out;
}

/** K-weighting coefficients (`KCoef::new`): stage 0 the high shelf, stage 1 the high-pass. */
function kcoef(rate: number): { b: number[][]; a: number[][] } {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelfB = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0];
  const shelfA = [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const hpA = [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  // FU1: the high-pass keeps 48 kHz's passband gain at every rate (b = [1, -2, 1] scaled by a0(48 kHz) / a0(rate)).
  const K48 = Math.tan((Math.PI * f0) / 48000);
  const g = (1 + K48 / Q + K48 * K48) / a0;
  return { b: [shelfB, [g, -2 * g, g]], a: [shelfA, hpA] };
}

/** Sub-block energies (f32, as the core's ring) of the signal in both channels. */
function subBlocks(rate: number, x: Float32Array): Float32Array {
  const { b, a } = kcoef(rate);
  const sub = Math.floor(rate / 10 + 0.5);
  const out = new Float32Array(Math.floor(x.length / sub));
  const z = [0, 0, 0, 0]; // [stage 0 z1, z2, stage 1 z1, z2]
  let acc = 0;
  let k = 0;
  let o = 0;
  for (let i = 0; i < x.length; i++) {
    let v = x[i];
    for (let s = 0; s < 2; s++) {
      const bs = b[s];
      const as = a[s];
      const y = bs[0] * v + z[2 * s];
      z[2 * s] = bs[1] * v - as[0] * y + z[2 * s + 1];
      z[2 * s + 1] = bs[2] * v - as[1] * y;
      v = y;
    }
    acc += 2 * v * v; // left + right, the same signal
    if (++k === sub) {
      out[o++] = acc / sub;
      acc = 0;
      k = 0;
    }
  }
  return out;
}

const orInf = (v: number | null): number => (v === null ? Number.NEGATIVE_INFINITY : v);
/** The Rust side reads LRA 0 with fewer than two gated blocks; `LoudnessStats` reads -Infinity. */
const lraOf = (v: number): number => (v === Number.NEGATIVE_INFINITY ? 0 : v);

function near(actual: number, expected: number, tol: number, label: string): void {
  if (expected === Number.NEGATIVE_INFINITY || actual === Number.NEGATIVE_INFINITY) expect(actual, label).toBe(expected);
  else expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

describe("LoudnessStats on the EBU Tech 3341 / 3342 fixtures (L-Ld6a)", () => {
  it("reads the 26 fixtures: 13 cases at 44.1 and 48 kHz", () => {
    expect(fixtures.length).toBe(26);
    expect(new Set(fixtures.map((f) => f.rate))).toEqual(new Set([44100, 48000]));
  });

  for (const f of fixtures) {
    it(`${f.name} at ${f.rate} Hz: the Tech's values within ±${f.expected.toleranceLU} LU, the Rust measurement within 1e-3 LU`, () => {
      const energies = subBlocks(f.rate, render(f.rate, f.segments));
      const st = new LoudnessStats();
      // as the hub takes them: one STATUS's sub-blocks per takeBlock (six quanta of 128 frames hold under one sub-block, so one at a time)
      for (let k = 0; k < energies.length; k++) st.takeBlock(k, energies, k, 1);
      expect(st.lost).toBe(0);
      const own = { I: st.integrated, M: st.momentary, S: st.shortTerm, LRA: st.lra };
      const tol = f.expected.toleranceLU;
      for (const m of ["I", "M", "S", "LRA"] as const) {
        const e = f.expected[m];
        if (e !== null) near(m === "LRA" ? lraOf(own[m]) : own[m], e, tol, `${f.name}@${f.rate} ${m} vs the Tech`);
        const r = orInf(f.measured[m]);
        near(m === "LRA" ? lraOf(own[m]) : own[m], r, 1e-3, `${f.name}@${f.rate} ${m} vs the Rust measurement`);
      }
    });
  }
});
