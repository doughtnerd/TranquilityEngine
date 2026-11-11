/**
 * Grid maths, the lead's core (G1): tempo-map compile, position <-> ticks <-> seconds <-> frames, entry and exit.
 * Next beat, bar and cue lookup are L-G1b's; the property tests against a naive integrator are L-G1a's.
 */
import { describe, expect, it } from "vitest";
import { emptySegment, type TempoMarker } from "./musicFormat";
import {
  compileSegmentGrid, compileTempoMap, entrySeconds, exitSeconds, framesToSeconds, framesToTicks, positionInMetre,
  positionToTicks, secondsToFrames, secondsToNearestTick, secondsToTicks, ticksToFrames, ticksToPosition,
  ticksToPositionText, ticksToSeconds,
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
