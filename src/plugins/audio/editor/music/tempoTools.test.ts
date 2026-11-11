// Ed4: tempo helpers. Every case is the L-Ed4a leaf's to fill and un-skip.
import { describe, expect, it } from "vitest";
import { MAX_BPM, MIN_BPM } from "../../../../engine/audio/musicFormat";
import { barCountCandidates, tapTempo, tempoFromLength } from "./tempoTools";

describe("tapTempo (L-Ed4a)", () => {
  it("returns null for no taps, one tap, a non-finite timestamp or a non-ascending run", () => {
    expect(tapTempo([])).toBeNull();
    expect(tapTempo([1])).toBeNull();
    expect(tapTempo([0, NaN])).toBeNull();
    expect(tapTempo([0, Infinity])).toBeNull();
    expect(tapTempo([1, 1])).toBeNull();
    expect(tapTempo([0, 0.5, 0.4])).toBeNull();
  });

  it("two taps 0.5 s apart give 120 bpm, used 2, spread 0", () => {
    expect(tapTempo([0, 0.5])).toEqual({ bpm: 120, used: 2, spread: 0 });
  });

  it("uses the median interval, so one stray tap does not move the result", () => {
    const result = tapTempo([0, 0.5, 1.0, 1.5, 2.0, 3.4]);
    expect(result?.bpm).toBe(120);
    expect(result?.used).toBe(6);
  });

  it("a gap longer than resetAfter starts a new run; a gap equal to it does not", () => {
    // Gap 3 > 2: only the taps after it form the run, so two taps remain.
    expect(tapTempo([0, 0.5, 3.5, 4.0])).toEqual({ bpm: 120, used: 2, spread: 0 });
    // Gap exactly 2 = resetAfter: no reset, so all four taps are used.
    expect(tapTempo([0, 0.5, 2.5, 3.0])?.used).toBe(4);
    // One tap after a reset is not enough.
    expect(tapTempo([0, 1, 4])).toBeNull();
  });

  it("keeps only the last `window` taps of a run", () => {
    const taps = [0, 1, 2, 2.5, 3.0];
    expect(tapTempo(taps)).toEqual({ bpm: 80, used: 5, spread: 0.25 });
    expect(tapTempo(taps, { window: 3 })).toEqual({ bpm: 120, used: 3, spread: 0 });
    // Window below the minimum of 2 is raised to 2.
    expect(tapTempo(taps, { window: 0 })).toEqual({ bpm: 120, used: 2, spread: 0 });
  });

  it("the median of an even interval count is the mean of the middle two", () => {
    // Intervals [0.5, 0.5, 1, 1]: the middle two are 0.5 and 1, mean 0.75, so 80 bpm.
    expect(tapTempo([0, 1, 2, 2.5, 3.0])?.bpm).toBe(80);
  });

  it("clamps to MIN_BPM and MAX_BPM", () => {
    expect(tapTempo([0, 0.01])?.bpm).toBe(MAX_BPM);
    expect(tapTempo([0, 100], { resetAfter: 1000 })?.bpm).toBe(MIN_BPM);
  });

  it("spread is the median absolute deviation of the intervals", () => {
    // Intervals [1, 2, 4]: median 2, deviations [1, 0, 2], median deviation 1.
    expect(tapTempo([0, 1, 3, 7], { resetAfter: 10 })).toEqual({ bpm: 30, used: 4, spread: 1 });
  });
});

describe("tempoFromLength (L-Ed4a)", () => {
  it("8 s over 4 bars of 4/4 is 120 bpm", () => {
    expect(tempoFromLength(8, 4, 4)).toEqual({ bpm: 120, valid: true });
  });

  it("the beat unit does not change the number (6/8 and 3/4 over the same bars agree)", () => {
    // 2 bars of 6 eighth-beats and 4 bars of 3 quarter-beats are both 12 beats.
    const sixEight = tempoFromLength(10, 2, 6);
    const threeFour = tempoFromLength(10, 4, 3);
    expect(sixEight?.bpm).toBe(threeFour?.bpm);
    expect(sixEight?.bpm).toBe(72);
  });

  it("subtracts gridOffset from the length", () => {
    expect(tempoFromLength(10.5, 4, 4, 0.5)?.bpm).toBe(96);
    expect(tempoFromLength(10.5, 4, 4, 0.5)?.bpm).toBe(tempoFromLength(10, 4, 4)?.bpm);
  });

  it("flags a tempo outside MIN_BPM..MAX_BPM as not valid but still returns it", () => {
    const fast = tempoFromLength(0.1, 1, 4);
    expect(fast?.valid).toBe(false);
    expect(fast?.bpm).toBeCloseTo(2400);
    const slow = tempoFromLength(100, 1, 1);
    expect(slow?.valid).toBe(false);
    expect(slow?.bpm).toBeCloseTo(0.6);
  });

  it("returns null for non-positive or non-finite inputs, a fractional bar count and a length not above gridOffset", () => {
    expect(tempoFromLength(0, 4, 4)).toBeNull();
    expect(tempoFromLength(-1, 4, 4)).toBeNull();
    expect(tempoFromLength(NaN, 4, 4)).toBeNull();
    expect(tempoFromLength(Infinity, 4, 4)).toBeNull();
    expect(tempoFromLength(8, 0, 4)).toBeNull();
    expect(tempoFromLength(8, -1, 4)).toBeNull();
    expect(tempoFromLength(8, NaN, 4)).toBeNull();
    expect(tempoFromLength(8, Infinity, 4)).toBeNull();
    expect(tempoFromLength(8, 1.5, 4)).toBeNull();
    expect(tempoFromLength(8, 4, 0)).toBeNull();
    expect(tempoFromLength(8, 4, NaN)).toBeNull();
    expect(tempoFromLength(8, 4, Infinity)).toBeNull();
    expect(tempoFromLength(8, 4, 4, 8)).toBeNull();
    expect(tempoFromLength(8, 4, 4, 9)).toBeNull();
  });
});

describe("barCountCandidates (L-Ed4a)", () => {
  it("lists the bar counts that fit 60..200 bpm, ascending, with their bpm", () => {
    // 8 s at 4/4: n bars give 30 * n bpm, so 60..200 fits n = 2..6.
    expect(barCountCandidates(8, 4)).toEqual([
      { bars: 2, bpm: 60 },
      { bars: 3, bpm: 90 },
      { bars: 4, bpm: 120 },
      { bars: 5, bpm: 150 },
      { bars: 6, bpm: 180 },
    ]);
  });

  it("honours minBpm, maxBpm, gridOffset and limit", () => {
    expect(barCountCandidates(8, 4, { minBpm: 100 }).map((c) => c.bars)).toEqual([4, 5, 6]);
    expect(barCountCandidates(8, 4, { maxBpm: 130 }).map((c) => c.bars)).toEqual([2, 3, 4]);
    expect(barCountCandidates(8.5, 4, { gridOffset: 0.5 })).toEqual(barCountCandidates(8, 4));
    expect(barCountCandidates(8, 4, { limit: 2 }).map((c) => c.bars)).toEqual([2, 3]);
  });

  it("is empty for invalid inputs or when no count fits", () => {
    expect(barCountCandidates(0, 4)).toEqual([]);
    expect(barCountCandidates(8, NaN)).toEqual([]);
    expect(barCountCandidates(8, 4, { gridOffset: 8 })).toEqual([]);
    expect(barCountCandidates(8, 4, { minBpm: 61, maxBpm: 89 })).toEqual([]);
  });
});
