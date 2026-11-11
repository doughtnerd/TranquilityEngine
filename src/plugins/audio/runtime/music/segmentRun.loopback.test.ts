// ADR 0166 P1 (leaf L-P1a): a segment's run on the fake backend (`testing.ts` `FakeMusicBackend`, not the loopback
// host: the core's gate, C2a/C2b, is not merged yet, so a real-core start is `core/musicOps.test.ts`'s job). The run is
// driven by hand as the planner (P2) will drive it: createSegmentRun, primeRun, pollPrimed, stampRun, then the core's
// group-start event through routeGroupEvent. "Planned frame" here: the fake's stamp and every member's PLAY carry the
// planned heard time exactly, and every member starts at the run's file frame.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import {
  _resetSegmentRuns,
  cancelRun,
  createSegmentRun,
  groupRequest,
  MAX_MUSIC_GROUP_ID,
  nextGroupId,
  pollPrimed,
  primeRun,
  routeGroupEvent,
  setSegmentClipSource,
  stampRun,
} from "./segmentRun";

const RATE = 48_000;

/** Clip facts: `long.ogg` 120 s (streamed by the 30 s rule), `short.ogg` 10 s (decoded). */
const FACTS: Record<string, MusicClipFacts> = {
  "music/long.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/long-b.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/short.ogg": { frames: 10 * RATE, rate: RATE, channels: 2, gapless: true },
};

/** A segment: 120 bpm 4/4, a 0.5 s pickup (gridOffset), entry at 1:1:0, two stems (one streamed, one decoded). */
function segment(tracks: unknown[] = [
  { name: "drums", clip: "music/long.ogg", alternatives: ["music/long-b.ogg"], bus: "Drums" },
  { name: "pad", clip: "music/short.ogg", volume: 0.5 },
]): SegmentNode {
  const node = parseSegmentNode({ type: "segment", id: "explore", gridOffset: 0.5, tracks }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

const instance = (group = 7): EventInstance =>
  ({ group, world: 3, path: "music.audioevent", asset: { bus: "Music", priority: 200, volume: 1 } }) as unknown as EventInstance;

let fake: FakeBackend;
function rig(): { b: FakeBackend; player: MusicPlayer; node: SegmentNode; f: MusicFrame } {
  fake = makeFakeBackend();
  setAudioBackend(fake);
  setSegmentClipSource({
    url: (p) => `/assets/${p}`,
    settings: () => ({ volume: 1, stream: false }),
    bus: (o) => o ?? "Master",
    facts: (p) => FACTS[p],
  });
  const node = segment();
  const player = createMusicPlayer(instance(), node);
  const f: MusicFrame = { backend: fake, music: fake.music ?? null, now: 1, dt: 1 / 60, hidden: false };
  return { b: fake, player, node, f };
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("SegmentRun on the fake backend (ADR 0166 P1, L-P1a)", () => {
  it("a segment starts on its planned frame", () => {
    const { b, player, node, f } = rig();
    // Planned entry T = 2.0 with a 0.5 s pickup: stamped at 1.5 s (72000 frames). Then again from a 0.5 s file offset.
    for (const startFrame of [0, 24_000]) {
      if (startFrame !== 0) b.clear();
      const run = createSegmentRun(player, node, startFrame);
      expect(run).not.toBeNull();
      if (!run) return;

      expect(primeRun(player, run, f)).toBe(true);
      expect(run.state).toBe("priming");
      expect(run.group).toBeGreaterThanOrEqual(1);
      expect(run.group).toBeLessThanOrEqual(MAX_MUSIC_GROUP_ID);
      expect(b.music!.admitted).toHaveLength(1);
      expect(b.music!.primes).toHaveLength(1);

      expect(pollPrimed(run, f)).toBe(false);
      b.music!.setPrimed(run.group);
      expect(pollPrimed(run, f)).toBe(true);

      stampRun(player, run, 1.5, f);
      expect(b.music!.stamps[0]).toMatchObject({ group: run.group, at: 1.5 });
      expect(b.music!.stamps[0].at * RATE).toBe(72_000);

      const plays = b.plays.slice(-2);
      expect(plays.map((p) => p.at)).toEqual([1.5, 1.5]);
      expect(plays.map((p) => p.path)).toEqual(["music/long.ogg", "music/short.ogg"]);

      expect(b.voices).toHaveLength(2);
      expect(run.stems[0].voice).not.toBeNull();
      expect(run.stems[1].voice).not.toBeNull();
      expect(run.stems[0].voice).toBe(b.voices[0]);
      expect(run.stems[1].voice).toBe(b.voices[1]);

      for (const member of b.music!.primes[0].request.members) expect(member.startFrame).toBe(startFrame);
      expect(run.state).toBe("stamped");
      expect(run.startAt).toBe(1.5);
      expect(run.prime).toBeNull();

      routeGroupEvent({ kind: "start", group: run.group, late: false, slipFrames: 0, startFrame: 72_000 });
      expect(run.state).toBe("playing");
    }
  });

  it("picks streamed or decoded per stem by the 30 s rule, and the first pass takes each track's clip", () => {
    const { b, player, node } = rig();

    // By the facts: long.ogg (120 s) streams, short.ogg (10 s) decodes.
    const run = createSegmentRun(player, node, 0);
    expect(run).not.toBeNull();
    if (!run) return;
    expect(run.stems[0]).toMatchObject({ track: "drums", alternative: 0, clip: "music/long.ogg", streamed: true, voice: null, primed: false });
    expect(run.stems[1]).toMatchObject({ track: "pad", alternative: 0, clip: "music/short.ogg", streamed: false, voice: null, primed: true });
    expect(run).toMatchObject({ state: "new", group: 0, loopsDone: 0, prime: null });
    expect(run.startAt).toBeNaN();

    // Without facts the import setting decides.
    const source = (stream: boolean) => ({
      url: (p: string) => `/assets/${p}`,
      settings: () => ({ volume: 1, stream }),
      bus: (o: string | undefined) => o ?? "Master",
      facts: () => undefined,
    });
    setSegmentClipSource(source(true));
    expect(createSegmentRun(player, node, 0)!.stems.map((s) => s.streamed)).toEqual([true, true]);
    setSegmentClipSource(source(false));
    expect(createSegmentRun(player, node, 0)!.stems.map((s) => s.streamed)).toEqual([false, false]);

    // A segment with no tracks has no run.
    expect(createSegmentRun(player, segment([]), 0)).toBeNull();
    expect(b.music!.admitted).toHaveLength(0);
  });

  it("the group request has one member per stem with the event's routing and the run's start frame", () => {
    const { player, node, f } = rig();
    const run = createSegmentRun(player, node, 0);
    expect(run).not.toBeNull();
    if (!run) return;
    expect(primeRun(player, run, f)).toBe(true);

    const request = groupRequest(player, run);
    expect(request).toMatchObject({ instance: 7, group: run.group, members: expect.any(Array) });
    expect(request.members).toHaveLength(2);
    const [drums, pad] = request.members;

    expect(drums).toMatchObject({ stem: "drums", startFrame: run.startFrame, loop: false });
    expect(drums.play).toMatchObject({
      path: "music/long.ogg",
      url: "/assets/music/long.ogg",
      stream: true,
      bus: "Drums",
      volume: 1,
      priority: 200,
      world: 3,
      group: 7,
    });

    expect(pad).toMatchObject({ stem: "pad", startFrame: run.startFrame, loop: false });
    expect(pad.play).toMatchObject({
      path: "music/short.ogg",
      url: "/assets/music/short.ogg",
      stream: false,
      bus: "Music",
      volume: 0.5,
      priority: 200,
      world: 3,
      group: 7,
    });
  });

  it("nextGroupId counts over 1..1023, skips live ids, wraps, and gives 0 when every id is live", () => {
    const none = () => false;
    _resetSegmentRuns();
    expect(nextGroupId(none)).toBe(1);
    expect(nextGroupId(none)).toBe(2);
    expect(nextGroupId((id) => id === 3)).toBe(4);

    // Walk the counter to the top of the range, then it wraps to 1.
    _resetSegmentRuns();
    let last = 0;
    for (let i = 0; i < MAX_MUSIC_GROUP_ID; i++) last = nextGroupId(none);
    expect(last).toBe(MAX_MUSIC_GROUP_ID);
    expect(nextGroupId(none)).toBe(1);

    // After the wrap a live id 1 is skipped.
    _resetSegmentRuns();
    for (let i = 0; i < MAX_MUSIC_GROUP_ID; i++) nextGroupId(none);
    expect(nextGroupId((id) => id === 1)).toBe(2);

    expect(nextGroupId(() => true)).toBe(0);
  });

  it("an all-decoded run is primed at once and posts no primeGroup", () => {
    const { b, player, f } = rig();
    const node = segment([{ name: "pad", clip: "music/short.ogg" }]);
    const run = createSegmentRun(player, node, 0);
    expect(run).not.toBeNull();
    if (!run) return;

    expect(primeRun(player, run, f)).toBe(true);
    expect(b.music!.primes).toHaveLength(0);
    expect(run.state).toBe("admitted");
    expect(pollPrimed(run, f)).toBe(true);
    expect(run.prime).toBeNull();
  });

  it("a refused admission posts nothing and frees the id", () => {
    const { b, player, node, f } = rig();
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    const run = createSegmentRun(player, node, 0);
    expect(run).not.toBeNull();
    if (!run) return;

    expect(primeRun(player, run, f)).toBe(false);
    expect(b.music!.primes).toHaveLength(0);
    expect(run.group).toBe(0);
    expect(run.state).toBe("new");
  });

  it("pollPrimed records the prime time, from the post to the poll that sees every member primed", () => {
    const { b, player, node, f } = rig();
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const run = createSegmentRun(player, node, 0);
    expect(run).not.toBeNull();
    if (!run) return;

    expect(primeRun(player, run, f)).toBe(true);
    expect(run.state).toBe("priming");
    expect(run.prime!.postedMs).toBe(1000);

    // Not every member is primed yet (the streamed drums stem): the poll says so and records nothing.
    now.mockReturnValue(1020);
    expect(pollPrimed(run, f)).toBe(false);

    now.mockReturnValue(1037);
    b.music!.setPrimed(run.group);
    expect(pollPrimed(run, f)).toBe(true);
    expect(player.counters.primeLastMs).toBe(37);
    expect(b.music!.primes[0].protect).toContain("music/long.ogg");
  });

  it("cancelRun cancels the group once and later events for it are ignored", () => {
    const { b, player, node, f } = rig();
    const run = createSegmentRun(player, node, 0);
    expect(run).not.toBeNull();
    if (!run) return;
    expect(primeRun(player, run, f)).toBe(true);
    const group = run.group;

    cancelRun(run, f);
    cancelRun(run, f);
    expect(b.music!.cancelled).toEqual([group]);
    expect(run.state).toBe("cancelled");

    expect(() => routeGroupEvent({ kind: "start", group, late: false, slipFrames: 0, startFrame: 0 })).not.toThrow();
    expect(run.state).toBe("cancelled");

    expect(() => routeGroupEvent({ kind: "start", group: 999, late: false, slipFrames: 0, startFrame: 0 })).not.toThrow();
  });
});
