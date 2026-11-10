// A3.1 leaf L2: the selection's per-frame cost (architecture §6.4: bookkeeping and selection at most 0.25 ms; api §9
// row A3.1: 4,096 logical voices at most 0.25 ms p99 in Node). 4,096 voices on the core, a mixed cap of 128 (default)
// and 256 (high), a tenth of the gains moving every frame (sources moving, fades), a few voices crossing the cap each
// frame, timed per `Selection.run` with `performance.now()`.
//
// Timing in a shared test run is noisy (other files run in parallel workers), so each case takes the best of a few
// attempts; the gate is on that attempt's p99. The informational case adds the spatial gain refresh for every voice
// (listener moving each frame: distance model and listener-space direction) to show the whole per-frame bookkeeping.
import { describe, expect, it } from "vitest";
import { ListenerBasis, Selection, type SelectionSink } from "./selection";
import { DistanceEffect } from "./spatial";
import { VoiceFlag, VoiceState, VoiceTable } from "./voiceTable";

const VOICES = 4096;
const WARMUP = 300;
const FRAMES = 3000;
const ATTEMPTS = 4;
const GATE_P99_MS = 0.25;

/** Seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Result {
  p50: number;
  p99: number;
  max: number;
  changes: number;
}

function percentile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** One attempt: a fresh table of 4,096 voices, `FRAMES` timed frames. `spatial` adds the gain refresh per voice. */
function attempt(cap: number, spatial: boolean, seed: number): Result {
  const r = rng(seed);
  const table = new VoiceTable(VOICES);
  const sel = new Selection(table);
  let changes = 0;
  const sink: SelectionSink = {
    setMixed: () => void changes++,
    steal: () => {},
  };
  for (let k = 0; k < VOICES; k++) {
    const i = table.allocate(k % 8, Math.floor(r() * 256), 1 + (k % 4), VoiceState.WAITING_FOR_DATA) & 0xffff;
    table.gain[i] = r();
    table.posX[i] = (r() - 0.5) * 200;
    table.posY[i] = (r() - 0.5) * 20;
    table.posZ[i] = (r() - 0.5) * 200;
    table.flags[i] = VoiceFlag.SPATIAL | (k % 3 === 0 ? VoiceFlag.LOOP : 0);
    table.state[i] = sel.admit(i, cap) ? VoiceState.PLAYING : VoiceState.VIRTUAL;
  }
  for (let b = 0; b < 8; b++) sel.busGain[b] = 0.5 + b / 16;
  const basis = new ListenerBasis();
  const distance = new DistanceEffect();
  const pos = [0, 0, 0];
  const fwd = [0, 0, -1];
  const up = [0, 1, 0];
  const times = new Float64Array(FRAMES);
  let t = 0;
  for (let f = 0; f < WARMUP + FRAMES; f++) {
    // A tenth of the gains move a little; a few jump (a sound starting, a fade landing).
    for (let k = 0; k < VOICES / 10; k++) {
      const i = Math.floor(r() * VOICES);
      const g = table.gain[i]! * (0.9 + 0.2 * r());
      table.gain[i] = g > 1 ? 1 : g;
    }
    for (let k = 0; k < 4; k++) table.gain[Math.floor(r() * VOICES)] = r();
    const t0 = performance.now();
    if (spatial) {
      t += 1 / 60;
      pos[0] = 50 * Math.sin(t);
      pos[2] = 50 * Math.cos(t);
      fwd[0] = Math.cos(t);
      fwd[2] = -Math.sin(t);
      basis.set(pos, fwd, up);
      for (let i = 0; i < VOICES; i++) {
        basis.locate(table.posX[i]!, table.posY[i]!, table.posZ[i]!);
        distance.refDistance = 1;
        distance.maxDistance = 100;
        table.gain[i] = Math.max(0, distance.gain(basis.distance));
        table.dirX[i] = basis.dirX;
        table.dirY[i] = basis.dirY;
        table.dirZ[i] = basis.dirZ;
      }
    }
    sel.run(cap, sink);
    const dt = performance.now() - t0;
    if (f >= WARMUP) times[f - WARMUP] = dt;
  }
  times.sort();
  return { p50: percentile(times, 0.5), p99: percentile(times, 0.99), max: times[FRAMES - 1]!, changes };
}

function best(cap: number, spatial: boolean): Result {
  let bestResult: Result | null = null;
  for (let a = 0; a < ATTEMPTS; a++) {
    const res = attempt(cap, spatial, 1 + a);
    if (!bestResult || res.p99 < bestResult.p99) bestResult = res;
    if (!spatial && res.p99 <= GATE_P99_MS / 2) break; // clearly within the gate
  }
  return bestResult!;
}

const fmt = (r: Result): string => `p50 ${r.p50.toFixed(4)} ms, p99 ${r.p99.toFixed(4)} ms, max ${r.max.toFixed(4)} ms, ${r.changes} SET_MIXED`;

describe("selection bench (A3.1 L2): 4,096 logical voices", () => {
  it("cap 128 (default preset): p99 at most 0.25 ms", { timeout: 120_000 }, () => {
    const r = best(128, false);
    console.log(`[selection bench] 4,096 voices, cap 128: ${fmt(r)}`);
    expect(r.p99).toBeLessThanOrEqual(GATE_P99_MS);
  });

  it("cap 256 (high preset): p99 at most 0.25 ms", { timeout: 120_000 }, () => {
    const r = best(256, false);
    console.log(`[selection bench] 4,096 voices, cap 256: ${fmt(r)}`);
    expect(r.p99).toBeLessThanOrEqual(GATE_P99_MS);
  });

  it("informational: plus the spatial gain refresh of every voice with the listener moving", { timeout: 120_000 }, () => {
    const r = best(128, true);
    console.log(`[selection bench] 4,096 moving spatial voices, cap 128, gains refreshed: ${fmt(r)}`);
    expect(r.p50).toBeGreaterThan(0);
  });
});
