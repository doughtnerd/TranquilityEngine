// ADR 0171/0172 (Pf2; api-and-models §5.5, §5.6, §7): the voice table reconstructed at five positions of a recorded
// synthetic scene (just after a keyframe, just before one, between two voice events, early, just after the next
// keyframe), each against the scene's ground truth; the reason texts and the thief; the 64-row cap; the name filter.
import { describe, expect, it } from "vitest";
import { assembleCapture, RecordType } from "../../runtime/capture/format";
import type { CaptureSeekState } from "../../runtime/capture/reader";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE } from "../../runtime/capture/testSupport";
import { CaptureSource } from "./profilerSource";
import { KEYFRAME_FRAMES, NAMES, OPS, audibilityOf, inProcessWorker, openScene, priorityOf, sceneRecords, truthAt, truthEventsAt } from "./voiceSceneSupport";
import {
  MAX_VOICE_ROWS, eventRows, nameFilter, nameLookup, reasonText, reconstructVoices, voiceTable, type VoiceRow,
} from "./voiceTableModel";

const seconds = (frame: number): number => frame / SAMPLE_RATE;

/** The recorded fields of a row, as the truth keeps them. */
function project(r: VoiceRow) {
  return { id: r.id, clip: r.clip, slot: r.slot, state: r.state, reason: r.reason, gain: r.gain, thief: r.thief };
}

/** The truth at `frame`: a thief the keyframe's rows can't carry (the steal predates the keyframe the table starts from) reads null. */
function expectedAt(frame: number) {
  const kf = Math.max(...KEYFRAME_FRAMES.filter((k) => k <= frame));
  return truthAt(frame).map((v) => ({ id: v.id, clip: v.clip, slot: v.slot, state: v.state, reason: v.reason, gain: v.gain, thief: v.stealFrame > kf ? v.thief : null }));
}

describe("the voice table at five positions of a recorded scene", () => {
  const positions: [string, number][] = [
    ["just after a keyframe (at it)", KEYFRAME_FRAMES[1]!],
    ["just before a keyframe", KEYFRAME_FRAMES[2]! - 1],
    ["between two voice events", 55_000],
    ["early, from the first keyframe", 2_000],
    ["just after the next keyframe (a stop in the segment)", 97_500],
  ];
  for (const [label, frame] of positions) {
    it(`reconstructs ${label} (frame ${frame})`, async () => {
      const s = await openScene();
      const names = nameLookup(s.summary.names);
      const state = await s.seek(seconds(frame));
      const replay = reconstructVoices(state, names);
      expect(replay.fromKeyframe).toBe(true);
      const rows = replay.rows.map(project).sort((a, b) => a.id - b.id);
      expect(rows).toEqual(expectedAt(frame));
      expect(rows.length).toBeGreaterThan(0);
      s.close();
    });
  }

  it("covers a keyframe's own instant, the segment between keyframes and the end of the capture", async () => {
    const s = await openScene();
    const names = nameLookup(s.summary.names);
    for (const frame of [KEYFRAME_FRAMES[1]!, KEYFRAME_FRAMES[1]! + 1, 49_001, 70_000, 95_999, 120_500, 150_700, 250 * 768]) {
      const rows = reconstructVoices(await s.seek(seconds(frame)), names).rows.map(project).sort((a, b) => a.id - b.id);
      expect(rows, `frame ${frame}`).toEqual(expectedAt(frame));
    }
    // The end: voice 5 (stolen, never freed in the scene) and voice 7 are left.
    expect(truthAt(250 * 768).map((v) => v.id)).toEqual([5, 7]);
    s.close();
  });

  it("rows from the keyframe carry every field; rows born after it carry what the event did and null for the rest", async () => {
    const s = await openScene();
    const names = nameLookup(s.summary.names);
    const atKeyframe = reconstructVoices(await s.seek(seconds(KEYFRAME_FRAMES[1]!)), names).rows;
    const v2 = atKeyframe.find((r) => r.id === 2)!;
    expect(v2).toMatchObject({ fromKeyframe: true, priority: priorityOf(2), audibility: audibilityOf(2), pitch: (4096 + 2 * 16) / 4096, stateName: "virtual", reasonText: "below audibility" });
    const later = reconstructVoices(await s.seek(seconds(55_000)), names).rows;
    const v4 = later.find((r) => r.id === 4)!;
    expect(v4).toMatchObject({ fromKeyframe: false, priority: null, audibility: null, pitch: null, gain: 0.25, clipName: "footstep_grass.ogg", busName: "SFX", stateName: "playing", playheadFrames: 0 });
    // A keyframe voice that an event then changed keeps its keyframe fields.
    const v2Real = reconstructVoices(await s.seek(seconds(65_000)), names).rows.find((r) => r.id === 2)!;
    expect(v2Real).toMatchObject({ fromKeyframe: true, stateName: "playing", reasonText: "promoted", priority: priorityOf(2) });
    s.close();
  });

  it("the STATUS's playheads override a row's playhead (the keyframe's own value stands for the others)", async () => {
    const s = await openScene();
    const names = nameLookup(s.summary.names);
    const state = await s.seek(seconds(55_000));
    const lastStatusFrame = Math.floor(55_000 / 768) * 768;
    const rows = reconstructVoices(state, names).rows;
    expect(state.status!.currentFrame).toBe(lastStatusFrame);
    expect(rows.find((r) => r.id === 3)!.playheadFrames).toBe(lastStatusFrame >> 1); // the keyframe said 1
    expect(rows.find((r) => r.id === 2)!.playheadFrames).toBe(2000); // not in the STATUS: the keyframe's
    s.close();
  });

  it("names the thief and the reason of a steal in the replayed span; a steal before the keyframe has no thief", async () => {
    const s = await openScene();
    const names = nameLookup(s.summary.names);
    const before = reconstructVoices(await s.seek(seconds(96_500)), names).rows.find((r) => r.id === 5)!;
    expect(before).toMatchObject({ state: 2, stateName: "stolen", thief: 6, reason: 1, reasonText: "bus max voices" });
    const keyframed = reconstructVoices(await s.seek(seconds(KEYFRAME_FRAMES[1]!)), names).rows.find((r) => r.id === 1)!;
    expect(keyframed).toMatchObject({ stateName: "stolen", reasonText: "priority", thief: null });
    const withEvent = reconstructVoices(await s.seek(seconds(40_500)), names).rows.find((r) => r.id === 1)!;
    expect(withEvent.thief).toBe(3);
    s.close();
  });

  it("without a keyframe at or before t the table is built from the last second's events and says so", async () => {
    const records = sceneRecords().filter((r) => r.type !== RecordType.KEYFRAME || r.frame !== KEYFRAME_FRAMES[0]);
    const meta = { ...SAMPLE_META, names: { ...SAMPLE_META.names, clips: NAMES.clips, buses: NAMES.buses, events: NAMES.events } };
    const s = await CaptureSource.openFile(assembleCapture(SAMPLE_HEADER, meta, records.map((r, i) => ({ ...r, seq: i + 1 })), { index: true }).slice().buffer, { worker: inProcessWorker() });
    const state = await s.seek(seconds(5_000));
    expect(state.keyframe).toBeNull();
    const replay = reconstructVoices(state, nameLookup(s.summary.names));
    expect(replay.fromKeyframe).toBe(false);
    expect(replay.rows.map((r) => r.id).sort()).toEqual([1, 2]); // both started within the second before t
    expect(replay.rows.every((r) => !r.fromKeyframe && r.priority === null)).toBe(true);
    expect(voiceTable(replay).fromKeyframe).toBe(false);
    s.close();
  });
});

describe("reason text", () => {
  it("reads each reason by the state it is in (§5.6)", () => {
    expect([1, 2, 3].map((r) => reasonText(2, r))).toEqual(["bus max voices", "global limit", "priority"]);
    expect([1, 2, 3, 4].map((r) => reasonText(1, r))).toEqual(["demoted by the cap", "below audibility", "paused", "world inaudible"]);
    expect([1, 2].map((r) => reasonText(0, r))).toEqual(["promoted", "cap raised"]);
    expect([1, 2].map((r) => reasonText(3, r))).toEqual(["clip loading", "stream priming"]);
    expect(reasonText(0, 0)).toBe("");
    expect(reasonText(4, 1)).toBe("reason 1");
    expect(reasonText(2, 9)).toBe("reason 9");
  });
});

describe("the table: order, cap and counts", () => {
  function fakeState(n: number): CaptureSeekState {
    const voices = Array.from({ length: n }, (_, i) => ({
      id: i + 1, clip: 1 + (i % 3), slot: i % 3, state: i % 6, priority: i % 4, reason: 0, gain: 1, pitch: 4096, audibility: (i * 211) % 65536, playheadFrames: 0,
    }));
    return { keyframe: { voices, buses: [], metered: [], events: [], music: [], mix: { slotTableVersion: 0, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 } }, records: [], status: null } as unknown as CaptureSeekState;
  }
  const names = nameLookup({ clips: [[1, "alpha"], [2, "Beta"]], buses: [[0, "Music"], [1, "SFX"]], events: [], parameters: [], snapshots: [], targets: [] });

  it("renders at most MAX_VOICE_ROWS, most audible first, while counting the rest by state", () => {
    const replay = reconstructVoices(fakeState(100), names);
    const t = voiceTable(replay);
    expect(MAX_VOICE_ROWS).toBe(64);
    expect(t.rows).toHaveLength(64);
    expect(t.total).toBe(100);
    expect(t.matched).toBe(100);
    expect(t.hidden).toBe(36);
    expect(Object.values(t.hiddenByState).reduce((a, b) => a + b, 0)).toBe(36);
    for (let i = 1; i < t.rows.length; i++) expect(t.rows[i - 1]!.audibility!).toBeGreaterThanOrEqual(t.rows[i]!.audibility!);
    // Everything shown is at least as audible as anything hidden.
    const shownMin = Math.min(...t.rows.map((r) => r.audibility!));
    const hiddenMax = Math.max(...replay.rows.filter((r) => !t.rows.includes(r)).map((r) => r.audibility!));
    expect(shownMin).toBeGreaterThanOrEqual(hiddenMax);
  });

  it("at exactly the cap nothing is hidden; max is a parameter; ties go by priority then id", () => {
    expect(voiceTable(reconstructVoices(fakeState(64), names)).hidden).toBe(0);
    expect(voiceTable(reconstructVoices(fakeState(10), names), "", 4).rows).toHaveLength(4);
    const tie = fakeState(3);
    for (const [i, v] of tie.keyframe!.voices.entries()) (tie.keyframe!.voices as unknown as { audibility: number; priority: number }[])[i] = { ...v, audibility: 100, priority: [1, 3, 3][i]! };
    expect(voiceTable(reconstructVoices(tie, names)).rows.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("an empty seek is an empty table", () => {
    const t = voiceTable(reconstructVoices({ keyframe: null, records: [], status: null } as unknown as CaptureSeekState, names));
    expect(t).toMatchObject({ rows: [], total: 0, matched: 0, hidden: 0, fromKeyframe: false });
  });
});

describe("the name filter", () => {
  const names = nameLookup({ clips: [[1, "jump.ogg"], [2, "Land.ogg"], [3, "footstep_grass.ogg"]], buses: [[1, "Music"], [2, "SFX"]], events: [[5, "PlayerJump"], [6, "Ambience"]], parameters: [], snapshots: [], targets: [] });

  async function replayAt(frame: number) {
    const s = await openScene();
    const state = await s.seek(seconds(frame));
    s.close();
    return { replay: reconstructVoices(state, nameLookup(s.summary.names)), state };
  }

  it("is a case-insensitive substring over the clip name", async () => {
    const { replay } = await replayAt(97_500); 
    const truth = truthAt(97_500);
    const byClip = (needle: string) => truth.filter((v) => (NAMES.clips[v.clip as 1 | 2 | 3]).toLowerCase().includes(needle.toLowerCase())).map((v) => v.id);
    for (const needle of ["land", "LAND", "Land.o", "grass", "STEP", ".ogg", "zzz"]) {
      expect(voiceTable(replay, needle).rows.map((r) => r.id).sort(), needle).toEqual(byClip(needle).sort());
    }
    expect(voiceTable(replay, "land").matched).toBe(1);
    expect(voiceTable(replay, "land").total).toBe(truth.length);
  });

  it("matches the bus name", async () => {
    const { replay } = await replayAt(97_500);
    const truth = truthAt(97_500);
    const music = truth.filter((v) => v.slot === 1).map((v) => v.id);
    expect(music.length).toBeGreaterThan(0);
    expect(voiceTable(replay, "music").rows.map((r) => r.id).sort()).toEqual(music.sort());
    expect(voiceTable(replay, "sFX").rows.map((r) => r.id).sort()).toEqual(truth.filter((v) => v.slot === 2).map((v) => v.id).sort());
  });

  it("a clip or a bus matches, never both required; trimmed text; an empty filter keeps all", async () => {
    const { replay } = await replayAt(97_500);
    const all = voiceTable(replay, "").matched;
    expect(voiceTable(replay, "   ").matched).toBe(all);
    expect(voiceTable(replay, "  music  ").matched).toBe(voiceTable(replay, "music").matched);
    // "o" is in "Music"? no; in "footstep" and "jump.ogg"? yes: matches come from either field.
    const either = replay.rows.filter((r) => r.clipName.toLowerCase().includes("g") || r.busName.toLowerCase().includes("g")).length;
    expect(voiceTable(replay, "g").matched).toBe(either);
  });

  it("filters the event instances by event name", async () => {
    const { state } = await replayAt(99_000);
    const truth = truthEventsAt(99_000);
    expect(truth.map(([id]) => id)).toEqual([10, 11]);
    expect(eventRows(state, names).map((e) => [e.id, e.name])).toEqual([[10, "PlayerJump"], [11, "Ambience"]]);
    expect(eventRows(state, names, "AMB").map((e) => e.id)).toEqual([11]);
    expect(eventRows(state, names, "jump").map((e) => e.id)).toEqual([10]);
    expect(eventRows(state, names, "nope")).toEqual([]);
  });

  it("event instances follow eventStart and eventStop over the keyframe's", async () => {
    const s = await openScene();
    const n = nameLookup(s.summary.names);
    for (const frame of [1_000, 2_500, 97_500, 98_500, 121_500]) {
      const rows = eventRows(await s.seek(seconds(frame)), n).map((e) => [e.id, e.asset]);
      expect(rows, `frame ${frame}`).toEqual(truthEventsAt(frame));
    }
    s.close();
  });

  it("nameFilter on its own", () => {
    const f = nameFilter("Ab");
    expect(f("xxABxx")).toBe(true);
    expect(f(undefined, "cab")).toBe(true);
    expect(f("a", "b")).toBe(false);
    expect(nameFilter("")()).toBe(true);
    expect(names.clip(3)).toBe("footstep_grass.ogg");
    expect(names.event(9)).toBeUndefined();
    expect(OPS.length).toBeGreaterThan(10);
  });
});
