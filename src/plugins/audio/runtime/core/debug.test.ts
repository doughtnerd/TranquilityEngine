// A2.5: `buildDebugInfo` against a real voice table, status mirror and mixer, with the rest of the backend built by hand.
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { ClipInfo } from "./clipRegistry";
import { buildDebugInfo, type AudioDebugInfo, type DebugSource } from "./debug";
import { makeStatusBlock, StatusMirror } from "./mirror";
import { UnlockQueue } from "./unlockQueue";
import { VoiceFlag, VoiceReason, VoiceState, VoiceTable, type VoiceStateCode } from "./voiceTable";

const P = VoiceState.PLAYING;

type VoiceStateName = AudioDebugInfo["voices"][number]["state"];

function clipInfo(id: number, path: string, sampleRate = 48_000): ClipInfo {
  return { id, path, state: "ready", refs: 1, frames: 0, channels: 1, sampleRate, format: 1, bytes: 0, failure: null };
}

function settings(): AudioSettings {
  return {
    ...defaultAudioSettings(),
    buses: [
      { name: "master", volume: 1, mute: false, effects: [] },
      { name: "music", parent: "master", volume: 0.5, mute: false, effects: [], maxVoices: 2 },
      { name: "sfx", parent: "master", volume: 1, mute: false, effects: [] },
    ],
  };
}

function setup() {
  const table = new VoiceTable(8);
  const mirror = new StatusMirror(table);
  const mixer = new Mixer(settings());
  const clips = new Map<number, ClipInfo>();
  const source: DebugSource = {
    host: { sampleRate: 48_000 },
    status: "running",
    time: 1.5,
    backgroundMode: "pause",
    busNames: mixer.busNames,
    mirror,
    table,
    clips: { info: (id) => clips.get(id) ?? null },
    mixer,
    lockedQueue: new UnlockQueue<number>({ onDrop: () => {} }),
    hrtfReady: true,
  };
  return { table, mirror, mixer, clips, source };
}

describe("buildDebugInfo: buses (A2.5)", () => {
  it("lists every bus by index with its gains, voice count and maxVoices", () => {
    const { table, mixer, source } = setup();
    table.setBusLimits([0, 2, 0]);
    table.allocate(1, 100, 0, P);
    table.allocate(1, 100, 0, VoiceState.LOCKED);
    table.allocate(2, 100, 0, P);
    const info = buildDebugInfo(source);
    expect(info.buses.map((b) => b.name)).toEqual(["master", "music", "sfx"]);
    const music = info.buses[1]!;
    const resolved = mixer.resolveAll().find((b) => b.name === "music")!;
    expect(music.gain).toBeCloseTo(resolved.gain);
    expect(music.effectiveGain).toBeCloseTo(resolved.effectiveGain);
    expect(music.effectiveGain).toBeCloseTo(0.5);
    expect(music.voices).toBe(2);
    expect(music.maxVoices).toBe(2);
    expect(info.buses[2]!.voices).toBe(1);
    expect(info.buses[2]!.maxVoices).toBeNull();
    expect(info.buses[0]!.voices).toBe(0);
  });

  it("takes peaks from the newest STATUS by bus index, and 0 for buses the block left out", () => {
    const { mirror, source } = setup();
    mirror.apply(makeStatusBlock({ peaks: [{ l: 0.25, r: 0.5 }, { l: 0.125, r: 0.0625 }] }));
    let info = buildDebugInfo(source);
    expect(info.buses.map((b) => [b.peakL, b.peakR])).toEqual([
      [0.25, 0.5],
      [0.125, 0.0625],
      [0, 0],
    ]);
    // A later block that reports one bus: the older values for the others are no longer shown.
    mirror.apply(makeStatusBlock({ peaks: [{ l: 0.75, r: 0.875 }] }));
    info = buildDebugInfo(source);
    expect(info.buses.map((b) => [b.peakL, b.peakR])).toEqual([
      [0.75, 0.875],
      [0, 0],
      [0, 0],
    ]);
  });

  it("reports a muted bus with gain 0 and effective gain 0", () => {
    const { mixer, source } = setup();
    mixer.bus("sfx").mute = true;
    const sfx = buildDebugInfo(source).buses[2]!;
    expect(sfx.gain).toBe(0);
    expect(sfx.effectiveGain).toBe(0);
  });
});

describe("buildDebugInfo: voices (A2.5)", () => {
  it("has one entry per live voice with the table's values, and skips free slots", () => {
    const { table, clips, source } = setup();
    clips.set(7, clipInfo(7, "sfx/shot.ogg"));
    const freed = table.allocate(0, 1, 0, P);
    table.free(freed, VoiceReason.NONE);
    const id = table.allocate(2, 200, 3, P);
    const i = id & 0xffff;
    table.clip[i] = 7;
    table.gain[i] = 0.5;
    table.pitch[i] = 1.25;
    table.audibility[i] = 0.4;
    table.group[i] = 12;
    // The playing node's name comes from the backend's per-slot `owners` (PlayRequest.owner).
    const owners: (string | null)[] = [];
    owners[i] = "Radio";
    const info = buildDebugInfo({ ...source, owners });
    expect(info.voices).toEqual([
      {
        id,
        clip: "sfx/shot.ogg",
        bus: "sfx",
        world: "3",
        state: "playing",
        priority: 200,
        gain: 0.5,
        pitch: 1.25,
        audibility: expect.closeTo(0.4, 5),
        playheadSeconds: null,
        owner: "Radio",
        event: 12,
      },
    ]);
    table.group[i] = 0;
    expect(buildDebugInfo(source).voices[0]!.event).toBeNull();
  });

  it("maps every table state and bus-muted or starved reasons to the API's state", () => {
    const { table, source } = setup();
    const cases: [VoiceStateCode, number, VoiceStateName][] = [
      [VoiceState.LOCKED, VoiceReason.LOCKED, "locked"],
      [VoiceState.WAITING_FOR_DATA, VoiceReason.WAITING_FOR_DATA, "waitingForData"],
      [VoiceState.VIRTUAL, VoiceReason.VIRTUAL, "virtual"],
      [P, VoiceReason.BUS_MUTED, "busMuted"],
      [P, VoiceReason.WAITING_FOR_DATA, "waitingForData"],
      [P, VoiceReason.NONE, "playing"],
    ];
    for (const [state] of cases) table.allocate(0, 1, 0, state);
    const info = buildDebugInfo(source);
    expect(info.voices.map((v) => v.state)).toEqual(["locked", "waitingForData", "virtual", "playing", "playing", "playing"]);
    // Reasons are set by hand here, since `allocate` takes them from the state only.
    cases.forEach(([, reason], k) => (table.reason[k] = reason));
    expect(buildDebugInfo(source).voices.map((v) => v.state)).toEqual(cases.map((c) => c[2]));
  });

  it("uses null for world and owner when none is set, and clamps audibility to 0..1", () => {
    const { table, source } = setup();
    const id = table.allocate(0, 1, 0, P);
    table.audibility[id & 0xffff] = 3.5;
    const v = buildDebugInfo(source).voices[0]!;
    expect(v.world).toBeNull();
    expect(v.owner).toBeNull();
    expect(v.audibility).toBe(1);
    expect(v.clip).toBe("");
  });

  it("gives a playhead in seconds only for voices flagged WANTS_PLAYHEAD with a known clip rate", () => {
    const { table, mirror, clips, source } = setup();
    clips.set(4, clipInfo(4, "music/loop.ogg", 44_100));
    const a = table.allocate(0, 1, 0, P);
    const b = table.allocate(0, 1, 0, P);
    table.clip[a & 0xffff] = 4;
    table.clip[b & 0xffff] = 4;
    table.flags[a & 0xffff] = VoiceFlag.WANTS_PLAYHEAD;
    mirror.apply(makeStatusBlock({ playheads: [{ id: a, clipFrame: 44_100 }, { id: b, clipFrame: 44_100 }] }));
    const [va, vb] = buildDebugInfo(source).voices;
    expect(va!.playheadSeconds).toBeCloseTo(1);
    expect(vb!.playheadSeconds).toBeNull();
    // An unknown clip rate (not decoded yet): no playhead.
    clips.set(4, clipInfo(4, "music/loop.ogg", 0));
    expect(buildDebugInfo(source).voices[0]!.playheadSeconds).toBeNull();
  });
});

describe("buildDebugInfo: header, counters and core (A2.5 keeps them)", () => {
  it("fills the header from the backend and keeps the counters and core fields", () => {
    const { table, mirror, source } = setup();
    table.allocate(0, 1, 0, P);
    mirror.apply(makeStatusBlock({ underruns: 2, mixedVoices: 3, mixedCap: 16, hrtfVoices: 1 }));
    const info = buildDebugInfo(source);
    expect(info.status).toBe("running");
    expect(info.sampleRate).toBe(48_000);
    expect(info.time).toBe(1.5);
    expect(info.background).toBe("pause");
    expect(info.counters).toMatchObject({ underruns: 2, mixedVoices: 3, mixedCap: 16, logicalVoices: 1, queuedPlays: 0, droppedPlays: 0, refusedLoads: 0, hrtfVoices: 1 });
    expect(info.core).toEqual({ backend: "core", hrtfReady: true, ladderState: "cap at floor", ladderRecoveries: 0 });
  });

  it("counts the ladder's loudness step (loudShed, Ld7) in ladderState and names it (G7a)", () => {
    const { mirror, source } = setup();
    mirror.apply(makeStatusBlock({ mixedCap: 16 }));
    const state = () => buildDebugInfo(source).core!.ladderState;
    // Underruns going on (the last one now): shedding. The loudness step alone, then with the bed step.
    mirror.underrunFrame = mirror.frameAudio;
    mirror.loudShed = 1;
    expect(state()).toBe("shedding (1 step: metering paused)");
    mirror.m3Shed = 1;
    expect(state()).toBe("shedding (2 steps: metering paused)");
    // Without the loudness step the text doesn't name it (each field counts on its own).
    mirror.loudShed = 0;
    expect(state()).toBe("shedding (1 step)");
    // A clean second since the last underrun: recovering, with the loudness step still in force.
    mirror.loudShed = 1;
    mirror.m3Shed = 0;
    mirror.underrunFrame = mirror.frameAudio - 48_000;
    expect(state()).toBe("recovering (1 step: metering paused)");
    mirror.loudShed = 0;
    expect(state()).toBe("cap at floor");
  });

  it("reports the cap selection runs at when the backend gives one (A3.3)", () => {
    const { mirror, source } = setup();
    mirror.apply(makeStatusBlock({ mixedCap: 0 }));
    expect(buildDebugInfo({ ...source, mixedCap: () => 24 }).counters.mixedCap).toBe(24);
  });
});

describe("buildDebugInfo: virtual and stolen voices (A3.1)", () => {
  it("shows a virtual voice on a muted bus as busMuted", () => {
    const { table, source } = setup();
    const id = table.allocate(0, 1, 0, VoiceState.VIRTUAL);
    table.reason[id & 0xffff] = VoiceReason.BUS_MUTED;
    expect(buildDebugInfo(source).voices[0]!.state).toBe("busMuted");
  });

  it("lists recent steals as stolen for about a second of selection frames", () => {
    const { table, clips, source } = setup();
    clips.set(3, clipInfo(3, "sfx/hit.wav"));
    table.setBusLimits([0, 1, 0]);
    const old = table.allocate(1, 10, 4, P);
    table.clip[old & 0xffff] = 3;
    table.frame = 100;
    const fresh = table.allocate(1, 200, 0, P); // the bus is full: steals `old`
    expect(fresh).not.toBe(0);
    const stolen = buildDebugInfo(source).voices.filter((v) => v.state === "stolen");
    expect(stolen).toEqual([{ id: old, clip: "sfx/hit.wav", bus: "music", world: "4", state: "stolen", priority: 10, gain: 0, pitch: 1, audibility: 0, playheadSeconds: null, owner: null, event: null }]);
    table.frame = 160;
    expect(buildDebugInfo(source).voices.some((v) => v.state === "stolen")).toBe(true);
    table.frame = 161;
    expect(buildDebugInfo(source).voices.some((v) => v.state === "stolen")).toBe(false);
  });
});
