// ADR 0166 K3: `handle.music.positionAt` and `judged` on stamped runs with no core (the heard grid on the real core,
// across a tempo change and a transition, is `positionAt.loopback.test.ts`). Heard time is the fake clock map
// `timeAt(ms) = ms / 1000`, so a test names a heard time in milliseconds.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend } from "../testing";
import { _resetMusicPlayers } from "./musicSystem";
import { _resetSegmentRuns } from "./segmentRun";
import { judgedOffset, positionAt } from "./handle";
import { setCalibration } from "./calibration";
import { musicSegment, playingRun, rigClips, stampedRun } from "./testing/beatRig";

const T120 = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const ms = (s: number) => s * 1000;

beforeEach(() => {
  rigClips();
  const fake = makeFakeBackend() as unknown as { timeAt(ms: number): number };
  fake.timeAt = (t) => t / 1000;
  setAudioBackend(fake as never);
});
afterEach(() => {
  setCalibration(0);
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

describe("positionAt", () => {
  it("reads the bar, beat and fraction heard at the time, and the nearest beat", () => {
    const { player, run } = playingRun(musicSegment({ tempo: T120 }), 0, 1.0);
    const at = positionAt(player, ms(2.6)); // 1.6 s in: beat 4 of bar 1 starts at 2.5
    expect(at.segment).toBe(run.node.id);
    expect([at.bar, at.beat]).toEqual([1, 4]);
    expect(at.beatFraction).toBeCloseTo(0.2, 9);
    expect(at.nearestBeatTime).toBeCloseTo(2.5, 9);
    expect(at.offset).toBeCloseTo(0.1, 9);
    const early = positionAt(player, ms(2.9)); // nearer the next beat (3.0)
    expect([early.bar, early.beat]).toEqual([1, 4]);
    expect(early.nearestBeatTime).toBeCloseTo(3.0, 9);
    expect(early.offset).toBeCloseTo(-0.1, 9);
    const bar2 = positionAt(player, ms(3.0));
    expect([bar2.bar, bar2.beat]).toEqual([2, 1]);
    expect(Math.abs(bar2.offset)).toBeLessThan(1e-9);
  });

  it("follows a tempo and metre change", () => {
    const node = musicSegment({ tempo: [...T120, { at: "3:1:0", bpm: 90, beatsPerBar: 3, beatUnit: 4 }] });
    const { player } = playingRun(node, 0, 1.0);
    // Bars 1-2 are 8 beats at 0.5 s: bar 3 starts at 5.0 (heard); then a beat is 2/3 s.
    const at = positionAt(player, ms(5.0 + 2 / 3 + 0.05));
    expect([at.bar, at.beat]).toEqual([3, 2]);
    expect(at.beatFraction).toBeCloseTo(0.05 / (2 / 3), 6);
    expect(at.nearestBeatTime).toBeCloseTo(5.0 + 2 / 3, 9);
    expect(at.offset).toBeCloseTo(0.05, 9);
  });

  it("is not playing before the run's start, with a stopped player, with no run, and for a non-finite input", () => {
    const { player, run } = playingRun(musicSegment({ tempo: T120 }), 0, 1.0);
    const off = { segment: null, bar: 0, beat: 0, beatFraction: 0, nearestBeatTime: 0, offset: 0, judged: 0 };
    expect(positionAt(player, ms(0.5))).toEqual(off);
    expect(positionAt(player, Number.NaN)).toEqual(off);
    run.state = "priming";
    expect(positionAt(player, ms(2))).toEqual(off);
    run.state = "playing";
    expect(positionAt(player, ms(2)).segment).toBe(run.node.id);
    player.state = "stopping";
    expect(positionAt(player, ms(2))).toEqual(off);
  });

  it("reads the successor from its landing on, and takes the nearest beat that is heard", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: T120, cues: [{ name: "entry", at: "2:1:0" }] });
    const { player, run } = playingRun(a, 0, 1);
    const succ = stampedRun(player, b, 48_000, 3.0, 6); // B's bar 2 beat 1 (its entry) is heard at 4.0
    player.next = succ;
    const before = positionAt(player, ms(3.9));
    expect(before.segment).toBe(run.node.id);
    const after = positionAt(player, ms(4.1));
    expect(after.segment).toBe(succ.node.id);
    expect([after.bar, after.beat]).toEqual([2, 1]);
    expect(after.nearestBeatTime).toBeCloseTo(4.0, 9);
    // A's own beat at 4.0 is cut off by the change; the incoming segment's first beat lands there.
    expect(before.nearestBeatTime).toBeCloseTo(4.0, 9);
    expect(before.offset).toBeCloseTo(-0.1, 9);
  });
});

describe("judged", () => {
  it("is the offset less the calibration, and positionAt carries it", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 1.0);
    expect(judgedOffset(0.03)).toBeCloseTo(0.03, 12);
    setCalibration(0.02);
    expect(judgedOffset(0.03)).toBeCloseTo(0.01, 12);
    expect(judgedOffset(-0.03)).toBeCloseTo(-0.05, 12);
    const at = positionAt(player, ms(2.53));
    expect(at.offset).toBeCloseTo(0.03, 9);
    expect(at.judged).toBeCloseTo(0.01, 9);
    setCalibration(-0.015);
    expect(positionAt(player, ms(2.47)).judged).toBeCloseTo(-0.03 + 0.015, 9);
  });

  it("synthetic taps 20 ms after every beat judge +20 ms, and a calibration of 20 ms zeroes them", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 1.0);
    for (const cal of [0, 0.02]) {
      setCalibration(cal);
      for (let k = 0; k < 12; k++) {
        const at = positionAt(player, ms(1 + k * 0.5 + 0.02));
        expect(at.offset).toBeCloseTo(0.02, 9);
        expect(at.judged).toBeCloseTo(0.02 - cal, 9);
      }
    }
  });
});
