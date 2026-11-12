// ADR 0166 api-and-models §1, the M4a rows (P7): `handle.music` getters and `nextGrid`, `Audio.horizon`, `Audio.timeAt`,
// `Audio.play(music, { at })`, and `Audio.time` in `update()`. One skipped case per row; leaf L-P7a fills the cases
// tagged `L-P7a` (the lead fills the one tagged `P7-lead`). Fixtures: build a player as `music/planner.test.ts` does
// (fake backend, `setSegmentClipSource`, a parsed segment, `planTick` until it plays) and read through `Audio` and
// `player.handle`.
//
// Clock used throughout: 120 bpm 4/4, so a beat is 0.5 s and a bar 2 s. A first segment with gridOffset 0 starts at
// heard 1.1 on bar 1 beat 1, so its grid points are 1.1 + 0.5 k. Each display frame is `frame(now)`: it sets the
// heard clock and begins a new frame, so the getters recompute on their next read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../myco";
import type { World } from "../../../engine/core/World";
import { Audio } from "./Audio";
import { AUDIO_SYSTEMS } from "./audioSystem";
import { setAudioBackend } from "./backend";
import { makeFakeBackend, type FakeBackend } from "./testing";
import type { EventInstance } from "./events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../engine/audio/musicValidate";
import { musicHandleOf } from "./music/handle";
import {
  _resetMusicPlayers, createMusicPlayer, disposeMusicPlayer, musicPlayers, type MusicFrame, type MusicPlayer,
} from "./music/musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "./music/segmentRun";
import { planTick, requestStart, type PlanRequest } from "./music/planner";
import { requestTransition, tickTransition } from "./music/transition";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;
const MUSIC_EVENT = "music.audioevent.json";

const FACTS: Record<string, MusicClipFacts> = {
  "music/a1.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/a2.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/b1.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/b2.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
};

function segment(id: string, clips: string[], gridOffset = 0, extra: Record<string, unknown> = {}): SegmentNode {
  const tracks = clips.map((clip, k) => ({ name: `t${k}`, clip }));
  const node = parseSegmentNode({ type: "segment", id, gridOffset, tracks, ...extra }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

/** Bars every 0.5 s on the heard clock, the planner's own test rule. */
const bars = (nb: number): number => Math.ceil(nb / 0.5 - 1e-9) * 0.5;

let groupIds = 7;
const instance = (): EventInstance =>
  ({ group: groupIds++, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 } }) as unknown as EventInstance;

let b: FakeBackend;
const f = { backend: null as unknown as FakeBackend, music: null as FakeBackend["music"] | null, now: 0, dt: DT, hidden: false };

/** Set the heard clock to `now` (Audio.time and the horizon now + L) and return the frame the planner ticks with. */
function at(now: number): MusicFrame {
  f.now = now;
  (b as { time: number }).time = now;
  b.horizonTime = now + L;
  return f as unknown as MusicFrame;
}

/** A new display frame at `now`: the handle's snapshot is recomputed on its next read. */
function frame(now: number): void {
  at(now);
  b.beginFrame?.();
}

function rig(): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  f.backend = b;
  f.music = b.music ?? null;
  setSegmentClipSource({ url: (p) => `/assets/${p}`, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: (p) => FACTS[p] });
  at(1);
}

/** A player whose first segment (two streamed stems, gridOffset 0) is stamped at 1.1 and playing from 1.2. */
function playingPlayer(node: SegmentNode = segment("A", ["music/a1.ogg", "music/a2.ogg"])): MusicPlayer {
  const player = createMusicPlayer(instance(), node);
  planTick(player, at(1));
  b.music!.setPrimed(player.planned!.run.group);
  planTick(player, at(1 + DT));
  expect(player.state).toBe("committed");
  planTick(player, at(1.2));
  expect(player.state).toBe("playing");
  return player;
}

/** A segment B for a change: two streamed stems, the planner's bar rule. */
const toB = (extra: Partial<PlanRequest> = {}): PlanRequest => ({
  to: segment("B", ["music/b1.ogg", "music/b2.ogg"]), reason: "switch", grid: "bar", notBefore: Number.NaN, startFrame: 0, points: bars, ...extra,
});

/** Register an audio event whose root is `root`, read by `Audio.play` as `MUSIC_EVENT`. */
function registerEvent(root: Record<string, unknown>): void {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, [MUSIC_EVENT]: { format: "myco.audioevent@1", root } }));
}

// `Audio.play` plays only with an active World that has the view (as audioApi.test.ts sets it up).
beforeEach(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
});

const SEGMENT_ROOT = {
  type: "segment", id: "A", tracks: [{ name: "t0", clip: "music/a1.ogg" }, { name: "t1", clip: "music/a2.ogg" }],
};

/** `Audio.play` of a segment-rooted event; the player is the newest one in the registry. */
function playMusic(options: { at?: number } = {}) {
  registerEvent(SEGMENT_ROOT);
  return Audio.play(MUSIC_EVENT, options);
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  Assets.clearSources();
  Audio.calibration = 0;
  vi.restoreAllMocks();
});

describe("L-P7a: handle.music getters (§1.2)", () => {
  it("L-P7a handle.music is undefined for an event that isn't music, and a MusicHandle for a segment, playlist or musicSwitch root", () => {
    rig();
    registerEvent({ type: "clip", clip: "music/a1.ogg" });
    expect(Audio.play(MUSIC_EVENT).music).toBeUndefined();
    expect(Audio.play("missing.audioevent.json").music).toBeUndefined();

    expect(playMusic().music).toBeDefined();

    const playlist = { group: 90 } as unknown as EventInstance;
    createMusicPlayer(playlist, { id: "P", type: "playlist" });
    expect(musicHandleOf(playlist)).toBeDefined();

    const musicSwitch = { group: 91 } as unknown as EventInstance;
    createMusicPlayer(musicSwitch, { id: "S", type: "musicSwitch" });
    expect(musicHandleOf(musicSwitch)).toBeDefined();
  });

  it("L-P7a segment is null while the first segment primes, then the playing segment's id", () => {
    rig();
    const h = playMusic();
    const player = musicPlayers().at(-1)!;
    planTick(player, at(1));
    frame(1);
    expect(h.music!.segment).toBeNull();

    b.music!.setPrimed(player.planned!.run.group);
    planTick(player, at(1 + DT));
    planTick(player, at(1.2));
    expect(player.state).toBe("playing");
    frame(1.2);
    expect(h.music!.segment).toBe("A");
  });

  it("L-P7a bar, beat and beatFraction follow the heard time through the anchor (bar 2 beat 3 half a beat in), 0..1 through the beat", () => {
    rig();
    const player = playingPlayer();
    frame(1.1);
    expect(player.handle.bar).toBe(1);
    expect(player.handle.beat).toBe(1);
    expect(player.handle.beatFraction).toBeCloseTo(0, 9);

    // 3.25 s after bar 1 beat 1 is 6.5 beats: bar 2 (beats 4..7), beat 3, half a beat in.
    frame(1.1 + 3.25);
    expect(player.handle.bar).toBe(2);
    expect(player.handle.beat).toBe(3);
    expect(player.handle.beatFraction).toBeCloseTo(0.5, 9);

    frame(1.1 + 0.9);
    expect(player.handle.beatFraction).toBeGreaterThanOrEqual(0);
    expect(player.handle.beatFraction).toBeLessThan(1);
  });

  it("L-P7a tempo, beatsPerBar and beatUnit read the span at the position, and change across a tempo marker", () => {
    rig();
    const tempoNode = parseSegmentNode(
      {
        type: "segment", id: "T", tracks: [{ name: "t0", clip: "music/a1.ogg" }],
        tempo: [
          { at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 },
          { at: "2:1:0", bpm: 60, beatsPerBar: 3, beatUnit: 8 },
        ],
      },
      "test",
      newMusicContext(),
    ) as SegmentNode;
    const player = playingPlayer(tempoNode);

    // Bar 1 (heard 1.1 to 3.1) at 120 bpm 4/4.
    frame(2.0);
    expect(player.handle.tempo).toBe(120);
    expect(player.handle.beatsPerBar).toBe(4);
    expect(player.handle.beatUnit).toBe(4);

    // Bar 2 starts at heard 3.1 (the marker): 60 bpm 3/8.
    frame(3.5);
    expect(player.handle.bar).toBe(2);
    expect(player.handle.tempo).toBe(60);
    expect(player.handle.beatsPerBar).toBe(3);
    expect(player.handle.beatUnit).toBe(8);
  });

  it("L-P7a time is this display frame's Audio.time", () => {
    rig();
    const player = playingPlayer();
    frame(2.0);
    expect(player.handle.time).toBe(2);
    expect(Audio.time).toBe(2);
    frame(2.25);
    expect(player.handle.time).toBe(2.25);
    expect(Audio.time).toBe(2.25);
  });

  // Un-skipped by R3a: the change is R3a's `requestTransition` (the default rule of a segment root: the next bar, entry
  // cue). A plays from 1.1, so its bars are heard at 1.1, 3.1, ...
  it("L-P7a transition is null until a change is planned, then { to, time } with the incoming segment's heard entry time, null again once it landed", () => {
    rig();
    const player = playingPlayer();
    frame(1.35);
    expect(player.handle.transition).toBeNull();

    // B's 0.1 s pickup (preEntry): the group starts at 3.0 but the entry (what `time` is) is heard at 3.1.
    const t = requestTransition(player, segment("B", ["music/b1.ogg", "music/b2.ogg"], 0.1), at(1.35))!;
    const p = t.incoming!;
    expect(p.point).toBeCloseTo(3.1, 9);
    expect(p.at).toBeCloseTo(3.0, 9);
    frame(1.35);
    expect(player.handle.transition).toEqual({ to: "B", time: expect.closeTo(3.1, 9) });

    // Primed and stamped, not yet landed: still pending.
    b.music!.setPrimed(p.run.group);
    tickTransition(player, at(1.4));
    planTick(player, at(1.4));
    expect(t.state).toBe("stamped");
    frame(2.95);
    expect(player.handle.transition).toEqual({ to: "B", time: expect.closeTo(3.1, 9) });

    // Landed at the entry: no pending change, B plays.
    for (let now = 3.0; now <= 3.15; now += DT) {
      tickTransition(player, at(now));
      planTick(player, at(now));
    }
    frame(3.15);
    expect(player.handle.transition).toBeNull();
    expect(player.handle.segment).toBe("B");
  });

  it("L-P7a the getters share one snapshot per frame: equal values within a frame, recomputed on the next, no allocation after the first read", () => {
    // The allocation half is not observable from here (no allocation counter in the fake); this checks the values.
    rig();
    const player = playingPlayer();
    frame(2.0);
    const h = player.handle;
    const first = { bar: h.bar, beat: h.beat, fraction: h.beatFraction, time: h.time, tempo: h.tempo };
    expect(first.time).toBe(2);
    expect(first.beat).toBe(2);

    // Same frame, read again: the same values (the clock does not move within a frame).
    expect({ bar: h.bar, beat: h.beat, fraction: h.beatFraction, time: h.time, tempo: h.tempo }).toEqual(first);

    // Next frame: recomputed at 2.6 (1.5 s = 3 beats after bar 1 beat 1: beat 4, no fraction).
    frame(2.6);
    expect(h.time).toBe(2.6);
    expect(h.beat).toBe(4);
    expect(h.beatFraction).toBeCloseTo(0, 9);
  });
});

describe("L-P7a: nextGrid (§1.2)", () => {
  it("L-P7a 'beat', 'bar' and { every, n } give the next grid point after Audio.time with its bar, beat and segment id", () => {
    rig();
    const player = playingPlayer();
    frame(1.3);
    const h = player.handle;
    expect(h.nextGrid("beat")).toEqual({ time: expect.closeTo(1.6, 9), bar: 1, beat: 2, segment: "A" });
    expect(h.nextGrid("bar")).toEqual({ time: expect.closeTo(3.1, 9), bar: 2, beat: 1, segment: "A" });
    // Every second beat counted from bar 1 beat 1 (0-based beat index a multiple of 2): 1.1, 2.1, 3.1 ...
    expect(h.nextGrid({ every: "beat", n: 2 })).toEqual({ time: expect.closeTo(2.1, 9), bar: 1, beat: 3, segment: "A" });
    // Every second bar, from bar 1: bars 1, 3, 5 ...
    expect(h.nextGrid({ every: "bar", n: 2 })).toEqual({ time: expect.closeTo(5.1, 9), bar: 3, beat: 1, segment: "A" });
  });

  it("L-P7a the point is clamped to the segment's exit cue (null past it when nothing follows)", () => {
    rig();
    // The exit cue sits on bar 2 beat 1: heard 3.1.
    const exiting = segment("E", ["music/a1.ogg"], 0, { cues: [{ name: "exit", at: "2:1:0" }], exit: "exit" });
    const player = playingPlayer(exiting);
    frame(2.7);
    expect(player.handle.nextGrid("beat")).toEqual({ time: expect.closeTo(3.1, 9), bar: 2, beat: 1, segment: "E" });
    // Bar 3 (5.1) is past the exit, and nothing follows: no point.
    expect(player.handle.nextGrid({ every: "bar", n: 2 })).toBeNull();
  });

  // Un-skipped by R3a: the pending change is R3a's `requestTransition` (default rule: B lands on A's next bar, 3.1).
  it("L-P7a with a pending change the points after transition.time are the incoming segment's (GridPoint.segment says which)", () => {
    rig();
    const player = playingPlayer();
    requestTransition(player, segment("B", ["music/b1.ogg", "music/b2.ogg"]), at(1.35));
    frame(1.45);
    const h = player.handle;
    expect(h.transition).toEqual({ to: "B", time: expect.closeTo(3.1, 9) });
    // A's next beat (1.6) is before the change: A's.
    expect(h.nextGrid("beat")).toEqual({ time: expect.closeTo(1.6, 9), bar: 1, beat: 2, segment: "A" });
    // A's next 2-bar point (5.1) is after it: B's grid from its entry at 3.1 (whose own first 2-bar point is its entry).
    expect(h.nextGrid({ every: "bar", n: 2 })).toEqual({ time: expect.closeTo(3.1, 9), bar: 1, beat: 1, segment: "B" });
  });

  it("L-P7a null when the music is not playing (priming, refused, stopped)", () => {
    rig();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const specs = ["beat", "bar", { every: "bar", n: 2 }] as const;

    // Priming the first segment.
    const priming = createMusicPlayer(instance(), segment("A", ["music/a1.ogg"]));
    planTick(priming, at(1));
    frame(1);
    for (const s of specs) expect(priming.handle.nextGrid(s)).toBeNull();

    // Stopped: a player that was playing and has ended.
    const stopped = playingPlayer();
    disposeMusicPlayer(stopped, b);
    frame(2.0);
    for (const s of specs) expect(stopped.handle.nextGrid(s)).toBeNull();

    // Refused: a first segment that can never fit the pool.
    (b.music as unknown as { ringPool: number }).ringPool = 1;
    const refused = createMusicPlayer(instance(), segment("R", ["music/a1.ogg", "music/a2.ogg"]));
    planTick(refused, at(1));
    expect(refused.state).toBe("refused");
    for (const s of specs) expect(refused.handle.nextGrid(s)).toBeNull();
  });
});

describe("L-P7a: Audio clock members (§1.3)", () => {
  it("L-P7a Audio.horizon is the backend's horizon (now + lookahead), and Audio.time on a backend without one", () => {
    rig();
    at(2);
    expect(Audio.horizon).toBeCloseTo(2 + L, 9);
    b.horizonTime = null;
    expect(Audio.horizon).toBe(Audio.time);
    expect(Audio.horizon).toBe(2);
  });

  it("L-P7a Audio.timeAt maps a performance.now() instant to heard time, never applies Audio.calibration, and is Audio.time on a backend without timeAt", () => {
    rig();
    (b as { time: number }).time = 2;
    b.rafTime = 1000;
    // 250 ms after the frame's rAF time is 0.25 s later on the heard clock.
    expect(Audio.timeAt(1250)).toBeCloseTo(2.25, 9);
    Audio.calibration = 0.05;
    expect(Audio.calibration).toBe(0.05);
    expect(Audio.timeAt(1250)).toBeCloseTo(2.25, 9);

    // A backend with no timeAt: Audio.time.
    const bare = makeFakeBackend();
    delete (bare as { timeAt?: unknown }).timeAt;
    setAudioBackend(bare);
    (bare as { time: number }).time = 3;
    expect(Audio.timeAt(1250)).toBe(3);
  });
});

describe("L-P7a: Audio.play(music, { at }) (§1.3)", () => {
  it("L-P7a at reaches the player (requestedAt) and the first segment starts no earlier than it", () => {
    rig();
    playMusic({ at: 3 });
    const player = musicPlayers().at(-1)!;
    expect(player.requestedAt).toBe(3);

    planTick(player, at(1));
    // The first segment has no grid yet: its start is the entry, heard at `at`.
    expect(player.planned!.point).toBeCloseTo(3, 9);
    expect(player.planned!.at).toBeGreaterThanOrEqual(3 - 1e-9);
    b.music!.setPrimed(player.planned!.run.group);
    planTick(player, at(1.02));
    expect(b.music!.stamps.at(-1)!.at).toBeCloseTo(3, 9);
  });

  it("L-P7a at closer than the prime lead starts at now + lead with one warning; a non-finite at plays as soon as possible", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    playMusic({ at: 1.05 });
    const near = musicPlayers().at(-1)!;
    planTick(near, at(1));
    expect(near.planned!.at).toBeCloseTo(1.1, 9);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("closer than the prime lead");

    playMusic({ at: Number.NaN });
    const asap = musicPlayers().at(-1)!;
    expect(Number.isNaN(asap.requestedAt)).toBe(true);
    planTick(asap, at(1));
    expect(asap.planned!.at).toBeCloseTo(1.1, 9);
  });
});

describe("P7-lead: Audio.time in update() (§1.7, §6 step 0)", () => {
  it("P7-lead engine.AudioMusic calls beginFrame before scripts read Audio.time; with no music it does not", () => {
    const step = AUDIO_SYSTEMS.find((s) => s.name === "engine.AudioMusic")!;
    const world = { render: {}, _componentsOfType: () => [] } as unknown as World;
    const b = makeFakeBackend();
    // As the core: `time` is last frame's until `beginFrame` advances the clock map to this frame's.
    let frameTime = 1;
    (b as { beginFrame: () => void }).beginFrame = () => { b.beginFrameCalls++; (b as { time: number }).time = frameTime; };
    setAudioBackend(b);
    // No music: the step leaves the clock alone, so `update()` reads the old value.
    frameTime = 2;
    step.run(world, 1 / 60);
    expect(b.beginFrameCalls).toBe(0);
    expect(Audio.time).toBe(0);
    // Music playing: the early step runs `beginFrame` before `UpdateScripts`, so `update()` reads this frame's time.
    createMusicPlayer({ group: 3 } as unknown as EventInstance, { id: "s", type: "segment" });
    step.run(world, 1 / 60);
    expect(b.beginFrameCalls).toBe(1);
    expect(Audio.time).toBe(2);
    frameTime = 2.0167;
    step.run(world, 1 / 60);
    expect(Audio.time).toBe(2.0167);
    expect(step.before).toContain("engine.UpdateScripts");
  });
});
