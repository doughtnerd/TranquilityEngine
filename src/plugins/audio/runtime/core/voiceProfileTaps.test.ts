// ADR 0171 (Rc3, api-and-models §5.6): the voice table's and selection's event taps, on a table and selection directly with
// a recording stub sink. Every voice kind and reason these two modules own: start, stop (ended, stopped, faded,
// worldReleased, failed), steal (busMaxVoices, globalLimit, priority), virtual (capDemoted, belowAudibility, paused,
// worldInaudible), real (promoted, capRaised), refused (busFull, poolFull), queued (clipLoading, streamPriming). The
// scene on the real core is `profileTapsLoopback.test.ts`. A table with no recorder never builds a tap's arguments.
import { describe, expect, it } from "vitest";
import { recordingSink } from "../mix/recordingSink";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { DWELL_FRAMES, Selection, type SelectionSink } from "./selection";
import { VoiceFlag, VoiceReason, VoiceState, VoiceTable, type ProfileNames } from "./voiceTable";

const names: ProfileNames = { clip: (id, stream) => `${stream ? "stream" : "clip"}${id}`, busRef: (i) => (2 << 8) | i };

function rig(capacity = 8) {
  const table = new VoiceTable(capacity);
  const stub = recordingSink();
  table.setProfile(stub.sink, names);
  const selection = new Selection(table);
  // What coreBackend's `stealSlot` does for selection's bus-limit steals.
  const sink: SelectionSink = { setMixed: () => {}, steal: (i) => table.free(((table.gen[i]! << 16) | i) >>> 0, VoiceReason.STOLEN) };
  return { table, stub, selection, sink };
}

/** A voice as `coreBackend.play` fills it, then admitted (its PLAY sent): returns its id and slot. */
function start(r: ReturnType<typeof rig>, o: { bus?: number; priority?: number; world?: number; gain?: number; clip?: number; cap?: number; flags?: number } = {}) {
  const { table, selection } = r;
  const id = table.allocate(o.bus ?? 0, o.priority ?? 128, o.world ?? 0, VoiceState.WAITING_FOR_DATA, o.clip ?? 1);
  if (id === 0) return { id: 0, i: -1 };
  const i = id & 0xffff;
  table.clip[i] = o.clip ?? 1;
  table.gain[i] = o.gain ?? 1;
  table.flags[i] = o.flags ?? 0;
  const mixed = selection.admit(i, o.cap ?? 8);
  table.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
  return { id, i };
}

const noCommands = { stop: () => {}, fade: () => {} };

/** Ends voice `id` as the core's STATUS would, and the frame frees it. */
function end(table: VoiceTable, id: number): void {
  table.markEnded(id);
  table.freeEnded();
}

describe("voiceStart and voiceStop (§5.6 kinds 1 and 2)", () => {
  it("a voice's start carries its id, clip and bus names, flags, start frame and gain, once the PLAY is sent", () => {
    const r = rig();
    const id = r.table.allocate(2, 100, 0, VoiceState.WAITING_FOR_DATA, 5);
    const i = id & 0xffff;
    r.table.clip[i] = 5;
    r.table.bus[i] = 2;
    r.table.gain[i] = 0.25;
    r.table.startFrame[i] = 4800;
    r.table.flags[i] = VoiceFlag.LOOP | VoiceFlag.STREAM;
    r.table.flags2[i] = 2;
    expect(r.stub.of("voiceStart")).toEqual([]); // allocation alone is not a start
    r.selection.admit(i, 8);
    expect(r.stub.of("voiceStart")).toEqual([[id, "stream5", (2 << 8) | 2, VoiceFlag.LOOP | VoiceFlag.STREAM | (2 << 8), 4800, 0.25]]);
  });

  it.each([
    ["ended", (t: VoiceTable, id: number) => end(t, id)],
    ["stopped", (t: VoiceTable, id: number) => { t.requestStop(id, 0); t.drainCommands(noCommands); end(t, id); }],
    ["faded", (t: VoiceTable, id: number) => { t.requestStop(id, 0.2); t.drainCommands(noCommands); end(t, id); }],
    ["worldReleased", (t: VoiceTable, id: number) => { t.releaseWorld(5); t.drainCommands(noCommands); end(t, id); }],
    ["failed", (t: VoiceTable, id: number) => { t.reason[id & 0xffff] = VoiceReason.FAILED; t.requestStop(id, 0.05); end(t, id); }],
  ] as const)("a started voice's free reports voiceStop %s", (reason, how) => {
    const r = rig();
    const { id } = start(r, { world: 5 });
    r.stub.clear();
    how(r.table, id);
    expect(r.stub.calls).toEqual([["voiceStop", id, reason]]);
  });

  it("a voice that never started (stopped while waiting for its clip) leaves no stop", () => {
    const r = rig();
    const id = r.table.allocate(0, 128, 0, VoiceState.WAITING_FOR_DATA, 1);
    r.table.requestStop(id, 0);
    expect(r.table.isLive(id)).toBe(false);
    expect(r.stub.of("voiceStop")).toEqual([]);
  });

  it("a stop is reported once, and a reused slot's new voice starts clean", () => {
    const r = rig(1);
    const a = start(r);
    end(r.table, a.id);
    const b = start(r);
    expect(b.id).not.toBe(a.id);
    end(r.table, b.id);
    expect(r.stub.of("voiceStop")).toEqual([[a.id, "ended"], [b.id, "ended"]]);
  });
});

describe("voiceSteal (§5.6 kind 3)", () => {
  it("allocation on a bus at its maxVoices steals: busMaxVoices, the thief's id known", () => {
    const r = rig();
    r.table.setBusLimits([0, 1]);
    const a = start(r, { bus: 1, priority: 10 });
    r.stub.clear();
    const b = start(r, { bus: 1, priority: 200 });
    expect(r.stub.of("voiceSteal")).toEqual([[a.id, b.id, "busMaxVoices"]]);
    // The victim was started and is stolen, not stopped: one record says it.
    expect(r.stub.of("voiceStop")).toEqual([]);
  });

  it("allocation on a full table steals: globalLimit", () => {
    const r = rig(2);
    const a = start(r, { priority: 10 });
    start(r, { priority: 20 });
    r.stub.clear();
    const c = start(r, { priority: 200 });
    expect(r.stub.of("voiceSteal")).toEqual([[a.id, c.id, "globalLimit"]]);
  });

  it("selection's bus-limit steal (a lowered maxVoices) is busMaxVoices with no thief; another free as STOLEN is by priority", () => {
    const r = rig();
    const a = start(r, { bus: 1, priority: 10 });
    const b = start(r, { bus: 1, priority: 90 });
    r.table.setBusLimits([0, 1]);
    r.stub.clear();
    r.selection.run(8, r.sink);
    expect(r.stub.of("voiceSteal")).toEqual([[a.id, 0, "busMaxVoices"]]);
    expect(r.table.stealWhy).toBe("priority"); // restored for the next, non-selection steal
    r.stub.clear();
    r.table.free(b.id, VoiceReason.STOLEN);
    expect(r.stub.of("voiceSteal")).toEqual([[b.id, 0, "priority"]]);
  });
});

describe("voiceRefused (§5.6 kind 6)", () => {
  it("a bus at its maxVoices that holds only voices at or above the new priority refuses: busFull, with the clip the caller holds", () => {
    const r = rig();
    r.table.setBusLimits([0, 1]);
    start(r, { bus: 1, priority: 200 });
    r.stub.clear();
    expect(r.table.allocate(1, 50, 0, VoiceState.WAITING_FOR_DATA, 9)).toBe(0);
    expect(r.stub.calls).toEqual([["voiceRefused", "clip9", (2 << 8) | 1, "busFull"]]);
  });

  it("a full table of voices at or above the priority refuses: poolFull (no clip given: the empty name)", () => {
    const r = rig(1);
    start(r, { priority: 200 });
    r.stub.clear();
    expect(r.table.allocate(0, 50, 0, VoiceState.WAITING_FOR_DATA)).toBe(0);
    expect(r.stub.calls).toEqual([["voiceRefused", "", (2 << 8) | 0, "poolFull"]]);
  });
});

describe("voiceQueued (§5.6 kind 7)", () => {
  it("a voice still waiting for its clip at the frame's command drain is queued: clipLoading, or streamPriming for a stream", () => {
    const r = rig();
    const clipV = r.table.allocate(0, 128, 0, VoiceState.WAITING_FOR_DATA, 4);
    r.table.clip[clipV & 0xffff] = 4;
    const streamV = r.table.allocate(1, 128, 0, VoiceState.WAITING_FOR_DATA, 6);
    r.table.clip[streamV & 0xffff] = 6;
    r.table.flags[streamV & 0xffff] = VoiceFlag.STREAM;
    expect(r.stub.calls).toEqual([]);
    r.table.drainCommands(noCommands);
    expect(r.stub.calls).toEqual([
      ["voiceQueued", "clip4", (2 << 8) | 0, "clipLoading"],
      ["voiceQueued", "stream6", (2 << 8) | 1, "streamPriming"],
    ]);
    r.stub.clear();
    r.table.drainCommands(noCommands);
    expect(r.stub.calls).toEqual([]); // reported once
  });

  it("a voice that started, or was freed, before the drain never queued", () => {
    const r = rig();
    start(r); // admitted at once: its clip was ready
    const gone = r.table.allocate(0, 128, 0, VoiceState.WAITING_FOR_DATA, 2);
    r.table.free(gone, VoiceReason.NONE);
    const locked = r.table.allocate(0, 128, 0, VoiceState.LOCKED, 3); // before unlock: no reason code for it
    r.stub.clear();
    r.table.drainCommands(noCommands);
    expect(r.stub.of("voiceQueued")).toEqual([]);
    expect(locked).not.toBe(0);
  });
});

describe("voiceVirtual and voiceReal (§5.6 kinds 4 and 5)", () => {
  it("a voice admitted virtual says why: the cap, or silence", () => {
    const r = rig();
    const a = start(r, { cap: 1 });
    r.stub.clear();
    const b = start(r, { cap: 1, gain: 0.5 }); // the cap's one mixed voice is taken
    expect(r.stub.of("voiceVirtual")).toEqual([[b.id, "capDemoted"]]);
    r.stub.clear();
    r.selection.mixedCount = 0;
    const c = start(r, { cap: 8, gain: 0 });
    expect(r.stub.of("voiceVirtual")).toEqual([[c.id, "belowAudibility"]]);
    expect(a.id).not.toBe(b.id);
  });

  it("the core's own demote (STATUS demoted) is capDemoted", () => {
    const r = rig();
    const a = start(r);
    r.stub.clear();
    r.table.markDemoted(a.id);
    expect(r.stub.calls).toEqual([["voiceVirtual", a.id, "capDemoted"]]);
  });

  it("an outranked mixed voice is demoted (capDemoted) and a louder virtual one promoted", () => {
    const r = rig();
    const quiet = start(r, { gain: 0.2, cap: 1 });
    const loud = start(r, { gain: 0.9, cap: 1 }); // admitted virtual, past its first frame's exemption
    r.stub.clear();
    for (let f = 0; f < DWELL_FRAMES + 2; f++) r.selection.run(1, r.sink);
    expect(r.stub.of("voiceVirtual")).toEqual([[quiet.id, "capDemoted"]]);
    expect(r.stub.of("voiceReal")).toEqual([[loud.id, "promoted"]]);
  });

  it("a promotion in a frame where the cap rose is capRaised", () => {
    const r = rig();
    start(r, { gain: 0.9, cap: 1 });
    const second = start(r, { gain: 0.5, cap: 1 });
    for (let f = 0; f < DWELL_FRAMES + 2; f++) r.selection.run(1, r.sink);
    expect(r.table.state[second.i]).toBe(VoiceState.VIRTUAL);
    r.stub.clear();
    r.selection.run(2, r.sink);
    expect(r.stub.of("voiceReal")).toEqual([[second.id, "capRaised"]]);
  });

  it("a settled mixed voice gone silent is demoted: belowAudibility", () => {
    const r = rig();
    const a = start(r);
    for (let f = 0; f < DWELL_FRAMES + 1; f++) r.selection.run(8, r.sink);
    r.table.gain[a.i] = 0;
    r.stub.clear();
    r.selection.run(8, r.sink);
    expect(r.stub.of("voiceVirtual")).toEqual([[a.id, "belowAudibility"]]);
  });

  it("an inaudible World's voice is demoted at once: worldInaudible; a paused one: paused", () => {
    const r = rig();
    const w = start(r, { world: 7 });
    const p = start(r, { world: 0 });
    r.selection.run(8, r.sink);
    r.stub.clear();
    r.selection.setWorldAudible(7, false);
    r.table.flags[p.i]! |= VoiceFlag.PAUSED;
    r.selection.run(8, r.sink);
    expect(r.stub.of("voiceVirtual")).toEqual(expect.arrayContaining([[w.id, "worldInaudible"], [p.id, "paused"]]));
    expect(r.stub.of("voiceVirtual")).toHaveLength(2);
  });
});

describe("with no recorder", () => {
  it("a full scene never builds a tap's arguments: the name resolvers are not called", () => {
    const table = new VoiceTable(2);
    const poison: ProfileNames = { clip: () => { throw new Error("clip name resolved"); }, busRef: () => { throw new Error("busRef resolved"); } };
    table.setProfile(null, poison); // null sink: the table keeps the null object and drops the resolvers' use
    expect(table.profile).toBe(NULL_PROFILE_SINK);
    const selection = new Selection(table);
    const sink: SelectionSink = { setMixed: () => {}, steal: (i) => table.free(((table.gen[i]! << 16) | i) >>> 0, VoiceReason.STOLEN) };
    for (let n = 0; n < 4; n++) {
      const id = table.allocate(0, 10 + n, 0, VoiceState.WAITING_FOR_DATA, 1); // the third and fourth steal
      const i = id & 0xffff;
      table.gain[i] = 0.5;
      selection.admit(i, 1);
      table.state[i] = VoiceState.VIRTUAL;
    }
    expect(table.allocate(0, 0, 0, VoiceState.WAITING_FOR_DATA, 1)).toBe(0); // refused
    table.markDemoted(1);
    for (let f = 0; f < 5; f++) selection.run(1, sink);
    table.drainCommands(noCommands);
    table.releaseWorld(3);
    for (let i = 0; i < 2; i++) table.free(((table.gen[i]! << 16) | i) >>> 0, VoiceReason.NONE);
    expect(table.liveCount).toBe(0);
  });
});
