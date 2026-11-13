import { describe, expect, it } from "vitest";
import { LoudnessStats } from "./loudnessStats";
import vectors from "../../../../../native/audio/crates/audio-dsp/tests/vectors/loudness_crate.json";

// Ld6 (ADR 0171 amended by 0172, test plan): main's gating (`LoudnessStats`, Ld3, 1,000-bin histograms) against
// the `ebur128` crate 0.1.11. The vectors are written by `native/audio/crates/audio-dsp/tests/loudness_crate.rs`:
// per case, the audio core's meter's sub-block energies (`audio_dsp::loudness::Meter`, f32) for spike S1's
// signals at 48 kHz and random programme material at 32 to 88.2 kHz, and the crate's momentary, short-term,
// integrated and LRA after every 10th sub-block (f32) and at the end (f64; `null` is -Infinity). The Rust side
// checks the meter plus exact list-based gating against the crate within 1e-3 LU at every sub-block; this file
// checks the shipped histogram gating on the same energies.

interface Case {
  name: string;
  rate: number;
  subs: string;
  every10: string;
  end: (number | null)[];
}

const cases = (vectors as { cases: Case[] }).cases;

/** Little-endian f32s from base64. */
function f32s(b64: string): Float32Array {
  const bin = atob(b64);
  const view = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i));
  const out = new Float32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * The meter's f32 ring and flushed filter states read digital silence as -Infinity where the crate's f64 filters
 * decay to, say, -619 LUFS; readings under -300 LUFS count as -Infinity on both sides (the Rust test's rule).
 */
const floor = (x: number): number => (x < -300 ? Number.NEGATIVE_INFINITY : x);
const diff = (a: number, b: number): number => (floor(a) === floor(b) ? 0 : Math.abs(floor(a) - floor(b)));
/** `LoudnessStats` reads LRA -Infinity until two blocks pass; the crate reads 0. */
const lraOf = (x: number): number => (x === Number.NEGATIVE_INFINITY ? 0 : x);

type Measure = "M" | "S" | "I" | "LRA";
interface Worst {
  d: number;
  at: string;
}

interface Result {
  /** Worst over the points after every 10th sub-block and at the end. */
  all: Record<Measure, Worst>;
  /** Worst over the end of each case only. */
  end: Record<Measure, Worst>;
  points: number;
}

const blank = (): Record<Measure, Worst> => ({ M: { d: 0, at: "" }, S: { d: 0, at: "" }, I: { d: 0, at: "" }, LRA: { d: 0, at: "" } });

/** Feeds every case and returns the worst difference per measure. */
function compareAll(): Result {
  const r: Result = { all: blank(), end: blank(), points: 0 };
  const note = (m: Measure, own: number, ref: number, at: string, isEnd: boolean): void => {
    const d = diff(own, ref);
    for (const w of isEnd ? [r.all, r.end] : [r.all]) {
      if (d > w[m].d || Number.isNaN(d)) w[m] = { d, at: `${at} (own ${own}, ebur128 ${ref})` };
    }
  };
  for (const c of cases) {
    const subs = f32s(c.subs);
    const ref = f32s(c.every10);
    const st = new LoudnessStats();
    for (let k = 0; k < subs.length; k++) {
      st.push(subs[k]);
      const n = k + 1;
      if (n % 10 !== 0) continue;
      const p = (n / 10 - 1) * 4;
      const at = `${c.name}@${c.rate} sub-block ${n}`;
      // the crate's points are f32: compare at f32 resolution
      if (n >= 4) note("M", Math.fround(st.momentary), ref[p], at, false);
      if (n >= 30) note("S", Math.fround(st.shortTerm), ref[p + 1], at, false);
      note("I", Math.fround(st.integrated), ref[p + 2], at, false);
      note("LRA", Math.fround(lraOf(st.lra)), ref[p + 3], at, false);
      r.points++;
    }
    const [m, s, i, lra] = c.end.map((v) => (v === null ? Number.NEGATIVE_INFINITY : v));
    const at = `${c.name}@${c.rate} end`;
    // the crate reads a window that isn't full yet as if zero-padded; LoudnessStats reads -Infinity
    if (subs.length >= 4) note("M", st.momentary, m, at, true);
    if (subs.length >= 30) note("S", st.shortTerm, s, at, true);
    note("I", st.integrated, i, at, true);
    note("LRA", lraOf(st.lra), lra, at, true);
    r.points++;
  }
  return r;
}

const result = compareAll();
const summary = (w: Record<Measure, Worst>): string =>
  (["M", "S", "I", "LRA"] as Measure[]).map((m) => `${m} ${w[m].d.toExponential(3)} at ${w[m].at}`).join("; ");

/** The histogram gating's own bound against exact gating (`loudnessStats.ts`'s file comment, spike S1). */
const HISTOGRAM_BOUND_LU = 0.11;

describe("LoudnessStats against the ebur128 crate (Ld6)", () => {
  it("reads the vectors: S1's 13 cases at 48 kHz and 12 random programmes", () => {
    expect(cases.length).toBe(25);
    for (const c of cases) {
      expect(f32s(c.subs).length, c.name).toBeGreaterThan(0);
      expect(f32s(c.every10).length % 4, c.name).toBe(0);
    }
    console.log(`LoudnessStats vs ebur128, ${result.points} points. Every second: ${summary(result.all)}. At the end: ${summary(result.end)}`);
  });

  it("momentary and short-term agree within 1e-3 LU at every second", () => {
    expect(result.all.M.d, result.all.M.at).toBeLessThanOrEqual(1e-3);
    expect(result.all.S.d, result.all.S.at).toBeLessThanOrEqual(1e-3);
  });

  // The histograms admit the whole bin that holds a relative gate (blocks up to 0.1 LU under it) and pick a
  // percentile's bin mean, so integrated and LRA can't meet the crate's 1e-3 LU; the bar is the histogram's own.
  it("integrated agrees within the histogram's 0.11 LU at every second", () => {
    expect(result.all.I.d, result.all.I.at).toBeLessThanOrEqual(HISTOGRAM_BOUND_LU);
  });

  it("LRA agrees within the histogram's 0.11 LU at the end of every case", () => {
    expect(result.end.LRA.d, result.end.LRA.at).toBeLessThanOrEqual(HISTOGRAM_BOUND_LU);
  });

  // Known (Ld6's report): with few 3 s blocks, one block admitted from under the -20 LU gate's bin moves the 10th
  // percentile to another block, LUs away. Programme 12 at 15 s: the gate is -48.864 LUFS, a block at -48.873 shares
  // its bin, so 13 blocks pass instead of 12 and the low pick moves from -39.869 to -42.365 (LRA 16.571 against the
  // crate's 14.076). Flips when the gating is fixed.
  it.fails("LRA agrees within the histogram's 0.11 LU at every second", () => {
    expect(result.all.LRA.d, result.all.LRA.at).toBeLessThanOrEqual(HISTOGRAM_BOUND_LU);
  });
});
