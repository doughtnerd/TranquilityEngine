// ADR 0166 K1: the beat clock against the S4 tolerances (architecture §4.5 "Tolerances"), on display-frame jitter traces
// replayed through the engine's real ClockMap (no wall clock): the S3 spike's recorded confirming run, and traces
// synthesised from its measured distributions. S4:
// - >= 95% of steady beats in the ideal frame, the rest within one frame;
// - every tempo-change and transition beat in the ideal frame;
// - 0 missed, doubled or phantom (a beat coalesced into a long frame's call counts as delivered, with `missed`).
// Rougher-than-measured device clocks are [U] (architecture §4.5: real devices are unverified); they are held to
// "within one frame, nothing missed, doubled or phantom" and their ideal-frame share is reported.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { _resetMusicPlayers } from "./musicSystem";
import { _resetSegmentRuns } from "./segmentRun";
import { rigClips } from "./testing/beatRig";
import { recordedTrace, replayClock, runScenario, score, synthTrace, type JitterTrace, type Score } from "./testing/jitterTrace";

beforeEach(() => rigClips(3600));
afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

/** `K1_TRACE_REPORT=1 npx vitest run beatClock.trace` prints each trace's tables (as a failure, which vitest shows). */
const report = (line: string): void => {
  if (process.env.K1_TRACE_REPORT) expect.soft(line).toBe("");
};

function play(tr: JitterTrace): Score {
  const { fired, nodeEpoch } = runScenario(tr);
  const s = score(tr, fired, nodeEpoch);
  // One line per trace for the build log (`vitest --reporter verbose` shows it).
  const b = s.buckets;
  const pct = (x: { n: number; ideal: number }) => `${x.ideal}/${x.n}`;
  report(`[K1 trace] ${tr.name}: steady ${pct(b.steady)} ${JSON.stringify(b.steady.offsets)}, tempo ${pct(b.tempo)}, transition ${pct(b.transition)}, hitch ${pct(b.hitch)} ${JSON.stringify(b.hitch.offsets)}; missed ${s.missed} doubled ${s.doubled} phantom ${s.phantom} coalesced ${s.coalesced}; grid error ${(s.gridError * 1e6).toFixed(1)} us`);
  return s;
}

/** The S4 tolerances. */
function meetsS4(s: Score): void {
  const { steady, tempo, transition } = s.buckets;
  expect(steady.n).toBeGreaterThan(50);
  expect(steady.ideal / steady.n).toBeGreaterThanOrEqual(0.95);
  for (const off of Object.keys(steady.offsets)) expect(Math.abs(Number(off))).toBeLessThanOrEqual(1);
  expect(tempo.n).toBeGreaterThan(0);
  expect(tempo.ideal).toBe(tempo.n);
  expect(transition.n).toBeGreaterThan(0);
  expect(transition.ideal).toBe(transition.n);
  expect(s.missed).toBe(0);
  expect(s.doubled).toBe(0);
  expect(s.phantom).toBe(0);
}

describe("S4 tolerances on the recorded S3 trace", () => {
  it("the replayed ClockMap is the spike's: Audio.time within 0.1 ms of the truth at p50", () => {
    const tr = recordedTrace();
    const clock = replayClock(tr);
    const err = Array.from(clock.time, (t, i) => Math.abs(t - (tr.truth[i]! - tr.limiterFrames) / tr.sr)).slice(100).sort((a, b) => a - b);
    expect(err[Math.floor(err.length / 2)]!).toBeLessThan(1e-4);
  });

  it("meets S4: steady, tempo change, stamped transition, 8 seeks learned from STATUS, 3 hitches", () => {
    const s = play(recordedTrace());
    meetsS4(s);
    // The beat clock's grid is the core's: every fired beat within one frame (at 44.1 kHz) of the rendered one.
    expect(s.gridError).toBeLessThan(1 / 44_100);
  });
});

describe("S4 tolerances on traces synthesised from S3's distributions", () => {
  const measured = [
    synthTrace({ name: "synth S3-like, seed 1", seed: 1 }),
    synthTrace({ name: "synth S3-like, seed 2, -6 ppm", seed: 2, ppm: -6 }),
    synthTrace({ name: "synth hint 0 (9 ms render-ahead, +528 ppm), seed 3", seed: 3, renderAheadMs: 9, noiseMs: 0.25, ppm: 528 }),
    synthTrace({ name: "synth 48 kHz, 2 ms wander, seed 4", seed: 4, sr: 48_000, wanderMs: 2 }),
  ];
  for (const tr of measured) {
    it(`meets S4: ${tr.name}`, () => meetsS4(play(tr)));
  }
});

describe("rougher than S3 measured ([U]: real devices)", () => {
  const rough = [
    synthTrace({ name: "rough: 10 ms timestamp quantum, seed 5", seed: 5, quantumMs: 10, noiseMs: 0.5, excursions: 40 }),
    synthTrace({ name: "rough: 1 ms rAF jitter, 1 ms noise, seed 6", seed: 6, frameJitterMs: 1, noiseMs: 1 }),
    // S3's one +3650 ppm run (the null sink's pacing, not a crystal): the window (rAF ms) falls 0.06 ms a frame short of
    // the audio clock and the offset filter lags 0.5 ms, so beats on a window's edge go one frame late.
    synthTrace({ name: "rough: +3650 ppm, seed 7", seed: 7, ppm: 3650 }),
    // Long frames over beats: each beat heard in one is delivered once, coalesced into the next frame's call.
    synthTrace({ name: "rough: 700 / 1200 / 2500 ms hitches, seed 8", seed: 8, hitches: [700, 1200, 2500] }),
  ];
  for (const tr of rough) {
    it(`within one frame, nothing missed, doubled or phantom: ${tr.name}`, () => {
      const s = play(tr);
      for (const b of [s.buckets.steady, s.buckets.tempo, s.buckets.transition]) {
        for (const off of Object.keys(b.offsets)) expect(Math.abs(Number(off))).toBeLessThanOrEqual(1);
      }
      expect(s.buckets.steady.ideal / s.buckets.steady.n).toBeGreaterThan(0.8);
      expect([s.missed, s.doubled, s.phantom]).toEqual([0, 0, 0]);
    });
  }
});
