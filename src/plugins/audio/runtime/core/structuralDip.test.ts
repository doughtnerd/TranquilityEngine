// ADR 0171 amended by 0172 (Ma2; api-and-models §6.5, §4.2; architecture §3.3, §2.3, §4.7; R8, R9, R12): the structural
// dip's records, decoded from the batches a core backend posts on the recording host (no wasm, ADR 0234). A move, a remove and a
// mid-list insert each post one stamped sequence (dip-down, BUS_SLOT, dip-up under one sequenceId) alone in one batch;
// same-task ops coalesce, later ones queue after the planned end; a direct edit of a pending slot rides the sequence; a
// freed slot is taken fresh; a rebuild's replay carries the end state. `StructuralDip` alone (over a real bus index and
// command writer, its clock in the test's hands): a sequence is in flight until its planned end, a tombstone recycles
// only after its tail with no voice on it, and `replayEndState` forgets the queue. The sound of each case (maxStep on
// the real core, a rebuild mid-dip) is in `structuralDipLoopback.test.ts`.
import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { TOMBSTONE_TAIL_FRAMES as TABLE_TAIL } from "../../../../engine/audio/slotTable";
import {
  ASAP,
  BUS_ROOT,
  BUS_SLOT_FLAGS_STRUCTURAL,
  FadeLaw,
  SET_PARAMS_MASK_BUS,
  LANE_DIP,
  Op,
  QUANTUM_FRAMES,
  TOMBSTONE_TAIL_FRAMES,
  rampSequenceId,
  readBusRamp,
  packShape,
  readBusSlot,
  readFade,
  readSetParams,
} from "../wire.generated";
import { batchRecords, type BatchRecord, type PostedBatch } from "./batchRecords";
import { BusIndex } from "./busIndex";
import { CommandWriter } from "./commandWriter";
import { closeRecordingAudio, fakeHostClock, recordingAudio } from "../testing";
import { Presence } from "./presence";
import { StructuralDip } from "./structuralDip";
import { VoiceTable } from "./voiceTable";

const RATE = 48_000;

afterEach(closeRecordingAudio);
const D = Math.round(0.02 * RATE); // the dip: 20 ms, 960 frames at 48 kHz

const PROJECT = {
  buses: [
    { name: "Master" },
    { name: "Music", parent: "Master", effects: [{ type: "lowpass", frequency: 800, q: 1 }, { type: "compressor", threshold: -12, knee: 6, ratio: 4, attack: 0.01, release: 0.2 }] },
    { name: "SFX", parent: "Master" },
    { name: "Steps", parent: "SFX" },
    { name: "UI", parent: "Master" },
  ],
};
const SLOT = { Master: 0, Music: 1, SFX: 2, Steps: 3, UI: 4 } as const;

type Rec =
  | { op: "ramp"; slot: number; lane: number; gain: number; frames: number; seq: number; frame: number }
  | { op: "slot"; slot: number; parent: number; flags: number; seq: number; frame: number; effects: number[] }
  | { op: "other"; code: number; frame: number };

/** One posted BATCH or REPLAY, each record with its absolute frame (`ASAP` stays -1). */
function decode(batch: PostedBatch): Rec[] {
  return batch.records.map((x): Rec => {
    if (x.opcode === Op.BUS_RAMP) {
      const r = readBusRamp(x.view, x.off);
      return { op: "ramp", slot: r.voiceId, lane: r.lane, gain: r.gain, frames: r.frames, seq: rampSequenceId(r.shape), frame: x.frame };
    }
    if (x.opcode === Op.BUS_SLOT) {
      const b = readBusSlot(x.view, x.off);
      return { op: "slot", slot: b.slot, parent: b.parent, flags: b.flags, seq: b.sequenceId, frame: x.frame, effects: b.effects.map((e) => e.type) };
    }
    return { op: "other", code: x.opcode, frame: x.frame };
  });
}

/** A core backend on the recording host (ADR 0234) over its own mixer; `batches()` decodes what was posted since the last call. */
function rig() {
  // The context's clock, which the test moves on (`advance`): its output timestamp follows, so F_now does.
  const clock = fakeHostClock({ rafTime: 0, currentTime: 0, dateNow: 0 });
  const r = recordingAudio({ mixer: "own", settings: parseAudioSettings(PROJECT).settings, preset: { maxLogical: 16 }, clock });
  const { backend, mixer, posted } = r;
  r.tick(0.016); // the configure's records go out
  posted.take();
  const batches = () => posted.take().map(decode);
  /** Every record posted since the last call (any opcode), for the generated readers. */
  const records = () => posted.takeRecords();
  const settle = async () => {
    for (let k = 0; k < 4; k++) await Promise.resolve();
  };
  /** Frames on the context's clock, `ms` at a time, each followed by the backend's frame. */
  const advance = (frames: number, step = 16) => {
    for (let t = 0; t < frames; t++) {
      clock.advance(step);
      r.tick(step / 1000);
    }
  };
  /** A hard rebuild as the host runs it: the old core is gone, the new one answers (its REPLAY goes on the link). */
  const rebuild = async () => {
    expect(await r.rebuild("trap")).toBe("rebuilt");
  };
  return { backend, mixer, batches, records, settle, advance, rebuild, tick: r.tick };
}

/** Voice `id`'s per-voice dip among `recs`: its FADE records, its `SET_PARAMS bus` records, and whether any bus sequence went. */
function voiceDip(recs: readonly BatchRecord[], id: number) {
  const fades = recs.filter((x) => x.opcode === Op.FADE && x.voiceId === id).map((x) => {
    const f = readFade(x.view, x.off);
    return { target: f.target, frames: f.frames, shape: f.shape ?? 0, frame: x.frame };
  });
  const buses = recs
    .filter((x) => x.opcode === Op.SET_PARAMS && x.voiceId === id)
    .map((x) => ({ p: readSetParams(x.view, x.off), frame: x.frame }))
    .filter((x) => (x.p.mask & SET_PARAMS_MASK_BUS) !== 0)
    .map((x) => ({ bus: x.p.bus, frame: x.frame }));
  const sequenced = recs.some((x) => (x.opcode === Op.BUS_RAMP && rampSequenceId(readBusRamp(x.view, x.off).shape) !== 0) || (x.opcode === Op.BUS_SLOT && readBusSlot(x.view, x.off).sequenceId !== 0));
  return { fades, buses, sequenced };
}
/** A linear ramp from its start (FADE's law and start phase word). */
const LINEAR = packShape(FadeLaw.Linear, 0);

/** The batches holding a sequenced record; each must hold nothing else (the sequence is posted alone). */
function sequenceBatches(posted: Rec[][]): Rec[][] {
  const out = posted.filter((b) => b.some((r) => r.op !== "other" && r.seq !== 0));
  for (const b of out) expect(b.every((r) => r.op !== "other" && r.seq !== 0), "a sequence's batch holds only the sequence").toBe(true);
  return out;
}

/** The dip's records of one batch, checked as one sequence: returns its id, F0, B and the records by kind. */
function sequenceOf(batch: Rec[]) {
  const ramps = batch.filter((r): r is Extract<Rec, { op: "ramp" }> => r.op === "ramp");
  const slots = batch.filter((r): r is Extract<Rec, { op: "slot" }> => r.op === "slot");
  const ids = new Set([...ramps.map((r) => r.seq), ...slots.map((s) => s.seq)]);
  expect(ids.size, "one sequenceId").toBe(1);
  const id = [...ids][0]!;
  expect(id).toBeGreaterThan(0);
  const down = ramps.filter((r) => r.gain === 0);
  const up = ramps.filter((r) => r.gain === 1);
  for (const r of ramps) {
    expect(r.lane).toBe(LANE_DIP);
    expect(r.frames).toBe(D);
  }
  const f0 = down[0]!.frame;
  for (const r of down) expect(r.frame).toBe(f0);
  const b = slots[0]!.frame;
  for (const s of slots) {
    expect(s.frame).toBe(b);
    expect(s.flags & BUS_SLOT_FLAGS_STRUCTURAL).toBeTruthy();
  }
  for (const r of up) expect(r.frame).toBe(b);
  expect(b % QUANTUM_FRAMES, "BUS_SLOT at a quantum start").toBe(0);
  expect(b, "the first quantum start at or after F0 + DIP_FRAMES").toBeGreaterThanOrEqual(f0 + D);
  expect(b - (f0 + D)).toBeLessThan(QUANTUM_FRAMES);
  return { id, f0, b, end: b + D, down, up, slots };
}

describe("the structural dip's sequence (Ma2)", () => {
  it("the table's tail is the wire's", () => {
    expect(TABLE_TAIL).toBe(TOMBSTONE_TAIL_FRAMES);
  });

  it("a move posts one sequence alone in one batch: dip-down at F0, BUS_SLOT (new parent) at B, dip-up at B, one sequenceId", async () => {
    const { backend, mixer, batches, settle } = rig();
    expect(mixer.apply({ op: "moveBus", bus: "UI", parent: "Music" })).toEqual({ ok: true, class: "dip" });
    // The model is the end state at once; the wire waits for the end of the task.
    expect(mixer.audioSettings.buses.find((b) => b.name === "UI")!.parent).toBe("Music");
    expect(backend.busConfigWire()[SLOT.UI]!.parent).toBe(SLOT.Music);
    expect(batches()).toEqual([]);
    await settle();
    const posted = sequenceBatches(batches());
    expect(posted).toHaveLength(1);
    const seq = sequenceOf(posted[0]!);
    expect(seq.down.map((r) => r.slot)).toEqual([SLOT.UI]);
    expect(seq.slots.map((s) => [s.slot, s.parent])).toEqual([[SLOT.UI, SLOT.Music]]);
    expect(seq.up.map((r) => r.slot)).toEqual([SLOT.UI]);
    backend.dispose();
  });

  it("a remove tombstones the bus and its descendants: each dips down and stays at 0, and becomes a silent root at B", async () => {
    const { backend, mixer, batches, settle, rebuild } = rig();
    expect(mixer.apply({ op: "removeBus", bus: "SFX" })).toEqual({ ok: true, class: "dip" });
    expect(backend.buses.slotOf("SFX")).toBe(-1);
    expect(backend.buses.slotOf("Steps")).toBe(-1);
    expect(backend.busNames.slice(0, 5)).toEqual(["Master", "Music", "SFX", "Steps", "UI"]); // tombstones keep their slots
    expect(mixer.busNames).toEqual(["Master", "Music", "UI"]); // G7c: out of the mixer's model at once (`Audio.buses`)
    await settle();
    // The rules and presence mask the removal changed went first, asap (staged before the sequence); the sequence alone.
    const posted = sequenceBatches(batches());
    expect(posted).toHaveLength(1);
    const seq = sequenceOf(posted[0]!);
    expect(seq.down.map((r) => r.slot)).toEqual([SLOT.SFX, SLOT.Steps]);
    expect(seq.up).toEqual([]);
    expect(seq.slots.map((s) => [s.slot, s.parent, s.effects.length])).toEqual([
      [SLOT.SFX, BUS_ROOT, 0],
      [SLOT.Steps, BUS_ROOT, 0],
    ]);
    // The replay's BUS_CONFIG carries them as silent roots; the dip lane replays at its end state, 0.
    expect(backend.busConfigWire().slice(2, 4)).toEqual([{ parent: BUS_ROOT, effects: [] }, { parent: BUS_ROOT, effects: [] }]);
    await rebuild();
    const replayed = batches().flat();
    const dips = replayed.filter((r): r is Extract<Rec, { op: "ramp" }> => r.op === "ramp" && r.lane === LANE_DIP).map((r) => [r.slot, r.gain]);
    expect(dips).toEqual([[SLOT.SFX, 0], [SLOT.Steps, 0], [SLOT.Master, 1], [SLOT.Music, 1], [SLOT.UI, 1]]);
    backend.dispose();
  });

  it("a mid-list effect insert (and a removal, a reorder) dips the bus around its new chain", async () => {
    const { backend, mixer, batches, settle } = rig();
    const cases: [MixOp, number[]][] = [
      [{ op: "addEffect", bus: "Music", index: 0, effect: { type: "highpass", frequency: 80, q: 1 } }, [1, 0, 2]],
      [{ op: "moveEffect", bus: "Music", from: 0, to: 2 }, [0, 2, 1]],
      [{ op: "removeEffect", bus: "Music", index: 1 }, [0, 1]],
    ];
    for (const [op, chain] of cases) {
      expect(mixer.apply(op), op.op).toEqual({ ok: true, class: "dip" });
      await settle();
      const posted = sequenceBatches(batches());
      expect(posted, op.op).toHaveLength(1);
      const seq = sequenceOf(posted[0]!);
      expect(seq.slots.map((s) => [s.slot, s.parent, s.effects]), op.op).toEqual([[SLOT.Music, SLOT.Master, chain]]);
      expect(seq.down.map((r) => r.slot)).toEqual([SLOT.Music]);
      expect(seq.up.map((r) => r.slot)).toEqual([SLOT.Music]);
    }
    backend.dispose();
  });

  it("ops of one task coalesce into one sequence; an op in a later task queues: it starts at or after the first's planned end", async () => {
    const { backend, mixer, batches, settle } = rig();
    // A mid-tree insert: an added bus (direct, asap), then the children re-parented under it, in one task.
    mixer.apply({ op: "addBus", name: "World", parent: "Master" });
    mixer.apply({ op: "moveBus", bus: "SFX", parent: "World" });
    mixer.apply({ op: "moveBus", bus: "UI", parent: "World" });
    await settle();
    let posted = batches();
    const added = posted.flat().filter((r) => r.op === "slot" && r.seq === 0);
    expect(added).toEqual([expect.objectContaining({ slot: 5, parent: SLOT.Master })]);
    const sequences = posted.filter((b) => b.some((r) => r.op === "slot" && r.seq !== 0));
    expect(sequences).toHaveLength(1);
    const first = sequenceOf(sequences[0]!);
    expect(first.slots.map((s) => [s.slot, s.parent])).toEqual([[SLOT.SFX, 5], [SLOT.UI, 5]]);
    expect(first.down.map((r) => r.slot)).toEqual([SLOT.SFX, SLOT.UI]);
    // A second structural op inside the first dip: its own sequence, queued after the first's end.
    mixer.apply({ op: "moveEffect", bus: "Music", from: 0, to: 1 });
    await settle();
    posted = sequenceBatches(batches());
    expect(posted).toHaveLength(1);
    const second = sequenceOf(posted[0]!);
    expect(second.id).not.toBe(first.id);
    expect(second.f0, "starts at or after the first's planned end").toBeGreaterThanOrEqual(first.end);
    expect(second.f0 - first.end).toBeLessThan(1); // right at it
    backend.dispose();
  });

  it("a direct effect edit of a slot whose structural change is open rides the sequence; one in a later task is stamped at its B", async () => {
    const { backend, mixer, batches, settle, tick } = rig();
    mixer.apply({ op: "moveEffect", bus: "Music", from: 0, to: 1 });
    expect(mixer.apply({ op: "setEffect", bus: "Music", index: 1, key: "frequency", value: 1200 })).toEqual({ ok: true, class: "direct" });
    await settle();
    let posted = batches().flat();
    const slots = posted.filter((r): r is Extract<Rec, { op: "slot" }> => r.op === "slot");
    expect(slots, "the open sequence carries the edit: one BUS_SLOT").toHaveLength(1);
    expect(slots[0]!.seq).toBeGreaterThan(0);
    const b = slots[0]!.frame;
    // A later task, while that BUS_SLOT is still ahead: stamped at B with the same id, never asap.
    mixer.apply({ op: "setEffect", bus: "Music", index: 1, key: "frequency", value: 900 });
    backend.flushNow();
    posted = batches().flat();
    const later = posted.filter((r): r is Extract<Rec, { op: "slot" }> => r.op === "slot");
    expect(later).toEqual([expect.objectContaining({ slot: SLOT.Music, frame: b, seq: slots[0]!.seq })]);
    // Another bus's direct edit stays asap.
    mixer.apply({ op: "addEffect", bus: "UI", index: 0, effect: { type: "lowpass", frequency: 500, q: 1 } });
    tick(0.016); // the frame's batch (flushNow is inside its coalescing window)
    const asap = batches().flat().filter((r) => r.op === "slot");
    expect(asap).toEqual([expect.objectContaining({ slot: SLOT.UI, frame: -1, seq: 0 })]);
    backend.dispose();
  });

  it("an add after the recycle takes the freed slot as fresh; the lane writer sends its lanes there", async () => {
    const { backend, mixer, batches, settle, advance } = rig();
    mixer.apply({ op: "removeBus", bus: "UI" });
    await settle();
    // The frames go by on the context's clock until the backend's frame recycles the tombstone (its end + the tail).
    for (let k = 0; k < 40 && backend.busNames[SLOT.UI] !== ""; k++) advance(1);
    expect(backend.busNames[SLOT.UI]).toBe("");
    batches();
    expect(mixer.apply({ op: "addBus", name: "Amb", parent: "Music" })).toEqual({ ok: true, class: "direct" });
    expect(backend.buses.slotOf("Amb")).toBe(SLOT.UI);
    backend.flushNow();
    const recs = batches().flat();
    expect(recs.filter((r) => r.op === "slot")).toEqual([expect.objectContaining({ slot: SLOT.UI, parent: SLOT.Music, seq: 0, frame: -1 })]);
    expect(recs.filter((r) => r.op === "ramp").map((r) => (r as { slot: number }).slot)).toEqual([4, 4, 4, 4, 4]);
    backend.dispose();
  });
});

describe("a sound's bus: the per-voice dip (G7a, §4.7)", () => {
  const req = (bus: string, at?: number) => ({ path: "a.wav", url: "a.wav", loop: true, stream: false, bus, ...(at !== undefined ? { at } : {}) });

  it("a sounding voice fades out over DIP_FRAMES from F0, changes bus at B with its fade at 0 and fades back in; no bus sequence", () => {
    const { backend, records, tick } = rig();
    const v = backend.play(req("SFX"))!;
    tick(0.016);
    records();
    v.setBus("UI");
    tick(0.016);
    const first = voiceDip(records(), v.id);
    expect(first.sequenced, "no bus sequence").toBe(false);
    expect(first.fades).toHaveLength(3);
    const f0 = first.fades[0]!.frame;
    const b = Math.ceil((f0 + D) / QUANTUM_FRAMES) * QUANTUM_FRAMES;
    expect(first.fades).toEqual([
      { target: 0, frames: D, shape: LINEAR, frame: f0 },
      { target: 0, frames: 0, shape: LINEAR, frame: b },
      { target: 1, frames: D, shape: LINEAR, frame: b },
    ]);
    expect(first.buses).toEqual([{ bus: SLOT.UI, frame: b }]);
    // A second move before the first one's end starts at that end (its fade-in is never cut to 0).
    v.setBus("Music");
    tick(0.016);
    const second = voiceDip(records(), v.id);
    expect(second.fades[0]).toEqual({ target: 0, frames: D, shape: LINEAR, frame: b + D });
    const b2 = Math.ceil((b + 2 * D) / QUANTUM_FRAMES) * QUANTUM_FRAMES;
    expect(second.buses).toEqual([{ bus: SLOT.Music, frame: b2 }]);
    backend.dispose();
  });

  it("a voice whose stamped start is still ahead changes bus at once, at its start frame, with no fade", () => {
    const { backend, records, tick } = rig();
    const v = backend.play(req("SFX", 1))!;
    tick(0.016);
    const start = backend.playheads.anchorFrame[v.id & 0xffff]!;
    expect(start).toBeGreaterThan(backend.clockMap.framesNow());
    records();
    v.setBus("UI");
    tick(0.016);
    const moved = voiceDip(records(), v.id);
    expect(moved.fades).toEqual([]);
    expect(moved.buses).toEqual([{ bus: SLOT.UI, frame: start }]);
    backend.dispose();
  });
});

// --- StructuralDip alone: over a real bus index and command writer on a recording link; the frames are the test's ---

function dipRig() {
  const mixer = new Mixer(parseAudioSettings(PROJECT).settings);
  const table = new VoiceTable(16);
  const posted: ArrayBuffer[] = [];
  const link = { batchPool: { acquire: () => new ArrayBuffer(64 * 1024), release: () => true }, nextSeq: () => 1, post: (b: ArrayBuffer) => void posted.push(b.slice(0)) };
  const writer = new CommandWriter(link as never, RATE);
  const buses = new BusIndex({
    mixer,
    writer,
    beds: { plan() {} },
    automation: { onBusesConfigured() {} },
    mirror: { resetPeaks() {} },
    table,
    presence: new Presence(),
    onCore: () => false,
    applyMix() {},
    busesReset() {},
    moveVoice() {},
  });
  buses.configureBuses(mixer);
  /** F_now; a batch posted now applies a lookahead later. */
  let now = 0;
  const LOOKAHEAD = 1024;
  const dip = new StructuralDip();
  dip.bind({ mixer: () => mixer, buses: () => buses, writer: () => writer, sending: () => true, firstFrame: () => now + LOOKAHEAD, framesNow: () => now });
  posted.length = 0;
  /** The sequences posted since the last call. */
  const sequences = () => sequenceBatches(posted.splice(0).flatMap((b) => { const batch = batchRecords(b); return batch ? [decode(batch)] : []; })).map(sequenceOf);
  const settle = async () => {
    for (let k = 0; k < 4; k++) await Promise.resolve();
  };
  return { mixer, table, buses, dip, sequences, settle, at: (f: number) => void (now = f) };
}

describe("StructuralDip alone (Ma2: in flight, R9 recycling, R12 replay)", () => {
  it("a sequence is in flight from the op (open in its task) until its planned end, and a later one queues after it", async () => {
    const r = dipRig();
    expect(r.dip.inFlight).toBe(false);
    expect(r.dip.apply({ op: "moveBus", bus: "UI", parent: "Music" })).toEqual({ ok: true, class: "dip" });
    expect(r.dip.inFlight, "open in this task").toBe(true);
    await r.settle();
    const [seq] = r.sequences();
    expect(seq).toBeDefined();
    r.at(seq!.end - 1);
    expect(r.dip.inFlight, "running on the core").toBe(true);
    r.at(seq!.end);
    expect(r.dip.inFlight, "back up").toBe(false);
  });

  it("a tombstone recycles only TOMBSTONE_TAIL_FRAMES after its sequence's end, and only with no voice on it", async () => {
    const r = dipRig();
    r.dip.apply({ op: "removeBus", bus: "UI" });
    // Not stamped yet: never recycles.
    expect(r.dip.recycle(1e12)).toEqual([]);
    await r.settle();
    const end = r.sequences()[0]!.end;
    expect(r.buses.slots.slots[SLOT.UI]).toMatchObject({ state: "tombstone", recycleAfterFrame: end + TOMBSTONE_TAIL_FRAMES });
    expect(r.dip.recycle(end + TOMBSTONE_TAIL_FRAMES - 1)).toEqual([]);
    // A voice still on it holds it.
    r.table.busLive[SLOT.UI] = 1;
    expect(r.dip.recycle(end + TOMBSTONE_TAIL_FRAMES)).toEqual([]);
    r.table.busLive[SLOT.UI] = 0;
    // G7c: the mixer holds the tombstone's state (its dip at 0, for a replay) until the slot recycles, then drops it.
    expect(r.mixer._tombstoneLanes().map((l) => [l.slot, l.dip.to])).toEqual([[SLOT.UI, 0]]);
    expect(r.dip.recycle(end + TOMBSTONE_TAIL_FRAMES)).toEqual([SLOT.UI]);
    expect(r.mixer._tombstoneLanes()).toEqual([]);
    expect(r.buses.slots.slots[SLOT.UI]).toMatchObject({ state: "free", gen: 1 });
    expect(r.buses.names[SLOT.UI]).toBe("");
  });

  it("replayEndState: the queue is forgotten and tombstones may recycle from the new core's frame; twice is once", async () => {
    const r = dipRig();
    r.dip.apply({ op: "removeBus", bus: "UI" });
    await r.settle();
    const end = r.sequences()[0]!.end;
    r.dip.replayEndState();
    expect(r.dip.inFlight).toBe(false);
    expect(r.buses.slots.slots[SLOT.UI]!.recycleAfterFrame).toBeLessThanOrEqual(end + TOMBSTONE_TAIL_FRAMES);
    // An op still open at the rebuild makes its main-side changes (the frame's commit clears its records while recovering).
    r.dip.apply({ op: "moveBus", bus: "Music", parent: "SFX" });
    expect(r.dip.inFlight).toBe(true);
    r.dip.replayEndState();
    expect(r.dip.inFlight).toBe(false);
    expect(r.buses.busConfigWire()[SLOT.Music]!.parent).toBe(SLOT.SFX);
    r.dip.replayEndState();
    expect(r.dip.inFlight).toBe(false);
    expect(r.buses.busConfigWire()[SLOT.Music]!.parent).toBe(SLOT.SFX);
  });
});
