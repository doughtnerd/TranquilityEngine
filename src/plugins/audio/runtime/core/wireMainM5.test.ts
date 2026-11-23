// ADR 0171/0172 M5 (Wa2; api-and-models §4.2, §4.3): main's side of the M5 wire. The writers of the new records read back
// with the generated readers (the STATUS reader and its count-sum rule are `statusBlock.test.ts`, ADR 0177); the mirror
// exposes the fields; the replay sends no BUS_MIX and resends every bus lane (Mx2; the lane writer's own cases are `laneWriter.test.ts`).
import { describe, expect, it } from "vitest";
import {
  ASAP,
  BUS_LP_OFF_HZ,
  BUS_MASTER_OUT,
  BUS_RAMP_MASK_GAIN,
  BUS_RAMP_MASK_LP_HZ,
  BUS_ROOT,
  BUS_SLOT_FLAGS_FRESH,
  BUS_SLOT_FLAGS_STRUCTURAL,
  ErrorCode,
  Kind,
  LANE_DIP,
  LANE_RUNTIME,
  LANE_SNAPSHOT,
  LOUD_FLAG_PAUSED,
  LOUD_OUTPUT_TAP,
  MAX_DUCK_RULES,
  MAX_LOUDNESS_BUSES,
  Op,
  rampSequenceId,
  readBatchHeader,
  readBusDuck,
  readBusPresence,
  readBusRamp,
  readBusSlot,
  readBusSends,
  BUS_SEND_MUTED,
  readLoudConfig,
  readRecordHead,
  STATUS_BUFFER_BYTES,
  WireError,
  writeStatus,
  type BusDuckRules,
  type StatusBlock,
} from "../wire.generated";
import { createBatchPool } from "./bufferPool";
import { CommandWriter, type BatchPort } from "./commandWriter";
import { LaneWriter } from "./laneWriter";
import { StatusMirror } from "./mirror";
import { makeStatusBlock } from "./statusFixtures";
import { PlayheadTracker, Replayer, replayBusConfig, replayMaster, type ReplaySource } from "./replay";
import { CoreSession } from "./session";
import { StatusReader } from "./statusReader";
import { VoiceTable } from "./voiceTable";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";

// --- the writers --------------------------------------------------------------------------------------------------------

function writerRig(sampleRate = 48_000) {
  const posted: ArrayBuffer[] = [];
  let seq = 1;
  const port: BatchPort = { batchPool: createBatchPool(), nextSeq: () => seq++, post: (b) => posted.push(b) };
  return { writer: new CommandWriter(port, sampleRate), posted };
}

/** The records of the first posted batch, in order, with the view to read them from. */
function records(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const header = readBatchHeader(view, 0);
  const out: { op: number; voiceId: number; frameOffset: number; off: number; bytes: number }[] = [];
  let off = 32;
  for (let i = 0; i < header.count; i++) {
    const head = readRecordHead(view, off);
    out.push({ op: head.opcode, voiceId: head.voiceId, frameOffset: head.frameOffset, off, bytes: head.words * 4 });
    off += head.words * 4;
  }
  return { header, view, records: out };
}

describe("CommandWriter, the M5 records", () => {
  it("busRamp: a 32-byte BUS_RAMP, asap, linear, over `seconds` (rounded to frames); `sequenceId` goes in the shape word", () => {
    const { writer, posted } = writerRig();
    writer.busRamp(3, LANE_SNAPSHOT, BUS_RAMP_MASK_LP_HZ, 1, 800, 0.05);
    writer.busRamp(BUS_MASTER_OUT, LANE_RUNTIME, BUS_RAMP_MASK_GAIN, 0.25, BUS_LP_OFF_HZ, 0);
    writer.busRamp(2, LANE_DIP, BUS_RAMP_MASK_GAIN, 0, BUS_LP_OFF_HZ, 0.01, 5, 96_000);
    writer.flush(48_000);
    const { view, records: recs } = records(posted[0]!);
    expect(recs.map((r) => [r.op, r.bytes])).toEqual([[Op.BUS_RAMP, 32], [Op.BUS_RAMP, 32], [Op.BUS_RAMP, 32]]);
    const a = readBusRamp(view, recs[0]!.off);
    expect(a).toMatchObject({ voiceId: 3, frameOffset: ASAP, lane: LANE_SNAPSHOT, mask: BUS_RAMP_MASK_LP_HZ, lpHz: 800, frames: 2400, shape: 0 });
    const m = readBusRamp(view, recs[1]!.off);
    expect(m).toMatchObject({ voiceId: BUS_MASTER_OUT, lane: LANE_RUNTIME, mask: BUS_RAMP_MASK_GAIN, frames: 0 });
    expect(m.gain).toBeCloseTo(0.25);
    const d = readBusRamp(view, recs[2]!.off);
    expect(d).toMatchObject({ voiceId: 2, lane: LANE_DIP, frames: 480 });
    expect(rampSequenceId(d.shape)).toBe(5);
    expect(d.frameOffset).toBe(0); // stamped at the batch's first stamp
    expect(rampSequenceId(a.shape)).toBe(0);
  });

  it("busRampFrames: the length in frames goes through untouched", () => {
    const { writer, posted } = writerRig();
    writer.busRampFrames(1, LANE_RUNTIME, BUS_RAMP_MASK_GAIN, 0.5, BUS_LP_OFF_HZ, 123);
    writer.flush(0);
    const { view, records: recs } = records(posted[0]!);
    expect(readBusRamp(view, recs[0]!.off).frames).toBe(123);
  });

  it("busSlot: 28 B plus 68 B per effect (ABI 5.0), zero-padded parameters, flags and sequence tag; at most eight effects (ADR 0345)", () => {
    const { writer, posted } = writerRig();
    const fx = (type: number, ...p: number[]) => ({ type, p });
    writer.busSlot({ slot: 4, parent: BUS_ROOT, effects: [fx(0, 1500, 6), fx(3, 0.5)], structural: true, sequenceId: 9 }, 5000);
    writer.busSlot({ slot: 5, parent: 4, effects: [], fresh: true });
    writer.busSlot({ slot: 6, parent: 4, effects: [fx(0), fx(1), fx(2), fx(3), fx(0), fx(1), fx(2), fx(3), fx(0)] });
    writer.flush(0);
    const { view, records: recs } = records(posted[0]!);
    // The asap records sort first, the stamped one (at 5000) last.
    expect(recs.map((r) => [r.op, r.bytes])).toEqual([[Op.BUS_SLOT, 28], [Op.BUS_SLOT, 28 + 8 * 68], [Op.BUS_SLOT, 28 + 2 * 68]]);
    const a = readBusSlot(view, recs[2]!.off);
    expect(a).toMatchObject({ slot: 4, parent: BUS_ROOT, flags: BUS_SLOT_FLAGS_STRUCTURAL, sequenceId: 9 });
    expect(a.effects[0]!.p).toEqual([1500, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(a.effects[1]).toMatchObject({ type: 3, p: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(readBusSlot(view, recs[0]!.off)).toMatchObject({ slot: 5, parent: 4, flags: BUS_SLOT_FLAGS_FRESH, effects: [] });
    expect(readBusSlot(view, recs[1]!.off).effects).toHaveLength(8);
    // A later record never sees the earlier one's parameters.
    const { writer: w2, posted: p2 } = writerRig();
    w2.busSlot({ slot: 1, parent: 0, effects: [fx(0, 9, 9, 9, 9, 9, 9, 9)] });
    w2.busSlot({ slot: 2, parent: 0, effects: [fx(1)] });
    w2.flush(0);
    const r2 = records(p2[0]!);
    expect(readBusSlot(r2.view, r2.records[1]!.off).effects[0]!.p).toEqual(new Array(16).fill(0));
  });

  it("busSends (ADR 0344, ABI 4.7): 16 B plus 12 B per send, at most MAX_BUS_SENDS", () => {
    const { writer, posted } = writerRig();
    const send = (to: number, level: number, flags = 0, frames = 0) => ({ to, flags, level, frames });
    writer.busSends(3, [send(1, 0.5), send(2, 1, BUS_SEND_MUTED, 480), send(4, 1), send(5, 1), send(6, 1)]);
    writer.flush(0);
    const { view, records: recs } = records(posted[0]!);
    expect(recs.map((r) => [r.op, r.bytes])).toEqual([[Op.BUS_SENDS, 16 + 4 * 12]]);
    const rec = readBusSends(view, recs[0]!.off);
    expect(rec.voiceId).toBe(3);
    expect(rec.sends.map((x) => [x.to, x.flags, x.level, x.frames])).toEqual([[1, 0, 0.5, 0], [2, BUS_SEND_MUTED, 1, 480], [4, 0, 1, 0], [5, 0, 1, 0]]);
  });

  it("busDuck: replace-all, asap, 16 B plus 24 B per rule; more than MAX_DUCK_RULES is a WireError OVERSIZE and nothing is staged", () => {
    const { writer, posted } = writerRig();
    const rule = (target: number): BusDuckRules => ({ target, trigger: 1, flags: 1, thresholdDb: -30, amount: -12, attack: 0.0625, release: 0.5 });
    writer.busDuck([rule(2), rule(3)]);
    writer.busDuck([]);
    writer.flush(0);
    const { view, records: recs } = records(posted[0]!);
    expect(recs.map((r) => [r.op, r.bytes, r.frameOffset])).toEqual([[Op.BUS_DUCK, 64, ASAP], [Op.BUS_DUCK, 16, ASAP]]);
    expect(readBusDuck(view, recs[0]!.off).rules).toEqual([rule(2), rule(3)]);
    expect(readBusDuck(view, recs[1]!.off).rules).toEqual([]);
    const over = Array.from({ length: MAX_DUCK_RULES + 1 }, (_, i) => rule(i));
    expect(() => writer.busDuck(over)).toThrow(WireError);
    try {
      writer.busDuck(over);
    } catch (e) {
      expect((e as WireError).code).toBe(ErrorCode.OVERSIZE);
    }
    expect(writer.pending).toBe(0);
    writer.busDuck(Array.from({ length: MAX_DUCK_RULES }, (_, i) => rule(i)));
    expect(writer.pending).toBe(1);
  });

  it("busPresence: the slot mask, stamped at the voice's frame or asap", () => {
    const { writer, posted } = writerRig();
    writer.busPresence(0b1011, 2000);
    writer.busPresence(0x8000_0001);
    writer.flush(1000);
    const { view, records: recs } = records(posted[0]!);
    expect(recs.map((r) => [r.op, r.bytes])).toEqual([[Op.BUS_PRESENCE, 16], [Op.BUS_PRESENCE, 16]]);
    // The asap record sorts first; the stamped one carries its offset from the batch's first stamp (2000).
    expect(recs.map((r) => r.frameOffset)).toEqual([ASAP, 0]);
    expect(readBusPresence(view, recs[0]!.off).mask).toBe(0x8000_0001);
    expect(readBusPresence(view, recs[1]!.off).mask).toBe(0b1011);
  });

  it("loudConfig: the true-peak gate and the metered slots (at most MAX_LOUDNESS_BUSES), asap; more is a WireError OVERSIZE", () => {
    const { writer, posted } = writerRig();
    writer.loudConfig(-7, [2, 5, 7]);
    writer.loudConfig(-9, []);
    writer.loudConfig(-1, Uint16Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    writer.flush(0);
    const { view, records: recs } = records(posted[0]!);
    expect(recs.map((r) => [r.op, r.bytes, r.frameOffset])).toEqual([[Op.LOUD_CONFIG, 32, ASAP], [Op.LOUD_CONFIG, 20, ASAP], [Op.LOUD_CONFIG, 52, ASAP]]);
    const a = readLoudConfig(view, recs[0]!.off);
    expect(a.tpGateDbfs).toBeCloseTo(-7);
    expect(a.meters.map((m) => m.slot)).toEqual([2, 5, 7]);
    expect(readLoudConfig(view, recs[1]!.off).meters).toEqual([]);
    expect(readLoudConfig(view, recs[2]!.off).meters.map((m) => m.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => writer.loudConfig(0, new Array(MAX_LOUDNESS_BUSES + 1).fill(1))).toThrow(WireError);
  });
});

// --- STATUS (the reader itself, every field and section: statusBlock.test.ts, ADR 0177) --------------------------------------------------------------------------------------------------------

const encode = (fields: Partial<StatusBlock>): ArrayBuffer => {
  const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
  writeStatus(new DataView(buffer), 0, makeStatusBlock(fields), 1);
  return buffer;
};


const m5Header = () => ({
  busyMsTotal: 1234.5,
  quantaTotal: 98765,
  wuVoices: 11.25,
  wuBuses: 22.5,
  wuSpatial: 33.75,
  wuMusic: 44,
  wuLoudness: 55.5,
  clockStepMs: 4,
  loudSubBlockFrames: 4800,
  clockSteps: 3,
  loudShed: 1,
  busRecordsEarly: 17,
  sidechainLate: 19,
  genStarved: 0,
  reserved2: 0,
});

/** `n` loud meters whose new-block counts are `counts`, with the energies bus-major, and `d` ducked buses. */
const sections = (counts: number[], d: number): Partial<StatusBlock> => {
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    loudBuses: counts.map((c, i) => ({ slot: i === counts.length - 1 ? LOUD_OUTPUT_TAP : i + 1, flags: c | (i === 0 ? LOUD_FLAG_PAUSED : 0), firstSeq: 100 + i, truePeak: 0.5 + i / 16, gatedQuanta: 7 * i })),
    loudEnergies: Array.from({ length: total }, (_, i) => (i + 1) / 64),
    busDuck: Array.from({ length: d }, (_, i) => ({ slot: i + 2, pad: 0, gain: 0.25 + i / 64 })),
  };
};

// --- the mirror ---------------------------------------------------------------------------------------------------------

describe("StatusMirror, the M5 fields", () => {
  it("copies the header values and the loud and duck sections of the newest block into preallocated arrays", () => {
    const mirror = new StatusMirror(new VoiceTable(8));
    const reader = new StatusReader();
    mirror.apply(reader.read(encode({ ...m5Header(), ...sections([3, 0, 2], 2) })));
    expect(mirror.header).toMatchObject(m5Header());
    expect(mirror).toMatchObject({ loudBusCount: 3, loudEnergyCount: 5, duckCount: 2 });
    expect(Array.from(mirror.loudSlot.subarray(0, 3))).toEqual([1, 2, LOUD_OUTPUT_TAP]);
    expect(Array.from(mirror.loudFlags.subarray(0, 3))).toEqual([3 | LOUD_FLAG_PAUSED, 0, 2]);
    expect(Array.from(mirror.loudFirstSeq.subarray(0, 3))).toEqual([100, 101, 102]);
    expect(mirror.loudTruePeak[1]).toBeCloseTo(0.5625);
    expect(Array.from(mirror.loudGatedQuanta.subarray(0, 3))).toEqual([0, 7, 14]);
    expect(Array.from(mirror.loudEnergies.subarray(0, 5))).toEqual([1, 2, 3, 4, 5].map((n) => n / 64));
    expect(Array.from(mirror.duckSlot.subarray(0, 2))).toEqual([2, 3]);
    expect(mirror.duckGain[0]).toBeCloseTo(0.25);
    mirror.apply(reader.read(encode({})));
    expect([mirror.loudBusCount, mirror.loudEnergyCount, mirror.duckCount]).toEqual([0, 0, 0]);
    expect(mirror.header.busyMsTotal).toBe(0);
  });
});

// --- the replay ---------------------------------------------------------------------------------------------------------

describe("Replayer, the header order without BUS_MIX", () => {
  it("RESET, BUS_CONFIG, then every lane of each bus (Mx2's lane writer, frames 0 when settled), then MASTER; no BUS_MIX (0x11)", () => {
    const table = new VoiceTable(4);
    const clips = { info: () => null, onResident: () => {} };
    const clockMap = { framesNow: () => 1000, lookaheadFrames: () => 0, sampleRate: 1000, timeOffset: 0, carryPending: false, reset() {} };
    const mixer = new Mixer({
      ...defaultAudioSettings(),
      buses: [
        { name: "Master", volume: 0.5, mute: false, effects: [] },
        { name: "Music", parent: "Master", volume: 0.25, mute: false, effects: [] },
      ],
      snapshots: [{ name: "Dull", volumes: {}, lowpass: { Music: 800 } }],
    });
    mixer.snapshot("Dull", 0);
    const lanes = new LaneWriter({
      mixer,
      writer: { busRampFrames: () => {} },
      clockMap: { rampFrames: () => 5, framesNow: () => 1000, lookaheadFrames: () => 0, sampleRate: 1000, frameOfTime: () => 0, stampFor: () => undefined },
      busIndexByName: new Map([["Master", 0], ["Music", 1]]),
      busGain: new Float32Array(32),
      refreshSharedLowpass: () => {},
    });
    const posted: ArrayBuffer[] = [];
    // ADR 0178: the header is the session's replayHeader phase; the parts this test has join it (the replayer adds RESET).
    const session = new CoreSession(() => "running");
    session.join("buses", { replayHeader: (b) => replayBusConfig(b, [{ parent: BUS_ROOT, effects: [] }, { parent: 0, effects: [] }]) });
    session.join("lanes", { replayHeader: (b) => lanes.replayLanes(b) });
    session.join("master", { replayHeader: (b) => replayMaster(b, 0.75, false) });
    const src = {
      table,
      clips,
      clockMap,
      mirror: { frameAudio: 1000 },
      writer: { clear() {} },
      playheads: new PlayheadTracker(table, clips as never, 1000),
      session,
    } as unknown as ReplaySource;
    const replayer = new Replayer(src, { post: (b) => posted.push(b), nextSeq: () => 1 });
    replayer.begin();
    replayer.restore();
    const view = new DataView(posted[0]!);
    expect(view.getUint16(6, true)).toBe(Kind.REPLAY);
    const ops: number[] = [];
    const ramps: ReturnType<typeof readBusRamp>[] = [];
    let off = 32;
    while (off < view.byteLength) {
      const op = view.getUint16(off, true);
      if (op === Op.BUS_RAMP) ramps.push(readBusRamp(view, off));
      ops.push(op);
      off += view.getUint16(off + 2, true) * 4;
    }
    expect(ops).toEqual([Op.RESET, Op.BUS_CONFIG, ...Array.from({ length: 10 }, () => Op.BUS_RAMP), Op.MASTER]);
    expect(ops).not.toContain(0x11);
    expect(ramps.map((r) => [r.voiceId, r.lane, r.frames, r.frameOffset, r.shape])).toEqual(
      [0, 1].flatMap((b) => [0, 1, 2, 3, 4].map((lane) => [b, lane, 0, ASAP, 0])),
    );
    expect([ramps[0]!.gain, ramps[5]!.gain]).toEqual([0.5, 0.25]); // the authored lanes
    expect([ramps[2]!.lpHz, ramps[7]!.lpHz]).toEqual([BUS_LP_OFF_HZ, 800]); // the snapshot lanes
    expect(ramps[7]!.mask).toBe(BUS_RAMP_MASK_GAIN | BUS_RAMP_MASK_LP_HZ);
  });
});
