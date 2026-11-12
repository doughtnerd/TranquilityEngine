// ADR 0166 R5: stingers on the fake backend. The playing segment `a` is 120 bpm 4/4 (a beat is 0.5 s, a bar 2 s), its
// anchor puts bar 1 beat 1 at heard time 0, and the fake clock and horizon are set by hand. Expected times are read off
// that grid, not off G1's helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, createSegmentRun, setSegmentClipSource } from "./segmentRun";
import { _resetStingers, createStingerState, tickStingers, triggerOn, triggerStinger } from "./stingers";

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
let f: MusicFrame;
let player: MusicPlayer;

/** A player playing `a` with its anchor at heard 0, and one tick so `trigger` has a frame. */
function rig(root: MusicNode): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: false }), bus: (o) => o ?? "Master", facts: () => undefined });
  const inst = { group: 7, world: 1, path: "m.audioevent", asset: { bus: "Music" } } as unknown as EventInstance;
  player = createMusicPlayer(inst, root);
  const a = (root as unknown as { children: SegmentNode[] }).children[0]!;
  player.run = createSegmentRun(player, a, 0);
  player.state = "playing";
  player.anchor = { segment: "a", ticks: 0, time: 0, pass: 1, node: a, rate: 48000 };
  (b as { time: number }).time = 0.1;
  b.horizonTime = 0.1;
  f = { backend: b, music: b.music ?? null, now: 0.1, dt: 1 / 60, hidden: false };
  tickStingers(player, f);
}

const at = (t: number, horizon = t): void => {
  (b as { time: number }).time = t;
  b.horizonTime = horizon;
};
const tick = (): void => tickStingers(player, f);

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  _resetStingers();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("trigger namespace", () => {
  it("is false for an unknown name and for a non-music handle", () => {
    rig(rootOf([stinger()]));
    expect(triggerStinger(player, "nope")).toBe(false);
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
    player.run = createSegmentRun(player, a, 0);
    expect(triggerStinger(player, "hit")).toBe(true);
    expect(b.music!.admitted[0]!.members[0]!.play.path).toBe("music/deep.ogg");
  });
});

describe("quantise and the grid", () => {
  it("stamps at the next beat and never changes the grid", () => {
    rig(rootOf([stinger()]));
    const run = player.run;
    const anchor = { ...player.anchor! };
    expect(triggerStinger(player, "hit")).toBe(true);
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
    expect(triggerStinger(player, "bar")).toBe(true);
    expect(triggerStinger(player, "now")).toBe(true);
    expect(triggerStinger(player, "cue")).toBe(true);
    tick();
    const times = b.music!.stamps.map((s) => s.at);
    expect(times[0]).toBeCloseTo(2, 9);
    expect(times[1]).toBeCloseTo(0.15, 9);
    expect(times[2]).toBeCloseTo(2, 9); // cue 2:1:0 is 2 s in
  });

  it("a cue already passed has no point and drops", () => {
    rig(rootOf([stinger({ at: { cue: "drop" } })]));
    at(2.5);
    expect(triggerStinger(player, "hit")).toBe(false);
    expect(player.counters.stingers.dropped).toBe(1);
  });

  it("uses its own volume and bus", () => {
    rig(rootOf([stinger({ volume: 0.5, bus: "Stingers" })]));
    expect(triggerStinger(player, "hit")).toBe(true);
    const play = b.music!.admitted[0]!.members[0]!.play;
    expect(play.bus).toBe("Stingers");
    expect(play.volume).toBeCloseTo(0.5, 9);
  });
});

describe("ifTooLate", () => {
  // Point 0.5 s; the horizon at 0.55 s makes it late.
  it("nextGrid moves to the next grid point and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rig(rootOf([stinger({ ifTooLate: "nextGrid" })]));
    at(0.4, 0.55);
    expect(triggerStinger(player, "hit")).toBe(true);
    tick();
    expect(b.music!.stamps[0]!.at).toBeCloseTo(1.0, 9);
    expect(player.counters.stingers.late).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it("playNow plays at the earliest time", () => {
    rig(rootOf([stinger({ ifTooLate: "playNow" })]));
    at(0.4, 0.55);
    expect(triggerStinger(player, "hit")).toBe(true);
    tick();
    expect(b.music!.stamps[0]!.at).toBeCloseTo(0.55, 9);
    expect(player.counters.stingers.late).toBe(1);
  });

  it("skip drops it and returns false without admitting anything", () => {
    rig(rootOf([stinger({ ifTooLate: "skip" })]));
    at(0.4, 0.55);
    expect(triggerStinger(player, "hit")).toBe(false);
    expect(b.music!.admitted).toHaveLength(0);
    expect(player.counters.stingers.skipped).toBe(1);
  });

  it("an on-time stinger is not late whatever ifTooLate says", () => {
    rig(rootOf([stinger({ ifTooLate: "skip" })]));
    expect(triggerStinger(player, "hit")).toBe(true);
    expect(player.counters.stingers.skipped).toBe(0);
  });

  it("a streamed stinger that finds its point inside its prime lead applies ifTooLate when primed", () => {
    rig(rootOf([stinger({ ifTooLate: "skip" })]));
    setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: () => undefined });
    player.counters.leadMs = 200;
    at(0.1);
    // Point 0.5 is after now + 0.2: accepted, queued, waiting for its ring.
    expect(triggerStinger(player, "hit")).toBe(true);
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
    expect(triggerStinger(player, "hit")).toBe(true); // plays at 0.5
    tick();
    at(1.0);
    expect(triggerStinger(player, "hit")).toBe(false);
    expect(player.counters.stingers.dropped).toBe(1);
    at(2.6);
    expect(triggerStinger(player, "hit")).toBe(true);
  });
});

describe("at most 4 at once", () => {
  // The fake backend only keeps voices for primed (streamed) groups, so these stingers stream.
  const streamed = (): void => setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: () => undefined });
  const fire = (): boolean => {
    const ok = triggerStinger(player, "hit");
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
    const calls = vi.spyOn(oldest.voices[0]!, "stop");
    expect(fire()).toBe(true);
    expect(calls).toHaveBeenCalledWith(0.005);
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
    expect(triggerStinger(player, "hit")).toBe(false);
    expect(player.counters.refusals.poolFull).toBe(1);
    expect(player.stingers!.queued).toHaveLength(0);
  });

  it("a trigger before any tick, or on a stopped player, is false", () => {
    rig(rootOf([stinger()]));
    player.state = "stopped";
    expect(triggerStinger(player, "hit")).toBe(false);
    expect(createStingerState().queued).toEqual([]);
  });
});
