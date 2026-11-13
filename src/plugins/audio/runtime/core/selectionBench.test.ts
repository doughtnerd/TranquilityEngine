// A3.1 leaf L2: the selection's per-frame work at 4,096 logical voices (architecture §6.4, api §9 row A3.1). The
// wall-clock half (p99 at most 0.25 ms per `Selection.run`) moved to `selectionBench.bench.ts`, run apart from `npm
// test` (`tools/audio-bench/selection.vitest.config.mts`): a wall-clock gate fails when the machine is busy.
//
// What stays here is the work the selection does per frame, which a busy machine can't change: every voice on the core
// is a candidate (the bookkeeping pass is O(L)), the ranking sorts only the gathered few (far under L, so selection
// isn't an O(L log L) sort), the score updates sent stay within SCORE_BUDGET, and the mixed count obeys the cap.
import { describe, expect, it } from "vitest";
import { SCORE_BUDGET } from "./selection";
import { runRig, VOICES } from "./selectionBenchRig";

const WARMUP = 300;
const FRAMES = 1000;

interface Work {
  maxCandidates: number;
  minCandidates: number;
  meanRanked: number;
  maxRanked: number;
  maxScores: number;
  maxMixed: number;
  minMixed: number;
  changes: number;
}

function work(cap: number, spatial: boolean): Work {
  const w: Work = { maxCandidates: 0, minCandidates: Infinity, meanRanked: 0, maxRanked: 0, maxScores: 0, maxMixed: 0, minMixed: Infinity, changes: 0 };
  let ranked = 0;
  w.changes = runRig(cap, spatial, 1, WARMUP, FRAMES, (_f, s) => {
    w.maxCandidates = Math.max(w.maxCandidates, s.candidates);
    w.minCandidates = Math.min(w.minCandidates, s.candidates);
    ranked += s.ranked;
    w.maxRanked = Math.max(w.maxRanked, s.ranked);
    w.maxScores = Math.max(w.maxScores, s.scores);
    w.maxMixed = Math.max(w.maxMixed, s.mixed);
    w.minMixed = Math.min(w.minMixed, s.mixed);
  }).changes;
  w.meanRanked = ranked / FRAMES;
  return w;
}

describe("selection work (A3.1 L2): 4,096 logical voices", () => {
  for (const cap of [128, 256]) {
    it(`cap ${cap}: every voice is a candidate, the ranked set stays far under L, scores within budget`, () => {
      const w = work(cap, false);
      console.log(`[selection work] cap ${cap}: ${JSON.stringify(w)}`);
      expect(w.minCandidates).toBe(VOICES);
      expect(w.maxCandidates).toBe(VOICES);
      expect(w.maxMixed).toBeLessThanOrEqual(cap);
      expect(w.minMixed).toBeGreaterThan(0);
      expect(w.maxScores).toBeLessThanOrEqual(SCORE_BUDGET);
      // The gather threshold keeps the ranked set to under twice the cap (measured 1.2x), not all of L.
      expect(w.meanRanked).toBeLessThanOrEqual(2 * cap);
      expect(w.maxRanked).toBeLessThanOrEqual(3 * cap);
    });
  }

  it("informational: with the spatial gain refresh of every voice, the same counts hold", () => {
    const w = work(128, true);
    console.log(`[selection work] 4,096 moving spatial voices, cap 128: ${JSON.stringify(w)}`);
    expect(w.minCandidates).toBe(VOICES);
    expect(w.maxMixed).toBeLessThanOrEqual(128);
    expect(w.maxScores).toBeLessThanOrEqual(SCORE_BUDGET);
  });
});

