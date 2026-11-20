// ADR 0166 P10 acceptance: every §1.6 counter reaches `Audio.debug().music` / `musicTotals` and the panel's Music sections.
// ADR 0249: those rows are composed above the backend seam (`runtime/audioRows.ts`), for every backend with music.
import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../engine/audio/settings";
import { AudioDebugMonitor } from "./audioDebugMonitor";
import type { EventInstance } from "../runtime/events/eventRuntime";
import { createMusicPlayer, disposeMusicPlayer } from "../runtime/music/musicSystem";
import { buildDebugInfo, type DebugSource } from "../runtime/core/debug";
import { debugRows } from "../runtime/audioRows";
import type { MusicBackendDebug } from "../runtime/backend";
import { StatusMirror } from "../runtime/core/mirror";
import { UnlockQueue } from "../runtime/core/unlockQueue";
import { VoiceTable } from "../runtime/core/voiceTable";
import { endAudioSession } from "../runtime/testing";
import { emptySegment } from "../../../engine/audio/musicFormat";
import { promote } from "../runtime/music/musicPlayer";

afterEach(() => endAudioSession());

/** A core's own debug info (no music: the rows come from above the seam). */
function coreSource(): DebugSource {
  const table = new VoiceTable(8);
  const mixer = new Mixer(defaultAudioSettings());
  return {
    host: { sampleRate: 48_000 },
    status: "running",
    time: 2,
    backgroundMode: "pause",
    busNames: mixer.busNames,
    mirror: new StatusMirror(table),
    table,
    clips: { info: () => null },
    mixer,
    lockedQueue: new UnlockQueue<number>({ onDrop: () => {} }),
    hrtfReady: true,
  };
}

const ZERO_VIEW: MusicBackendDebug = {
  poolUsed: 0, poolSize: 0, poolHighWater: 0, musicRingRefused: 0, groupTableFull: 0, encodedOverBudget: 0,
  streamStartsLate: 0, groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0, voiceSplits: 0, curvePoolFull: 0, groups: [],
};

/**
 * ADR 0249: the rows are composed above the seam from the players and what the music backend reports of itself
 * (`MusicBackend.debugView`: the pool, its groups and the core's group counters; Ê). `rows()` is `Audio.debug()`'s music part.
 */
function source(view: Partial<MusicBackendDebug> = {}) {
  const backend = {
    time: 2,
    music: { primeEmaMs: 37, debugView: (): MusicBackendDebug => ({ ...ZERO_VIEW, ...view, groups: [{ id: 5, state: "priming", primed: 1, of: 3 }] }) },
  };
  const rows = () => debugRows({ voices: [] }, backend);
  return { rows };
}

describe("Audio.debug() music (P10, §1.6)", () => {
  it("musicTotals carries the music backend's pool and group counters and main's session sums", () => {
    const { rows } = source({ poolUsed: 2, poolSize: 8, poolHighWater: 5, musicRingRefused: 1, groupTableFull: 4, streamStartsLate: 3, groupsLate: 6, groupsHeld: 1, groupsAbandoned: 5, maxSlipFrames: 700, splitQuanta: 9, voiceSplits: 11, curvePoolFull: 2 });
    expect(rows().musicTotals).toEqual({
      poolUsed: 2, poolSize: 8, poolHighWater: 5, musicRingRefused: 1, streamStartsLate: 3, groupsLate: 6, groupsHeld: 1, groupsAbandoned: 5, maxSlipFrames: 700, splitQuanta: 9, voiceSplits: 11, curvePoolFull: 2, groupTableFull: 4, encodedOverBudget: 0,
      replans: {}, refusals: {}, recoveries: {}, stingers: { played: 0, late: 0, skipped: 0, dropped: 0 },
    });
  });

  it("with no music playing: music is [] and totals are zero", () => {
    const info = source().rows();
    expect(info.music).toEqual([]);
    const { replans, refusals, recoveries, stingers, ...counts } = info.musicTotals!;
    expect(Object.values(counts).every((v) => v === 0)).toBe(true);
    expect([replans, refusals, recoveries]).toEqual([{}, {}, {}]);
    expect(stingers).toEqual({ played: 0, late: 0, skipped: 0, dropped: 0 });
  });

  it("ADR 0220: musicTotals sums main's counters over every instance, the ended ones included, until the session ends", () => {
    const { rows } = source();
    const a = createMusicPlayer({ group: 7, path: "a.audioevent.json" } as unknown as EventInstance, emptySegment("verse"));
    const b = createMusicPlayer({ group: 8, path: "b.audioevent.json" } as unknown as EventInstance, emptySegment("verse"));
    a.counters.refusals.neverFits = 1;
    a.counters.recoveries.hidden = 2;
    a.counters.replans.deadline = 3;
    a.counters.stingers.skipped = 1;
    b.counters.refusals.neverFits = 1;
    b.counters.refusals.poolFull = 4;
    const expected = { replans: { deadline: 3 }, refusals: { neverFits: 2, poolFull: 4 }, recoveries: { hidden: 2 }, stingers: { played: 0, late: 0, skipped: 1, dropped: 0 } };
    expect(rows().musicTotals).toMatchObject(expected);
    disposeMusicPlayer(a, null);
    const after = rows();
    expect(after.music!.map((r) => r.id)).toEqual([8]);
    expect(after.musicTotals).toMatchObject(expected);
    endAudioSession();
    const fresh = source().rows().musicTotals!;
    expect([fresh.refusals, fresh.recoveries, fresh.replans, fresh.stingers.skipped]).toEqual([{}, {}, {}, 0]);
  });

  it("a row carries every player counter and Ê, and the groups of its runs", () => {
    const { rows } = source();
    const player = createMusicPlayer({ group: 7, path: "bgm.audioevent.json" } as unknown as EventInstance, emptySegment("verse"));
    Object.assign(player.counters, { lateGroups: 1, groupsHeld: 2, groupTimeouts: 3, lastSlipFrames: 480, missedBeats: 4, primeLastMs: 55, leadMs: 210 });
    player.counters.replans.deadline = 2;
    player.counters.refusals.poolFull = 1;
    player.counters.recoveries.hidden = 1;
    Object.assign(player.counters.stingers, { played: 1, late: 2, skipped: 3, dropped: 4 });
    promote(player, { node: emptySegment("verse"), group: 5, stems: [{ track: "drums", streamed: true, primed: true }, { track: "pad", streamed: false, primed: true }] } as never, 0);
    const [row] = rows().music!;
    expect(row).toMatchObject({
      id: 7, asset: "bgm.audioevent.json", segment: "verse", pending: null,
      primeLastMs: 55, primeEmaMs: 37, leadMs: 210, lateGroups: 1, groupsHeld: 2, groupTimeouts: 3, lastSlipFrames: 480, missedBeats: 4,
      replans: { deadline: 2 }, refusals: { poolFull: 1 }, recoveries: { hidden: 1 }, stingers: { played: 1, late: 2, skipped: 3, dropped: 4 },
      groups: [{ id: 5, state: "priming", primed: 1, of: 3 }],
      stems: [{ name: "drums", primed: true, streamed: true, ring: 0 }, { name: "pad", primed: true, streamed: false, ring: null }],
    });
  });

  it("the panel's Music sections list the row and the totals", () => {
    const { rows } = source({ poolUsed: 1, poolSize: 8, poolHighWater: 1, musicRingRefused: 0 });
    createMusicPlayer({ group: 7, path: "bgm.audioevent.json" } as unknown as EventInstance, emptySegment("verse"));
    const monitor = new AudioDebugMonitor();
    monitor.observe({ ...buildDebugInfo(coreSource()), ...rows() });
    const sections = monitor.view()!.sections;
    expect(sections.find((s) => s.id === "music")!.rows).toHaveLength(1);
    expect(sections.find((s) => s.id === "musicTotals")!.rows.length).toBeGreaterThan(0);
  });
});
