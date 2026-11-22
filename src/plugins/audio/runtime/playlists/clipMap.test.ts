// ADR 0329: a sequence clip's time → sample time (pickup, first pass, further passes filling the clip, tail).
import { describe, expect, it } from "vitest";
import { clipGeometry, clipTimesOf, pieceAt, sampleAt } from "./clipMap";

describe("clip time → sample time", () => {
  // A 4 s sample looping 1..2; a 6 s clip: pickup 0..1, first pass 1..2, two more passes, the 2 s tail.
  const g = clipGeometry(6, 0, 4, { start: 1, end: 2 });

  it("pickup and first pass, extra passes of the first loop filling the clip, then the tail", () => {
    expect(g).toMatchObject({ length: 6, firstPassEnd: 2, extraPasses: 2, tailStart: 4 });
    expect([0, 0.5, 1.5, 2, 2.5, 3.25, 4, 5.9].map((u) => sampleAt(g, u))).toEqual([0, 0.5, 1.5, 1, 1.5, 1.25, 2, expect.closeTo(3.9, 9)]);
    expect(sampleAt(g, 6)).toBeNull();
  });

  it("splits into pieces each voice plays without a jump", () => {
    expect([0, 2.2, 3, 4.5].map((u) => ({ ...pieceAt(g, u)! }))).toEqual([
      { from: 0, to: 2, sample: 0, pass: 1 },
      { from: 2, to: 3, sample: 1, pass: 2 },
      { from: 3, to: 4, sample: 1, pass: 3 },
      { from: 4, to: 6, sample: 2, pass: 0 },
    ]);
  });

  it("a remainder too short for a pass is silence after the tail; length 0 is one pass to the sample's end", () => {
    const r = clipGeometry(6.5, 0, 4, { start: 1, end: 2 });
    expect(r).toMatchObject({ extraPasses: 2, tailStart: 4 });
    expect(sampleAt(r, 6.2)).toBeNull();
    expect(clipGeometry(0, 0, 4, { start: 1, end: 2 })).toMatchObject({ length: 4, extraPasses: 0, tailStart: 2 });
    expect(clipGeometry(0, 0.5, 3, null)).toMatchObject({ length: 2.5, loop: null });
  });

  it("an offset inside the loop starts with a partial first pass; past the loop it plays straight", () => {
    const inLoop = clipGeometry(4, 1.5, 4, { start: 1, end: 2 });
    expect(inLoop).toMatchObject({ firstPassEnd: 0.5, extraPasses: 1, tailStart: 1.5 });
    expect(sampleAt(inLoop, 0.7)).toBeCloseTo(1.2, 9);
    expect(clipGeometry(2, 2.5, 4, { start: 1, end: 2 }).loop).toBeNull();
  });

  it("a hold point holds (silence) for the passes' share of the clip", () => {
    const h = clipGeometry(5, 0, 3, { start: 1, end: 1 });
    expect(h).toMatchObject({ firstPassEnd: 1, extraPasses: 1, tailStart: 3 });
    expect(pieceAt(h, 2)).toMatchObject({ from: 1, to: 3, sample: null });
    expect(sampleAt(h, 3.5)).toBeCloseTo(1.5, 9);
  });

  it("a sample time is heard once per pass when it is in the loop", () => {
    expect(clipTimesOf(g, 1.5, 0, 6, [])).toEqual([1.5, 2.5, 3.5]);
    expect(clipTimesOf(g, 0.5, 0, 6, [])).toEqual([0.5]);
    expect(clipTimesOf(g, 3, 0, 6, [])).toEqual([5]);
    expect(clipTimesOf(g, 1.5, 2, 3, [])).toEqual([2.5]);
  });
});
