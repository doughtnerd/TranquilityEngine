// ADR 0171/0172 (Rc5; api-and-models §5.4, §5.5, §7; architecture §3.7): the capture Worker's handler in process. The
// time index, `seek` (keyframe at or before t plus the records to t) and `range` (raw samples, min/max buckets, every
// STATUS column at its offset), progress, cancel (mid-open, by a newer open, by `close`), the live path, and refusals.
// The 10-minute capture's open and seek times are logged (design targets 2 s and 16 ms on a shared container); the
// assertions are on the work done (records visited per seek). KEYFRAME payloads are Rc1b's placeholder bytes, which the
// H3 stub doesn't decode, so `snapshot.keyframe` is null until W5; the base record and `keyframeSeq` are checked.
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeStatusBlock } from "../core/mirror";
import { STATUS_BUFFER_BYTES, readStatus, writeStatus, type StatusBlock } from "../wire.generated";
import { CAPTURE_FLAG_COMPRESSED, CAPTURE_HEADER_BYTES, RecordType, assembleCapture, encodeRecords, readCaptureHeader } from "./format";
import {
  CANCEL_CHECK_RECORDS, CaptureTimeIndex, STATUS_COLUMNS, decodeRecordAt, openCapture, rangeCapture, readStatusColumn, recordSeconds,
  seekCapture, type CaptureContents, type StatusColumn,
} from "./reader";
import { SAMPLE_HEADER, SAMPLE_META, longCapture, longCaptureRecords, longStatusFields, sampleCapture, sampleRecords } from "./testSupport";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "./worker";

function compress(file: Uint8Array): Uint8Array {
  const z = deflateRawSync(file.subarray(CAPTURE_HEADER_BYTES));
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + z.byteLength);
  out.set(file.subarray(0, CAPTURE_HEADER_BYTES));
  out.set(z, CAPTURE_HEADER_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(10, v.getUint16(10, true) | CAPTURE_FLAG_COMPRESSED, true);
  return out;
}

const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

function rig(over: { yieldNow?: () => Promise<void>; now?: () => number } = {}) {
  const out: { r: CaptureResponse; transfer: Transferable[] }[] = [];
  const handler = createCaptureWorkerHandler({ post: (r, transfer) => void out.push({ r, transfer }), ...over });
  const last = (id: number) => out.filter((o) => o.r.id === id && o.r.type !== "progress").at(-1)!;
  return { handler, out, last, send: (req: CaptureRequest) => handler.handle(req) };
}

async function indexed(file: Uint8Array): Promise<{ c: CaptureContents; idx: CaptureTimeIndex }> {
  const c = await openCapture(file);
  const idx = new CaptureTimeIndex();
  idx.extend(c);
  return { c, idx };
}

/** Brute force: the last STATUS at or before `t`. */
function lastStatus(c: CaptureContents, t: number): number {
  let best = -1;
  for (let i = 0; i < c.records.count; i++) if (c.records.type[i] === RecordType.STATUS && recordSeconds(c, i) <= t) best = i;
  return best;
}

const TEN_MINUTES = 600;
let long: Uint8Array | null = null;
const longFile = () => (long ??= longCapture(TEN_MINUTES));

describe("seekCapture and rangeCapture on the sample (every record type, two epochs)", () => {
  it("indexes STATUS and KEYFRAME on the continuous axis with each EPOCH's timeOffset", async () => {
    const { c, idx } = await indexed(sampleCapture());
    expect(idx.statusCount).toBe(3);
    expect(idx.keyframeCount).toBe(2);
    expect(Array.from(idx.statusSeconds.subarray(0, 3))).toEqual([768 / 48_000, 1536 / 48_000, 768 / 44_100 + 3.25]);
    expect(idx.markers).toEqual([{ seq: 6, seconds: 1000 / 48_000, text: "owner joined ✓" }]);
    expect(idx.gaps.map((g) => g.seq)).toEqual([12]);
    expect(idx.startSeconds).toBe(0);
    expect(idx.endSeconds).toBeCloseTo(768 / 44_100 + 3.25, 12);
    expect(c.records.count).toBe(16);
  });

  it("seek: the cursor is the last STATUS at or before t, the base the keyframe before it, the records EVENTs and MIXOPs up to t", async () => {
    const { c, idx } = await indexed(sampleCapture());
    const a = seekCapture(c, idx, 1300 / 48_000);
    expect([a.epoch, a.frame, a.seq, a.keyframeSeq]).toEqual([0, 768, 3, 2]);
    expect(a.status?.currentFrame).toBe(768);
    expect(a.keyframe).toBeNull(); // Rc1b's codec is the H3 stub until W5
    expect(a.records.map((r) => [r.kind, r.seq])).toEqual([["event", 4], ["event", 5], ["mixop", 8], ["event", 9]]);
    const b = seekCapture(c, idx, 99);
    expect([b.epoch, b.frame, b.seq, b.keyframeSeq]).toEqual([1, 768, 15, 14]);
    expect(b.seconds).toBeCloseTo(768 / 44_100 + 3.25, 12); // clamped to the end
    expect(b.records).toEqual([]);
    const before = seekCapture(c, idx, -5);
    expect(before.status).toBeNull();
    expect(before.keyframeSeq).toBe(-1);
    expect(() => seekCapture(c, idx, NaN)).toThrow(/badValue/);
  });

  it("range: one sample per STATUS in [t0, t1], and refuses unknown columns and bad spans", async () => {
    const { c, idx } = await indexed(sampleCapture());
    const r = rangeCapture(c, idx, 0, 10, ["currentFrame", "underruns"]);
    expect(Array.from(r.currentFrame!)).toEqual([768, 1536, 768]);
    expect(Array.from(r.underruns!)).toEqual([0, 0, 0]);
    expect(r.seconds!.length).toBe(3);
    expect(rangeCapture(c, idx, 768 / 48_000, 768 / 48_000, ["currentFrame"]).currentFrame!.length).toBe(1);
    expect(rangeCapture(c, idx, 0.5, 1, ["currentFrame"]).currentFrame!.length).toBe(0);
    expect(() => rangeCapture(c, idx, 0, 1, ["nope"])).toThrow(/unknown range column/);
    expect(() => rangeCapture(c, idx, 1, 0, [])).toThrow(/badValue/);
    expect(() => rangeCapture(c, idx, 0, 1, [], 0)).toThrow(/buckets/);
  });

  it("every STATUS column reads its field at its offset (against writeStatus and readStatus)", () => {
    const fields: Partial<StatusBlock> = {};
    let n = 1;
    for (const col of Object.keys(STATUS_COLUMNS) as StatusColumn[]) {
      const kind = STATUS_COLUMNS[col][1];
      (fields as Record<string, number>)[col] = kind === "f64" ? n + 0.5 : kind === "i32" ? -n : n;
      n++;
    }
    const bytes = new Uint8Array(STATUS_BUFFER_BYTES);
    writeStatus(new DataView(bytes.buffer), 0, makeStatusBlock(fields), 1);
    const parsed = readStatus(bytes);
    const view = new DataView(bytes.buffer);
    for (const col of Object.keys(STATUS_COLUMNS) as StatusColumn[]) {
      expect([col, readStatusColumn(view, 0, col)]).toEqual([col, parsed[col]]);
      expect([col, parsed[col]]).toEqual([col, fields[col]]);
    }
  });
});

describe("the 10-minute capture (Rc5's acceptance: jump under 16 ms, open under 2 s, design targets, logged)", () => {
  it("opens stored and compressed through the Worker handler, logging the times", async () => {
    const file = longFile();
    const h = readCaptureHeader(file);
    const z = compress(file);
    const { send, last, out } = rig();
    let t = performance.now();
    await send({ type: "open", id: 1, source: "file", bytes: buf(file) });
    const storedMs = performance.now() - t;
    const opened = last(1).r;
    expect(opened.type).toBe("opened");
    if (opened.type !== "opened") return;
    expect(opened.summary.recordCount).toBe(h.recordCount);
    expect(opened.summary.keyframeCount).toBe(TEN_MINUTES + 1); // seconds 0..600: the last block ends on 600 s
    expect(opened.summary.markers.map((m) => m.text)).toEqual(Array.from({ length: 11 }, (_, i) => `minute ${i}`));
    expect(opened.summary.endSeconds).toBeGreaterThan(TEN_MINUTES - 0.1);
    const progress = out.filter((o) => o.r.type === "progress" && o.r.id === 1);
    expect(progress.length).toBe(Math.floor(h.recordCount / CANCEL_CHECK_RECORDS));
    t = performance.now();
    await send({ type: "open", id: 2, source: "file", bytes: buf(z) });
    const compressedMs = performance.now() - t;
    expect(last(2).r.type).toBe("opened");
    expect(out.some((o) => o.r.type === "progress" && o.r.id === 2 && o.r.phase === "inflate")).toBe(true);
    console.log(`[Rc5] 10-minute capture: ${h.recordCount} records, ${(file.byteLength / 1048576).toFixed(1)} MiB stored (${(z.byteLength / 1048576).toFixed(2)} MiB compressed); open ${storedMs.toFixed(0)} ms stored, ${compressedMs.toFixed(0)} ms compressed (target 2,000 ms)`);
  });

  it("seeks anywhere visiting at most two seconds of records, matching a brute-force scan; times logged", async () => {
    const { c, idx } = await indexed(longFile());
    // The most records in any one second, by record time: a seek visits one keyframe interval plus 1 s of disorder past t.
    const perSecond = new Map<number, number>();
    for (let i = 0; i < c.records.count; i++) {
      const s = Math.floor(recordSeconds(c, i));
      perSecond.set(s, (perSecond.get(s) ?? 0) + 1);
    }
    const maxPerSecond = Math.max(...perSecond.values());
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const times: number[] = [];
    let maxScanned = 0;
    for (let n = 0; n < 400; n++) {
      const t = rand() * TEN_MINUTES;
      const t0 = performance.now();
      const s = seekCapture(c, idx, t);
      times.push(performance.now() - t0);
      maxScanned = Math.max(maxScanned, s.recordsScanned);
      if (n % 40 === 0) {
        const want = lastStatus(c, t);
        expect(s.seq).toBe(c.records.seq[want]);
        expect(s.status?.currentFrame).toBe(c.records.frame[want]);
        const kf = c.keyframes.filter((i) => recordSeconds(c, i) <= t).at(-1)!;
        expect(s.keyframeSeq).toBe(c.records.seq[kf]);
        const events: number[] = [];
        for (let i = kf + 1; i < c.records.count; i++) if (c.records.type[i] === RecordType.EVENT && recordSeconds(c, i) <= t) events.push(c.records.seq[i]!);
        expect(s.records.map((r) => r.seq)).toEqual(events);
        expect(s.records.every((r) => r.kind === "event" && (r.payload.kind === 1 || r.payload.kind === 2))).toBe(true);
      }
    }
    expect(maxScanned).toBeLessThanOrEqual(2 * maxPerSecond + 2);
    console.log(`[Rc5] slowest seeks by order: ${times.map((ms, i) => [i, ms] as const).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([i, ms]) => `#${i} ${ms.toFixed(2)}`).join(", ")}`);
    times.sort((a, b) => a - b);
    const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]!;
    console.log(`[Rc5] seek on the 10-minute capture: p50 ${q(0.5).toFixed(3)} ms, p95 ${q(0.95).toFixed(3)} ms, max ${q(1).toFixed(3)} ms (target 16 ms); at most ${maxScanned} records visited (${maxPerSecond} in the busiest second)`);
  });

  it("range: raw samples match readStatus; buckets hold each bucket's min and max and count", async () => {
    const { c, idx } = await indexed(longFile());
    const raw = rangeCapture(c, idx, 100, 101, ["loadPermille", "minSlackFrames", "busyMsTotal"]);
    const n = raw.seconds!.length;
    expect(n).toBeGreaterThan(60);
    for (let j = 0; j < n; j++) {
      const k = Math.round((raw.seconds![j]! * 48_000) / 768) - 1;
      const f = longStatusFields(k, 768 * (k + 1));
      expect([raw.loadPermille![j], raw.minSlackFrames![j], raw.busyMsTotal![j]]).toEqual([f.loadPermille, f.minSlackFrames, f.busyMsTotal]);
    }
    const B = 50;
    const r = rangeCapture(c, idx, 0, TEN_MINUTES, ["loadPermille", "underruns"], B);
    expect(r.seconds!.length).toBe(B);
    const width = TEN_MINUTES / B;
    const lo = new Array<number>(B).fill(Infinity);
    const hi = new Array<number>(B).fill(-Infinity);
    const count = new Array<number>(B).fill(0);
    for (let i = 0; i < c.records.count; i++) {
      if (c.records.type[i] !== RecordType.STATUS) continue;
      const t = recordSeconds(c, i);
      if (t > TEN_MINUTES) continue;
      const b = Math.min(B - 1, Math.floor(t / width));
      const s = decodeRecordAt(c, i);
      const v = readStatus(s.payload as Uint8Array).loadPermille;
      lo[b] = Math.min(lo[b]!, v);
      hi[b] = Math.max(hi[b]!, v);
      count[b]!++;
    }
    expect(Array.from(r.count!)).toEqual(count);
    expect(Array.from(r["loadPermille.min"]!)).toEqual(lo);
    expect(Array.from(r["loadPermille.max"]!)).toEqual(hi);
    expect(r["underruns.max"]![B - 1]).toBe(longStatusFields(Math.floor((TEN_MINUTES * 48_000) / 768) - 1, 0).underruns);
    const empty = rangeCapture(c, idx, 0, 0.001, ["underruns"], 4);
    expect(Array.from(empty.count!)).toEqual([0, 0, 0, 0]);
    expect(Number.isNaN(empty["underruns.min"]![0])).toBe(true);
  });
});

describe("the handler: protocol, transfers, cancel, live, refusals", () => {
  it("answers seek and range after open; range transfers every column's buffer", async () => {
    const { send, last } = rig();
    await send({ type: "open", id: 1, source: "file", bytes: buf(sampleCapture()) });
    await send({ type: "seek", id: 2, seconds: 0.033 });
    expect(last(2).r).toMatchObject({ type: "snapshot", snapshot: { seq: 11, keyframeSeq: 2 } });
    await send({ type: "range", id: 3, t0: 0, t1: 10, columns: ["currentFrame", "liveVoices"], buckets: 2 });
    const r = last(3);
    expect(r.r.type).toBe("range");
    if (r.r.type !== "range") return;
    expect(Object.keys(r.r.columns).sort()).toEqual(["count", "currentFrame.max", "currentFrame.min", "liveVoices.max", "liveVoices.min", "seconds"]);
    expect(r.transfer).toHaveLength(6);
    expect(r.transfer).toEqual(Object.values(r.r.columns).map((a) => a.buffer));
    await send({ type: "range", id: 4, t0: 0, t1: 10, columns: ["bogus"] });
    expect(last(4).r).toMatchObject({ type: "error", error: { code: "badValue", offset: -1 } });
    await send({ type: "close", id: 5 });
    expect(last(5).r.type).toBe("closed");
    await send({ type: "seek", id: 6, seconds: 0 });
    expect(last(6).r).toMatchObject({ type: "error", error: { code: "badValue", message: expect.stringContaining("no capture is open") } });
  });

  it("refuses a deflate bomb, a 4 GB declaration and a corrupt record with a CaptureError, opening nothing", async () => {
    const plain = sampleCapture({ index: false });
    const bomb = deflateRawSync(new Uint8Array(32 * 1024 * 1024));
    const bombFile = new Uint8Array(CAPTURE_HEADER_BYTES + bomb.byteLength);
    bombFile.set(compress(plain).subarray(0, CAPTURE_HEADER_BYTES));
    bombFile.set(bomb, CAPTURE_HEADER_BYTES);
    const big = plain.slice();
    new DataView(big.buffer).setUint32(68, 0xffff_ffff, true);
    const recs = sampleRecords();
    recs[4]!.seq = 2;
    const corrupt = assembleCapture(SAMPLE_HEADER, SAMPLE_META, recs);
    const { send, last } = rig();
    await send({ type: "open", id: 1, source: "file", bytes: buf(bombFile) });
    expect(last(1).r).toMatchObject({ type: "error", error: { code: "inflateOverrun", offset: CAPTURE_HEADER_BYTES } });
    await send({ type: "open", id: 2, source: "file", bytes: buf(big) });
    expect(last(2).r).toMatchObject({ type: "error", error: { code: "tooLarge", offset: 68 } });
    await send({ type: "open", id: 3, source: "file", bytes: buf(corrupt) });
    expect(last(3).r).toMatchObject({ type: "error", error: { code: "badSeq" } });
    await send({ type: "seek", id: 4, seconds: 0 });
    expect(last(4).r.type).toBe("error");
  });

  it("cancel mid-open: the open yields between slices, takes the cancel and answers cancelled", async () => {
    let clock = 0;
    let yields = 0;
    const r = rig({ now: () => (clock += 100), yieldNow: async () => { if (++yields === 1) await r.send({ type: "cancel", id: 1 }); } });
    await r.send({ type: "open", id: 1, source: "file", bytes: buf(longFile()) });
    expect(yields).toBe(1);
    expect(r.last(1).r).toEqual({ type: "cancelled", id: 1 });
    await r.send({ type: "seek", id: 2, seconds: 0 });
    expect(r.last(2).r.type).toBe("error");
  });

  it("cancel during the inflate of a compressed file", async () => {
    let clock = 0;
    const r = rig({ now: () => (clock += 100), yieldNow: () => r.send({ type: "cancel", id: 7 }) });
    await r.send({ type: "open", id: 7, source: "file", bytes: buf(compress(longFile())) });
    expect(r.last(7).r).toEqual({ type: "cancelled", id: 7 });
    expect(r.out.filter((o) => o.r.type === "progress").every((o) => o.r.type === "progress" && o.r.phase === "inflate")).toBe(true);
  });

  it("a newer open cancels one still opening; close cancels one too", async () => {
    let clock = 0;
    const r = rig({ now: () => (clock += 100), yieldNow: () => new Promise((res) => setTimeout(res, 0)) });
    const a = r.send({ type: "open", id: 1, source: "file", bytes: buf(longFile()) });
    const b = r.send({ type: "open", id: 2, source: "file", bytes: buf(sampleCapture()) });
    await Promise.all([a, b]);
    expect(r.last(1).r.type).toBe("cancelled");
    expect(r.last(2).r).toMatchObject({ type: "opened", summary: { recordCount: 16 } });
    await r.send({ type: "seek", id: 3, seconds: 0.033 });
    expect(r.last(3).r).toMatchObject({ type: "snapshot", snapshot: { seq: 11 } });
    const c = r.send({ type: "open", id: 4, source: "file", bytes: buf(longFile()) });
    await r.send({ type: "close", id: 5 });
    await c;
    expect(r.last(4).r.type).toBe("cancelled");
    expect(r.last(5).r.type).toBe("closed");
  });

  it("live: a header plus META opens empty; segments append, extend the index and seek; a refused segment ends the view", async () => {
    const { send, last } = rig();
    const recs = longCaptureRecords(3);
    const head = assembleCapture(SAMPLE_HEADER, SAMPLE_META, []);
    await send({ type: "open", id: 1, source: "live", bytes: buf(head) });
    expect(last(1).r).toMatchObject({ type: "opened", summary: { recordCount: 0, statusCount: 0, startSeconds: 0, endSeconds: 0 } });
    await send({ type: "seek", id: 2, seconds: 1 });
    expect(last(2).r).toMatchObject({ type: "snapshot", snapshot: { status: null, keyframeSeq: -1 } });
    const firstKf2 = recs.findIndex((r) => r.type === RecordType.KEYFRAME && r.frame >= 48_000);
    await send({ type: "appendSegment", id: 3, bytes: buf(encodeRecords(recs.slice(0, firstKf2))) });
    expect(last(3).r).toMatchObject({ type: "appended", summary: { keyframeCount: 1, markers: [{ text: "minute 0" }] } });
    await send({ type: "appendSegment", id: 4, bytes: buf(encodeRecords(recs.slice(firstKf2))) });
    const appended = last(4).r;
    expect(appended).toMatchObject({ type: "appended", summary: { recordCount: recs.length, keyframeCount: 3 } });
    await send({ type: "seek", id: 5, seconds: 1.5 });
    const s = last(5).r;
    expect(s.type === "snapshot" && s.snapshot.keyframeSeq).toBe(recs[firstKf2]!.seq);
    await send({ type: "appendSegment", id: 6, bytes: buf(encodeRecords(recs.slice(0, 2))) });
    expect(last(6).r).toMatchObject({ type: "error", error: { code: "badSeq" } });
    await send({ type: "seek", id: 7, seconds: 1 });
    expect(last(7).r.type).toBe("error");
    await send({ type: "open", id: 8, source: "file", bytes: buf(sampleCapture()) });
    await send({ type: "appendSegment", id: 9, bytes: buf(encodeRecords([])) });
    expect(last(9).r).toMatchObject({ type: "error", error: { message: expect.stringContaining("file capture") } });
  });
});
