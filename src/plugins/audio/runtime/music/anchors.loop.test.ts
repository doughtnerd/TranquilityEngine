// ADR 0166 P3 follow-up: a simple forever loop (one region, `count: 0`, no `while`) is looped by the members themselves
// (the worker for streamed stems, the voice for decoded ones), and the anchor's pass walk agrees with them.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend, type FakeVoice } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, ticksToSeconds } from "../../../../engine/audio/musicGrid";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, createSegmentRun, groupRequest, pollPrimed, primeRun, setSegmentClipSource, stampRun, type SegmentRun } from "./segmentRun";
import { advanceAnchor, anchorRun, heardTimeOf, predictWrap, simpleLoopOf, ticksAt } from "./anchors";

let facts: Record<string, MusicClipFacts | undefined> = {};
let streamed = true;

function rig(rate: number | null, seconds = 4): FakeBackend {
  facts = rate === null ? {} : {
    "a.ogg": { frames: Math.round(seconds * rate), rate, channels: 2, gapless: true },
    "b.ogg": { frames: Math.round(seconds * rate), rate, channels: 2, gapless: true },
  };
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: streamed }), bus: (o) => o ?? "Master", facts: (p) => facts[p] });
  const b = makeFakeBackend();
  setAudioBackend(b);
  return b;
}

function segment(regions: unknown[], extra: Record<string, unknown> = {}): SegmentNode {
  const node = parseSegmentNode({ type: "segment", id: "A", tracks: [{ name: "t0", clip: "a.ogg" }, { name: "t1", clip: "b.ogg" }], regions, ...extra }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

let groups = 7;
const instance = (): EventInstance =>
  ({ group: groups++, world: 1, path: "m.audioevent", asset: { bus: "Music", priority: 200, volume: 1 } }) as unknown as EventInstance;

/** Admit, prime and stamp a run of `node` at `at` on the fake; the player's run and anchor. */
function stamped(b: FakeBackend, node: SegmentNode, at: number): { player: MusicPlayer; run: SegmentRun } {
  const player = createMusicPlayer(instance(), node);
  const f: MusicFrame = { backend: b, music: b.music ?? null, now: at - 0.2, dt: 1 / 60, hidden: false };
  const run = createSegmentRun(player, node, 0)!;
  expect(primeRun(player, run, f)).toBe(true);
  // An all-decoded run skips priming; the fake only stamps groups it was told about, so tell it.
  if (b.music!.primes.length === 0) b.music!.primeGroup(groupRequest(player, run));
  b.music!.setPrimed(run.group);
  pollPrimed(run, f);
  stampRun(player, run, at, f);
  player.run = run;
  player.anchor = anchorRun(run, at);
  return { player, run };
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  streamed = true;
});

describe("a simple forever loop is looped by its members (P3 follow-up)", () => {
  it("sound-lab's case: 1:1:0 to end, count 0: every member loops the whole file; the grid keeps advancing over the wrap", () => {
    const b = rig(48_000, 4); // a 4 s file, 120 bpm: two bars a pass
    const { player } = stamped(b, segment([{ id: "loop", from: "1:1:0", to: "end", count: 0 }]), 10);
    const req = b.music!.admitted[0]!;
    for (const m of req.members) {
      expect(m.loop).toBe(true);
      expect(m.loopStartFrame).toBe(0);
      expect(m.loopEndFrame).toBe(0); // the file's end
      expect(m.play.loop).toBe(true);
    }
    expect(predictWrap(player, 10)).toBeCloseTo(14, 9);
    expect(predictWrap(player, 14)).toBeCloseTo(18, 9);
    expect(predictWrap(player, 10 + 4 * 300.25)).toBeCloseTo(10 + 4 * 301, 6);
    expect(ticksAt(player.anchor!, 15)).toBeCloseTo(1920, 6); // one second into pass 2
    expect(advanceAnchor(player, 15)).toBe(true);
    expect(player.anchor).toMatchObject({ ticks: 0, pass: 2 });
    expect(heardTimeOf(player.anchor!, 3840)).toBeCloseTo(16, 9); // bar 2 of pass 2
  });

  it("a region inside the file (44.1 kHz clip, 133 bpm): member frames at the clip's rate are the pass the anchor walks", () => {
    const b = rig(44_100, 30);
    const node = segment([{ id: "loop", from: "2:1:0", to: "4:1:0", count: 0 }], { tempo: [{ at: "1:1:0", bpm: 133, beatsPerBar: 4, beatUnit: 4 }] });
    const g = compileSegmentGrid(node);
    const from = Math.round(ticksToSeconds(g, 3840) * 44_100), to = Math.round(ticksToSeconds(g, 3 * 3840) * 44_100);
    const { player } = stamped(b, node, 0);
    const m = b.music!.admitted[0]!.members[0]!;
    expect([m.loop, m.loopStartFrame, m.loopEndFrame]).toEqual([true, from, to]);
    const w1 = predictWrap(player, 0);
    expect(w1).toBeCloseTo(to / 44_100, 12);
    expect(predictWrap(player, w1) - w1).toBeCloseTo((to - from) / 44_100, 12);
    // The wrap lands on bar 2 again (on the clip's frame grid: within half a frame, 0.02 ticks at 133 bpm).
    expect(Math.abs(ticksAt(player.anchor!, w1) - 3840)).toBeLessThan(0.03);
  });

  it("counted passes, `while` and several regions stay R4a/R4b's: no member loop", () => {
    rig(48_000, 60);
    const cases: unknown[][] = [
      [{ id: "r", from: "1:1:0", to: "3:1:0", count: 3 }],
      [{ id: "r", from: "1:1:0", to: "3:1:0", count: 0, while: { parameter: "Boss", is: "alive" } }],
      [{ id: "r", from: "1:1:0", to: "3:1:0", count: 0 }, { id: "s", from: "5:1:0", to: "6:1:0", count: 0 }],
      [],
    ];
    for (const regions of cases) {
      const node = segment(regions);
      expect(simpleLoopOf(node, 48_000)).toBeNull();
      const player = createMusicPlayer(instance(), node);
      for (const mem of groupRequest(player, createSegmentRun(player, node, 0)!).members) {
        expect(mem.loop).toBe(false);
        expect(mem.play.loop).toBe(false);
        expect(mem.loopStartFrame).toBeUndefined();
      }
    }
  });

  it("decoded members: the whole file loops by the PLAY flag; a region inside it goes to the voice as a loop in seconds", () => {
    streamed = false;
    const b = rig(48_000, 20);
    stamped(b, segment([{ id: "loop", from: "1:1:0", to: "end", count: 0 }]), 1);
    expect(b.music!.stamps).toHaveLength(1);
    expect((b.voices as FakeVoice[]).every((v) => !v.events.some((e) => e.kind === "loop"))).toBe(true);
    const b2 = rig(48_000, 20);
    stamped(b2, segment([{ id: "loop", from: "2:1:0", to: "4:1:0", count: 0 }]), 1);
    const loops = (b2.voices as FakeVoice[]).map((v) => v.events.filter((e) => e.kind === "loop"));
    expect(loops).toEqual([[{ kind: "loop", start: 2, end: 6, looping: true }], [{ kind: "loop", start: 2, end: 6, looping: true }]]);
  });

  it("without clip facts, a decoded clip's length from the backend gives the pass (sound-lab before F-7a)", () => {
    streamed = false;
    const b = rig(null);
    b.durations.set("a.ogg", 4);
    b.durations.set("b.ogg", 4);
    const { player } = stamped(b, segment([{ id: "loop", from: "1:1:0", to: "end", count: 0 }]), 10);
    expect(b.music!.stamps).toHaveLength(1);
    expect(predictWrap(player, 12)).toBeCloseTo(14, 9);
    expect(predictWrap(player, 14.5)).toBeCloseTo(18, 9);
  });
});
