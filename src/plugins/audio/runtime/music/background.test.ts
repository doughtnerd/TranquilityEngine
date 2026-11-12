// ADR 0166 P9: music recovery and the hidden-tab tick on the fake backend (`testing.ts` `FakeMusicBackend`) with a
// deterministic clock: each step sets `now` and the fake's horizon (now + L, L = 33.3 ms: 60 Hz); the test says when a
// group is primed. The loopback halves are `core/musicRecoveryLoopback.test.ts` and `core/musicHiddenLoopback.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, routeGroupEvent, setSegmentClipSource } from "./segmentRun";
import { planTick } from "./planner";
import { ticksAt } from "./anchors";
import { _resetMusicBackground, groupAbandoned, musicHidden, noteHidden, recoverAbandoned, recoverGroups, tickHidden } from "./background";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;

const FACTS: Record<string, MusicClipFacts> = {
  "music/a1.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/a2.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/c1.ogg": { frames: 10 * RATE, rate: RATE, channels: 2, gapless: true },
};

/** 120 bpm 4/4 (a bar is 2 s), no pickup. */
function segment(id: string, clips: string[]): SegmentNode {
  const tracks = clips.map((clip, k) => ({ name: `t${k}`, clip }));
  const node = parseSegmentNode({ type: "segment", id, gridOffset: 0, tracks }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

let groupIds = 7;
const instance = (): EventInstance =>
  ({ group: groupIds++, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 } }) as unknown as EventInstance;

let b: FakeBackend;
const f = { backend: null as unknown as FakeBackend, music: null as FakeBackend["music"] | null, now: 0, dt: DT, hidden: false };

function at(now: number): MusicFrame {
  f.now = now;
  (b as { time: number }).time = now;
  b.horizonTime = now + L;
  return f as unknown as MusicFrame;
}

function rig(): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  f.backend = b;
  f.music = b.music ?? null;
  setSegmentClipSource({ url: (p) => `/assets/${p}`, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: (p) => FACTS[p] });
  at(1);
}

/** A player whose first segment (two streamed stems) was stamped at 1.1 s (now 1 + lead 0.1) and plays. */
function playingPlayer(clips = ["music/a1.ogg", "music/a2.ogg"]): MusicPlayer {
  const player = createMusicPlayer(instance(), segment("A", clips));
  planTick(player, at(1));
  if (player.planned) {
    b.music!.setPrimed(player.planned.run.group);
    planTick(player, at(1 + DT));
    expect(player.run!.startAt).toBeCloseTo(1.1, 9);
  } // else decoded: stamped at once, at now + L
  expect(player.state).toBe("committed");
  planTick(player, at(1.2));
  expect(player.state).toBe("playing");
  return player;
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  _resetMusicBackground();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("music recovery (ADR 0166 P9, architecture §3.7)", () => {
  it("re-enters every stem together on the next bar at or after now + lead, from the heard position (sameTime)", () => {
    rig();
    const player = playingPlayer();
    const old = player.run!;
    const oldAnchor = { ...player.anchor! };
    // The rebuild at 5.3 s: the music is heard at file 4.2 s. now + lead = 5.4 (file 4.3), so the next bar is file
    // 6.0 s, heard at 7.1 s: the group restarts from file frame 288,000.
    at(5.3);
    recoverGroups(b, "rebuild");
    expect(player.state).toBe("recovering");
    expect(player.counters.recoveries.rebuild).toBe(1);
    expect(b.music!.cancelled).toContain(old.group);
    const p = player.planned!;
    expect(p.request.reason).toBe("recovery");
    expect(p.point).toBeCloseTo(7.1, 9);
    expect(p.at).toBeCloseTo(7.1, 9);
    expect(p.run.startFrame).toBe(6 * RATE);
    const prime = b.music!.primes.at(-1)!;
    expect(prime.request.members.map((m) => m.startFrame)).toEqual([6 * RATE, 6 * RATE]);
    // Primed: stamped at 7.1 (one stamp, every member), and the run and anchor are the player's again.
    b.music!.setPrimed(p.run.group);
    planTick(player, at(7));
    expect(b.music!.stamps.at(-1)).toMatchObject({ group: p.run.group, at: p.at });
    expect(player.run).toBe(p.run);
    expect(player.next).toBeNull();
    expect(player.state).toBe("committed");
    // The grid continues where it should: the new anchor reads the same position as the old one, any time after.
    for (const t of [7.1, 8, 9.37, 30]) expect(ticksAt(player.anchor!, t)).toBeCloseTo(ticksAt(oldAnchor, t), 6);
  });

  it("drops the successor and any plan; a player not stamped yet starts again", () => {
    rig();
    const player = createMusicPlayer(instance(), segment("A", ["music/a1.ogg"]));
    planTick(player, at(1));
    const first = player.planned!.run.group;
    recoverGroups(b, "crash");
    expect(player.counters.recoveries.crash).toBe(1);
    expect(b.music!.cancelled).toContain(first);
    expect(player.planned).toBeNull();
    expect(player.run).toBeNull();
    expect(player.state).toBe("starting");
    planTick(player, at(1.05));
    expect(player.planned).not.toBeNull();
    expect(player.planned!.at).toBeCloseTo(1.15, 9);
  });

  it("stops the player past the recovery limit (3 per 60 s), with one warning", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const player = playingPlayer();
    for (let k = 0; k < 3; k++) {
      clock += 1000;
      at(2 + k);
      recoverGroups(b, "rate");
      expect(player.state).toBe("recovering");
    }
    expect(player.counters.recoveries.rate).toBe(3);
    clock += 1000;
    recoverGroups(b, "rebuild");
    expect(player.state).toBe("stopping");
    expect(player.counters.recoveries.refused).toBe(1);
    expect(player.planned).toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("recoveries within 60 s"))).toHaveLength(1);
    // A stopping player isn't recovered again (and no second warning).
    recoverGroups(b, "rebuild");
    expect(player.counters.recoveries.refused).toBe(1);
  });

  it("a group the core gave up on (abandon) re-plans the playing segment", () => {
    rig();
    const player = playingPlayer();
    const group = player.run!.group;
    at(3.5);
    routeGroupEvent({ kind: "abandon", group, late: false, slipFrames: 0, startFrame: 0 }, RATE);
    expect(player.run!.state).toBe("cancelled");
    expect(player.counters.groupTimeouts).toBe(1);
    groupAbandoned(player, group);
    recoverAbandoned(b);
    expect(player.counters.recoveries.abandon).toBe(1);
    expect(player.state).toBe("recovering");
    // Heard file 2.4 s at 3.5; now + lead = 3.6 (file 2.5): the next bar is file 4.0, heard 5.1.
    expect(player.planned!.point).toBeCloseTo(5.1, 9);
    expect(player.planned!.run.startFrame).toBe(4 * RATE);
    // Nothing pending: a second call does nothing.
    recoverAbandoned(b);
    expect(player.counters.recoveries.abandon).toBe(1);
  });

  it("a re-entry past the segment's exit cue has nothing to play: the player ends", () => {
    rig();
    const player = playingPlayer(["music/c1.ogg"]); // 10 s: the exit cue is the file's end
    at(12);
    recoverGroups(b, "rebuild");
    expect(player.planned).toBeNull();
    expect(player.state).toBe("stopping");
  });
});

describe("the hidden-tab tick (ADR 0166 P9, architecture §3.8)", () => {
  it("ticks every player from STATUS while hidden: a start due meanwhile is stamped, and the batch is flushed", () => {
    rig();
    const commits: number[] = [];
    (b as unknown as { frameCommit(): void }).frameCommit = () => void commits.push(b.time);
    const player = createMusicPlayer(instance(), segment("A", ["music/a1.ogg"]));
    planTick(player, at(1));
    const p = player.planned!;
    b.music!.setPrimed(p.run.group);
    // Visible: tickHidden does nothing.
    at(1.03);
    tickHidden(b);
    expect(b.beginFrameCalls).toBe(0);
    expect(player.state).toBe("starting");
    noteHidden(true);
    expect(musicHidden()).toBe(true);
    tickHidden(b);
    expect(b.beginFrameCalls).toBe(1);
    expect(b.music!.stamps.at(-1)).toMatchObject({ group: p.run.group, at: p.at });
    expect(player.state).toBe("committed");
    expect(player.counters.recoveries.hidden).toBe(1);
    expect(commits).toEqual([1.03]);
    expect(b.music!.onGroupEvent).toBe(routeGroupEvent);
    noteHidden(false);
    tickHidden(b);
    expect(commits).toHaveLength(1);
  });
});
