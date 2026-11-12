// ADR 0166 P8: hot reload of a playing segment on the fake backend with a deterministic clock. Each frame sets `now` and
// the horizon (now + L, L = 33.3 ms at 60 Hz); the test says when a group is primed. 120 bpm 4/4: a bar is 2 s; the
// first segment starts at 1.1 s (now 1 + the 100 ms lead), so bar lines are heard at 3.1, 5.1, ...
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend, type AudioVoice, type ShapedFade } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, tickPlayer, type MusicFrame, type MusicNodeRef, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "./segmentRun";
import { requestStart } from "./planner";
import { noteAssetChanged, RELOAD_FADE_MS, setReloadHost } from "./reload";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;
const FACTS: MusicClipFacts = { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true };

function segment(id: string, clips: string[], extra: Record<string, unknown> = {}): SegmentNode {
  const tracks = clips.map((clip, k) => ({ name: `t${k}`, clip }));
  const node = parseSegmentNode({ type: "segment", id, tracks, ...extra }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

let groupIds = 7;
const instance = (path = "music.audioevent"): EventInstance =>
  ({ group: groupIds++, world: 1, path, asset: { bus: "Music", volume: 1 } }) as unknown as EventInstance;

let b: FakeBackend;
const f = { backend: null as unknown as FakeBackend, music: null as FakeBackend["music"] | null, now: 0, dt: DT, hidden: false };
const shaped: { voice: AudioVoice; fade: ShapedFade }[] = [];

/** Set the clock to `now`: Audio.time and the horizon (now + L). */
function at(now: number): MusicFrame {
  f.now = now;
  (b as { time: number }).time = now;
  b.horizonTime = now + L;
  return f as unknown as MusicFrame;
}

const invalidated: string[] = [];
let eventRoot: MusicNodeRef | null = null;

function rig(): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  f.backend = b;
  f.music = b.music ?? null;
  shaped.length = 0;
  invalidated.length = 0;
  eventRoot = null;
  setSegmentClipSource({ url: (p) => `/assets/${p}`, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: () => FACTS });
  setReloadHost({ invalidateClip: (p) => invalidated.push(p), eventRoot: () => eventRoot });
  at(1);
}

/** Give every voice of the player's run a recording `fadeShaped` (the fake's voices have none). */
function recordFades(player: MusicPlayer): void {
  for (const s of player.run!.stems) {
    const v = s.voice as AudioVoice & { stopped?: number[] };
    v.fadeShaped = (fade: ShapedFade) => void shaped.push({ voice: v, fade });
  }
}

/** A player whose segment A (two streamed stems) plays from 1.1 s. */
function playingPlayer(node: SegmentNode = segment("A", ["music/a1.ogg", "music/a2.ogg"])): MusicPlayer {
  const player = createMusicPlayer(instance(), node);
  tickPlayer(player, at(1));
  b.music!.setPrimed(player.planned!.run.group);
  tickPlayer(player, at(1 + DT));
  expect(player.state).toBe("committed");
  tickPlayer(player, at(1.2));
  expect(player.state).toBe("playing");
  recordFades(player);
  return player;
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setReloadHost(null);
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("reload: a stem edit swaps at the next bar without a gap", () => {
  it("re-primes the changed segment, keeps the outgoing stems until the bar line, and switches there", () => {
    rig();
    const player = playingPlayer();
    const old = player.run!;
    const oldGroup = old.group;
    const stamps = b.music!.stamps.length;

    noteAssetChanged("music/a1.ogg");
    expect(invalidated).toEqual(["music/a1.ogg"]);
    // Nothing is planned until the player's tick.
    expect(player.planned).toBeNull();
    tickPlayer(player, at(2));
    const p = player.planned!;
    expect(p.request.reason).toBe("reload");
    expect(p.point).toBeCloseTo(3.1, 9); // the next bar line after now + lead
    expect(p.at).toBeCloseTo(3.1, 9);
    expect(p.run.group).not.toBe(oldGroup);
    expect(b.music!.admitted.at(-1)!.group).toBe(p.run.group);
    // The new group starts from the file position the old one is at then: sameTime, (3.1 - 1.1) s into the file.
    expect(p.run.startFrame).toBe(2 * RATE);
    expect(b.music!.primes.at(-1)!.request.members.map((m) => m.startFrame)).toEqual([2 * RATE, 2 * RATE]);

    // Still priming: the outgoing group is untouched.
    tickPlayer(player, at(2.5));
    expect(b.music!.stamps).toHaveLength(stamps);
    expect(player.run).toBe(old);
    expect(shaped).toHaveLength(0);
    expect(b.music!.cancelled).not.toContain(oldGroup);

    // Primed: stamped in the same batch at T, and the outgoing stems get their fade-out at T.
    b.music!.setPrimed(p.run.group);
    tickPlayer(player, at(2.6));
    expect(b.music!.stamps).toHaveLength(stamps + 1);
    expect(b.music!.stamps.at(-1)!.at).toBeCloseTo(3.1, 9);
    expect(shaped).toHaveLength(2);
    for (const s of shaped) {
      expect(s.fade.at).toBeCloseTo(3.1, 9);
      expect(s.fade.to).toBe(0);
      expect(s.fade.seconds).toBeCloseTo(RELOAD_FADE_MS / 1000, 12);
      expect(s.fade.stopAtEnd).toBe(true);
      expect(s.fade.law).toBe("equalPowerOut");
    }
    // The outgoing run still owns the player until the bar line, and nothing stopped it early.
    expect(player.run).toBe(old);
    expect(old.state).not.toBe("cancelled");
    for (const s of old.stems) expect((s.voice as unknown as { stopped?: boolean }).stopped).toBeFalsy();

    // At the bar line the incoming run takes over, anchored where it starts.
    tickPlayer(player, at(3.1));
    expect(player.run).toBe(p.run);
    expect(player.next).toBeNull();
    expect(player.anchor!.time).toBeCloseTo(3.1, 9);
    expect(player.anchor!.ticks).toBe(3840); // 2 s into the file: one 4/4 bar at 120 bpm
    expect(old.state).toBe("ending");
    // The outgoing group is freed once its fade is over.
    tickPlayer(player, at(3.15));
    expect(b.music!.cancelled).not.toContain(oldGroup);
    tickPlayer(player, at(3.3));
    expect(b.music!.cancelled).toContain(oldGroup);
    expect(old.state).toBe("cancelled");
    expect(player.state).toBe("playing");
  });

  it("a bar line too close to now + lead waits for the next one", () => {
    rig();
    const player = playingPlayer();
    noteAssetChanged("music/a2.ogg");
    tickPlayer(player, at(3.0)); // earliest 3.1 - EPS passes; 3.0 + 0.1 = 3.1 is on the bar line
    expect(player.planned!.point).toBeCloseTo(3.1, 9);
    noteAssetChanged("music/a2.ogg");
    tickPlayer(player, at(3.05)); // the plan is replaced; 3.15 is past 3.1, so the next bar is 5.1
    expect(player.planned!.point).toBeCloseTo(5.1, 9);
  });

  it("a clip nobody plays, or one that changed before anything plays, marks nothing", () => {
    rig();
    const player = playingPlayer();
    noteAssetChanged("music/other.ogg");
    expect(invalidated).toEqual(["music/other.ogg"]); // the cache is dropped anyway
    tickPlayer(player, at(2));
    expect(player.planned).toBeNull();
  });
});

describe("reload: an edited event asset", () => {
  it("a changed segment is swapped at the bar, and the root is replaced so rules apply to the next decision", () => {
    rig();
    const player = playingPlayer();
    const edited = segment("A", ["music/a1.ogg", "music/a2.ogg", "music/a3.ogg"]);
    eventRoot = edited;
    noteAssetChanged("music.audioevent");
    tickPlayer(player, at(2));
    expect(player.root).toBe(edited);
    const p = player.planned!;
    expect(p.request.to).toBe(edited);
    expect(p.run.stems).toHaveLength(3);
    b.music!.setPrimed(p.run.group);
    tickPlayer(player, at(2.6));
    tickPlayer(player, at(3.1));
    expect(player.run).toBe(p.run);
  });

  it("an edit that leaves the playing segment as it was only swaps the root", () => {
    rig();
    const player = playingPlayer();
    const same = segment("A", ["music/a1.ogg", "music/a2.ogg"]);
    eventRoot = same;
    noteAssetChanged("music.audioevent");
    tickPlayer(player, at(2));
    expect(player.root).toBe(same);
    expect(player.planned).toBeNull();
  });

  it("an event that no longer holds the playing segment keeps the old version, with one warning", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const player = playingPlayer();
    const old = player.root;
    eventRoot = segment("Z", ["music/z.ogg"]);
    noteAssetChanged("music.audioevent");
    tickPlayer(player, at(2));
    noteAssetChanged("music.audioevent");
    tickPlayer(player, at(2.1));
    expect(player.root).toBe(old);
    expect(player.planned).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    eventRoot = null; // an invalid file reads as no root
    noteAssetChanged("music.audioevent");
    tickPlayer(player, at(2.2));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a changed tempo map enters at the entry cue: from the file start, its pre-entry heard before the bar line", () => {
    rig();
    const player = playingPlayer();
    eventRoot = segment("A", ["music/a1.ogg", "music/a2.ogg"], {
      tempo: [{ at: "1:1:0", bpm: 90, beatsPerBar: 4, beatUnit: 4 }],
      cues: [{ name: "go", at: "1:2:0" }],
      entry: "go",
    });
    noteAssetChanged("music.audioevent");
    tickPlayer(player, at(2));
    const p = player.planned!;
    expect(p.point).toBeCloseTo(3.1, 9);
    expect(p.run.startFrame).toBe(0);
    expect(p.at).toBeLessThan(p.point); // the pre-entry (one beat at 90 bpm) plays before T
  });
});

describe("reload: while something else is planned", () => {
  it("waits for the other plan, which is not replaced", () => {
    rig();
    const player = playingPlayer();
    const next = segment("B", ["music/b1.ogg"]);
    requestStart(player, { to: next, reason: "transition", grid: "bar", notBefore: Number.NaN, startFrame: 0 }, at(1.3));
    const foreign = player.planned!;
    noteAssetChanged("music/a1.ogg");
    tickPlayer(player, at(1.4));
    expect(player.planned).toBe(foreign);
    // Once the foreign plan is stamped and has taken over, the stale-clip mark is dropped with its run (B plays no a1).
    b.music!.setPrimed(foreign.run.group);
    tickPlayer(player, at(2.9));
    expect(player.planned).toBeNull();
  });
});
