// ADR 0171 amended by 0172 (Ma2; api-and-models §6.5, §4.2; architecture §3.3, §2.3, §4.7; R8, R9, R12): the structural
// dip's records, decoded from the batches a core backend posts on a recording link (no wasm). A move, a remove and a
// mid-list insert each post one stamped sequence (dip-down, BUS_SLOT, dip-up under one sequenceId) alone in one batch;
// same-task ops coalesce, later ones queue after the planned end; a direct edit of a pending slot rides the sequence; a
// tombstone recycles only after its tail with no voice on it; the replay carries the end state. The sound of each case
// (maxStep on the real core, a rebuild mid-dip) is in `structuralDipLoopback.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { TOMBSTONE_TAIL_FRAMES as TABLE_TAIL } from "../../../../engine/audio/slotTable";
import {
  ASAP,
  BUS_ROOT,
  BUS_SLOT_FLAGS_STRUCTURAL,
  FadeLaw,
  Kind,
  SET_PARAMS_MASK_BUS,
  LANE_DIP,
  Op,
  QUANTUM_FRAMES,
  TOMBSTONE_TAIL_FRAMES,
  rampSequenceId,
  readBatchHeader,
  readBusRamp,
  readBusSlot,
  readEnvelope,
  readRecordHead,
} from "../wire.generated";
import { CoreBackend } from "./coreBackend";
import { ReplayBuilder } from "./replay";
import { DIP_MS, dipFrames } from "./structuralDip";

const RATE = 48_000;
const D = dipFrames(RATE); // 960

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

/** Decodes one BATCH: each record with its absolute frame (`ASAP` stays -1). */
function decode(buffer: ArrayBuffer): Rec[] | null {
  const view = new DataView(buffer);
  const kind = readEnvelope(view, 0).kind;
  if (kind !== Kind.BATCH && kind !== Kind.REPLAY) return null;
  const header = readBatchHeader(view, 0);
  const out: Rec[] = [];
  let off = 32;
  for (let i = 0; i < header.count; i++) {
    const head = readRecordHead(view, off);
    const frame = head.frameOffset === ASAP ? -1 : header.firstFrame + head.frameOffset;
    if (head.opcode === Op.BUS_RAMP) {
      const r = readBusRamp(view, off);
      out.push({ op: "ramp", slot: r.voiceId, lane: r.lane, gain: r.gain, frames: r.frames, seq: rampSequenceId(r.shape), frame });
    } else if (head.opcode === Op.BUS_SLOT) {
      const s = readBusSlot(view, off);
      out.push({ op: "slot", slot: s.slot, parent: s.parent, flags: s.flags, seq: s.sequenceId, frame, effects: s.effects.map((e) => e.type) });
    } else out.push({ op: "other", code: head.opcode, frame });
    off += head.words * 4;
  }
  return out;
}

/** A core backend on a recording link over its own mixer; `batches()` decodes what was posted since the last call. */
function rig() {
  const posted: ArrayBuffer[] = [];
  const mixer = new Mixer(parseAudioSettings(PROJECT).settings);
  const link = {
    batchPool: { acquire: () => new ArrayBuffer(64 * 1024), release() {} },
    nextSeq: () => 1,
    post: (b: ArrayBuffer) => void posted.push(b.slice(0)),
    onStatus: () => () => {},
    statusDecoder: null,
  };
  const host = { link, status: "running" as const, preset: { maxLogical: 16 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: () => () => {} };
  const clock = { rafTime: () => 0, outputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }), currentTime: () => 0, dateNow: () => 0, fake: true as const };
  const clips = { acquire: () => 1, release() {}, state: () => "ready", info: () => null, onResident: () => () => {}, releaseWorld() {}, applyClipEvent() {}, residentIds: () => [], acquireReserved() {} };
  const backend = new CoreBackend(host as never, { clips: clips as never, clock: clock as never, mixer });
  backend.update(0.016); // the configure's records go out
  posted.length = 0;
  const batches = () => posted.splice(0).map(decode).filter((b): b is Rec[] => b !== null);
  const settle = async () => {
    for (let k = 0; k < 4; k++) await Promise.resolve();
  };
  return { backend, mixer, batches, settle };
}

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
  it("DIP_FRAMES is round(0.020 x sampleRate); the table's tail is the wire's", () => {
    expect(DIP_MS).toBe(20);
    expect(dipFrames(48_000)).toBe(960);
    expect(dipFrames(44_100)).toBe(882);
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
    expect(backend.dip.last).toMatchObject({ id: seq.id, f0: seq.f0, b: seq.b, end: seq.end });
    expect(backend.dip.inFlight).toBe(true);
    backend.dispose();
  });

  it("a remove tombstones the bus and its descendants: each dips down and stays at 0, and becomes a silent root at B", async () => {
    const { backend, mixer, batches, settle } = rig();
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
    const out = new ReplayBuilder();
    backend.lanes.replayLanes(out);
    const replayed: Rec[] = [];
    out.post({ post: (m) => void replayed.push(...(decode(m) ?? [])), nextSeq: () => 1 }, 0, true);
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
    expect(backend.dip.inFlight).toBe(true);
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
    const { backend, mixer, batches, settle } = rig();
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
    backend.update(0.016); // the frame's batch (flushNow is inside its coalescing window)
    const asap = batches().flat().filter((r) => r.op === "slot");
    expect(asap).toEqual([expect.objectContaining({ slot: SLOT.UI, frame: -1, seq: 0 })]);
    backend.dispose();
  });

  it("a tombstone recycles only TOMBSTONE_TAIL_FRAMES after its sequence's end, and only with no voice on it", async () => {
    const { backend, mixer, settle } = rig();
    mixer.apply({ op: "removeBus", bus: "UI" });
    // Not stamped yet: never recycles.
    expect(backend.dip.recycle(1e12)).toEqual([]);
    await settle();
    const end = backend.dip.last!.end;
    expect(backend.buses.slots.slots[SLOT.UI]).toMatchObject({ state: "tombstone", recycleAfterFrame: end + TOMBSTONE_TAIL_FRAMES });
    expect(backend.dip.recycle(end + TOMBSTONE_TAIL_FRAMES - 1)).toEqual([]);
    // A voice still on it holds it.
    backend.table.busLive[SLOT.UI] = 1;
    expect(backend.dip.recycle(end + TOMBSTONE_TAIL_FRAMES)).toEqual([]);
    backend.table.busLive[SLOT.UI] = 0;
    // G7c: the mixer holds the tombstone's state (its dip at 0, for a replay) until the slot recycles, then drops it.
    expect(mixer._tombstoneLanes().map((l) => [l.slot, l.dip.to])).toEqual([[SLOT.UI, 0]]);
    expect(backend.dip.recycle(end + TOMBSTONE_TAIL_FRAMES)).toEqual([SLOT.UI]);
    expect(mixer._tombstoneLanes()).toEqual([]);
    expect(backend.buses.slots.slots[SLOT.UI]).toMatchObject({ state: "free", gen: 1 });
    expect(backend.busNames[SLOT.UI]).toBe("");
    backend.dispose();
  });

  it("an add after the recycle takes the freed slot as fresh; the lane writer sends its lanes there", async () => {
    const { backend, mixer, batches, settle } = rig();
    mixer.apply({ op: "removeBus", bus: "UI" });
    await settle();
    backend.dip.recycle(backend.dip.last!.end + TOMBSTONE_TAIL_FRAMES);
    batches();
    expect(mixer.apply({ op: "addBus", name: "Amb", parent: "Music" })).toEqual({ ok: true, class: "direct" });
    expect(backend.buses.slotOf("Amb")).toBe(SLOT.UI);
    backend.flushNow();
    const recs = batches().flat();
    expect(recs.filter((r) => r.op === "slot")).toEqual([expect.objectContaining({ slot: SLOT.UI, parent: SLOT.Music, seq: 0, frame: -1 })]);
    expect(recs.filter((r) => r.op === "ramp").map((r) => (r as { slot: number }).slot)).toEqual([4, 4, 4, 4, 4]);
    backend.dispose();
  });

  it("replayEndState: the queue is forgotten and tombstones may recycle from the new core's frame", async () => {
    const { backend, mixer, settle } = rig();
    mixer.apply({ op: "removeBus", bus: "UI" });
    await settle();
    backend.dip.replayEndState();
    expect(backend.dip.inFlight).toBe(false);
    expect(backend.buses.slots.slots[SLOT.UI]!.recycleAfterFrame).toBeLessThanOrEqual(backend.dip.last!.end + TOMBSTONE_TAIL_FRAMES);
    // An op still open at the rebuild makes its main-side changes (the frame's commit clears its records while recovering).
    mixer.apply({ op: "moveBus", bus: "Music", parent: "SFX" });
    expect(backend.dip.inFlight).toBe(true);
    backend.dip.replayEndState();
    expect(backend.dip.inFlight).toBe(false);
    expect(backend.busConfigWire()[SLOT.Music]!.parent).toBe(SLOT.SFX);
    backend.dispose();
  });
});

describe("a sound's bus: the per-voice dip (G7a, §4.7)", () => {
  const req = (bus: string, at?: number) => ({ path: "a.wav", url: "a.wav", loop: true, stream: false, bus, ...(at !== undefined ? { at } : {}) });

  it("a sounding voice fades out over DIP_FRAMES from F0, changes bus at B with its fade at 0 and fades back in; no bus sequence", () => {
    const { backend } = rig();
    const v = backend.play(req("SFX"))!;
    backend.update(0.016);
    const fades = vi.spyOn(backend.writer, "fadeShaped");
    const params = vi.spyOn(backend.writer, "setParams");
    const emitted = backend.dip.emitted;
    v.setBus("UI");
    expect(backend.dip.emitted).toBe(emitted);
    expect(fades).toHaveBeenCalledTimes(3);
    const f0 = fades.mock.calls[0]![5]!;
    const b = Math.ceil((f0 + D) / QUANTUM_FRAMES) * QUANTUM_FRAMES;
    expect(fades.mock.calls).toEqual([
      [v.id, 0, D / RATE, FadeLaw.Linear, 0, f0],
      [v.id, 0, 0, FadeLaw.Linear, 0, b],
      [v.id, 1, D / RATE, FadeLaw.Linear, 0, b],
    ]);
    expect(params.mock.calls).toEqual([[v.id, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, SLOT.UI, 0, b]]);
    // A second move before the first one's end starts at that end (its fade-in is never cut to 0).
    fades.mockClear();
    params.mockClear();
    v.setBus("Music");
    expect(fades.mock.calls[0]).toEqual([v.id, 0, D / RATE, FadeLaw.Linear, 0, b + D]);
    const b2 = Math.ceil((b + 2 * D) / QUANTUM_FRAMES) * QUANTUM_FRAMES;
    expect(params.mock.calls).toEqual([[v.id, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, SLOT.Music, 0, b2]]);
    backend.dispose();
  });

  it("a voice whose stamped start is still ahead changes bus at once, at its start frame, with no fade", () => {
    const { backend } = rig();
    const v = backend.play(req("SFX", 1))!;
    backend.update(0.016);
    const start = backend.playheads.anchorFrame[v.id & 0xffff]!;
    expect(start).toBeGreaterThan(backend.clockMap.framesNow());
    const fades = vi.spyOn(backend.writer, "fadeShaped");
    const params = vi.spyOn(backend.writer, "setParams");
    v.setBus("UI");
    expect(fades).not.toHaveBeenCalled();
    expect(params.mock.calls).toEqual([[v.id, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, SLOT.UI, 0, start]]);
    backend.dispose();
  });
});
