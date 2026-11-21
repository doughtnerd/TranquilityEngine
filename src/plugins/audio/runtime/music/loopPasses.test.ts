// ADR 0285: grid points quantised on a looping segment with no transition planned, two and more passes after the
// anchor. Nothing re-anchors the player here (only transition planning and reload did), so a reader that maps heard
// time to file position linearly from the anchor names a point the loop never plays. 120 bpm 4/4 (a beat 0.5 s, a bar
// 2 s); the region loops file 0..3 s (a bar and a half) forever, so pass k starts at heard 3(k - 1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { endAudioSession, makeFakeBackend, musicFrameAt, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { QUANTIZED_RAMP_SECONDS } from "../events/automation";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { createMusicPlayer, type MusicPlayer } from "./musicSystem";
import { commitStart, noteStartHeard } from "./musicPlayer";
import { createSegmentRun } from "./segmentRun";
import { quantizedRamp } from "./stems";
import { tickStingers, triggerOn } from "./stingers";
import { rigClips } from "./testing/beatRig";

let b: FakeBackend;
let player: MusicPlayer;

function rig(): void {
  const { value } = parseAudioEvent({
    format: "myco.audioevent@1", bus: "Music",
    root: {
      type: "playlist", id: "p",
      children: [{
        type: "segment", id: "a", tracks: [{ name: "t", clip: "a.ogg" }, { name: "u", clip: "b.ogg" }],
        cues: [{ name: "drop", at: "2:1:0" }],
        regions: [{ id: "r", from: "1:1:0", to: "2:3:0", count: 0 }],
      }],
      library: [{ type: "segment", id: "hit", tracks: [{ name: "t", clip: "hit.ogg" }] }],
      stingers: [
        { trigger: "bar", segment: "hit", at: "bar" },
        { trigger: "beat", segment: "hit", at: "beat" },
        { trigger: "cue", segment: "hit", at: { cue: "drop" } },
      ],
    },
  });
  const root = value.musicRoot as MusicNode;
  const inst = { group: 7, world: 1, path: "m.audioevent", asset: { bus: "Music", priority: 200, volume: 1 } } as unknown as EventInstance;
  player = createMusicPlayer(inst, root);
  const a = (root as unknown as { children: SegmentNode[] }).children[0]!;
  const run = createSegmentRun(player, a, 0)!;
  run.startAt = 0;
  run.state = "playing";
  // The stems' voices, as the stamp hands them out (quantised automation moves a sounding stem's gain).
  for (const stem of run.stems) stem.voice = b.play({ path: stem.clip, url: stem.clip, loop: false, stream: true, bus: "Music" });
  commitStart(player, run, 0);
  noteStartHeard(player, 0);
}

beforeEach(() => {
  b = makeFakeBackend();
  setAudioBackend(b);
  rigClips(8, 48_000, b, ["a.ogg", "b.ogg", "hit.ogg"]);
  rig();
});
afterEach(() => {
  endAudioSession();
  setAudioBackend(null);
});

/** The stinger `name` triggered at heard `now`: the heard time it was stamped at. */
function stingerAt(name: string, now: number): number {
  tickStingers(player, musicFrameAt(b, now));
  expect(triggerOn(player.instance, name)).toBe(true);
  b.music!.setPrimed(b.music!.admitted.at(-1)!.group);
  tickStingers(player, musicFrameAt(b, now));
  return b.music!.stamps.at(-1)!.at;
}

describe("stingers on a looping segment, no transition planned", () => {
  it("a bar stinger in pass 2 lands on the bar line heard in that pass", () => {
    // Pass 2 starts at 3 (file 0); file 2 (bar 2) is heard at 5. The anchor's linear reading put it at 4 (file 1).
    expect(stingerAt("bar", 3.5)).toBeCloseTo(5, 9);
  });

  it("a bar line past the region's end is the next pass's first", () => {
    // Pass 3 starts at 6: at 5.2 (pass 2, file 2.2) the next bar line heard is file 0 of pass 3.
    expect(stingerAt("bar", 5.2)).toBeCloseTo(6, 9);
  });

  it("a cue stinger in pass 3 lands on the cue heard in that pass", () => {
    // The cue (file 2) is heard at 8 in pass 3; the linear reading had it behind and dropped the stinger.
    expect(stingerAt("cue", 6.5)).toBeCloseTo(8, 9);
  });
});

describe("quantised stem automation on a looping segment, no transition planned", () => {
  it("the next bar in pass 2 is the bar heard in that pass", () => {
    b.lookahead = 0;
    const f = musicFrameAt(b, 3.5);
    expect(quantizedRamp(player, "u", 1, "bar", QUANTIZED_RAMP_SECONDS, f)).toBeCloseTo(5, 9);
  });

  it("the next bar in pass 4 counts from that pass's start", () => {
    // Pass 4 starts at 9; at 9.5 (file 0.5) the next bar (file 2) is heard at 11, not at 10 as the linear reading had it.
    b.lookahead = 0;
    const f = musicFrameAt(b, 9.5);
    expect(quantizedRamp(player, "u", 1, "bar", QUANTIZED_RAMP_SECONDS, f)).toBeCloseTo(11, 9);
  });
});
