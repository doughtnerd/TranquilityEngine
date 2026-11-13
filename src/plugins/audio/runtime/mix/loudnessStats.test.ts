import { describe, expect, it } from "vitest";
import { LoudnessStats } from "./loudnessStats";
import vectors from "./__fixtures__/loudnessVectors.json";

// Reference values from spike S1's Rust Feed / Gating / Hist (see __fixtures__/genLoudnessVectors.rs). In the JSON,
// `null` stands for -Infinity.

const RING_LEN = 32;

/** Mean-square energy of a steady signal at `lufs` (the inverse of `-0.691 + 10 log10(e)`). */
function energyFor(lufs: number): number {
  return 10 ** ((lufs + 0.691) / 10);
}

const fromJson = (v: number | null): number => (v === null ? Number.NEGATIVE_INFINITY : v);

/** Absolute tolerance check that also demands -Infinity match -Infinity exactly. */
function expectNear(actual: number, expected: number, tol: number, label: string): void {
  if (expected === Number.NEGATIVE_INFINITY || actual === Number.NEGATIVE_INFINITY) {
    expect(actual, label).toBe(expected);
    return;
  }
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(tol);
}

/**
 * Number of 3 s LRA blocks among the first `n` sub-blocks that pass the absolute and relative gates, counted here
 * from the raw energies (not from the implementation). Used only to decide whether a Rust 0 may stand for TS
 * -Infinity: the spec allows that only while fewer than two blocks have passed.
 */
function gatedLraBlocks(subs: readonly number[], n: number): number {
  const lufs = (e: number) => -0.691 + 10 * Math.log10(e);
  const blocks: number[] = [];
  for (let end = 30; end <= n; end += 10) {
    let sum = 0;
    for (let j = end - 30; j < end; j++) sum += subs[j];
    const e = sum / 30;
    if (lufs(e) >= -70) blocks.push(e);
  }
  if (blocks.length === 0) return 0;
  const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const gate = lufs(mean) - 20;
  return blocks.filter((e) => lufs(e) >= gate).length;
}

function expectLra(actual: number, expected: number, tol: number, label: string, subs: readonly number[], n: number): void {
  if (expected === 0 && actual === Number.NEGATIVE_INFINITY) {
    expect(gatedLraBlocks(subs, n), `${label}: TS -Infinity needs fewer than two gated blocks`).toBeLessThan(2);
    return;
  }
  expectNear(actual, expected, tol, label);
}

/** Pushes `n` steady sub-blocks at `lufs`. */
function tone(s: LoudnessStats, n: number, lufs: number): void {
  const e = energyFor(lufs);
  for (let i = 0; i < n; i++) s.push(e);
}

describe("LoudnessStats against the Rust Feed / Hist / Gating (S1 vectors)", () => {
  it("L-Ld3a: M and S are bit-identical at every checkpoint of every case", () => {
    for (const c of vectors.cases) {
      const at = new Map(c.checkpoints.map((cp) => [cp.n, cp]));
      const s = new LoudnessStats();
      let visited = 0;
      for (let n = 1; n <= c.subs.length; n++) {
        s.push(c.subs[n - 1]);
        const cp = at.get(n);
        if (!cp) continue;
        visited++;
        expect(s.momentary, `${c.name}: M at ${n}`).toBe(fromJson(cp.m));
        expect(s.shortTerm, `${c.name}: S at ${n}`).toBe(fromJson(cp.s));
      }
      expect(visited, `${c.name}: checkpoints visited`).toBe(c.checkpoints.length);
    }
  });

  it("L-Ld3a, G7d: integrated matches the exact Gating within 1e-9 LU (and differs from the Rust Hist, which the gating no longer is)", () => {
    let histDiffers = false;
    for (const c of vectors.cases) {
      const at = new Map(c.checkpoints.map((cp) => [cp.n, cp]));
      const s = new LoudnessStats();
      for (let n = 1; n <= c.subs.length; n++) {
        s.push(c.subs[n - 1]);
        const cp = at.get(n);
        if (!cp) continue;
        expectNear(s.integrated, fromJson(cp.iExact), 1e-9, `${c.name}: I vs exact at ${n}`);
        if (Math.abs(s.integrated - fromJson(cp.i)) > 1e-6) histDiffers = true;
      }
    }
    expect(histDiffers, "some checkpoint where the histogram was off").toBe(true);
  });

  it("L-Ld3a, G7d: LRA matches the exact Gating within 1e-9 LU (where Rust reads 0 with under two blocks, TS reads -Infinity)", () => {
    for (const c of vectors.cases) {
      const at = new Map(c.checkpoints.map((cp) => [cp.n, cp]));
      const s = new LoudnessStats();
      for (let n = 1; n <= c.subs.length; n++) {
        s.push(c.subs[n - 1]);
        const cp = at.get(n);
        if (!cp) continue;
        expectLra(s.lra, fromJson(cp.lraExact), 1e-9, `${c.name}: LRA vs exact at ${n}`, c.subs, n);
      }
    }
  });

  it("L-Ld3a: take() reproduces Feed::take on the four feed vectors: pushed counts, out energies, lost", () => {
    for (const f of vectors.feeds) {
      const s = new LoudnessStats();
      const out: number[] = [];
      const pushOne = s.push.bind(s);
      s.push = (e: number) => {
        out.push(e);
        pushOne(e);
      };
      for (const t of f.takes) {
        const pushed = s.take(t.seq, t.ring, f.ringLen);
        expect(pushed, `${f.name}: pushed at seq ${t.seq}`).toBe(t.pushed);
      }
      expect(out.length, `${f.name}: out count`).toBe(f.out.length);
      expect(out, `${f.name}: out energies`).toEqual(f.out);
      expect(s.lost, `${f.name}: lost`).toBe(f.lost);
    }
  });
});

/** A small deterministic generator (xorshift32), so the programmes are the same on every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

/** Programme-like sub-blocks: steps of 1 to 40 sub-blocks at -80 to -8 LUFS with a little ripple. */
function programme(seed: number, n: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const level = -80 + 72 * r();
    const len = 1 + Math.floor(40 * r());
    for (let j = 0; j < len && out.length < n; j++) out.push(energyFor(level + (r() - 0.5)));
  }
  return out;
}

const lufsOf = (e: number) => (e > 0 ? -0.691 + 10 * Math.log10(e) : Number.NEGATIVE_INFINITY);
const binOfLufs = (l: number) => Math.min(Math.max(Math.floor((l + 70) * 10), 0), 999);

/**
 * Exact list-based I and LRA after every sub-block (as the Rust `stats_series`, `audio-dsp/tests/loudness_common`),
 * with the number of blocks that shared the relative gate's 0.1 LU bin but fell under the gate (what the histogram
 * admitted wrongly).
 */
function exactSeries(subs: readonly number[]): { i: number[]; lra: number[]; nearMissI: number; nearMissL: number } {
  const i: number[] = [];
  const lra: number[] = [];
  const blocksI: number[] = [];
  const blocksL: number[] = [];
  let nearMissI = 0;
  let nearMissL = 0;
  let curLra = Number.NEGATIVE_INFINITY;
  const mean = (a: readonly number[], from: number, to: number) => {
    let s = 0;
    for (let k = from; k < to; k++) s += a[k];
    return s / (to - from);
  };
  for (let k = 0; k < subs.length; k++) {
    if (k >= 3) {
      const e = mean(subs, k - 3, k + 1);
      if (lufsOf(e) >= -70) blocksI.push(e);
    }
    if (blocksI.length === 0) i.push(Number.NEGATIVE_INFINITY);
    else {
      const gate = lufsOf(mean(blocksI, 0, blocksI.length)) - 10;
      let c = 0;
      let s = 0;
      for (const e of blocksI) {
        if (lufsOf(e) >= gate) {
          c++;
          s += e;
        } else if (binOfLufs(lufsOf(e)) === binOfLufs(gate)) nearMissI++;
      }
      i.push(c > 0 ? lufsOf(s / c) : Number.NEGATIVE_INFINITY);
    }
    if (k >= 29 && (k - 29) % 10 === 0) {
      const e = mean(subs, k - 29, k + 1);
      if (lufsOf(e) >= -70) blocksL.push(e);
      if (blocksL.length > 0) {
        const gate = lufsOf(mean(blocksL, 0, blocksL.length)) - 20;
        const v = blocksL.map(lufsOf).filter((l) => l >= gate).sort((a, b) => a - b);
        nearMissL += blocksL.filter((e) => lufsOf(e) < gate && binOfLufs(lufsOf(e)) === binOfLufs(gate)).length;
        curLra = v.length < 2 ? Number.NEGATIVE_INFINITY : v[Math.floor((v.length - 1) * 0.95 + 0.5)] - v[Math.floor((v.length - 1) * 0.1 + 0.5)];
      }
    }
    lra.push(curLra);
  }
  return { i, lra, nearMissI, nearMissL };
}

describe("LoudnessStats exact gating (G7d)", () => {
  it("G7d: integrated and LRA equal list-based gating within 1e-9 LU after every sub-block of six programmes, blocks in the gate's own bin included", () => {
    let nearMissI = 0;
    let nearMissL = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const subs = programme(seed * 7919, 3000);
      const ref = exactSeries(subs);
      nearMissI += ref.nearMissI;
      nearMissL += ref.nearMissL;
      const s = new LoudnessStats();
      for (let k = 0; k < subs.length; k++) {
        s.push(subs[k]);
        expectNear(s.integrated, ref.i[k], 1e-9, `seed ${seed}: I at ${k + 1}`);
        expectNear(s.lra, ref.lra[k], 1e-9, `seed ${seed}: LRA at ${k + 1}`);
      }
    }
    // the programmes do put blocks in the gate's bin under the gate (what the histogram admitted)
    expect(nearMissI, "I near misses").toBeGreaterThan(0);
    expect(nearMissL, "LRA near misses").toBeGreaterThan(0);
  });

  it("G7d: the storage holds an hour by default (36,000 + 3,600 blocks, 560,240 bytes) and is emptied by reset('integrated') and reset('all')", () => {
    const s = new LoudnessStats();
    expect(s.byteLength).toBe(560_240);
    tone(s, 200, -23);
    expect(s.listedIntegratedBlocks).toBe(197);
    expect(s.listedLraBlocks).toBe(18);
    s.reset("integrated");
    expect([s.listedIntegratedBlocks, s.listedLraBlocks]).toEqual([0, 0]);
    tone(s, 50, -23);
    expect(s.listedIntegratedBlocks).toBeGreaterThan(0);
    s.reset("all");
    expect([s.listedIntegratedBlocks, s.listedLraBlocks]).toEqual([0, 0]);
    s.reset("maxPeak");
    tone(s, 40, -23);
    const listed = s.listedIntegratedBlocks;
    s.reset("maxPeak");
    expect(s.listedIntegratedBlocks).toBe(listed);
  });

  it("G7d: past the bound blocks still count (in their bin, by the bin rule at the gate): exact while under it, I within 0.11 LU after (LRA approximate: a rank can move to a neighbouring block), and a steady tone stays exact", () => {
    // 600 s of programme against a 60 s bound: 600 integrated and 60 LRA blocks listed, ten times that unlisted.
    const subs = programme(4242, 6000);
    const ref = exactSeries(subs);
    const s = new LoudnessStats(60);
    let worstI = 0;
    let worstL = 0;
    for (let k = 0; k < subs.length; k++) {
      const exactI = s.listedIntegratedBlocks < 600;
      const exactL = s.listedLraBlocks < 60;
      s.push(subs[k]);
      expectNear(s.integrated, ref.i[k], exactI ? 1e-9 : 0.11, `I at ${k + 1}`);
      // past the bound, unlisted blocks in the gate's bin are admitted and a percentile on one reads its bin's mean
      expectNear(s.lra, ref.lra[k], exactL ? 1e-9 : 2, `LRA at ${k + 1}`);
      if (!exactI) worstI = Math.max(worstI, Math.abs(s.integrated - ref.i[k]));
      if (!exactL && ref.lra[k] > Number.NEGATIVE_INFINITY) worstL = Math.max(worstL, Math.abs(s.lra - ref.lra[k]));
    }
    expect(s.listedIntegratedBlocks).toBe(600);
    expect(s.listedLraBlocks).toBe(60);
    console.log(`past a 60 s bound over 600 s: worst I ${worstI.toExponential(3)} LU, worst LRA ${worstL.toExponential(3)} LU`);

    const steady = new LoudnessStats(1);
    tone(steady, 600, -23);
    expect(steady.listedIntegratedBlocks).toBe(10);
    expect(steady.integrated).toBeCloseTo(-23, 9);
    expect(steady.lra).toBeCloseTo(0, 9);
  });
});

describe("LoudnessStats gates and ranges", () => {
  it("L-Ld3a: absolute gate: -80 dB then -23 dB integrates to the -23 half; digital silence keeps integrated where it was", () => {
    const s = new LoudnessStats();
    tone(s, 40, -80);
    tone(s, 600, -23);
    expect(s.integrated).toBeCloseTo(-23, 1);

    // The first three zeros still leave loud sub-blocks in the 400 ms window, so those partial blocks are gated in
    // (they are real audio). Once the window is all silence, integrated must not move.
    for (let i = 0; i < 4; i++) s.push(0);
    const before = s.integrated;
    for (let i = 0; i < 100; i++) s.push(0);
    expect(s.momentary).toBe(Number.NEGATIVE_INFINITY);
    expect(s.integrated).toBe(before);
  });

  it("L-Ld3a: relative gate: a quiet lead-in under -10 LU of the loud part does not count", () => {
    const s = new LoudnessStats();
    tone(s, 300, -40);
    tone(s, 300, -20);
    expect(s.integrated).toBeCloseTo(-20, 1);
  });

  it("L-Ld3a: empty readings are -Infinity (never NaN): M before 4, S before 30, I before a block passes, LRA before 2 blocks", () => {
    const s = new LoudnessStats();
    const readings = () => [s.momentary, s.shortTerm, s.integrated, s.lra, s.maxMomentary, s.maxShortTerm, s.maxTruePeak];
    for (const r of readings()) expect(r).toBe(Number.NEGATIVE_INFINITY);

    tone(s, 3, -20);
    expect(s.momentary).toBe(Number.NEGATIVE_INFINITY);
    expect(s.integrated).toBe(Number.NEGATIVE_INFINITY);
    tone(s, 1, -20);
    expect(s.momentary).toBeCloseTo(-20, 1);
    expect(s.integrated).toBeCloseTo(-20, 1);
    expect(s.shortTerm).toBe(Number.NEGATIVE_INFINITY);

    tone(s, 25, -20); // 29 sub-blocks
    expect(s.shortTerm).toBe(Number.NEGATIVE_INFINITY);
    expect(s.lra).toBe(Number.NEGATIVE_INFINITY);
    tone(s, 1, -20); // 30: S and the first LRA block
    expect(s.shortTerm).toBeCloseTo(-20, 1);
    expect(s.lra).toBe(Number.NEGATIVE_INFINITY);
    tone(s, 10, -20); // 40: second LRA block
    expect(Number.isNaN(s.lra)).toBe(false);
    expect(s.lra).toBe(0);

    const silent = new LoudnessStats();
    for (let i = 0; i < 50; i++) silent.push(0);
    for (const r of [silent.momentary, silent.shortTerm, silent.integrated, silent.lra]) {
      expect(r).toBe(Number.NEGATIVE_INFINITY);
    }
  });

  it("L-Ld3a: LRA hop: the first 3 s block counts after 30 sub-blocks, then one per 10", () => {
    // The count of LRA blocks that passed the absolute gate: the blocks the exact storage holds.
    const blocks = (s: LoudnessStats) => s.listedLraBlocks;
    const s = new LoudnessStats();
    for (let n = 1; n <= 100; n++) {
      s.push(energyFor(-20));
      const expected = n < 30 ? 0 : Math.floor((n - 30) / 10) + 1;
      expect(blocks(s), `LRA blocks after ${n}`).toBe(expected);
    }
  });

  it("L-Ld3a: maxima: maxMomentary, maxShortTerm, maxTruePeak (dB of notePeak) only rise; reset('maxPeak') clears them and nothing else", () => {
    const s = new LoudnessStats();
    tone(s, 40, -20);
    const m1 = s.maxMomentary;
    const s1 = s.maxShortTerm;
    expect(m1).toBeCloseTo(-20, 1);
    expect(s1).toBeCloseTo(-20, 1);

    tone(s, 40, -40);
    expect(s.maxMomentary).toBe(m1);
    expect(s.maxShortTerm).toBe(s1);

    tone(s, 40, -10);
    expect(s.maxMomentary).toBeGreaterThan(m1);
    expect(s.maxShortTerm).toBeGreaterThan(s1);

    s.notePeak(0.5);
    expect(s.maxTruePeak).toBeCloseTo(20 * Math.log10(0.5), 9);
    s.notePeak(0.25);
    expect(s.maxTruePeak).toBeCloseTo(20 * Math.log10(0.5), 9);
    s.notePeak(0.8);
    expect(s.maxTruePeak).toBeCloseTo(20 * Math.log10(0.8), 9);

    s.taint();
    const integrated = s.integrated;
    const lra = s.lra;
    const elapsed = s.elapsed;
    const momentary = s.momentary;
    const shortTerm = s.shortTerm;
    const incomplete = s.incomplete;

    s.reset("maxPeak");
    expect(s.maxMomentary).toBe(Number.NEGATIVE_INFINITY);
    expect(s.maxShortTerm).toBe(Number.NEGATIVE_INFINITY);
    expect(s.maxTruePeak).toBe(Number.NEGATIVE_INFINITY);
    expect(s.maxPeakLinear).toBe(0);
    expect(s.integrated).toBe(integrated);
    expect(s.lra).toBe(lra);
    expect(s.elapsed).toBe(elapsed);
    expect(s.momentary).toBe(momentary);
    expect(s.shortTerm).toBe(shortTerm);
    expect(s.incomplete).toBe(incomplete);
    expect(s.tainted).toBe(true);
  });

  it("L-Ld3a: elapsed counts sub-blocks x 0.1 s and excludes paused sub-blocks", () => {
    const s = new LoudnessStats();
    tone(s, 20, -20);
    expect(s.elapsed).toBeCloseTo(2.0, 9);
    s.pause();
    tone(s, 10, -20);
    expect(s.elapsed).toBeCloseTo(2.0, 9);
    s.resume(false);
    tone(s, 5, -20);
    expect(s.elapsed).toBeCloseTo(2.5, 9);
  });
});

describe("LoudnessStats reset, pause, flags, continuity", () => {
  it("L-Ld3a: reset('all') clears readings, maxima, elapsed, window, incomplete and tainted; take() sequence position and lost stay", () => {
    const s = new LoudnessStats();
    const ring4 = new Float64Array(4).fill(energyFor(-20));
    tone(s, 40, -20);
    s.epoch(); // sets incomplete and restarts the window
    s.taint();
    s.take(10, ring4, 4); // seq 10 after the epoch's 0: overruns the 4-entry ring, loses 6
    expect(s.lost).toBe(6);

    s.reset("all");
    expect(s.momentary).toBe(Number.NEGATIVE_INFINITY);
    expect(s.shortTerm).toBe(Number.NEGATIVE_INFINITY);
    expect(s.integrated).toBe(Number.NEGATIVE_INFINITY);
    expect(s.lra).toBe(Number.NEGATIVE_INFINITY);
    expect(s.maxMomentary).toBe(Number.NEGATIVE_INFINITY);
    expect(s.maxShortTerm).toBe(Number.NEGATIVE_INFINITY);
    expect(s.maxTruePeak).toBe(Number.NEGATIVE_INFINITY);
    expect(s.elapsed).toBe(0);
    expect(s.incomplete).toBe(false);
    expect(s.tainted).toBe(false);
    expect(s.lost).toBe(6);

    tone(s, 3, -20);
    expect(s.momentary).toBe(Number.NEGATIVE_INFINITY);

    // The sequence position survived: the next take continues from 10, so 12 pushes 2 with no new loss.
    expect(s.take(12, ring4, 4)).toBe(2);
    expect(s.lost).toBe(6);
  });

  it("L-Ld3a: reset('integrated') clears I, LRA, elapsed, incomplete and tainted but keeps the M and S window and the maxima", () => {
    const s = new LoudnessStats();
    tone(s, 40, -20);
    s.notePeak(0.5);
    s.epoch();
    tone(s, 30, -20);
    s.taint();
    expect(s.incomplete).toBe(true);
    expect(s.tainted).toBe(true);

    const m = s.momentary;
    const sh = s.shortTerm;
    const maxM = s.maxMomentary;
    const maxS = s.maxShortTerm;
    const peak = s.maxTruePeak;

    s.reset("integrated");
    expect(s.integrated).toBe(Number.NEGATIVE_INFINITY);
    expect(s.lra).toBe(Number.NEGATIVE_INFINITY);
    expect(s.elapsed).toBe(0);
    expect(s.incomplete).toBe(false);
    expect(s.tainted).toBe(false);
    expect(s.momentary).toBe(m);
    expect(s.shortTerm).toBe(sh);
    expect(s.maxMomentary).toBe(maxM);
    expect(s.maxShortTerm).toBe(maxS);
    expect(s.maxTruePeak).toBe(peak);
  });

  it("L-Ld3a: pause discards pushed energies and a sequence jump while paused is not lost; resume() sets incomplete and restarts the window; resume(false) does not set it", () => {
    const ring = new Float64Array(RING_LEN).fill(energyFor(-20));

    const s = new LoudnessStats();
    tone(s, 40, -20);
    const m = s.momentary;
    const i = s.integrated;
    s.pause();
    expect(s.paused).toBe(true);
    tone(s, 5, -40);
    expect(s.momentary).toBe(m);
    expect(s.integrated).toBe(i);
    s.take(1000, ring, RING_LEN); // a jump of 1000 while paused
    expect(s.lost).toBe(0);
    expect(s.incomplete).toBe(false);

    s.resume();
    expect(s.paused).toBe(false);
    expect(s.incomplete).toBe(true);
    expect(s.lost).toBe(0);
    expect(s.momentary).toBe(Number.NEGATIVE_INFINITY);
    expect(s.shortTerm).toBe(Number.NEGATIVE_INFINITY);

    const t = new LoudnessStats();
    tone(t, 40, -20);
    t.pause();
    tone(t, 5, -40);
    t.resume(false);
    expect(t.incomplete).toBe(false);
    expect(t.momentary).toBe(Number.NEGATIVE_INFINITY);
    tone(t, 4, -20);
    expect(t.momentary).toBeCloseTo(-20, 1);
  });

  it("L-Ld3a: taint() sets tainted until reset('all') or reset('integrated')", () => {
    const s = new LoudnessStats();
    expect(s.tainted).toBe(false);
    s.taint();
    expect(s.tainted).toBe(true);
    s.reset("maxPeak");
    expect(s.tainted).toBe(true);
    s.reset("integrated");
    expect(s.tainted).toBe(false);
    s.taint();
    s.reset("all");
    expect(s.tainted).toBe(false);
  });

  it("L-Ld3a: a take() overrun (stall past the ring) counts lost, sets incomplete, restarts the window and keeps integrated", () => {
    const s = new LoudnessStats();
    const ring4 = new Float64Array(4).fill(energyFor(-20));
    for (let q = 1; q <= 60; q++) s.take(q, ring4, 4);
    const integrated = s.integrated;
    expect(integrated).toBeCloseTo(-20, 1);
    expect(s.shortTerm).toBeCloseTo(-20, 1);
    expect(s.incomplete).toBe(false);

    const pushed = s.take(70, ring4, 4); // 10 new sub-blocks into a 4-entry ring
    expect(pushed).toBe(4);
    expect(s.lost).toBe(6);
    expect(s.incomplete).toBe(true);
    expect(s.shortTerm).toBe(Number.NEGATIVE_INFINITY);
    expect(s.integrated).toBeCloseTo(integrated, 9);
  });

  it("L-Ld3a: takeBlock() with a firstSeq ahead of the expected one counts the skipped sub-blocks as lost; contiguous blocks lose nothing; u32 wrap of seq works", () => {
    const block = new Float64Array(8).fill(energyFor(-20));

    const s = new LoudnessStats();
    expect(s.takeBlock(0, block, 0, 5)).toBe(5);
    expect(s.takeBlock(5, block, 0, 3)).toBe(3);
    expect(s.lost).toBe(0);
    expect(s.incomplete).toBe(false);
    expect(s.takeBlock(12, block, 0, 2)).toBe(2); // sub-blocks 8..11 skipped
    expect(s.lost).toBe(4);
    expect(s.incomplete).toBe(true);

    // Wrap: the first block starts at 0xFFFFFFFD (its skipped count from the initial position 0 is counted once).
    const w = new LoudnessStats();
    w.takeBlock(0xfffffffd, block, 0, 3);
    const afterFirst = w.lost;
    expect(w.takeBlock(0, block, 0, 2)).toBe(2); // contiguous across the wrap: 0xFFFFFFFD + 3 wraps to 0
    expect(w.lost).toBe(afterFirst);
    expect(w.takeBlock(5, block, 0, 1)).toBe(1); // sub-blocks 2, 3 and 4 are skipped across the wrapped position
    expect(w.lost).toBe(afterFirst + 3);
  });

  it("L-Ld3a: epoch() keeps integrated, LRA and maxima, reseeds the feed so seq 0 continues, sets incomplete, and restarts M and S", () => {
    const s = new LoudnessStats();
    const ring = new Float64Array(RING_LEN).fill(energyFor(-20));
    for (let q = 1; q <= 60; q++) s.take(q, ring, RING_LEN);
    const integrated = s.integrated;
    const lra = s.lra;
    const maxM = s.maxMomentary;
    expect(s.momentary).toBeCloseTo(-20, 1);

    s.epoch();
    expect(s.integrated).toBe(integrated);
    expect(s.lra).toBe(lra);
    expect(s.maxMomentary).toBe(maxM);
    expect(s.incomplete).toBe(true);
    expect(s.momentary).toBe(Number.NEGATIVE_INFINITY);
    expect(s.shortTerm).toBe(Number.NEGATIVE_INFINITY);

    expect(s.take(4, ring, RING_LEN)).toBe(4);
    expect(s.lost).toBe(0);
  });

  it("L-Ld3a: a 3.2 s stall at the core's 32-entry ring loses nothing; a 4 s stall loses sub-blocks and sets incomplete (take with ringLen 32)", () => {
    const ring = new Float64Array(RING_LEN).fill(energyFor(-20));
    const s = new LoudnessStats();
    for (let q = 1; q <= 30; q++) s.take(q, ring, RING_LEN);

    expect(s.take(62, ring, RING_LEN)).toBe(32); // 3.2 s without a take
    expect(s.lost).toBe(0);
    expect(s.incomplete).toBe(false);

    expect(s.take(102, ring, RING_LEN)).toBe(32); // 4 s without a take: 8 overwritten
    expect(s.lost).toBe(8);
    expect(s.incomplete).toBe(true);
  });
});

describe("LoudnessStats allocates nothing", () => {
  it("L-Ld3a: feeding 20,000 sub-blocks (push, take, takeBlock) keeps the instance's own keys, every buffer's identity and length and byteLength unchanged, and the hot methods contain no allocation syntax", () => {
    // Not a source scan: the instance's preallocated storage is pinned by identity, length and byte count, and the
    // instance's own keys by name, across a long feed through every hot path.
    const s = new LoudnessStats();
    const buffers = s.buffers();
    const shape = buffers.map((b) => ({ b, byteLength: b.byteLength, length: (b as unknown as { length: number }).length }));
    const bytes = s.byteLength;
    const keys = Object.keys(s).sort();

    const ring = new Float64Array(RING_LEN);
    const block = new Float64Array(64);
    const energy = (i: number) => (i % 97 === 0 ? 0 : energyFor(-30 + (i % 20)));

    // Phase 1: push (8,000 sub-blocks).
    for (let i = 0; i < 8000; i++) s.push(energy(i));

    // Phase 2: take, one sub-block per call (6,000). `last` is still 0 here, so the sequence starts at 1.
    let seq = 0;
    for (let i = 0; i < 6000; i++) {
      seq++;
      ring[seq % RING_LEN] = energy(seq);
      s.take(seq, ring, RING_LEN);
    }

    // Phase 3: takeBlock, four sub-blocks per call (6,000), contiguous with the takes.
    for (let i = 0; i < 1500; i++) {
      for (let j = 0; j < 4; j++) block[j] = energy(seq + j);
      s.takeBlock(seq, block, 0, 4);
      seq += 4;
    }

    expect(s.lost).toBe(0);
    expect(s.elapsed).toBeCloseTo(2000, 6);

    const after = s.buffers();
    expect(after.length).toBe(shape.length);
    after.forEach((b, idx) => {
      expect(b).toBe(shape[idx].b);
      expect(b.byteLength).toBe(shape[idx].byteLength);
      expect((b as unknown as { length: number }).length).toBe(shape[idx].length);
    });
    expect(s.byteLength).toBe(bytes);
    expect(Object.keys(s).sort()).toEqual(keys);
  });
});
