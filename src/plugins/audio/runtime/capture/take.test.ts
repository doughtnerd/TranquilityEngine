// ADR 0348: a take file. The recorder's request records and the ring's profile records merge by seq into one file in
// the capture framing; the take reader reads the requests and the capture reader reads the profile unchanged (passing
// over the requests). Refusals: a cut file, another format, an unknown required record, a malformed request, a take
// without its META section, a capture opened as a take. The recorder: ids, emitters, poses at 30 Hz changes only,
// keyframes each second, the cap stops it with a message rather than dropping requests.
import { describe, expect, it } from "vitest";
import {
  CAPTURE_FLAG_TAKE, CAPTURE_FORMAT_MINOR, CAPTURE_HEADER_BYTES, CAPTURE_MAX_UNCOMPRESSED_BYTES, CAPTURE_RECORD_HEAD_BYTES, CaptureError, RecordType,
  TAKE_MAX_UNCOMPRESSED_BYTES, assembleCapture, encodeRecords, readCaptureHeader, recordPayloadBytes, type CaptureMetaInit, type CaptureRecordInit, type IndexEntry,
} from "./format";
import { decodeRecordAt, openCapture } from "./reader";
import { assembleTakeFile, captureFileBytes, mergeRequests, type SaveTake } from "./save";
import { openTakeFile } from "./takeFile";
import { createCaptureWorkerHandler, type CaptureResponse } from "./worker";
import { TakeRecorder, type TakeRecorderRing } from "./takeRecorder";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, keyframeBytesPlaceholder, statusBytes } from "./testSupport";
import { TakeRecordType, encodeTakeRecordBytes } from "../../../../engine/audio/take/records";
import type { RingSpan } from "./ring";

/** A ring stand-in: one seq counter shared with the profile records the test writes, a clock, and a frame "now". */
class FakeRing implements TakeRecorderRing {
  seq = 1;
  frame = 768;
  epoch = 0;
  live = true;
  marks: string[] = [];
  constructor(readonly ringBytes = 1024 * 1024) {}
  stamp() {
    return this.live ? { seq: this.seq++, epoch: this.epoch, frame: this.frame } : null;
  }
  marker(text: string): void {
    this.marks.push(text);
  }
}

/** The profile records the ring would hold, taking seqs from the same counter (EPOCH, KEYFRAME, STATUS ...). */
function profile(ring: FakeRing, frames: number[], epoch = true): CaptureRecordInit[] {
  const out: CaptureRecordInit[] = [];
  if (epoch) out.push({ type: RecordType.EPOCH, epoch: 0, seq: ring.seq++, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0, perfMs: 1000 } });
  for (const f of frames) {
    out.push({ type: RecordType.KEYFRAME, epoch: 0, seq: ring.seq++, frame: f, payload: keyframeBytesPlaceholder() });
    out.push({ type: RecordType.STATUS, epoch: 0, seq: ring.seq++, frame: f, payload: statusBytes(f) });
  }
  return out;
}

/** A ring span of `records` (in seq order) with its keyframe entries. */
function spanOf(records: CaptureRecordInit[]): RingSpan {
  const keyframes: IndexEntry[] = [];
  let off = 0;
  for (const r of records) {
    if (r.type === RecordType.KEYFRAME) keyframes.push({ epoch: r.epoch, frame: r.frame, byteOffset: off, seq: r.seq });
    off += CAPTURE_RECORD_HEAD_BYTES + recordPayloadBytes(r);
  }
  return { bytes: encodeRecords(records), recordCount: records.length, keyframes, firstFrame: 0, sampleRate: SAMPLE_RATE, firstSeq: records[0]?.seq ?? 1 };
}

let clock = 0;
const now = () => clock;

/** A recorded take: requests interleaved with profile records by seq, and its stored file. */
function recordTake(): { file: Uint8Array; take: SaveTake; ring: FakeRing } {
  clock = 1000;
  const ring = new FakeRing();
  const early = profile(ring, [768]);
  let random = 0xabc;
  const rec = new TakeRecorder(ring, { now, globals: () => ({ Intensity: 0.25 }), randomState: () => random }); // keyframe at 0
  const inst = { group: 5, playing: true, position: { x: 1, y: 0, z: 2 } };
  const node = {};
  clock = 1500;
  rec.play(inst, "sfx/steps.playlist.json", { key: node, name: "Player", position: () => inst.position }, { volume: 0.5, parameters: { Speed: 1 } });
  const mid = profile(ring, [1536], false);
  clock = 1600;
  rec.parameter("Speed", 2, 5);
  rec.parameter("Intensity", 0.75, null);
  rec.parameter("Other", 1, 99); // an instance from before the take: not recorded
  rec.mix("busFade", "Music", 0.5, 2);
  rec.frame({ posX: 0, posY: 0, posZ: 0, fwdX: 0, fwdY: 0, fwdZ: 1 });
  rec.mark("boss");
  clock = 2700;
  random = 0xdef; // picks were made since
  rec.frame({ posX: 0, posY: 0, posZ: 0, fwdX: 0, fwdY: 0, fwdZ: 1 }); // listener still: no pose; a keyframe (1.7 s)
  rec.stop(inst, 0.25);
  rec.stop({}, 1); // never played in the take: nothing
  const late = profile(ring, [2304], false);
  const { requests, section } = rec.finish({ seed: 42, seeded: true, audioHash: "deadbeef" });
  const take: SaveTake = {
    header: SAMPLE_HEADER, meta: { ...SAMPLE_META, take: section }, span: spanOf([...early, ...mid, ...late]), truncatedFromSeq: 0, requests,
  };
  return { file: assembleTakeFile(take), take, ring };
}

describe("a take file (ADR 0348)", () => {
  it("merges the requests into the profile by seq; the take reader and the capture reader both open it", async () => {
    const { file, take } = recordTake();
    const header = readCaptureHeader(file);
    expect(header.flags & CAPTURE_FLAG_TAKE).toBe(CAPTURE_FLAG_TAKE);
    const { take: t, profile: p } = await openTakeFile(file);
    expect(t.meta).toMatchObject({ seed: 42, audioHash: "deadbeef", emitters: { 0: "Listener", 1: "Player" }, frames: false });
    expect(t.requests.map((q) => q.kind)).toEqual(["play", "param", "param", "mix", "pose", "pose", "mark", "stop"]);
    expect(t.requests[0]).toEqual({ kind: "play", t: 0.5, instance: 5, path: "sfx/steps.playlist.json", emitter: 1, options: { volume: 0.5, parameters: { Speed: 1 } } });
    expect(t.requests[2]).toMatchObject({ kind: "param", instance: null, name: "Intensity", value: 0.75 });
    // The first pose has the listener and the emitter (both new); the second frame moved nothing.
    const pose = t.requests.filter((q) => q.kind === "pose");
    expect(pose.map((q) => q.kind === "pose" && q.emitter)).toEqual([0, 1]);
    expect(t.keyframes.map((k) => k.t)).toEqual([0, 1.7]);
    expect(t.keyframes[0]!.globals).toEqual({ Intensity: 0.25 });
    expect(t.keyframes[1]!.instances).toEqual([{ instance: 5, path: "sfx/steps.playlist.json", started: 0.5, emitter: 1, parameters: { Speed: 2 } }]);
    expect(t.keyframes[1]!.globals).toEqual({ Intensity: 0.75 });
    // Each keyframe carries the pick generator state then, for replay to restart from.
    expect(t.keyframes.map((k) => k.random)).toEqual([0xabc, 0xdef]);
    // The profile: every ring record, in seq order, with the INDEX pointing at the moved keyframes.
    expect(p.take).toBe(true);
    expect(p.index).not.toBeNull();
    expect(p.keyframes.length).toBe(3);
    const types = Array.from({ length: p.records.count }, (_, i) => decodeRecordAt(p, i).type);
    expect(types.filter((x) => x === RecordType.STATUS)).toHaveLength(3);
    expect(p.records.count).toBe(take.span.recordCount + take.requests!.recordCount + 1);
    // The Profiler's open reads it as a capture: the same records, the requests passed over as unknown kinds.
    const asCapture = await openCapture(file);
    expect(asCapture.records.count).toBe(p.records.count);
  });

  it("keeps a plugin's records (0x40..0x7e) in order with the requests; the take reader hands them over and the Profiler's open passes over them", async () => {
    clock = 0;
    const ring = new FakeRing();
    const prof = profile(ring, [768]);
    const rec = new TakeRecorder(ring, { now });
    expect(rec.writeExtension(0x40, new Uint8Array([1, 2, 3]))).toBe(true);
    rec.mark("between");
    expect(rec.writeExtension(0x43, new Uint8Array(0))).toBe(true);
    // Types outside the plugins' range (audio's own, the INDEX) and payloads past a record's cap aren't kept.
    expect(rec.writeExtension(TakeRecordType.PLAY, new Uint8Array(1))).toBe(false);
    expect(rec.writeExtension(0x7f, new Uint8Array(1))).toBe(false);
    expect(rec.writeExtension(0x41, new Uint8Array(300_000))).toBe(false);
    const { requests, section } = rec.finish({ seed: 0, seeded: false, audioHash: "" });
    expect(rec.writeExtension(0x40, new Uint8Array(1))).toBe(false); // finished
    const take: SaveTake = { header: SAMPLE_HEADER, meta: { ...SAMPLE_META, take: section }, span: spanOf(prof), truncatedFromSeq: 0, requests };
    const file = assembleTakeFile(take);
    const seen: number[] = [];
    const { take: t, extensions } = await openTakeFile(file, { onExtensionRecord: (r) => void seen.push(r.type) });
    expect(extensions.map((e) => e.type)).toEqual([0x40, 0x43]);
    expect(seen).toEqual([0x40, 0x43]);
    expect(Array.from(extensions[0]!.payload)).toEqual([1, 2, 3]);
    expect(extensions[0]!.seq).toBeLessThan(extensions[1]!.seq);
    expect(t.requests.map((q) => q.kind)).toEqual(["mark"]);
    // Between the two: the mark's seq (one stream, one order).
    expect(t.requests[0]).toMatchObject({ kind: "mark", text: "between" });
    const asCapture = await openCapture(file);
    expect(asCapture.records.count).toBe(readCaptureHeader(file).recordCount);
  });

  it("the listener's pose is recorded when it moves, at most 30 times a second", () => {
    clock = 0;
    const ring = new FakeRing();
    const rec = new TakeRecorder(ring, { now });
    const poses = () => rec.finish({ seed: 0, seeded: false, audioHash: "" });
    for (let ms = 0; ms <= 1000; ms += 5) {
      clock = ms;
      rec.frame({ posX: ms / 1000, posY: 0, posZ: 0, fwdX: 0, fwdY: 0, fwdZ: 1 });
    }
    const { requests } = poses();
    let n = 0;
    const v = new DataView(requests.bytes.buffer, requests.bytes.byteOffset, requests.bytes.byteLength);
    for (let off = 0; off < requests.bytes.byteLength; off += CAPTURE_RECORD_HEAD_BYTES + v.getUint32(off + 4, true)) if (v.getUint8(off) === TakeRecordType.POSE) n++;
    expect(n).toBeGreaterThanOrEqual(29);
    expect(n).toBeLessThanOrEqual(31);
  });

  it("a one-shot voice without a group takes an id from 2^30; a pre-take instance's requests are left out", async () => {
    clock = 0;
    const ring = new FakeRing();
    const prof = profile(ring, [768]);
    const rec = new TakeRecorder(ring, { now });
    const voice = { playing: true };
    rec.play(voice, "ui/click.wav", null, {});
    rec.release({ group: 3 });
    rec.trigger({ group: 3 }, "Hit");
    const { requests, section } = rec.finish({ seed: 0, seeded: false, audioHash: "" });
    const take: SaveTake = { header: SAMPLE_HEADER, meta: { ...SAMPLE_META, take: section }, span: spanOf(prof), truncatedFromSeq: 0, requests };
    const { take: t } = await openTakeFile(assembleTakeFile(take));
    expect(t.requests).toEqual([{ kind: "play", t: 0, instance: 0x4000_0000, path: "ui/click.wav", emitter: null, options: {} }]);
    expect(t.meta.seeded).toBe(false);
  });

  it("ADR 0386: a handle's pause, resume and fade are recorded as the game asked them; a pre-take instance's are left out", async () => {
    clock = 0;
    const ring = new FakeRing();
    const prof = profile(ring, [768]);
    const rec = new TakeRecorder(ring, { now });
    const inst = { group: 4, playing: true };
    rec.play(inst, "music/theme.playlist.json", null, {});
    clock = 250;
    rec.pause(inst);
    clock = 1250;
    rec.resume(inst);
    rec.fade(inst, 0.5, 2);
    rec.fade(inst, Number.NaN, 1); // ignored by the handle: not played, not recorded
    rec.fade(inst, -3, -1); // clamped as the handle clamps
    rec.pause({ group: 9 }); // from before the take
    const { requests, section } = rec.finish({ seed: 0, seeded: false, audioHash: "" });
    const take: SaveTake = { header: SAMPLE_HEADER, meta: { ...SAMPLE_META, take: section }, span: spanOf(prof), truncatedFromSeq: 0, requests };
    const { take: t } = await openTakeFile(assembleTakeFile(take));
    expect(t.requests.slice(1)).toEqual([
      { kind: "pause", t: 0.25, instance: 4 },
      { kind: "resume", t: 1.25, instance: 4 },
      { kind: "fade", t: 1.25, instance: 4, to: 0.5, seconds: 2 },
      { kind: "fade", t: 1.25, instance: 4, to: 0, seconds: 0 },
    ]);
  });

  it("a take of a newer format minor is refused up front, naming the versions (ADR 0386)", async () => {
    const { file } = recordTake();
    const c = file.slice();
    new DataView(c.buffer).setUint16(84, CAPTURE_FORMAT_MINOR + 1, true);
    await expect(openTakeFile(c)).rejects.toMatchObject({ code: "newerFormat" });
    await expect(openTakeFile(c)).rejects.toThrow(/incompatible version: file is capture format 2\.3, this build reads 2\.0\u20132\.2/);
  });

  it("a group the runtime recycled names a new instance apart: a late stop of the ended one doesn't stop it on replay", async () => {
    clock = 0;
    const ring = new FakeRing();
    const prof = profile(ring, [768]);
    const rec = new TakeRecorder(ring, { now });
    const first = { group: 5, playing: true };
    rec.play(first, "a.playlist.json", null, {});
    first.playing = false; // it ended, and the runtime hands its group to the next instance
    const second = { group: 5, playing: true };
    rec.play(second, "b.playlist.json", null, {});
    rec.stop(first, 0); // a late stop of the ended one
    const { requests, section } = rec.finish({ seed: 0, seeded: false, audioHash: "" });
    const take: SaveTake = { header: SAMPLE_HEADER, meta: { ...SAMPLE_META, take: section }, span: spanOf(prof), truncatedFromSeq: 0, requests };
    const { take: t } = await openTakeFile(assembleTakeFile(take));
    const plays = t.requests.filter((r) => r.kind === "play") as { instance: number; path: string }[];
    const stops = t.requests.filter((r) => r.kind === "stop") as { instance: number }[];
    expect(plays.map((p) => p.instance)).toEqual([5, expect.any(Number)]);
    expect(plays[1]!.instance).not.toBe(5);
    expect(stops.every((s) => s.instance !== plays[1]!.instance)).toBe(true);
  });

  it("stops with a message at the take cap rather than drop a request, and when the ring is gone", () => {
    clock = 0;
    const ring = new FakeRing(0);
    const stops: string[] = [];
    const rec = new TakeRecorder(ring, { now, capBytes: 1024 * 1024 + 400, onStop: (m) => stops.push(m) });
    for (let i = 0; i < 100; i++) rec.mark(`mark ${i}`);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatch(/limit/);
    const kept = rec.bytes;
    rec.mark("after");
    expect(rec.bytes).toBe(kept);
    const ring2 = new FakeRing();
    const stops2: string[] = [];
    const rec2 = new TakeRecorder(ring2, { now, onStop: (m) => stops2.push(m) });
    ring2.live = false;
    rec2.mark("x");
    expect(stops2[0]).toMatch(/released/);
  });

  it("the take cap is the header's for a take, the capture cap otherwise", () => {
    const shell = assembleCapture({ ...SAMPLE_HEADER, take: true }, SAMPLE_META, []);
    const set = (bytes: number, take: boolean) => {
      const c = shell.slice();
      const v = new DataView(c.buffer);
      v.setUint32(68, bytes, true);
      v.setUint16(10, take ? CAPTURE_FLAG_TAKE : 0, true);
      try {
        readCaptureHeader(c);
        return "none";
      } catch (e) {
        return (e as CaptureError).code;
      }
    };
    expect(set(CAPTURE_MAX_UNCOMPRESSED_BYTES + 1, false)).toBe("tooLarge");
    expect(set(CAPTURE_MAX_UNCOMPRESSED_BYTES + 1, true)).not.toBe("tooLarge");
    expect(set(TAKE_MAX_UNCOMPRESSED_BYTES + 1, true)).toBe("tooLarge");
  });

  describe("refuses rather than misreads", () => {
    const code = async (file: Uint8Array): Promise<string> => {
      try {
        await openTakeFile(file);
        return "opened";
      } catch (e) {
        if (e instanceof CaptureError) return e.code;
        throw e;
      }
    };

    it("a file cut at any byte", async () => {
      const { file } = recordTake();
      for (let n = 0; n < file.byteLength; n += 7) expect(await code(file.slice(0, n)), `${n} B`).not.toBe("opened");
    });

    it("another format version", async () => {
      const { file } = recordTake();
      for (const [format, want] of [[1, "olderFormat"], [3, "newerFormat"]] as const) {
        const c = file.slice();
        new DataView(c.buffer).setUint16(8, format, true);
        expect(await code(c)).toBe(want);
      }
    });

    it("an unknown required record, a malformed request, a capture opened as a take, a take without its META section", async () => {
      const ring = new FakeRing();
      const base = profile(ring, [768]);
      const make = (extra: CaptureRecordInit[], meta: CaptureMetaInit = { ...SAMPLE_META, take: { audioHash: "", seed: 0, seeded: true, duration: 1, frames: false, emitters: {} } }, take = true) =>
        assembleCapture({ ...SAMPLE_HEADER, take }, meta, [...base, ...extra], { index: true });
      const mark = encodeTakeRecordBytes({ type: TakeRecordType.MARK, payload: { kind: "mark", t: 0, text: "ok" } });
      expect(await code(make([{ type: TakeRecordType.MARK, epoch: 0, seq: 50, frame: 768, payload: mark }]))).toBe("opened");
      expect(await code(make([{ type: 0x80, epoch: 0, seq: 50, frame: 768, payload: mark }]))).toBe("unknownRequired");
      expect(await code(make([{ type: TakeRecordType.MARK, epoch: 0, seq: 50, frame: 768, payload: mark.subarray(0, 9) }]))).toBe("badLength");
      expect(await code(make([], SAMPLE_META))).toBe("badMeta");
      expect(await code(make([], SAMPLE_META, false))).toBe("badHeader");
    });
  });

  it("mergeRequests keeps every record in seq order and moves the INDEX entries with their keyframes", () => {
    const ring = new FakeRing();
    const a = profile(ring, [768]);
    const req: CaptureRecordInit = { type: TakeRecordType.MARK, epoch: 0, seq: 2, frame: 0, payload: encodeTakeRecordBytes({ type: TakeRecordType.MARK, payload: { kind: "mark", t: 0, text: "m" } }) };
    // Seqs: the EPOCH is 1, the request 2, the keyframe 3: renumber the profile so the request sits between.
    const prof = a.map((r, i) => ({ ...r, seq: i === 0 ? 1 : i + 2 }) as CaptureRecordInit);
    const span = spanOf(prof);
    const merged = mergeRequests(span, { bytes: encodeRecords([req]), recordCount: 1 });
    const v = new DataView(merged.bytes.buffer, merged.bytes.byteOffset, merged.bytes.byteLength);
    const seqs: number[] = [];
    for (let off = 0; off < merged.bytes.byteLength; off += CAPTURE_RECORD_HEAD_BYTES + v.getUint32(off + 4, true)) seqs.push(v.getUint32(off + 8, true));
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(v.getUint8(merged.keyframes[0]!.byteOffset)).toBe(RecordType.KEYFRAME);
  });

  it("captureFileBytes compresses everything after the header", async () => {
    const { take } = recordTake();
    const bytes = await captureFileBytes(take, async (p) => p.slice()); // an identity "compressor" still sets the flag
    expect(readCaptureHeader(bytes).flags & 0x8).toBe(0x8);
    expect(bytes.byteLength).toBe(assembleTakeFile(take).byteLength);
    expect(bytes.subarray(0, 8)).toEqual(assembleTakeFile(take).subarray(0, 8));
    expect(CAPTURE_HEADER_BYTES).toBe(96);
  });

  it("the capture Worker answers a take's pictures (for the Profiler's Picture track); a capture has none", async () => {
    const JPEG = new Uint8Array([0xff, 0xd8, 7, 0xff, 0xd9]);
    clock = 1000;
    const ring = new FakeRing();
    const early = profile(ring, [768]);
    const rec = new TakeRecorder(ring, { now, frames: { encode: async () => JPEG, defer: (fn) => fn() } });
    for (clock = 1000; clock <= 3200; clock += 100) {
      rec.frame(null, { width: 1280, height: 720 });
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    const late = profile(ring, [1536], false);
    const { requests, section } = rec.finish({ seed: 1, seeded: false, audioHash: "" });
    const file = assembleTakeFile({ header: SAMPLE_HEADER, meta: { ...SAMPLE_META, take: section }, span: spanOf([...early, ...late]), truncatedFromSeq: 0, requests });
    const ask = async (bytes: Uint8Array) => {
      const got: CaptureResponse[] = [];
      const w = createCaptureWorkerHandler({ post: (r) => got.push(r), yieldNow: async () => {} });
      await w.handle({ type: "open", id: 1, source: "file", bytes: bytes.slice().buffer as ArrayBuffer });
      expect(got.at(-1)?.type).toBe("opened");
      await w.handle({ type: "frames", id: 2 });
      await w.handle({ type: "frames", id: 3 }); // asked again: the session kept them
      return got.filter((r): r is Extract<CaptureResponse, { type: "frames" }> => r.type === "frames");
    };
    const [first, again] = await ask(file);
    expect(first!.frames.map((f) => [f.t, f.width, f.height])).toEqual([[0, 640, 360], [1, 640, 360], [2, 640, 360]]);
    expect([...first!.frames[0]!.jpeg]).toEqual([...JPEG]);
    expect(again!.frames).toHaveLength(3);
    const capture = assembleCapture(SAMPLE_HEADER, SAMPLE_META, profile(new FakeRing(), [768]));
    expect((await ask(capture))[0]!.frames).toEqual([]);
  });
});
