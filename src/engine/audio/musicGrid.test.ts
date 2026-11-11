/**
 * Grid maths, the lead's core (G1): tempo-map compile, position <-> ticks <-> seconds <-> frames, entry and exit.
 * Next beat, bar and cue lookup are L-G1b's; the property tests against a naive integrator are L-G1a's.
 */
import { describe, expect, it } from "vitest";
import { emptySegment, type TempoMarker } from "./musicFormat";
import {
  compileSegmentGrid, compileTempoMap, cueSeconds, cueTicks, entrySeconds, exitSeconds, framesToSeconds, framesToTicks,
  nextBarTicks, nextBeatTicks, nextGridSeconds, nextGridTicks, positionInMetre, positionToTicks, secondsToFrames,
  secondsToNearestTick, secondsToTicks, ticksToFrames, ticksToPosition, ticksToPositionText, ticksToSeconds,
} from "./musicGrid";

const m = (at: string, bpm: number, beatsPerBar = 4, beatUnit = 4): TempoMarker => ({ at, bpm, beatsPerBar, beatUnit });

describe("compileTempoMap", () => {
  it("one marker: 120 bpm 4/4 is 0.5 s a beat, 2 s a bar", () => {
    const map = compileTempoMap([m("1:1:0", 120)], 0);
    expect(map.count).toBe(1);
    expect(map.ticksPerSecond[0]).toBe(1920);
    expect(positionToTicks(map, 2, 1, 0)).toBe(3840);
    expect(ticksToSeconds(map, 3840)).toBe(2);
    expect(ticksToSeconds(map, 960)).toBe(0.5);
  });

  it("cumulative ticks and seconds at each marker, metre per span", () => {
    // 2 bars of 4/4 at 120 (4 s), then 3/4 at 90 for 2 bars (6 beats at 60/90 s), then tempo-only change mid-bar.
    const problems: string[] = [];
    const map = compileTempoMap([m("1:1:0", 120), m("3:1:0", 90, 3), m("5:2:0", 60, 3)], 0, problems);
    expect(problems).toEqual([]);
    expect(Array.from(map.startTick)).toEqual([0, 8 * 960, 15 * 960]);
    expect(Array.from(map.beatsPerBar)).toEqual([4, 3, 3]);
    expect(map.startSeconds[1]).toBe(4);
    expect(map.startSeconds[2]).toBeCloseTo(4 + 7 * (60 / 90), 12);
    expect(Array.from(map.barOriginTick)).toEqual([0, 8 * 960, 14 * 960]);
    expect(positionToTicks(map, 5, 2, 0)).toBe(15 * 960);
    expect(positionToTicks(map, 6, 1, 7)).toBe(17 * 960 + 7);
  });

  it("applies gridOffset to file seconds, the pickup has negative ticks", () => {
    const map = compileTempoMap([m("1:1:0", 120)], 0.25);
    expect(ticksToSeconds(map, 0)).toBe(0.25);
    expect(secondsToTicks(map, 0)).toBe(-480);
    expect(ticksToPosition(map, -1)).toBeNull();
  });

  it("drops unusable markers with a problem and falls back to the default", () => {
    const problems: string[] = [];
    const map = compileTempoMap([m("1:1:0", 100), m("1:5:0", 100, 4), m("2:3:0", 80, 3), m("1:1:0", 90)], 0, problems);
    expect(map.count).toBe(1);
    expect(problems.length).toBe(3);
    expect(problems[0]).toMatch(/beat 5 is past the bar's 4 beats/);
    expect(problems[1]).toMatch(/metre change sits on beat 1/);
    const none = compileTempoMap([], 0);
    expect(none.bpm[0]).toBe(120);
  });
});

describe("positions and ticks", () => {
  const map = compileTempoMap([m("1:1:0", 120), m("3:1:0", 90, 3), m("5:2:0", 60, 3)], 0);

  it("round trips every tick on the grid", () => {
    const p = { bar: 1, beat: 1, tick: 0 };
    for (let t = 0; t < 40 * 960; t += 13) {
      const pos = ticksToPosition(map, t, p)!;
      expect(positionToTicks(map, pos.bar, pos.beat, pos.tick)).toBe(t);
    }
  });

  it("names positions across a metre change", () => {
    expect(ticksToPositionText(map, 8 * 960 - 1)).toBe("2:4:959");
    expect(ticksToPositionText(map, 8 * 960)).toBe("3:1:0");
    expect(ticksToPositionText(map, 11 * 960)).toBe("4:1:0");
    expect(ticksToPositionText(map, 15 * 960)).toBe("5:2:0");
    expect(ticksToPositionText(map, 17 * 960)).toBe("6:1:0");
  });

  it("checks a beat against its bar's metre", () => {
    expect(positionInMetre(map, 2, 4)).toBe(true);
    expect(positionInMetre(map, 3, 4)).toBe(false);
    expect(positionInMetre(map, 3, 3)).toBe(true);
  });
});

describe("ticks, seconds and frames", () => {
  const map = compileTempoMap([m("1:1:0", 128), m("5:1:0", 96.5), m("9:1:0", 150, 7, 8)], 0.0123);

  it("seconds and ticks invert each other on integer ticks", () => {
    for (let t = -300; t < 60 * 960; t += 37) expect(secondsToNearestTick(map, ticksToSeconds(map, t))).toBe(t);
  });

  it.each([44100, 48000, 96000])("frames round trip every tick at %d Hz", (rate) => {
    for (let t = 0; t < 60 * 960; t += 11) expect(framesToTicks(map, ticksToFrames(map, t, rate), rate)).toBe(t);
  });

  it("rounds frames to nearest, halves up", () => {
    expect(secondsToFrames(0.5 / 48000, 48000)).toBe(1);
    expect(secondsToFrames(0.49 / 48000, 48000)).toBe(0);
    expect(secondsToFrames(-0.5 / 48000, 48000)).toBe(0);
    expect(framesToSeconds(48000, 48000)).toBe(1);
  });
});

describe("compileSegmentGrid", () => {
  it("resolves cues, entry and exit to ticks and seconds", () => {
    const seg = emptySegment("s");
    seg.gridOffset = 0.5;
    seg.tempo = [m("1:1:0", 120)];
    seg.cues = [{ name: "entry", at: "2:1:0" }, { name: "x", at: "3:5:0" }, { name: "exit", at: "5:1:0" }, { name: "e", at: "end" }, { name: "s", at: "start" }];
    const problems: string[] = [];
    const g = compileSegmentGrid(seg, { endSeconds: 20, problems });
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/cues\[1\]/);
    expect(g.cueNames).toEqual(["entry", "exit", "e", "s"]);
    expect(Array.from(g.cueTicks)).toEqual([3840, 15360, secondsToTicks(g, 20), -960]);
    expect(entrySeconds(g)).toBe(2.5);
    expect(exitSeconds(g)).toBe(8.5);
    const open = compileSegmentGrid({ ...seg, cues: [] });
    expect(entrySeconds(open)).toBe(0.5);
    expect(exitSeconds(open)).toBeNull();
  });
});

describe("L-G1b", () => {
  const B = 960;
  // 4/4 at 120 for bars 1-2; 3/4 at 90 from bar 3 (metre change on beat 1); tempo-only change to 60 at 5:2:0 (mid-bar).
  const map = compileTempoMap([m("1:1:0", 120), m("3:1:0", 90, 3), m("5:2:0", 60, 3)], 0);
  // 4/4 at 120 with a tempo-only change at 2:3:0 (mid-bar, same metre): the bar phase must not move.
  const mid = compileTempoMap([m("1:1:0", 120), m("2:3:0", 100)], 0);
  const four = compileTempoMap([m("1:1:0", 120)], 0);

  it("next beat: at or after, the point itself counts, the pickup gives 0", () => {
    expect(nextBeatTicks(map, -500)).toBe(0);
    expect(nextBeatTicks(map, 0)).toBe(0);
    expect(nextBeatTicks(map, 1)).toBe(B);
    expect(nextBeatTicks(map, B)).toBe(B);
    expect(nextBeatTicks(map, 8 * B - 1)).toBe(8 * B);
    expect(nextBeatTicks(map, 14 * B + 1)).toBe(15 * B);
  });

  it("next bar across a metre change: 4/4, then 3/4 from bar 3, then the mid-bar tempo change", () => {
    expect(nextBarTicks(map, -1)).toBe(0);
    expect(nextBarTicks(map, 1)).toBe(4 * B);
    expect(nextBarTicks(map, 4 * B)).toBe(4 * B);
    expect(nextBarTicks(map, 4 * B + 1)).toBe(8 * B);
    expect(nextBarTicks(map, 8 * B)).toBe(8 * B);
    expect(nextBarTicks(map, 8 * B + 1)).toBe(11 * B);
    expect(nextBarTicks(map, 11 * B + 1)).toBe(14 * B);
    expect(nextBarTicks(map, 14 * B)).toBe(14 * B);
    expect(nextBarTicks(map, 14 * B + 1)).toBe(17 * B);
  });

  it("next bar keeps the bar phase across a mid-bar tempo-only marker", () => {
    expect(nextBarTicks(mid, 1)).toBe(4 * B);
    expect(nextBarTicks(mid, 4 * B + 1)).toBe(8 * B);
    expect(nextBarTicks(mid, 6 * B)).toBe(8 * B);
  });

  it("every 2 bars counts bar numbers from bar 1", () => {
    expect(nextGridTicks(four, -5, { every: "bar", n: 2 })).toBe(0);
    expect(nextGridTicks(four, 0, { every: "bar", n: 2 })).toBe(0);
    expect(nextGridTicks(four, 1, { every: "bar", n: 2 })).toBe(8 * B);
    expect(nextGridTicks(four, 8 * B, { every: "bar", n: 2 })).toBe(8 * B);
    expect(nextGridTicks(four, 8 * B + 1, { every: "bar", n: 2 })).toBe(16 * B);
  });

  it("every 2 bars across a metre change: bars 1, 3, 5, 7 whatever their metre", () => {
    expect(nextGridTicks(map, 1, { every: "bar", n: 2 })).toBe(8 * B);
    expect(nextGridTicks(map, 8 * B + 1, { every: "bar", n: 2 })).toBe(14 * B);
    expect(nextGridTicks(map, 14 * B + 1, { every: "bar", n: 2 })).toBe(19200);
  });

  it("every 3 bars and a mid-bar tempo marker keep counting bars", () => {
    expect(nextGridTicks(mid, 0, { every: "bar", n: 3 })).toBe(0);
    expect(nextGridTicks(mid, 1, { every: "bar", n: 3 })).toBe(4 * B * 3);
    expect(nextGridTicks(mid, 4000, { every: "bar", n: 3 })).toBe(11520);
    expect(nextGridTicks(map, 8 * B + 1, { every: "bar", n: 3 })).toBe(10560);
  });

  it("every n beats count beat indices from 1:1:0", () => {
    expect(nextGridTicks(map, 1, { every: "beat", n: 2 })).toBe(2 * B);
    expect(nextGridTicks(map, 2 * B, { every: "beat", n: 2 })).toBe(2 * B);
    expect(nextGridTicks(map, 1921, { every: "beat", n: 2 })).toBe(4 * B);
    expect(nextGridTicks(map, 8 * B + 1, { every: "beat", n: 4 })).toBe(12 * B);
    expect(nextGridTicks(map, -3, { every: "beat", n: 4 })).toBe(0);
  });

  it("nextGridTicks for 'beat' and 'bar' are the plain next beat and bar", () => {
    expect(nextGridTicks(map, 4 * B + 1, "beat")).toBe(5 * B);
    expect(nextGridTicks(map, 4 * B + 1, "bar")).toBe(8 * B);
  });

  it("next grid seconds: a time on a bar line is itself, a time in the pickup is the grid start", () => {
    const offset = compileTempoMap([m("1:1:0", 120)], 0.25);
    expect(nextGridSeconds(offset, 0.1, "beat")).toBe(0.25);
    expect(nextGridSeconds(offset, 0.3, "bar")).toBe(2.25);
    expect(nextGridSeconds(offset, 2.25, "bar")).toBe(2.25);
    expect(nextGridSeconds(offset, 2.25 + 1e-13, "bar")).toBe(2.25);
    expect(nextGridSeconds(offset, 2.25 + 1e-6, "bar")).toBe(4.25);
  });

  it("next grid seconds through the metre change and the 3/4 span", () => {
    // Bar 3 is at 4 s, bar 4 at 6 s, bar 5 at 8 s (90 bpm, 3/4), bar 7 at ticksToSeconds(19200).
    expect(nextGridSeconds(map, 5, "bar")).toBe(6);
    expect(nextGridSeconds(map, 6.5, { every: "bar", n: 2 })).toBe(8);
    expect(nextGridSeconds(map, 8.5, { every: "bar", n: 2 })).toBeCloseTo(ticksToSeconds(map, 19200), 12);
  });

  it("cue lookup: ticks and seconds of a named cue, null on a miss, on a dropped cue, and on an unknown end", () => {
    const seg = emptySegment("s");
    seg.gridOffset = 0.5;
    seg.tempo = [m("1:1:0", 120)];
    seg.cues = [{ name: "entry", at: "2:1:0" }, { name: "x", at: "3:5:0" }, { name: "exit", at: "5:1:0" }, { name: "e", at: "end" }];
    const g = compileSegmentGrid(seg);
    expect(cueTicks(g, "entry")).toBe(3840);
    expect(cueSeconds(g, "entry")).toBe(2.5);
    expect(cueTicks(g, "exit")).toBe(15360);
    expect(cueSeconds(g, "exit")).toBe(8.5);
    expect(cueTicks(g, "missing")).toBeNull();
    expect(cueSeconds(g, "missing")).toBeNull();
    expect(cueTicks(g, "x")).toBeNull();
    expect(cueTicks(g, "e")).toBeNull();
    expect(cueSeconds(g, "e")).toBeNull();
    const known = compileSegmentGrid(seg, { endSeconds: 20 });
    expect(cueTicks(known, "e")).toBeCloseTo(secondsToTicks(known, 20), 6);
    expect(cueSeconds(known, "e")).toBeCloseTo(20, 9);
  });
});
