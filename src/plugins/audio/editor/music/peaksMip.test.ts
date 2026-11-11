// L-Ed1a fills these (peaksMip.ts: buildMips, pickLevel, binSpan). Each case is named for the rule it checks.
import { describe, it } from "vitest";

describe("buildMips", () => {
  it.skip("returns the base level itself first and halves the bin count (rounded up) at each level", () => {});
  it.skip("doubles binFrames at each level", () => {});
  it.skip("takes the min of the mins and the max of the maxes under each bin", () => {});
  it.skip("copies an odd last bin unchanged", () => {});
  it.skip("reduces each channel independently and keeps the data channel-major", () => {});
  it.skip("stops at one bin by default and at minBins when given", () => {});
  it.skip("returns just the base for an empty level and for a one-bin level", () => {});
  it.skip("does not change the base data", () => {});
  it.skip("keeps the clip's overall min and max at every level", () => {});
});

describe("pickLevel", () => {
  it.skip("picks the coarsest level whose binFrames is at most the frames per pixel", () => {});
  it.skip("picks level 0 when zoomed in past the base level", () => {});
  it.skip("picks the coarsest level when zoomed out past it", () => {});
  it.skip("gives 0 for an empty span or a width below 1", () => {});
  it.skip("reads at most about one bin per pixel across a range of zooms", () => {});
});

describe("binSpan", () => {
  it.skip("returns floor(start / binFrames) to ceil(end / binFrames)", () => {});
  it.skip("clamps to the level's bins", () => {});
  it.skip("returns an empty run for an empty, inverted or out-of-range span", () => {});
});
