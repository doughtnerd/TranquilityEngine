// ADR 0171/0172 M5 (Wa2; api-and-models §4.2, §4.3): main's side of the M5 wire. The writers of the new records read back
// with the generated readers; `StatusReader` reads the 256-byte header and the three sections into preallocated arrays
// (identity reuse of the block, its arrays and items shows it allocates nothing per block) and enforces the count-sum rule; the mirror
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
  LOUD_METERS,
  LOUD_OUTPUT_TAP,
  MAX_DUCK_RULES,
  MAX_LOUD_ENERGIES,
  MAX_LOUDNESS_BUSES,
  Op,
  rampSequenceId,
  readBatchHeader,
  readBusDuck,
  readBusPresence,
  readBusRamp,
  readBusSlot,
  readLoudConfig,
  readRecordHead,
  readStatus,
  STATUS_BUFFER_BYTES,
  STATUS_WORST_CASE_BYTES,
  WireError,
  writeStatus,
  type BusDuckRules,
  type StatusBlock,
} from "../wire.generated";
import { createBatchPool } from "./bufferPool";
import { CommandWriter, type BatchPort } from "./commandWriter";
import { LaneWriter } from "./laneWriter";
import { makeStatusBlock, StatusMirror } from "./mirror";
import { PlayheadTracker, Replayer, type ReplaySource } from "./replay";
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

  it("busSlot: 28 B plus 32 B per effect, zero-padded parameters, flags and sequence tag; at most four effects", () => {
    const { writer, posted } = writerRig();
    const fx = (type: number, ...p: number[]) => ({ type, p });
    writer.busSlot({ slot: 4, parent: BUS_ROOT, effects: [fx(0, 1500, 6), fx(3, 0.5)], structural: true, sequenceId: 9 }, 5000);
    writer.busSlot({ slot: 5, parent: 4, effects: [], fresh: true });
    writer.busSlot({ slot: 6, parent: 4, effects: [fx(0), fx(1), fx(2), fx(3), fx(0)] });
    writer.flush(0);
    const { view, records: recs } = records(posted[0]!);
    // The asap records sort first, the stamped one (at 5000) last.
    expect(recs.map((r) => [r.op, r.bytes])).toEqual([[Op.BUS_SLOT, 28], [Op.BUS_SLOT, 28 + 128], [Op.BUS_SLOT, 28 + 64]]);
    const a = readBusSlot(view, recs[2]!.off);
    expect(a).toMatchObject({ slot: 4, parent: BUS_ROOT, flags: BUS_SLOT_FLAGS_STRUCTURAL, sequenceId: 9 });
    expect(a.effects[0]!.p).toEqual([1500, 6, 0, 0, 0, 0, 0]);
    expect(a.effects[1]).toMatchObject({ type: 3, p: [0.5, 0, 0, 0, 0, 0, 0] });
    expect(readBusSlot(view, recs[0]!.off)).toMatchObject({ slot: 5, parent: 4, flags: BUS_SLOT_FLAGS_FRESH, effects: [] });
    expect(readBusSlot(view, recs[1]!.off).effects).toHaveLength(4);
    // A later record never sees the earlier one's parameters.
    const { writer: w2, posted: p2 } = writerRig();
    w2.busSlot({ slot: 1, parent: 0, effects: [fx(0, 9, 9, 9, 9, 9, 9, 9)] });
    w2.busSlot({ slot: 2, parent: 0, effects: [fx(1)] });
    w2.flush(0);
    const r2 = records(p2[0]!);
    expect(readBusSlot(r2.view, r2.records[1]!.off).effects[0]!.p).toEqual([0, 0, 0, 0, 0, 0, 0]);
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

// --- StatusReader --------------------------------------------------------------------------------------------------------

const encode = (fields: Partial<StatusBlock>): ArrayBuffer => {
  const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
  writeStatus(new DataView(buffer), 0, makeStatusBlock(fields), 1);
  return buffer;
};

const codeOf = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    return (e as WireError).code;
  }
  return -999;
};
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
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

describe("StatusReader, ADR 0171 header and sections (Wa2)", () => {
  it("reads every M5 header field at its offset (176..255) and the three sections, equal to the generated readStatus", () => {
    const buffer = encode({ ...m5Header(), ...sections([3, 0, 2], 2), ended: [1], peaks: [{ l: 1, r: 2 }] });
    const view = new DataView(buffer);
    expect(view.getFloat64(176, true)).toBe(1234.5);
    expect(view.getUint16(232, true)).toBe(3);
    expect(view.getUint16(234, true)).toBe(5);
    expect(view.getUint16(236, true)).toBe(2);
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(readStatus(buffer));
    expect(got).toMatchObject(m5Header());
    expect(got.loudBuses).toHaveLength(3);
    expect(got.loudBuses[0]).toMatchObject({ slot: 1, flags: 3 | LOUD_FLAG_PAUSED, firstSeq: 100 });
    expect(got.loudBuses[2]!.slot).toBe(LOUD_OUTPUT_TAP);
    expect(got.loudEnergies).toEqual([1, 2, 3, 4, 5].map((n) => n / 64));
    expect(got.busDuck).toEqual([{ slot: 2, pad: 0, gain: 0.25 }, { slot: 3, pad: 0, gain: 0.25 + 1 / 64 }]);
  });

  it("the worst case (every section at its cap, 17,824 B) parses and equals readStatus; a block with none reads empty sections", () => {
    const ids = Array.from({ length: 1024 }, (_, i) => i + 1);
    const full = encode({
      ...m5Header(),
      ...sections(new Array(LOUD_METERS).fill(MAX_LOUD_ENERGIES / LOUD_METERS), MAX_DUCK_RULES),
      ended: ids,
      demoted: ids,
      starved: ids,
      playheads: Array.from({ length: 256 }, (_, i) => ({ id: i, clipFrame: i })),
      clipEvents: Array.from({ length: 64 }, (_, i) => ({ clipId: i, code: 1 })),
      streamEvents: Array.from({ length: 64 }, (_, i) => ({ id: i, code: 2 })),
      peaks: Array.from({ length: 32 }, (_, i) => ({ l: i, r: -i })),
      beds: Array.from({ length: 4 }, (_, i) => ({ bus: i, voices: i, work: i })),
      zones: Array.from({ length: 4 }, (_, i) => ({ kernelId: i, state: 3, pad: 0, quantaSinceInput: i, wetPeak: 0.5 })),
      zoneEvents: Array.from({ length: 16 }, (_, i) => ({ slot: i % 4, code: 1, reserved: 0 })),
      musicRings: Array.from({ length: 16 }, (_, i) => ({ streamId: i + 1, epochFlags: i })),
      groupStarts: Array.from({ length: 8 }, (_, i) => ({ groupId: i, flags: 1, slipFrames: i, startFrameLo: i, startFrameHi: 0 })),
    });
    expect(STATUS_WORST_CASE_BYTES).toBe(17_824);
    expect(new DataView(full).getUint32(12, true) + 16).toBe(STATUS_WORST_CASE_BYTES);
    const reader = new StatusReader();
    const got = reader.read(full);
    expect(got).toEqual(readStatus(full));
    expect(got.loudBuses).toHaveLength(9);
    expect(got.loudEnergies).toHaveLength(288);
    expect(got.busDuck).toHaveLength(32);
    const empty = reader.read(encode({}));
    expect([empty.loudBuses.length, empty.loudEnergies.length, empty.busDuck.length]).toEqual([0, 0, 0]);
  });

  it("the count sum: the loudBuses new-block counts (flags & 0x3F) must equal loudEnergyCount, else WireError MALFORMED; the other flag bits do not count", () => {
    const reader = new StatusReader();
    const good = encode(sections([2, 3], 0)); // flags carry LOUD_FLAG_PAUSED on the first meter: bit 6 is not a count
    expect(reader.read(good).loudEnergies).toHaveLength(5);
    // The body has room for 64 energies, so only the sum can be wrong.
    const room = encode(sections([32, 32], 0));
    expect(reader.read(room).loudEnergies).toHaveLength(64);
    for (const [counts, energies] of [[[2, 3], 4], [[2, 3], 6], [[0], 1], [[32, 32], 63], [[1, 0], 0]] as const) {
      const bad = room.slice(0);
      const v = new DataView(bad);
      v.setUint16(232, counts.length, true);
      counts.forEach((c, i) => v.setUint16(STATUS_HEADER_BYTES_PLUS + i * 16 + 2, c, true));
      v.setUint16(234, energies, true);
      expect(codeOf(() => reader.read(bad))).toBe(ErrorCode.MALFORMED);
      expect(messageOf(() => reader.read(bad))).toBe("STATUS: loudEnergies count sum");
    }
  });

  it("the caps and overruns fire OVERSIZE with the generated reader's messages: 10 loudBuses, 289 loudEnergies, 33 busDuck, sections past the end", () => {
    const reader = new StatusReader();
    const good = encode(sections([1, 1], 1));
    const withU16 = (offset: number, value: number): ArrayBuffer => {
      const copy = good.slice(0);
      new DataView(copy).setUint16(offset, value, true);
      return copy;
    };
    for (const [bytes, text] of [
      [withU16(232, 10), "STATUS: loudBuses overrun"],
      [withU16(234, 289), "STATUS: loudEnergies overrun"],
      [withU16(236, 33), "STATUS: busDuck overrun"],
    ] as const) {
      expect(codeOf(() => reader.read(bytes))).toBe(ErrorCode.OVERSIZE);
      expect(messageOf(() => reader.read(bytes))).toBe(text);
      expect(codeOf(() => readStatus(bytes))).toBe(ErrorCode.OVERSIZE);
    }
    // Counts within their caps but past the message's end (the body is cut short): the same OVERSIZE.
    const cut = good.slice(0);
    new DataView(cut).setUint32(12, 256 - 16 + 20, true);
    expect(codeOf(() => reader.read(cut))).toBe(ErrorCode.OVERSIZE);
    // A body shorter than the header is TRUNCATED, as before.
    const short = good.slice(0, 200);
    expect(codeOf(() => reader.read(short))).toBe(ErrorCode.TRUNCATED);
  });

  it("a refused M5 message leaves the block as it was", () => {
    const reader = new StatusReader();
    reader.read(encode({ currentFrame: 55, ...m5Header(), ...sections([2], 1) }));
    const bad = encode({ currentFrame: 99, ...sections([2], 0) });
    new DataView(bad).setUint16(234, 3, true);
    expect(() => reader.read(bad)).toThrow(WireError);
    expect(reader.block.currentFrame).toBe(55);
    expect(reader.block.busyMsTotal).toBe(1234.5);
    expect(reader.block.loudEnergies).toHaveLength(2);
    expect(reader.block.busDuck).toHaveLength(1);
  });

  it("allocates nothing per block: the block, every section array and every item are the reader's own and reused across 3,000 worst-case reads", () => {
    const worst = encode({
      ...sections(new Array(LOUD_METERS).fill(MAX_LOUD_ENERGIES / LOUD_METERS), MAX_DUCK_RULES),
      peaks: Array.from({ length: 32 }, (_, i) => ({ l: i, r: -i })),
      playheads: Array.from({ length: 256 }, (_, i) => ({ id: i, clipFrame: i })),
    });
    const small = encode(sections([1], 1));
    const reader = new StatusReader();
    const a = reader.read(worst);
    const buses = a.loudBuses;
    const energies = a.loudEnergies;
    const duck = a.busDuck;
    const item = a.loudBuses[3];
    const duckItem = a.busDuck[3];
    const b = reader.read(small);
    expect(b).toBe(a);
    expect(b.loudBuses).toBe(buses);
    expect(b.loudEnergies).toBe(energies);
    expect(b.busDuck).toBe(duck);
    expect([b.loudBuses.length, b.loudEnergies.length, b.busDuck.length]).toEqual([1, 1, 1]);
    expect(reader.read(worst).loudBuses[3]).toBe(item);
    expect(reader.block.busDuck[3]).toBe(duckItem);
    // Structural, not a heap measure (a heap delta under a parallel suite is noise, the ground rules' wall-clock rule): every
    // item object of every section, captured after a worst-case read, is the same object after 3,000 more reads.
    const owned = (blk: typeof a) => [blk, blk.loudBuses, blk.loudEnergies, blk.busDuck, blk.peaks, blk.playheads, ...blk.loudBuses, ...blk.busDuck, ...blk.peaks, ...blk.playheads];
    const firstRead = owned(reader.read(worst));
    for (let i = 0; i < 3000; i++) reader.read(i % 2 === 0 ? worst : small);
    const lastRead = owned(reader.read(worst));
    expect(lastRead.length).toBe(firstRead.length);
    for (let i = 0; i < firstRead.length; i++) expect(lastRead[i]).toBe(firstRead[i]);
  });
});

/** The first loudBuses item's offset: the sections start after the 256-byte header when no older section has items. */
const STATUS_HEADER_BYTES_PLUS = 256;

// --- the mirror ---------------------------------------------------------------------------------------------------------

describe("StatusMirror, the M5 fields", () => {
  it("copies the header values and the loud and duck sections of the newest block into preallocated arrays", () => {
    const mirror = new StatusMirror(new VoiceTable(8));
    const reader = new StatusReader();
    mirror.apply(reader.read(encode({ ...m5Header(), ...sections([3, 0, 2], 2) })));
    const { reserved2: _reserved2, ...header } = m5Header();
    expect(mirror).toMatchObject({ ...header, loudBusCount: 3, loudEnergyCount: 5, duckCount: 2 });
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
    expect(mirror.busyMsTotal).toBe(0);
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
    const src = {
      table,
      clips,
      clockMap,
      mirror: { frameAudio: 1000 },
      lanes,
      writer: { clear() {} },
      playheads: new PlayheadTracker(table, clips as never, 1000),
      masterVolume: 0.75,
      muted: false,
      host: { sampleRate: 1000 },
      busConfigWire: () => [{ parent: BUS_ROOT, effects: [] }, { parent: 0, effects: [] }],
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
