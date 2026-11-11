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

void [vi, cancelRun, groupRequest, MAX_MUSIC_GROUP_ID, nextGroupId, pollPrimed, primeRun, routeGroupEvent, stampRun];

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
void rig;
void createSegmentRun;

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("SegmentRun on the fake backend (ADR 0166 P1, L-P1a)", () => {
  it.skip("a segment starts on its planned frame", () => {
    // L-P1a
  });

  it.skip("picks streamed or decoded per stem by the 30 s rule, and the first pass takes each track's clip", () => {
    // L-P1a
  });

  it.skip("the group request has one member per stem with the event's routing and the run's start frame", () => {
    // L-P1a
  });

  it.skip("nextGroupId counts over 1..1023, skips live ids, wraps, and gives 0 when every id is live", () => {
    // L-P1a
  });

  it.skip("an all-decoded run is primed at once and posts no primeGroup", () => {
    // L-P1a
  });

  it.skip("a refused admission posts nothing and frees the id", () => {
    // L-P1a
  });

  it.skip("pollPrimed records the prime time, from the post to the poll that sees every member primed", () => {
    // L-P1a
  });

  it.skip("cancelRun cancels the group once and later events for it are ignored", () => {
    // L-P1a
  });
});
