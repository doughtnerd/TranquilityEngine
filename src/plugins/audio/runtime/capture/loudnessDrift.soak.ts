// ADR 0171 amended by 0172 (M5d, task So1, soak 3, the TypeScript half; architecture §4.4; build log D4): main's shipped
// gating (`LoudnessStats`, exact since G7d) over 20 minutes of programme at 48 kHz against the `ebur128` crate 0.1.11. The
// energies are the core's meter's (`audio_dsp::loudness::Meter`) sub-blocks over the 20 minutes, written with the crate's
// M, S, I and LRA at the end of every minute by `native/audio/crates/audio-dsp/tests/loudness_drift.rs` (run with
// `--ignored`; the Rust half checks the meter plus spike S1's exact gating against the crate at the same minutes). Seconds:
//
//   npx vitest run --config tools/audio-bench/soak.vitest.config.mts loudnessDrift
//
// **Asserted.** At every minute, integrated and LRA (and momentary and short-term) within 1e-3 LU of the crate; the meter's
// memory bounded: its exact storage holds the 20 minutes' blocks under D4's one-hour bound (36,000 integrated blocks, 3,600
// LRA blocks), its byte size and buffers never change. Main's time per audio second is logged, never asserted.
import { describe, expect, it } from "vitest";
import { EXACT_GATING_SECONDS, LRA_HOP_SUBS, LoudnessStats } from "../mix/loudnessStats";
import vectors from "../../../../../native/audio/crates/audio-dsp/tests/vectors/loudness_drift.json";

interface Drift {
  rate: number;
  minutes: (number | null)[][];
  subs: string;
}
const drift = vectors as Drift;

function f32s(b64: string): Float32Array {
  const bin = atob(b64);
  const view = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i));
  const out = new Float32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

const TOL = 1e-3;
const ref = (x: number | null): number => (x === null ? Number.NEGATIVE_INFINITY : x);
/** Under -300 LUFS is digital silence on both sides (Ld6's rule); the same infinity agrees. */
const floor = (x: number): number => (x < -300 ? Number.NEGATIVE_INFINITY : x);
const diff = (a: number, b: number): number => (floor(a) === floor(b) ? 0 : Math.abs(floor(a) - floor(b)));
/** `LoudnessStats` reads LRA -Infinity until two blocks pass; the crate reads 0. */
const lraOf = (x: number): number => (x === Number.NEGATIVE_INFINITY ? 0 : x);

describe("soak 3: 20 minutes of programme through main's exact gating against ebur128 (§4.4, D4)", () => {
  it("integrated and LRA within 1e-3 LU at every minute; memory under the one-hour bound and constant", () => {
    const subs = f32s(drift.subs);
    const perMinute = 600; // 0.1 s sub-blocks
    expect(drift.rate).toBe(48_000);
    expect(drift.minutes).toHaveLength(20);
    expect(subs.length).toBe(20 * perMinute);
    const st = new LoudnessStats();
    const bytes = st.byteLength;
    const buffers = st.buffers().map((b) => b.buffer);
    const rows: string[] = ["| minute | I (TS) | I (crate) | dI | LRA (TS) | LRA (crate) | dLRA | dM | dS | I blocks listed |", "|---|---|---|---|---|---|---|---|---|---|"];
    const worst = { i: 0, lra: 0, m: 0, s: 0 };
    let ms = 0;
    for (let k = 0; k < subs.length; k++) {
      const t0 = performance.now();
      st.push(subs[k]!);
      ms += performance.now() - t0;
      if ((k + 1) % perMinute !== 0) continue;
      const minute = (k + 1) / perMinute;
      const [m, s, i, lra] = drift.minutes[minute - 1]!.map(ref) as [number, number, number, number];
      const d = { i: diff(st.integrated, i), lra: Math.abs(lraOf(st.lra) - lra), m: diff(st.momentary, m), s: diff(st.shortTerm, s) };
      worst.i = Math.max(worst.i, d.i);
      worst.lra = Math.max(worst.lra, d.lra);
      worst.m = Math.max(worst.m, d.m);
      worst.s = Math.max(worst.s, d.s);
      rows.push(`| ${minute} | ${st.integrated.toFixed(4)} | ${i.toFixed(4)} | ${d.i.toExponential(2)} | ${lraOf(st.lra).toFixed(4)} | ${lra.toFixed(4)} | ${d.lra.toExponential(2)} | ${d.m.toExponential(2)} | ${d.s.toExponential(2)} | ${st.listedIntegratedBlocks} |`);
      expect(d.i, `integrated at minute ${minute}`).toBeLessThanOrEqual(TOL);
      expect(d.lra, `LRA at minute ${minute}`).toBeLessThanOrEqual(TOL);
      expect(d.m, `momentary at minute ${minute}`).toBeLessThanOrEqual(TOL);
      expect(d.s, `short-term at minute ${minute}`).toBeLessThanOrEqual(TOL);
    }
    // Memory: the exact storage holds 20 minutes of blocks, under the one-hour bound, in the buffers it started with.
    const boundI = 10 * EXACT_GATING_SECONDS;
    const boundL = EXACT_GATING_SECONDS;
    expect(st.listedIntegratedBlocks).toBeLessThan(boundI);
    expect(st.listedLraBlocks).toBeLessThan(boundL);
    expect(st.listedIntegratedBlocks).toBeLessThanOrEqual(subs.length - 3);
    expect(st.listedLraBlocks).toBeLessThanOrEqual(Math.floor((subs.length - 30) / LRA_HOP_SUBS) + 1);
    expect(st.byteLength).toBe(bytes);
    st.buffers().forEach((b, j) => expect(b.buffer).toBe(buffers[j]));
    console.log([
      `So1 soak 3 (TypeScript): LoudnessStats (exact gating, D4) vs ebur128 0.1.11 over 20 min of programme at 48 kHz, ${subs.length} sub-blocks (container)`,
      ...rows,
      `worst over 20 minutes: I ${worst.i.toExponential(3)}, LRA ${worst.lra.toExponential(3)}, M ${worst.m.toExponential(3)}, S ${worst.s.toExponential(3)} LU (bar ${TOL})`,
      `memory: ${bytes} B per meter, constant; listed blocks I ${st.listedIntegratedBlocks} / ${boundI}, LRA ${st.listedLraBlocks} / ${boundL} (the one-hour bound not reached); main ${((ms / 1200) * 1000).toFixed(1)} us per audio second (logged)`,
    ].join("\n"));
  });
});
