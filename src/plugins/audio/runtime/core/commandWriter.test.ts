// A1.4 (lead): the command writer (api-and-models §4.2).
import { describe, expect, it } from "vitest";
import {
  ASAP,
  BATCH_MAX_BYTES,
  Kind,
  Op,
  PLAY_FLAGS_MIXED,
  readBatchHeader,
  readEnvelope,
  readFade,
  readPlay,
  readAutomate,
  readBusAutomate,
  readCurves,
  readParam,
  readRecordHead,
  readSetLoop,
  readStop,
  SET_LOOP_FLAGS_LOOPING,
  type Play,
} from "../wire.generated";
import { createBatchPool, type BufferPool } from "./bufferPool";
import {
  AUTOMATION_GLOBAL,
  AUTOMATION_TARGET,
  CORE_BINDINGS,
  CORE_CURVE_KEYS,
  CORE_CURVES,
  CommandWriter,
  STAGING_BYTES,
  type AutomationBinding,
  type BatchPort,
  type PlayArgs,
} from "./commandWriter";
import { VoiceState, VoiceTable } from "./voiceTable";

function rig(sampleRate = 48_000) {
  const pool: BufferPool = createBatchPool();
  const posted: ArrayBuffer[] = [];
  let seq = 100;
  const port: BatchPort = {
    batchPool: pool,
    nextSeq: () => seq++,
    post: (b) => posted.push(b),
  };
  return { writer: new CommandWriter(port, sampleRate), pool, posted };
}

const play = (voiceId: number): PlayArgs => ({ voiceId, clip: 7, bus: 1, flags: PLAY_FLAGS_MIXED, group: 0, gain: 0.5, pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 24000, score: 1, startOffsetFrames: 0 });

/** The records of one posted batch, in order. */
function records(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const env = readEnvelope(view, 0);
  const header = readBatchHeader(view, 0);
  const out: { op: number; voiceId: number; frameOffset: number; off: number }[] = [];
  let off = 32;
  for (let i = 0; i < header.count; i++) {
    const head = readRecordHead(view, off);
    out.push({ op: head.opcode, voiceId: head.voiceId, frameOffset: head.frameOffset, off });
    off += head.words * 4;
  }
  expect(off).toBe(16 + env.bodyBytes);
  return { env, header, records: out, view };
}

describe("CommandWriter (§4.2)", () => {
  it("records round-trip through the generated readers, asap records keep the 0xFFFFFFFF sentinel", () => {
    const { writer, posted } = rig();
    writer.play(play(5));
    writer.stop(5, 0.5);
    writer.fade(5, 0.25, 1);
    expect(writer.flush(1000)).toBe(1);
    const b = records(posted[0]!);
    expect(b.env.kind).toBe(Kind.BATCH);
    expect(b.header.count).toBe(3);
    expect(b.header.firstFrame).toBe(1000);
    expect(b.records.map((r) => r.op)).toEqual([Op.PLAY, Op.STOP, Op.FADE]);
    expect(b.records.every((r) => r.frameOffset === ASAP)).toBe(true);
    const p: Play = readPlay(b.view, b.records[0]!.off);
    expect(p).toMatchObject({ voiceId: 5, clip: 7, bus: 1, gain: 0.5, pitch: 1, dirZ: -1, lpHz: 24000 });
    expect(readStop(b.view, b.records[1]!.off).fadeFrames).toBe(24_000);
    const f = readFade(b.view, b.records[2]!.off);
    expect(f.target).toBeCloseTo(0.25);
    expect(f.frames).toBe(48_000);
  });

  it("a stamped record's frameOffset is its frame minus firstFrame; the header's firstFrame is the earliest stamp", () => {
    const { writer, posted } = rig();
    writer.play(play(1), 5_000);
    writer.play(play(2), 4_000);
    writer.flush(10_000);
    const b = records(posted[0]!);
    expect(b.header.firstFrame).toBe(4_000);
    expect(b.records.map((r) => [r.voiceId, r.frameOffset])).toEqual([
      [2, 0],
      [1, 1_000],
    ]);
  });

  it("the header's firstFrame is the earliest stamp even when it is later than the estimate", () => {
    const { writer, posted } = rig();
    writer.play(play(1), 12_000);
    writer.play(play(2));
    writer.flush(10_000);
    const b = records(posted[0]!);
    expect(b.header.firstFrame).toBe(12_000);
    // Asap first (stable), then the stamp.
    expect(b.records.map((r) => [r.voiceId, r.frameOffset])).toEqual([
      [2, ASAP],
      [1, 0],
    ]);
  });

  it("records are stable-sorted by frame", () => {
    const { writer, posted } = rig();
    for (const [id, at] of [
      [1, 300],
      [2, 100],
      [3, 100],
      [4, 200],
    ] as const)
      writer.play(play(id), at);
    writer.flush(1_000);
    expect(records(posted[0]!).records.map((r) => r.voiceId)).toEqual([2, 3, 4, 1]);
  });

  it("a full batch carries the excess into the next batch with absolute frames preserved", () => {
    const { writer, posted, pool } = rig();
    const per = Math.floor((BATCH_MAX_BYTES - 32) / 56);
    const n = per + 10;
    for (let i = 0; i < n; i++) writer.play(play(i + 1), 50_000 + i);
    expect(writer.flush(0)).toBe(2);
    const a = records(posted[0]!);
    const b = records(posted[1]!);
    expect(a.records).toHaveLength(per);
    expect(b.records).toHaveLength(10);
    expect(a.header.firstFrame).toBe(50_000);
    expect(b.header.firstFrame).toBe(50_000 + per);
    expect(b.records[0]!.frameOffset).toBe(0);
    expect(b.records.map((r) => r.voiceId)).toEqual(Array.from({ length: 10 }, (_, i) => per + i + 1));
    expect(writer.stats.carried).toBeGreaterThan(0);
    expect(pool.available).toBe(2);
  });

  it("a batch never exceeds 64 KB", () => {
    const { writer, posted } = rig();
    for (let i = 0; i < 2_000; i++) writer.play(play(i + 1));
    writer.flush(0);
    expect(posted.length).toBeGreaterThan(1);
    for (const b of posted) expect(b.byteLength).toBeLessThanOrEqual(BATCH_MAX_BYTES);
  });

  it("an empty pool posts nothing and keeps everything staged", () => {
    const { writer, posted, pool } = rig();
    const held: ArrayBuffer[] = [];
    for (let b = pool.acquire(); b; b = pool.acquire()) held.push(b);
    writer.play(play(1));
    writer.play(play(2), 9_000);
    expect(writer.flush(100)).toBe(0);
    expect(writer.pending).toBe(2);
    expect(writer.stats.poolEmpty).toBe(1);
    pool.release(held[0]!);
    expect(writer.flush(200)).toBe(1);
    expect(writer.pending).toBe(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.voiceId)).toEqual([1, 2]);
    expect(b.header.firstFrame).toBe(9_000);
    expect(b.records[1]!.frameOffset).toBe(0);
  });

  it("pool exhaustion mid-flush leaves the unsent records staged in order with their frames", () => {
    const { writer, posted, pool } = rig();
    const per = Math.floor((BATCH_MAX_BYTES - 32) / 56);
    const held: ArrayBuffer[] = [];
    for (let i = 0; i < 3; i++) held.push(pool.acquire()!); // one buffer left
    for (let i = 0; i < per + 3; i++) writer.play(play(i + 1), 1_000 + i);
    expect(writer.flush(0)).toBe(1);
    expect(writer.pending).toBe(3);
    pool.release(held[0]!);
    expect(writer.flush(0)).toBe(1);
    const b = records(posted[1]!);
    expect(b.records.map((r) => r.voiceId)).toEqual([per + 1, per + 2, per + 3]);
    expect(b.header.firstFrame).toBe(1_000 + per);
  });

  it("a full staging area drops the newest and the next batch carries the overflow flag", () => {
    const { writer, posted } = rig();
    const fit = Math.floor(STAGING_BYTES / 56);
    for (let i = 0; i < fit + 5; i++) writer.play(play(i + 1));
    expect(writer.stats.dropped).toBe(5);
    expect(writer.pending).toBe(fit);
    writer.flush(0);
    const first = posted[0]!;
    expect(readBatchHeader(new DataView(first), 0).flags & 1).toBe(1);
    expect(readBatchHeader(new DataView(posted[1]!), 0).flags & 1).toBe(0);
  });

  it("drainCommands writes STOP and FADE with seconds converted to frames", () => {
    const { writer, posted } = rig(44_100);
    const table = new VoiceTable(4);
    const id = table.allocate(0, 1, 0, VoiceState.PLAYING);
    table.requestFade(id, 0.5, 2);
    table.requestStop(id, 0.1);
    table.drainCommands(writer);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.op)).toEqual([Op.FADE, Op.STOP]);
    expect(readFade(b.view, b.records[0]!.off).frames).toBe(88_200);
    expect(readStop(b.view, b.records[1]!.off).fadeFrames).toBe(4_410);
    expect(b.records[0]!.voiceId).toBe(id);
  });

  it("envelope seq comes from the port and bodyBytes matches", () => {
    const { writer, posted } = rig();
    writer.reset(false);
    writer.master(0.5, true, 100);
    writer.flush(0);
    writer.setPaused(1, true);
    writer.flush(0);
    expect(readEnvelope(new DataView(posted[0]!), 0).seq).toBe(100);
    expect(readEnvelope(new DataView(posted[1]!), 0).seq).toBe(101);
    expect(records(posted[0]!).records.map((r) => r.op)).toEqual([Op.RESET, Op.MASTER]);
  });

  it("steady-state flushes recycle the pool and don't grow anything", () => {
    const { writer, posted, pool } = rig();
    for (let round = 0; round < 50; round++) {
      writer.play(play(round + 1));
      writer.flush(round);
      pool.release(posted[round]!);
    }
    expect(pool.available).toBe(4);
    expect(writer.stats.batches).toBe(50);
    expect(writer.pending).toBe(0);
  });
});

describe("CommandWriter automation records (ADR 0158 E2)", () => {
  it("setLoop writes a stamped SET_LOOP; a release clears the looping bit", () => {
    const { writer, posted } = rig();
    writer.play(play(5), 2000);
    writer.setLoop(5, 2000, 4800, 9600, true);
    writer.setLoop(5, 2100, 0, 0, false);
    writer.flush(1000);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.op)).toEqual([Op.PLAY, Op.SET_LOOP, Op.SET_LOOP]);
    expect(b.header.firstFrame).toBe(2000);
    const loop = readSetLoop(b.view, b.records[1]!.off);
    expect(loop).toMatchObject({ voiceId: 5, frameOffset: 0, loopStartFrame: 4800, loopEndFrame: 9600, flags: SET_LOOP_FLAGS_LOOPING });
    expect(readSetLoop(b.view, b.records[2]!.off)).toMatchObject({ frameOffset: 100, flags: 0 });
  });

  it("automate stays after its stamped PLAY and keeps at most 8 bindings; an empty list clears", () => {
    const { writer, posted } = rig();
    const binding: AutomationBinding = { param: AUTOMATION_GLOBAL | 3, curve: 7, target: AUTOMATION_TARGET.lowpass };
    writer.play(play(9), 500);
    writer.automate(9, 500, [binding, { param: 1, curve: 8, target: AUTOMATION_TARGET.volume }]);
    writer.automate(9, 500, Array.from({ length: 12 }, () => binding));
    writer.automate(9, undefined, []);
    writer.flush(400);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.op)).toEqual([Op.AUTOMATE, Op.PLAY, Op.AUTOMATE, Op.AUTOMATE]);
    expect(readAutomate(b.view, b.records[0]!.off).bindings).toEqual([]);
    const a = readAutomate(b.view, b.records[2]!.off);
    expect(a.voiceId).toBe(9);
    expect(a.bindings).toEqual([binding, { param: 1, curve: 8, target: 0 }]);
    expect(readAutomate(b.view, b.records[3]!.off).bindings).toHaveLength(CORE_BINDINGS);
  });

  it("param writes PARAM asap; a bad seek jumps", () => {
    const { writer, posted } = rig();
    writer.param(3, 1, 0.5, 2);
    writer.param(0, 63, 1, Number.NaN);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(readParam(b.view, b.records[0]!.off)).toEqual({ voiceId: 0, frameOffset: ASAP, group: 3, slot: 1, value: 0.5, seekPerSecond: 2 });
    expect(readParam(b.view, b.records[1]!.off)).toMatchObject({ group: 0, slot: 63, value: 1, seekPerSecond: 0 });
  });

  it("curves writes the engine's curves with their interp codes, split into records that fit a batch", () => {
    const { writer, posted } = rig();
    writer.curves(10, [
      [[0, 0], [1, 1, "smooth"]],
      [[0.5, 0.25, "step"], [2, 3, "easeOut"], [3, 3, "easeIn"]],
      [],
    ]);
    writer.flush(0);
    const b = records(posted[0]!);
    const c = readCurves(b.view, b.records[0]!.off);
    expect(c.firstCurve).toBe(10);
    expect(c.curves.map((x) => x.keys.map((k) => [k.x, k.y, k.interp]))).toEqual([
      [[0, 0, 0], [1, 1, 2]],
      [[0.5, 0.25, 1], [2, 3, 4], [3, 3, 3]],
      [],
    ]);
    // 512 curves of 40 keys (≈ 200 KB): 32 keys each are sent, over several records with consecutive ids.
    const big = rig();
    const long = Array.from({ length: 40 }, (_, i) => [i, i] as const);
    big.writer.curves(0, Array.from({ length: CORE_CURVES / 2 }, () => long));
    big.writer.flush(0);
    let next = 0;
    for (const buffer of big.posted) {
      const r = records(buffer);
      for (const rec of r.records) {
        const cc = readCurves(r.view, rec.off);
        expect(cc.firstCurve).toBe(next);
        expect(cc.curves.every((x) => x.keys.length === CORE_CURVE_KEYS)).toBe(true);
        next += cc.curves.length;
      }
    }
    expect(next).toBe(CORE_CURVES / 2);
    expect(big.writer.pending).toBe(0);
    expect(big.writer.stats.dropped).toBe(0);
  });

  it("busAutomate writes BUS_AUTOMATE for the bus index", () => {
    const { writer, posted } = rig();
    writer.busAutomate(2, [{ param: AUTOMATION_GLOBAL, curve: 4, target: AUTOMATION_TARGET.lowpass }]);
    writer.flush(0);
    const b = records(posted[0]!);
    const r = readBusAutomate(b.view, b.records[0]!.off);
    expect(r).toEqual({ voiceId: 2, frameOffset: ASAP, bindings: [{ param: 0x8000, curve: 4, target: 2 }] });
  });
});
