// L-Ed1a fills these (peaksMip.ts: buildMips, pickLevel, binSpan). Each case is named for the rule it checks.
import { describe, expect, it } from "vitest";
import { type PeakLevel, binAt, binSpan, buildMips, pickLevel } from "./peaksMip";

/** A level whose bin `bin` of `channel` is the `[min, max]` that `value(channel, bin)` returns. */
function makeLevel(binFrames: number, bins: number, channels: number, value: (channel: number, bin: number) => [number, number]): PeakLevel {
  const data = new Int16Array(channels * bins * 2);
  for (let c = 0; c < channels; c++) {
    for (let b = 0; b < bins; b++) {
      const [min, max] = value(c, b);
      data[(c * bins + b) * 2] = min;
      data[(c * bins + b) * 2 + 1] = max;
    }
  }
  return { binFrames, bins, channels, data };
}

const emptyLevel = (binFrames: number, bins: number): PeakLevel => makeLevel(binFrames, bins, 1, () => [0, 0]);

describe("buildMips", () => {
  it("returns the base level itself first and halves the bin count (rounded up) at each level", () => {
    const base = emptyLevel(4, 7);
    const levels = buildMips(base);
    expect(levels[0]).toBe(base);
    expect(levels.map((l) => l.bins)).toEqual([7, 4, 2, 1]);
  });

  it("doubles binFrames at each level", () => {
    const levels = buildMips(emptyLevel(3, 8));
    expect(levels.map((l) => l.binFrames)).toEqual([3, 6, 12, 24]);
  });

  it("takes the min of the mins and the max of the maxes under each bin", () => {
    const mins = [5, -2, 7, 0];
    const maxes = [6, 9, 8, 3];
    const base = makeLevel(1, 4, 1, (_c, b) => [mins[b], maxes[b]]);
    const [, l1] = buildMips(base);
    expect(binAt(l1, 0, 0)).toEqual({ min: -2, max: 9 });
    expect(binAt(l1, 0, 1)).toEqual({ min: 0, max: 8 });
  });

  it("copies an odd last bin unchanged", () => {
    const base = makeLevel(1, 3, 1, (_c, b) => [[1, 3, -5][b], [2, 4, -1][b]]);
    const [, l1] = buildMips(base);
    expect(l1.bins).toBe(2);
    expect(binAt(l1, 0, 0)).toEqual({ min: 1, max: 4 });
    expect(binAt(l1, 0, 1)).toEqual({ min: -5, max: -1 });
  });

  it("reduces each channel independently and keeps the data channel-major", () => {
    // Channel 0 spans [0, 10] in bin pairs; channel 1 is offset by 100.
    const base = makeLevel(1, 4, 2, (c, b) => [c * 100 + b, c * 100 + b + 10]);
    const [, l1] = buildMips(base);
    expect(l1.data.length).toBe(2 * 2 * 2);
    expect(binAt(l1, 0, 0)).toEqual({ min: 0, max: 11 });
    expect(binAt(l1, 0, 1)).toEqual({ min: 2, max: 13 });
    expect(binAt(l1, 1, 0)).toEqual({ min: 100, max: 111 });
    expect(binAt(l1, 1, 1)).toEqual({ min: 102, max: 113 });
    // Channel 0's bins come first in the array.
    expect(Array.from(l1.data.slice(0, 4))).toEqual([0, 11, 2, 13]);
  });

  it("stops at one bin by default and at minBins when given", () => {
    const base = emptyLevel(1, 9);
    expect(buildMips(base).map((l) => l.bins)).toEqual([9, 5, 3, 2, 1]);
    expect(buildMips(base, { minBins: 3 }).map((l) => l.bins)).toEqual([9, 5, 3]);
  });

  it("returns just the base for an empty level and for a one-bin level", () => {
    const empty = emptyLevel(2, 0);
    const one = emptyLevel(2, 1);
    expect(buildMips(empty)).toEqual([empty]);
    expect(buildMips(empty)[0]).toBe(empty);
    expect(buildMips(one)).toHaveLength(1);
    expect(buildMips(one)[0]).toBe(one);
  });

  it("does not change the base data", () => {
    const base = makeLevel(1, 5, 2, (c, b) => [c - b * 3, c + b * 2]);
    const before = Array.from(base.data);
    buildMips(base);
    expect(Array.from(base.data)).toEqual(before);
  });

  it("keeps the clip's overall min and max at every level", () => {
    const base = makeLevel(1, 11, 2, (c, b) => [((b * 37 + c * 11) % 61) - 30, ((b * 17 + c * 5) % 53) - 10]);
    let min = Infinity;
    let max = -Infinity;
    for (const v of base.data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    for (const level of buildMips(base)) {
      let lMin = Infinity;
      let lMax = -Infinity;
      for (const v of level.data) {
        lMin = Math.min(lMin, v);
        lMax = Math.max(lMax, v);
      }
      expect(lMin).toBe(min);
      expect(lMax).toBe(max);
    }
  });
});

describe("pickLevel", () => {
  // Bins 16, 8, 4, 2, 1 at binFrames 4, 8, 16, 32, 64.
  const levels = buildMips(emptyLevel(4, 16));

  it("picks the coarsest level whose binFrames is at most the frames per pixel", () => {
    // 320 frames over 80 px is 4 frames per pixel: level 0 exactly.
    expect(pickLevel(levels, 0, 320, 80)).toBe(0);
    // 320 frames over 10 px is 32 frames per pixel: level 3 (binFrames 32).
    expect(pickLevel(levels, 0, 320, 10)).toBe(3);
    // 20 frames per pixel: binFrames 16 fits, 32 does not.
    expect(pickLevel(levels, 0, 200, 10)).toBe(2);
  });

  it("picks level 0 when zoomed in past the base level", () => {
    expect(pickLevel(levels, 0, 20, 100)).toBe(0);
  });

  it("picks the coarsest level when zoomed out past it", () => {
    // 100 frames per pixel: binFrames 64 is the coarsest level.
    expect(pickLevel(levels, 0, 10000, 100)).toBe(4);
    expect(pickLevel(levels, 0, 1e9, 100)).toBe(4);
  });

  it("gives 0 for an empty span or a width below 1", () => {
    expect(pickLevel(levels, 500, 500, 100)).toBe(0);
    expect(pickLevel(levels, 900, 100, 100)).toBe(0);
    expect(pickLevel(levels, 0, 10000, 0)).toBe(0);
    expect(pickLevel(levels, 0, 10000, 0.5)).toBe(0);
  });

  it("reads at most about one bin per pixel across a range of zooms", () => {
    const base = emptyLevel(4, 100000); // 400000 frames, so every span below fits in the clip
    const mips = buildMips(base);
    for (const widthPx of [64, 300, 1000]) {
      for (const framesPerPixel of [4, 5, 7, 16, 23, 100, 333]) {
        const span = framesPerPixel * widthPx;
        const start = 37;
        const end = start + span;
        const index = pickLevel(mips, start, end, widthPx);
        const picked = mips[index];
        // The coarsest level whose bins fit one pixel: binFrames <= framesPerPixel < 2 * binFrames (unless level 0).
        expect(picked.binFrames).toBeLessThanOrEqual(framesPerPixel);
        if (index + 1 < mips.length) expect(mips[index + 1].binFrames).toBeGreaterThan(framesPerPixel);
        const run = binSpan(picked, start, end);
        const readBins = run.end - run.first;
        // Bins per pixel is framesPerPixel / binFrames, so under 2 by construction; the span may straddle two more
        // bins at its edges. The spec's "about one bin per pixel" is this bound, not exactly one.
        expect(readBins / widthPx).toBeLessThan(2 + 2 / widthPx);
      }
    }
  });
});

describe("binSpan", () => {
  const level = emptyLevel(10, 20);

  it("returns floor(start / binFrames) to ceil(end / binFrames)", () => {
    expect(binSpan(level, 25, 61)).toEqual({ first: 2, end: 7 });
    expect(binSpan(level, 30, 60)).toEqual({ first: 3, end: 6 });
  });

  it("clamps to the level's bins", () => {
    expect(binSpan(level, -50, 1000)).toEqual({ first: 0, end: 20 });
    expect(binSpan(level, 150, 5000)).toEqual({ first: 15, end: 20 });
  });

  it("returns an empty run for an empty, inverted or out-of-range span", () => {
    expect(binSpan(level, 50, 50)).toEqual({ first: 5, end: 5 });
    expect(binSpan(level, 100, 30)).toEqual({ first: 10, end: 10 });
    expect(binSpan(level, 500, 600)).toEqual({ first: 20, end: 20 });
    expect(binSpan(level, -100, -10)).toEqual({ first: 0, end: 0 });
  });
});
