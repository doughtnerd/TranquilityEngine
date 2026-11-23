// ADR 0285, kept for playlist voices by ADR 0343: the pass walk of a looping voice's anchor (`anchors.ts`), through its
// own interface: the position heard at a time across loop passes (a forever loop in closed form, a counted loop played
// out), the next grid point heard in the pass it is heard in, and a point the loop wraps before. Ported from the music
// segment anchor tests when the music player was retired.
import { describe, expect, it } from "vitest";
import { compileTempoMap, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import { nextGridHeardOn, nextHeardOn, ticksAtOn, type LoopAnchor, type SegmentLoops } from "./anchors";

const RATE = 48_000;
/** 120 bpm 4/4 from the file's start: a beat is 0.5 s (960 ticks), a bar 2 s. */
const grid = (): SegmentGrid => Object.assign(compileTempoMap([{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }], 0), {
  cueNames: [] as string[], cueTicks: new Float64Array(0), endSeconds: Number.NaN, entryTicks: 0, exitTicks: Number.NaN,
});
const loops = (regions: { from: number; to: number; count: number }[]): SegmentLoops => ({
  grid: grid(), regions: regions.map((r, index) => ({ index, ...r })), exit: Number.POSITIVE_INFINITY, rate: RATE,
});
/** An anchor at file seconds `at` heard at `time` (pass 1). */
const anchor = (l: SegmentLoops, at: number, time: number): LoopAnchor => ({ loops: l, ticks: (at / 0.5) * MUSIC_TICKS_PER_BEAT, time, pass: 1, rate: RATE });
/** File seconds of a position in ticks. */
const sec = (ticks: number): number => (ticks / MUSIC_TICKS_PER_BEAT) * 0.5;

describe("a looping voice's anchor (ADR 0285)", () => {
  it("before and inside a forever loop the position wraps every pass, hours in included", () => {
    const a = anchor(loops([{ from: 2, to: 4, count: 0 }]), 0, 10); // heard 10 s at the file's start; loop 2..4 s forever
    expect(sec(ticksAtOn(a, 11))).toBeCloseTo(1, 9);
    expect(sec(ticksAtOn(a, 13))).toBeCloseTo(3, 9);
    expect(sec(ticksAtOn(a, 14.5))).toBeCloseTo(2.5, 9); // one wrap at heard 14
    expect(sec(ticksAtOn(a, 10 + 4 + 2 * 5000 + 0.25))).toBeCloseTo(2.25, 6);
    expect(ticksAtOn(a, Number.NaN)).toBeNaN();
  });

  it("a counted loop wraps its passes, then plays on", () => {
    const a = anchor(loops([{ from: 2, to: 4, count: 2 }]), 0, 0); // two passes: one wrap at heard 4
    expect(sec(ticksAtOn(a, 5))).toBeCloseTo(3, 9);
    expect(sec(ticksAtOn(a, 6.5))).toBeCloseTo(4.5, 9); // past the second pass: on through the file
  });

  it("the next bar is heard in the pass it is heard in; a point the loop wraps before comes from the region's start", () => {
    const l = loops([{ from: 2, to: 3, count: 0 }]); // a half-bar loop: its end (3 s) is no bar line
    const a = anchor(l, 0, 0);
    expect(nextGridHeardOn(a, 0.1, "bar").at).toBeCloseTo(2, 9); // bar 2, at the region's start
    // From inside the loop the next bar line in file time (4 s) is never reached: the pass's start (bar 2) is, after the wrap.
    const p = nextGridHeardOn(a, 2.2, "bar");
    expect(p.at).toBeCloseTo(3, 9);
    expect(p.file).toBeCloseTo(2, 9);
    expect(nextGridHeardOn(a, 2.2, "beat").at).toBeCloseTo(2.5, 9);
  });

  it("strict asks for the point after the one on the asked time; a point no pass reaches is NaN", () => {
    const l = loops([{ from: 2, to: 3, count: 0 }]);
    const a = anchor(l, 0, 0);
    expect(nextGridHeardOn(a, 0.5, "beat").at).toBeCloseTo(0.5, 9);
    expect(nextGridHeardOn(a, 0.5, "beat", true).at).toBeCloseTo(1, 9);
    // File second 3.5 lies past a forever loop's end: never heard.
    expect(nextHeardOn(a, 2.2, (_g, file) => (file <= 3.5 ? 3.5 : Number.NaN)).at).toBeNaN();
  });
});
