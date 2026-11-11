// Ed4: tempo helpers. Every case is the L-Ed4a leaf's to fill and un-skip.
import { describe, it } from "vitest";

describe("tapTempo (L-Ed4a)", () => {
  it.skip("returns null for no taps, one tap, a non-finite timestamp or a non-ascending run", () => {});
  it.skip("two taps 0.5 s apart give 120 bpm, used 2, spread 0", () => {});
  it.skip("uses the median interval, so one stray tap does not move the result", () => {});
  it.skip("a gap longer than resetAfter starts a new run; a gap equal to it does not", () => {});
  it.skip("keeps only the last `window` taps of a run", () => {});
  it.skip("the median of an even interval count is the mean of the middle two", () => {});
  it.skip("clamps to MIN_BPM and MAX_BPM", () => {});
  it.skip("spread is the median absolute deviation of the intervals", () => {});
});

describe("tempoFromLength (L-Ed4a)", () => {
  it.skip("8 s over 4 bars of 4/4 is 120 bpm", () => {});
  it.skip("the beat unit does not change the number (6/8 and 3/4 over the same bars agree)", () => {});
  it.skip("subtracts gridOffset from the length", () => {});
  it.skip("flags a tempo outside MIN_BPM..MAX_BPM as not valid but still returns it", () => {});
  it.skip("returns null for non-positive or non-finite inputs, a fractional bar count and a length not above gridOffset", () => {});
});

describe("barCountCandidates (L-Ed4a)", () => {
  it.skip("lists the bar counts that fit 60..200 bpm, ascending, with their bpm", () => {});
  it.skip("honours minBpm, maxBpm, gridOffset and limit", () => {});
  it.skip("is empty for invalid inputs or when no count fits", () => {});
});
