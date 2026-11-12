// ADR 0166 P10 acceptance: every §1.6 counter reaches `Audio.debug().music` / `musicTotals` and the panel's Music sections.
import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { debugSections } from "../../editor/audioDebugRows";
import type { EventInstance } from "../events/eventRuntime";
import { _resetMusicPlayers, createMusicPlayer } from "../music/musicSystem";
import { buildDebugInfo, type DebugSource } from "./debug";
import { StatusMirror } from "./mirror";
import { UnlockQueue } from "./unlockQueue";
import { VoiceTable } from "./voiceTable";

afterEach(() => _resetMusicPlayers());

function source(view?: { poolUsed: number; poolSize: number; poolHighWater: number; musicRingRefused: number; groupTableFull?: number }) {
  const table = new VoiceTable(8);
  const mirror = new StatusMirror(table);
  const mixer = new Mixer(defaultAudioSettings());
  const musicOps = {
    primeEmaMs: 37,
    debugView: () => ({ poolUsed: 0, poolSize: 0, poolHighWater: 0, musicRingRefused: 0, ...view, groups: [{ id: 5, state: "priming" as const, primed: 1, of: 3 }] }),
  };
  const src: DebugSource = {
    host: { sampleRate: 48_000 },
    status: "running",
    time: 2,
    backgroundMode: "pause",
    busNames: mixer.busNames,
    mirror,
    table,
    clips: { info: () => null },
    mixer,
    lockedQueue: new UnlockQueue<number>({ onDrop: () => {} }),
    hrtfReady: true,
    musicOps: musicOps as unknown as DebugSource["musicOps"],
  };
  return { src, mirror };
}

describe("Audio.debug() music (P10, §1.6)", () => {
  it("musicTotals carries the core's counters from the status mirror and the pool from musicOps", () => {
    const { src, mirror } = source({ poolUsed: 2, poolSize: 8, poolHighWater: 5, musicRingRefused: 1, groupTableFull: 4 });
    Object.assign(mirror, { streamStartsLate: 3, maxSlipFrames: 700, splitQuanta: 9, voiceSplits: 11, curvePoolFull: 2 });
    expect(buildDebugInfo(src).musicTotals).toEqual({
      poolUsed: 2, poolSize: 8, poolHighWater: 5, musicRingRefused: 1, streamStartsLate: 3, maxSlipFrames: 700, splitQuanta: 9, voiceSplits: 11, curvePoolFull: 2, groupTableFull: 4,
    });
  });

  it("with no music playing: music is [] and totals are zero", () => {
    const info = buildDebugInfo(source().src);
    expect(info.music).toEqual([]);
    expect(Object.values(info.musicTotals!).every((v) => v === 0)).toBe(true);
  });

  it("a row carries every player counter and Ê, and the groups of its runs", () => {
    const { src } = source();
    const player = createMusicPlayer({ group: 7, path: "bgm.audioevent.json" } as unknown as EventInstance, { id: "verse", type: "segment" });
    Object.assign(player.counters, { lateGroups: 1, groupsHeld: 2, groupTimeouts: 3, lastSlipFrames: 480, missedBeats: 4, primeLastMs: 55, leadMs: 210 });
    player.counters.replans.deadline = 2;
    player.counters.refusals.poolFull = 1;
    player.counters.recoveries.hidden = 1;
    Object.assign(player.counters.stingers, { played: 1, late: 2, skipped: 3, dropped: 4 });
    player.run = { node: { id: "verse", type: "segment" }, group: 5, stems: [{ track: "drums", streamed: true, primed: true }, { track: "pad", streamed: false, primed: true }] } as never;
    const [row] = buildDebugInfo(src).music!;
    expect(row).toMatchObject({
      id: 7, asset: "bgm.audioevent.json", segment: "verse", pending: null,
      primeLastMs: 55, primeEmaMs: 37, leadMs: 210, lateGroups: 1, groupsHeld: 2, groupTimeouts: 3, lastSlipFrames: 480, missedBeats: 4,
      replans: { deadline: 2 }, refusals: { poolFull: 1 }, recoveries: { hidden: 1 }, stingers: { played: 1, late: 2, skipped: 3, dropped: 4 },
      groups: [{ id: 5, state: "priming", primed: 1, of: 3 }],
      stems: [{ name: "drums", primed: true, streamed: true, ring: 0 }, { name: "pad", primed: true, streamed: false, ring: null }],
    });
  });

  it("the panel's Music sections list the row and the totals", () => {
    const { src } = source({ poolUsed: 1, poolSize: 8, poolHighWater: 1, musicRingRefused: 0 });
    createMusicPlayer({ group: 7, path: "bgm.audioevent.json" } as unknown as EventInstance, { id: "verse", type: "segment" });
    const sections = debugSections(buildDebugInfo(src));
    expect(sections.find((s) => s.id === "music")!.rows).toHaveLength(1);
    expect(sections.find((s) => s.id === "musicTotals")!.rows.length).toBeGreaterThan(0);
  });
});
