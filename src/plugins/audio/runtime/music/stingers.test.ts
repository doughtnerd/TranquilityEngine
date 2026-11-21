// ADR 0166 R5: stingers on the fake backend. The playing segment `a` is 120 bpm 4/4 (a beat is 0.5 s, a bar 2 s), its
// anchor puts bar 1 beat 1 at heard time 0, and the fake clock and horizon are set by hand. Expected times are read off
// that grid, not off G1's helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend, endAudioSession, musicFrameAt } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { createMusicPlayer, type MusicPlayer } from "./musicSystem";
import { createSegmentRun } from "./segmentRun";
import { projectBuses, serveMusicClips } from "./testing/clips";
import { tickStingers, triggerOn } from "./stingers";
import { commitStart, noteStartHeard, promote, stopPlayer } from "./musicPlayer";

type Raw = Record<string, unknown>;

const seg = (id: string, clip = `music/${id}.ogg`): Raw => ({ type: "segment", id, tracks: [{ name: "t", clip }] });
const stinger = (extra: Raw = {}): Raw => ({ trigger: "hit", segment: "hit", at: "beat", ...extra });

function rootOf(stingers: Raw[], library: Raw[] = [seg("hit")], extra: Raw = {}): MusicNode {
  const { value } = parseAudioEvent({
    format: "myco.audioevent@1", bus: "Music",
    root: { type: "playlist", id: "p", children: [{ ...seg("a"), cues: [{ name: "drop", at: "2:1:0" }] }], library, stingers, ...extra },
  });
  if (!value.musicRoot) throw new Error("not a music root");
  return value.musicRoot;
}

let b: FakeBackend;
let player: MusicPlayer;

/** A player playing `a` with its anchor at heard 0, and one tick so `trigger` has a frame. */
function rig(root: MusicNode): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  serveMusicClips(b);
  const inst = { group: 7, world: 1, path: "m.audioevent", asset: { bus: "Music" } } as unknown as EventInstance;
  player = createMusicPlayer(inst, root);
  const a = (root as unknown as { children: SegmentNode[] }).children[0]!;
  const run = createSegmentRun(player, a, 0); // null when the first child is itself a container
  if (run) {
    run.startAt = 0;
    commitStart(player, run, 0);
    noteStartHeard(player, 0);
  }
  b.lookahead = 0;
  tickStingers(player, musicFrameAt(b, 0.1));
}

const at = (t: number, horizon = t): void => {
  b.advanceTo(t);
  b.lookahead = horizon - t;
};
const tick = (): void => tickStingers(player, musicFrameAt(b));

afterEach(() => {
  endAudioSession();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("trigger namespace", () => {
  it("is false for an unknown name and for a non-music handle", () => {
    rig(rootOf([stinger()]));
    expect(triggerOn(player.instance, "nope")).toBe(false);
    expect(player.counters.refusals.stingerUnknown).toBe(1);
    expect(triggerOn({}, "hit")).toBe(false);
  });

  it("the deepest container above the playing segment wins, then list order", () => {
    const inner = { type: "playlist", id: "in", children: [seg("a")], library: [seg("deep")], stingers: [stinger({ segment: "deep" })] };
    const { value } = parseAudioEvent({
      format: "myco.audioevent@1", bus: "Music",
      root: { type: "playlist", id: "p", children: [inner], library: [seg("hit")], stingers: [stinger()] },
    });
    rig(value.musicRoot!);
    // The playing segment is the inner playlist's child.
    const a = ((value.musicRoot as unknown as { children: { children: SegmentNode[] }[] }).children[0]!).children[0]!;
    promote(player, createSegmentRun(player, a, 0)!, 0);
    expect(triggerOn(player.instance, "hit")).toBe(true);
    expect(b.music!.admitted[0]!.members[0]!.play.path).toBe("music/deep.ogg");
  });
});

describe("quantise and the grid", () => {
  it("stamps at the next beat and never changes the grid", () => {
    rig(rootOf([stinger()]));
    const run = player.run;
    const anchor = { ...player.anchor! };
    expect(triggerOn(player.instance, "hit")).toBe(true);
    tick();
    expect(b.music!.stamps).toHaveLength(1);
    expect(b.music!.stamps[0]!.at).toBeCloseTo(0.5, 9);
    expect(player.counters.stingers).toMatchObject({ played: 1, late: 0 });
    // The playing segment's anchor, run and plan are untouched; so are the next grid points.
    expect(player.run).toBe(run);
    expect(player.anchor).toEqual(anchor);
    expect(player.next).toBeNull();
    expect(player.planned).toBeNull();
    expect(player.state).toBe("playing");
  });

  it("a bar spec lands on the bar; immediate on the earliest time; a cue on the cue", () => {
    rig(rootOf([stinger({ trigger: "bar", at: "bar" }), stinger({ trigger: "now", at: "immediate" }), stinger({ trigger: "cue", at: { cue: "drop" } })]));
    at(0.1, 0.15);
    expect(triggerOn(player.instance, "bar")).toBe(true);
    expect(triggerOn(player.instance, "now")).toBe(true);
    expect(triggerOn(player.instance, "cue")).toBe(true);
    tick();
    const times = b.music!.stamps.map((s) => s.at);
    expect(times[0]).toBeCloseTo(2, 9);
    expect(times[1]).toBeCloseTo(0.15, 9);
    expect(times[2]).toBeCloseTo(2, 9); // cue 2:1:0 is 2 s in
  });

  it("a cue already passed has no point and drops", () => {
    rig(rootOf([stinger({ at: { cue: "drop" } })]));
    at(2.5);
    expect(triggerOn(player.instance, "hit")).toBe(false);
    expect(player.counters.stingers.dropped).toBe(1);
  });

  it("uses its own volume and bus", () => {
    const restoreBuses = projectBuses(["Music", "Stingers"]);
    rig(rootOf([stinger({ volume: 0.5, bus: "Stingers" })]));
    expect(triggerOn(player.instance, "hit")).toBe(true);
    const play = b.music!.admitted[0]!.members[0]!.play;
    expect(play.bus).toBe("Stingers");
    expect(play.volume).toBeCloseTo(0.5, 9);
    restoreBuses();
  });
});

describe("ifTooLate", () => {
  // Point 0.5 s; the horizon at 0.55 s makes it late.
  it("nextGrid moves to the next grid point and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rig(rootOf([stinger({ ifTooLate: "nextGrid" })]));
    at(0.4, 0.55);
    expect(triggerOn(player.instance, "hit")).toBe(true);
    tick();
    expect(b.music!.stamps[0]!.at).toBeCloseTo(1.0, 9);
    expect(player.counters.stingers.late).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it("playNow plays at the earliest time", () => {
    rig(rootOf([stinger({ ifTooLate: "playNow" })]));
    at(0.4, 0.55);
    expect(triggerOn(player.instance, "hit")).toBe(true);
    tick();
    expect(b.music!.stamps[0]!.at).toBeCloseTo(0.55, 9);
    expect(player.counters.stingers.late).toBe(1);
  });

  it("skip drops it and returns false without admitting anything", () => {
    rig(rootOf([stinger({ ifTooLate: "skip" })]));
    at(0.4, 0.55);
    expect(triggerOn(player.instance, "hit")).toBe(false);
    expect(b.music!.admitted).toHaveLength(0);
    expect(player.counters.stingers.skipped).toBe(1);
  });

  it("an on-time stinger is not late whatever ifTooLate says", () => {
    rig(rootOf([stinger({ ifTooLate: "skip" })]));
    expect(triggerOn(player.instance, "hit")).toBe(true);
    expect(player.counters.stingers.skipped).toBe(0);
  });

  it("a streamed stinger that finds its point inside its prime lead applies ifTooLate when primed", () => {
    rig(rootOf([stinger({ ifTooLate: "skip" })]));
    serveMusicClips(b, {}, { stream: true });
    player.counters.leadMs = 200;
    at(0.1);
    // Point 0.5 is after now + 0.2: accepted, queued, waiting for its ring.
    expect(triggerOn(player.instance, "hit")).toBe(true);
    tick();
    expect(b.music!.stamps).toHaveLength(0);
    // The prime finishes after the point is inside the lead: skip drops it.
    at(0.4);
    b.music!.setPrimed(b.music!.admitted[0]!.group);
    tick();
    expect(b.music!.stamps).toHaveLength(0);
    expect(player.counters.stingers.skipped).toBe(1);
    expect(b.music!.cancelled).toContain(b.music!.admitted[0]!.group);
  });
});

describe("dontRepeat", () => {
  it("drops a repeat inside the window and plays again after it", () => {
    rig(rootOf([stinger({ dontRepeat: 2 })]));
    expect(triggerOn(player.instance, "hit")).toBe(true); // plays at 0.5
    tick();
    at(1.0);
    expect(triggerOn(player.instance, "hit")).toBe(false);
    expect(player.counters.stingers.dropped).toBe(1);
    at(2.6);
    expect(triggerOn(player.instance, "hit")).toBe(true);
  });
});

describe("at most 4 at once", () => {
  // The fake backend only keeps voices for primed (streamed) groups, so these stingers stream.
  const streamed = (): void => serveMusicClips(b, {}, { stream: true });
  const fire = (): boolean => {
    const ok = triggerOn(player.instance, "hit");
    b.music!.setPrimed(b.music!.admitted[b.music!.admitted.length - 1]!.group);
    tick();
    return ok;
  };

  it("the fifth steals the oldest with a 5 ms fade", () => {
    rig(rootOf([stinger({ at: "immediate" })]));
    streamed();
    for (let k = 0; k < 4; k++) expect(fire()).toBe(true);
    expect(player.stingers!.sounding).toHaveLength(4);
    const oldest = player.stingers!.sounding[0]!;
    const calls = vi.spyOn(oldest.voices[0]!, "fadeShaped");
    expect(fire()).toBe(true);
    expect(calls).toHaveBeenCalledWith(expect.objectContaining({ to: 0, seconds: 0.005, law: "linear", stopAtEnd: true }));
    expect(player.stingers!.sounding).toHaveLength(4);
    expect(player.stingers!.sounding).not.toContain(oldest);
  });

  it("an ended stinger frees its slot", () => {
    rig(rootOf([stinger({ at: "immediate" })]));
    streamed();
    expect(fire()).toBe(true);
    const e = player.stingers!.sounding[0]!;
    at(5);
    for (const v of e.voices) v.stop();
    tick();
    expect(player.stingers!.sounding).toHaveLength(0);
  });
});

describe("the pool", () => {
  it("a refused admission returns false and counts it", () => {
    rig(rootOf([stinger()]));
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    expect(triggerOn(player.instance, "hit")).toBe(false);
    expect(player.counters.refusals.poolFull).toBe(1);
    expect(player.stingers!.queued).toHaveLength(0);
  });

  it("a trigger before any tick, or on a stopping player, is false", () => {
    rig(rootOf([stinger()]));
    stopPlayer(player);
    expect(triggerOn(player.instance, "hit")).toBe(false);
  });
});
