// ADR 0171 amended by 0172 (M5a, task Rc2): the recorder ring. Sizing (§4.2), the tap's registration and raw copy
// (§3.1), keyframes on rendered frames (R13), EPOCH/GAP/MARKER (§5.4, §3.5), eviction by whole segments with the
// truncation flag (§3.6), WRAP stripped from the hand-offs, and every span Rc1's reader opens.
import { describe, expect, it } from "vitest";
import { CoreLink, type LinkPort } from "../core/context";
import { Kind, type StatusBlock } from "../wire.generated";
import { CAPTURE_RECORD_HEAD_BYTES, EpochReason, GapReason, RecordType, decodeEpoch, decodeGap, decodeKeyframe, type KeyframePayload } from "./format";
import { decodeRecordAt, openLiveCapture, type CaptureContents } from "./reader";
import { Recorder, createRecorder, recorderModule, type EpochContext, type RecorderOptions } from "./recorder";
import { KEYFRAME_INDEX_SLOTS, RING_MIN_BYTES, RING_PRESET_BYTES, RecorderRing, ringBytesFor, type RingPreset } from "./ring";
import { EMPTY_KEYFRAME_PAYLOAD, SAMPLE_RATE, keyframeCodecForTests, liveHead, rc1bReady, statusBytes, statusBytesWithVoices } from "./testSupport";

const MiB = 1024 * 1024;
const BLOCK = 768;
const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };

function recorder(opts: RecorderOptions = {}): Recorder {
  let t = 1000;
  return createRecorder({ ringBytes: 4 * MiB, codec: keyframeCodecForTests(), now: () => (t += 1), ...opts });
}

/** Feeds a real STATUS block at `frame` through the tap the way `CoreLink` does. */
function feed(r: Recorder, frame: number, voices = 0): void {
  const block = voices > 0 ? statusBytesWithVoices(frame, voices) : statusBytes(frame);
  const data = block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength) as ArrayBuffer;
  r.tap(data, block.byteLength, new DataView(data));
}

/** Rc1's reader over records (a live view: the same decoder a file uses). */
function decode(bytes: Uint8Array): CaptureContents {
  const d = openLiveCapture(liveHead());
  d.appendRecords(bytes);
  return d.contents;
}

function types(c: CaptureContents): number[] {
  return Array.from(c.records.type.subarray(0, c.records.count));
}

describe("ringBytesFor (§4.2)", () => {
  const presets: RingPreset[] = ["low", "default", "high", "editor"];
  it("is the preset size without deviceMemory", () => {
    expect(presets.map((p) => ringBytesFor(p))).toEqual([4 * MiB, 16 * MiB, 32 * MiB, 32 * MiB]);
    expect(ringBytesFor("high", Number.NaN)).toBe(32 * MiB);
    expect(ringBytesFor("high", 0)).toBe(32 * MiB);
  });
  it("is min(preset, 8 MiB x deviceMemory), never below 4 MiB, for each value browsers report", () => {
    const table: Record<number, number[]> = {
      0.25: [4, 4, 4, 4], 0.5: [4, 4, 4, 4], 1: [4, 8, 8, 8], 2: [4, 16, 16, 16], 4: [4, 16, 32, 32], 8: [4, 16, 32, 32],
    };
    for (const [dm, sizes] of Object.entries(table)) {
      expect(presets.map((p) => ringBytesFor(p, Number(dm)) / MiB), `deviceMemory ${dm}`).toEqual(sizes);
    }
  });
  it("keeps a 2 GB device at or under 16 MiB (a platform limit)", () => {
    for (const p of presets) expect(ringBytesFor(p, 2)).toBeLessThanOrEqual(16 * MiB);
    expect(RING_MIN_BYTES).toBe(RING_PRESET_BYTES.low);
  });
  it("sizes the recorder's one buffer", () => {
    const r = createRecorder({ preset: "high", deviceMemory: 2, codec: keyframeCodecForTests() });
    expect(r.ring.capacity).toBe(16 * MiB);
    expect(r.ring.bytes.byteLength).toBe(16 * MiB);
    expect(recorderModule).toBe(true);
  });
});

describe("the tap (§3.1)", () => {
  function linkRig() {
    const posted: number[] = [];
    const port: LinkPort = { postMessage: (m) => { if (m instanceof ArrayBuffer) posted.push(new DataView(m).getUint16(6, true)); }, onmessage: null };
    const link = new CoreLink(port);
    link.statusDecoder = () => ({ flags: 0, abiVersion: 0 }) as unknown as StatusBlock;
    return { link, posted };
  }

  it("attach sets the link's recorderTap; the block is copied raw before the RECYCLE rewrites its envelope", () => {
    const { link, posted } = linkRig();
    const r = recorder();
    r.begin(0, CONTEXT);
    r.attach(link);
    expect(link.recorderTap).toBe(r.tap);
    const block = statusBytes(BLOCK);
    const data = block.slice().buffer as ArrayBuffer;
    link.handleMessage(data);
    expect(posted).toEqual([Kind.RECYCLE]);
    const c = decode(r.takeSpan().bytes);
    const i = types(c).indexOf(RecordType.STATUS);
    const seg = c.segments[c.records.segment[i]!]!;
    const copied = seg.subarray(c.records.offset[i]!, c.records.offset[i]! + c.records.len[i]!);
    expect(Array.from(copied)).toEqual(Array.from(block));
    expect(new DataView(copied.buffer, copied.byteOffset).getUint16(6, true)).toBe(Kind.STATUS);
    r.detach();
    expect(link.recorderTap).toBeNull();
  });

  it("detach leaves a tap someone else set alone", () => {
    const { link } = linkRig();
    const r = recorder();
    r.attach(link);
    const other = () => {};
    link.recorderTap = other;
    r.detach();
    expect(link.recorderTap).toBe(other);
  });

  it("copies NaN payloads and odd tails bit for bit (a word copy, no float decode)", () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const block = statusBytes(BLOCK);
    const bytes = new Uint8Array(block.byteLength + 3);
    bytes.set(block);
    const v = new DataView(bytes.buffer);
    v.setUint32(12, block.byteLength - 16 + 3, true);
    v.setUint32(40, 0x7fc01234, true); // a NaN with a payload
    bytes.set([1, 2, 3], block.byteLength);
    r.tap(bytes.buffer as ArrayBuffer, bytes.byteLength);
    const span = r.takeSpan().bytes;
    const at = span.byteLength - bytes.byteLength;
    expect(Array.from(span.subarray(at))).toEqual(Array.from(bytes));
  });

  it("refuses a block shorter than its frame or past statusBytesMax, and does nothing before begin", () => {
    const r = recorder();
    feed(r, BLOCK);
    expect(r.statusCount).toBe(0);
    r.begin(0, CONTEXT);
    r.tap(new ArrayBuffer(16), 16);
    r.tap(new ArrayBuffer(64), 1 << 20);
    expect(r.badStatus).toBe(2);
  });
});

describe("keyframes on rendered frames (R13)", () => {
  it("opens a segment with EPOCH + KEYFRAME at begin, then a KEYFRAME each 1,000 ms of STATUS frames", () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    for (let k = 1; k <= 200; k++) feed(r, k * BLOCK); // 3.2 s
    const c = decode(r.takeSpan().bytes);
    expect(types(c).slice(0, 3)).toEqual([RecordType.EPOCH, RecordType.KEYFRAME, RecordType.STATUS]);
    const keyFrames = c.keyframes.map((i) => c.records.frame[i]!);
    expect(keyFrames).toEqual([0, 48_384, 96_768, 145_152]); // the first block >= 1 s of frames past the last
    for (let k = 1; k < keyFrames.length; k++) expect(keyFrames[k]! - keyFrames[k - 1]!).toBeGreaterThanOrEqual(SAMPLE_RATE);
    expect(r.ring.segments).toBe(4);
  });

  it("keys on frames, not blocks: at the hidden-tab idle cadence a keyframe still lands each second of frames", () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const idle = Math.round(0.128 * SAMPLE_RATE); // 128 ms of frames per block
    for (let k = 1; k <= 40; k++) feed(r, k * idle);
    const c = decode(r.takeSpan().bytes);
    expect(c.keyframes.length).toBe(1 + Math.floor((40 * idle) / (8 * idle)));
  });

  it("requestKeyframe opens a segment at the next STATUS", () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    feed(r, BLOCK);
    r.requestKeyframe();
    feed(r, 2 * BLOCK);
    expect(r.ring.segments).toBe(2);
  });

  it.runIf(rc1bReady())("builds the keyframe from the source through Rc1b's codec, decodable (turns on with Rc1b)", () => {
    const payload: KeyframePayload = { ...EMPTY_KEYFRAME_PAYLOAD, mix: { ...EMPTY_KEYFRAME_PAYLOAD.mix, slotTableVersion: 7, masterVolume: 0.5 } };
    const r = createRecorder({ ringBytes: 4 * MiB, keyframeSource: () => payload });
    r.begin(0, CONTEXT);
    feed(r, BLOCK);
    const c = decode(r.takeSpan().bytes);
    const i = c.keyframes[0]!;
    const seg = c.segments[c.records.segment[i]!]!;
    const kf = decodeKeyframe(new DataView(seg.buffer, seg.byteOffset, seg.byteLength), c.records.offset[i]!, c.records.len[i]!);
    expect(kf.mix.slotTableVersion).toBe(7);
    expect(kf.mix.masterVolume).toBe(0.5);
  });
});

describe("EPOCH, GAP, MARKER (§5.4, §3.5)", () => {
  it("a new core's epoch opens a segment at its frame with EPOCH then KEYFRAME; frames restart without disorder", () => {
    const r = recorder();
    r.begin(96_000, CONTEXT);
    for (let k = 1; k <= 10; k++) feed(r, 96_000 + k * BLOCK);
    r.gap(GapReason.rebuild, 96_000 + 10 * BLOCK, 2000, 2100);
    r.epoch(EpochReason.trap, 0, { ...CONTEXT, sampleRate: 44_100, timeOffset: 2.25 });
    for (let k = 1; k <= 10; k++) feed(r, k * BLOCK);
    const c = decode(r.takeSpan().bytes);
    expect(c.epochs.map((e) => [e.epoch, e.sampleRate, e.payload?.reason])).toEqual([[0, SAMPLE_RATE, EpochReason.start], [1, 44_100, EpochReason.trap]]);
    expect(c.epochs[1]!.payload!.timeOffset).toBe(2.25);
    const gi = types(c).indexOf(RecordType.GAP);
    const gap = decodeRecordAt(c, gi);
    expect(gap.type === RecordType.GAP && gap.payload).toMatchObject({ reason: GapReason.rebuild, perfFrom: 2000, perfTo: 2100 });
    expect(r.ring.segments).toBe(2);
    expect(r.ring.segRate[r.ring.rowOf(1)]).toBe(44_100);
  });

  it("markers are cut to 120 bytes; newTake writes GAP held and starts the take at a fresh keyframe", () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    feed(r, BLOCK);
    r.marker("x".repeat(300), BLOCK);
    r.newTake(2 * BLOCK, 500);
    feed(r, 3 * BLOCK);
    expect(r.takeStart).toBe(1);
    const all = decode(r.ring.copyRecords(0).bytes);
    const mi = types(all).indexOf(RecordType.MARKER);
    const m = decodeRecordAt(all, mi);
    expect(m.type === RecordType.MARKER && m.payload.text.length).toBe(120);
    const g = decodeRecordAt(all, types(all).indexOf(RecordType.GAP));
    expect(g.type === RecordType.GAP && g.payload.reason).toBe(GapReason.held);
    const take = decode(r.takeSpan().bytes);
    expect(types(take)).toEqual([RecordType.KEYFRAME, RecordType.STATUS]);
    expect(r.truncated).toBe(false);
  });

  it("record() reserves Rc3's other records in the current epoch; past the cap or before begin it is refused", () => {
    const r = recorder();
    expect(r.record(0x40, 0, 4)).toBe(-1);
    r.begin(0, CONTEXT);
    const off = r.record(0x40, 10, 4);
    r.ring.view.setUint32(off, 0xdeadbeef, true);
    expect(r.record(0x40, 10, 300_000)).toBe(-1);
    const c = decode(r.takeSpan().bytes);
    expect(types(c)).toEqual([RecordType.EPOCH, RecordType.KEYFRAME, 0x40]);
  });
});

describe("eviction by whole segments (§3.6)", () => {
  /** A small ring that wraps several times: about 3.4 KB per block, ≈ 215 KB per second. */
  function run(seconds: number, ringBytes = 1 * MiB) {
    const r = recorder({ ringBytes });
    const sealed: { bytes: Uint8Array; segment: number; records: number }[] = [];
    r.onSegmentSealed = (bytes, info) => sealed.push({ bytes, segment: info.segment, records: info.records });
    r.begin(0, CONTEXT);
    const blocks = Math.floor((seconds * SAMPLE_RATE) / BLOCK);
    for (let k = 1; k <= blocks; k++) feed(r, k * BLOCK, 400);
    return { r, sealed, blocks };
  }

  it("keeps the tail on a segment start, wraps through WRAP, and the kept ring decodes alone", () => {
    const { r, blocks } = run(30);
    expect(r.ring.evicted).toBeGreaterThan(0);
    expect(r.ring.wrapAt >= 0 || r.ring.evicted > 4).toBe(true);
    const span = r.ring.copyRecords(0);
    const c = decode(span.bytes);
    expect(types(c)[0]).toBe(RecordType.KEYFRAME); // the EPOCH's segment went first
    expect(types(c)).not.toContain(RecordType.WRAP);
    expect(c.records.count).toBe(span.recordCount);
    expect(span.keyframes.length).toBe(c.keyframes.length);
    for (let k = 0; k < c.keyframes.length; k++) {
      const i = c.keyframes[k]!;
      expect(span.keyframes[k]!.byteOffset).toBe(c.records.offset[i]! - CAPTURE_RECORD_HEAD_BYTES);
      expect(span.keyframes[k]!.seq).toBe(c.records.seq[i]);
    }
    // The newest STATUS is the last block, and the STATUS frames run without a hole.
    const frames: number[] = [];
    for (let i = 0; i < c.records.count; i++) if (c.records.type[i] === RecordType.STATUS) frames.push(c.records.frame[i]!);
    expect(frames[frames.length - 1]).toBe(blocks * BLOCK);
    for (let k = 1; k < frames.length; k++) expect(frames[k]! - frames[k - 1]!).toBe(BLOCK);
    expect(span.firstFrame).toBe(c.records.frame[0]);
    expect(r.ring.usedBytes).toBe(span.bytes.byteLength);
  });

  it("sets truncated once an eviction passes the take's start; truncatedFromSeq is the first kept seq", () => {
    const short = run(2);
    expect(short.r.truncated).toBe(false);
    expect(short.r.truncatedFromSeq).toBe(0);
    const { r } = run(30);
    expect(r.truncated).toBe(true);
    const span = r.takeSpan();
    expect(r.truncatedFromSeq).toBe(span.firstSeq);
    expect(r.debug()).toMatchObject({ truncated: true, capacity: 1 * MiB, segments: r.ring.segments });
  });

  it("hands every sealed segment over WRAP-stripped; appended in order they decode as one live view", () => {
    const { sealed } = run(30);
    expect(sealed.length).toBeGreaterThan(20);
    const d = openLiveCapture(liveHead());
    for (const s of sealed) d.appendRecords(s.bytes);
    expect(d.contents.records.count).toBe(sealed.reduce((n, s) => n + s.records, 0));
    expect(types(d.contents)).not.toContain(RecordType.WRAP);
    expect(sealed.map((s) => s.segment)).toEqual(sealed.map((_, i) => i));
  });

  it("drops a record that can't fit beside the open segment and writes GAP dropped after the next keyframe", () => {
    const r = recorder({ ringBytes: 600 * 1024 });
    r.begin(0, CONTEXT);
    let k = 0;
    // 600 KB of STATUS inside one second: the open segment fills the ring.
    while (r.ring.dropped === 0 && k < 1000) feed(r, ++k * 1, 1000);
    expect(r.ring.dropped).toBeGreaterThan(0);
    const firstDropped = r.ring.droppedFirstSeq;
    feed(r, SAMPLE_RATE + 1, 10);
    const c = decode(r.ring.copySegment(r.ring.openSegment));
    expect(types(c).slice(0, 3)).toEqual([RecordType.KEYFRAME, RecordType.GAP, RecordType.STATUS]);
    const g = decodeRecordAt(c, 1);
    expect(g.type === RecordType.GAP && g.payload).toMatchObject({ reason: GapReason.dropped, firstSeq: firstDropped });
  });

  it("a full segment table evicts the oldest segment when a new one opens", () => {
    const ring = new RecorderRing(4 * MiB);
    for (let s = 0; s < KEYFRAME_INDEX_SLOTS + 3; s++) {
      ring.record(RecordType.KEYFRAME, 0, 0, s * SAMPLE_RATE, 8, true, SAMPLE_RATE);
    }
    expect(ring.segments).toBe(KEYFRAME_INDEX_SLOTS);
    expect(ring.evicted).toBe(3);
    expect(decode(ring.copyRecords(0).bytes).keyframes.length).toBe(KEYFRAME_INDEX_SLOTS);
  });

  it("decodes EPOCH and GAP payloads it wrote with format.ts's codecs", () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    r.gap(GapReason.paused, 0, 10, 20);
    const span = r.takeSpan().bytes;
    const v = new DataView(span.buffer);
    expect(decodeEpoch(v, CAPTURE_RECORD_HEAD_BYTES, 32).reason).toBe(EpochReason.start);
    const gapAt = span.byteLength - 28;
    expect(decodeGap(v, gapAt, 28)).toMatchObject({ reason: GapReason.paused, perfFrom: 10, perfTo: 20 });
  });
});
