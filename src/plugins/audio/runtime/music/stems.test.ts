// ADR 0166 P5: a silent stem's ring returns at the voice's end; solo gain. Fake backend, as P1's loopback test.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend, type FakeVoice } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, createSegmentRun, pollPrimed, primeRun, routeGroupEvent, setSegmentClipSource, stampRun, type SegmentRun } from "./segmentRun";
import { releaseSilentRing, soloStem, tickStems } from "./stems";

function rig(): { b: FakeBackend; player: MusicPlayer; run: SegmentRun; f: MusicFrame; voices: FakeVoice[] } {
  const b = makeFakeBackend();
  setAudioBackend(b);
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: () => undefined });
  const node = parseSegmentNode(
    { type: "segment", id: "s", tracks: [{ name: "drums", clip: "a.ogg" }, { name: "bass", clip: "b.ogg" }, { name: "pad", clip: "c.ogg" }] },
    "test",
    newMusicContext(),
  ) as SegmentNode;
  const inst = { group: 7, world: 1, path: "m.audioevent", asset: { bus: "Music", priority: 200, volume: 1 } } as unknown as EventInstance;
  const player = createMusicPlayer(inst, node);
  const f: MusicFrame = { backend: b, music: b.music ?? null, now: 1, dt: 1 / 60, hidden: false };
  const run = createSegmentRun(player, node, 0)!;
  primeRun(player, run, f);
  b.music!.setPrimed(run.group);
  pollPrimed(run, f);
  stampRun(player, run, 1, f);
  routeGroupEvent({ kind: "start", group: run.group, late: false, slipFrames: 0, startFrame: 48_000 });
  player.run = run;
  return { b, player, run, f, voices: b.voices as FakeVoice[] };
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

describe("stems (ADR 0166 P5)", () => {
  it("a silent stem's ring returns at the voice's end", () => {
    const { player, run, f, voices } = rig();
    tickStems(player, f); // the player's clock for soloStem
    soloStem(player, "drums", 0.5);
    const fades = voices.map((v) => v.events.filter((e) => e.kind === "fade"));
    expect(fades).toEqual([[{ kind: "fade", to: 1, seconds: 0.5 }], [{ kind: "fade", to: 0, seconds: 0.5 }], [{ kind: "fade", to: 0, seconds: 0.5 }]]);
    // Silent but the voice is still alive: nothing to release.
    expect(releaseSilentRing(run.stems[1]!, { ...f, now: 2 })).toBe(false);
    voices[1]!.end(); // the core reports the voice's end (memberFreed returns the ring)
    // Before the fade ends (1.5) it is not yet silent; after, it is.
    expect(releaseSilentRing(run.stems[1]!, { ...f, now: 1.2 })).toBe(false);
    tickStems(player, { ...f, now: 2 });
    expect(run.stems[1]!.voice).toBeNull();
    expect(releaseSilentRing(run.stems[1]!, { ...f, now: 3 })).toBe(false); // once
    expect(run.stems[0]!.voice).toBe(voices[0]);
    expect(run.stems[2]!.voice).toBe(voices[2]); // alive, so held
  });

  it("an audible stem whose voice ended is not a silent release", () => {
    const { player, run, f, voices } = rig();
    voices[0]!.end();
    tickStems(player, { ...f, now: 5 });
    expect(run.stems[0]!.voice).toBe(voices[0]);
  });

  it("clearing the solo brings every stem back to 1", () => {
    const { player, f, voices } = rig();
    soloStem(player, "bass", 0.1);
    tickStems(player, { ...f, now: 2 });
    soloStem(player, null, 0.2);
    for (const v of voices) expect(v.events.filter((e) => e.kind === "fade").pop()).toMatchObject({ to: 1, seconds: 0.2 });
  });
});
