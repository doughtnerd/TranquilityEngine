// ADR 0171 amended by 0172 (M5a, Rc2; leaf L-Rc2a, done by the lead): the ring allocates nothing per block, checked
// structurally (the same buffer, view and segment tables by identity, no growth, over 10,000 STATUS records through
// wraps and evictions), and every state eviction leaves decodes with Rc1's reader.
import { describe, expect, it } from "vitest";
import { RecordType } from "./format";
import { openLiveCapture } from "./reader";
import { createRecorder, type EpochContext } from "./recorder";
import { KEYFRAME_INDEX_SLOTS, RecorderRing } from "./ring";
import { SAMPLE_RATE, keyframeCodecForTests, liveHead, statusBytesWithVoices } from "./testSupport";

const MiB = 1024 * 1024;
const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };

function decodeCount(bytes: Uint8Array): number {
  const d = openLiveCapture(liveHead());
  d.appendRecords(bytes);
  return d.contents.records.count;
}

describe("the recorder ring allocates nothing per block (L-Rc2a)", () => {
  it("keeps one buffer, one view and the same segment tables over 10,000 STATUS records through wraps and evictions", () => {
    const r = createRecorder({ ringBytes: 1 * MiB, codec: keyframeCodecForTests() });
    const ring = r.ring;
    // One reused STATUS buffer (the test allocates nothing per block either); only `currentFrame` changes.
    const block = statusBytesWithVoices(0, 256);
    const data = block.slice().buffer as ArrayBuffer;
    const view = new DataView(data);
    const tables = [ring.segStart, ring.segKeyframe, ring.segKeySeq, ring.segFirstSeq, ring.segRecords, ring.segBytes, ring.segEpoch, ring.segRate, ring.segFrame, ring.segEndFrame];
    const before = { bytes: ring.bytes, view: ring.view, buffer: ring.bytes.buffer, tap: r.tap, tables: [...tables] };
    r.begin(0, CONTEXT);
    for (let k = 1; k <= 10_000; k++) {
      view.setFloat64(16, k * 768, true);
      r.tap(data, block.byteLength, view);
    }
    expect(r.statusCount).toBe(10_000);
    expect(ring.evicted).toBeGreaterThan(100);
    expect(ring.bytes).toBe(before.bytes);
    expect(ring.view).toBe(before.view);
    expect(ring.bytes.buffer).toBe(before.buffer);
    expect(ring.bytes.byteLength).toBe(1 * MiB);
    expect(r.tap).toBe(before.tap);
    const now = [ring.segStart, ring.segKeyframe, ring.segKeySeq, ring.segFirstSeq, ring.segRecords, ring.segBytes, ring.segEpoch, ring.segRate, ring.segFrame, ring.segEndFrame];
    for (let i = 0; i < now.length; i++) {
      expect(now[i]).toBe(before.tables[i]);
      expect(now[i]!.length).toBe(KEYFRAME_INDEX_SLOTS);
    }
    expect(ring.dropped).toBe(0);
    // And what it kept decodes.
    const span = ring.copyRecords(0);
    expect(decodeCount(span.bytes)).toBe(span.recordCount);
  });

  it("leaves a decodable ring after every eviction under random record sizes and segment lengths", () => {
    // A deterministic LCG: sizes from 0 B to 64 KB, a segment every 1-40 records, 20,000 records in a 600 KB ring.
    let s = 12345;
    const rand = (n: number) => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) % n);
    const ring = new RecorderRing(600 * 1024);
    let frame = 0;
    let checks = 0;
    let lastEvicted = 0;
    let untilSegment = 0;
    for (let i = 0; i < 20_000; i++) {
      frame += 1;
      const opens = untilSegment-- <= 0;
      if (opens) untilSegment = rand(40);
      const len = rand(8) === 0 ? rand(64 * 1024) : rand(600);
      const off = ring.record(opens ? RecordType.KEYFRAME : 0x40, 0, 0, frame, len, opens, SAMPLE_RATE);
      if (off >= 0) ring.bytes.fill(i & 0xff, off, off + len);
      if (ring.evicted !== lastEvicted) {
        lastEvicted = ring.evicted;
        const span = ring.copyRecords(0);
        const d = openLiveCapture(liveHead());
        d.appendRecords(span.bytes);
        const c = d.contents;
        expect(c.records.count).toBe(span.recordCount);
        expect(c.records.type[0]).toBe(RecordType.KEYFRAME); // the tail is always a segment's keyframe
        expect(c.keyframes.length).toBe(ring.segments);
        expect(ring.usedBytes).toBe(span.bytes.byteLength);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(500);
    // Each kept segment copies alone and decodes alone.
    for (let id = ring.firstSegment; id < ring.nextSegment; id++) {
      expect(decodeCount(ring.copySegment(id))).toBe(ring.segRecords[ring.rowOf(id)]);
    }
  });
});
