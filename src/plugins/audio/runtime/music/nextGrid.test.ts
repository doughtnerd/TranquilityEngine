// `handle.music.nextGrid` on a looping segment (found building ADR 0263): the next point is heard from the position
// heard now, however many passes behind the anchor is, and a point the loop wraps before is the next pass's first.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, endAudioSession, type FakeBackend } from "../testing";
import { musicSegment, playingRun, rigClips } from "./testing/beatRig";

let b: FakeBackend;

beforeEach(() => {
  rigClips(4); // a 4 s file: 120 bpm 4/4 is two bars a pass
  b = makeFakeBackend();
  setAudioBackend(b);
});
afterEach(() => {
  endAudioSession();
  setAudioBackend(null);
});

describe("nextGrid over loop passes", () => {
  it("reads the next bar on the pass heard now, and across the wrap", () => {
    const { player } = playingRun(musicSegment({ regions: [{ id: "all", from: "1:1:0", to: "end", count: 0 }] }), 0, 1);
    b.time = 1 + 8 + 0.3; // pass 3, bar 1
    expect(player.handle.nextGrid("bar")).toMatchObject({ bar: 2, beat: 1 });
    expect(player.handle.nextGrid("bar")!.time).toBeCloseTo(1 + 8 + 2, 9);
    b.time = 1 + 8 + 2.2; // pass 3, bar 2: the next bar line heard is bar 1 of pass 4
    expect(player.handle.nextGrid("bar")).toMatchObject({ bar: 1, beat: 1 });
    expect(player.handle.nextGrid("bar")!.time).toBeCloseTo(1 + 12, 9);
    expect(player.handle.nextGrid("beat")!.time).toBeCloseTo(1 + 8 + 2.5, 9);
  });

  it("without a loop, the last bar line is the exit at the file's end", () => {
    const { player } = playingRun(musicSegment(), 0, 1);
    b.time = 1 + 2.2;
    expect(player.handle.nextGrid("bar")).toMatchObject({ bar: 3, beat: 1 });
    expect(player.handle.nextGrid("bar")!.time).toBeCloseTo(1 + 4, 9);
  });
});
