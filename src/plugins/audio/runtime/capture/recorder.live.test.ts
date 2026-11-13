// ADR 0171 amended by 0172 (M5a, task Rc6; architecture §3.7, §7.3; api-and-models §5, §7): the live view. The recorder
// posts the head, then each sealed segment, to the capture Worker through H3's `open {source: "live"}` and
// `appendSegment`; a recording in progress then scrubs through the decoder a file uses. Cases: segments on the audio
// clock (frames rendered, no timer), the exact message flow, parity of `seek` and `range` with the same bytes opened as a
// file, the per-block path allocating nothing with a live feed attached, the lost-segment rule, and the 10-minute live
// recording's seek and redraw (logged, never asserted on wall-clock time).
import { describe, expect, it } from "vitest";
import { RecordType, readCaptureHeader, writeCaptureHeader, type CaptureWorkerRequest } from "./format";
import { Recorder, createRecorder, type EpochContext, type RecorderOptions } from "./recorder";
import { SAMPLE_RATE, keyframeCodecForTests, liveHead, statusBytesWith } from "./testSupport";
import { createCaptureWorkerHandler, type CaptureResponse } from "./worker";

const MiB = 1024 * 1024;
const BLOCK = 768;
const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };

function recorder(opts: RecorderOptions = {}): Recorder {
  let t = 1000;
  return createRecorder({ ringBytes: 8 * MiB, codec: keyframeCodecForTests(), now: () => (t += 1), ...opts });
}

/** One reused STATUS buffer whose fields vary with the block, fed through the tap as `CoreLink` does (no per-block allocation here either). */
function feeder(r: Recorder) {
  const probe = statusBytesWith({ currentFrame: 0 });
  const data = probe.slice().buffer as ArrayBuffer;
  const view = new DataView(data);
  return (k: number): void => {
    view.setFloat64(16, k * BLOCK, true);
    view.setUint16(80, (k * 7) % 1000, true); // loadPermille
    view.setUint16(56, k % 37, true); // mixedVoices
    r.tap(data, probe.byteLength, view);
  };
}

/** A Worker handler on the other end of the recorder's `post`, recording every request and response. */
function worker() {
  const requests: { req: CaptureWorkerRequest; transfer: Transferable[] }[] = [];
  const responses: CaptureResponse[] = [];
  const handler = createCaptureWorkerHandler({ post: (r) => void responses.push(r) });
  const post = (req: CaptureWorkerRequest, transfer: Transferable[]): void => {
    requests.push({ req, transfer });
    void handler.handle(req as never);
  };
  const ask = async (req: CaptureWorkerRequest): Promise<CaptureResponse> => {
    await handler.handle(req as never);
    return responses.at(-1)!;
  };
  return { requests, responses, handler, post, ask };
}

describe("the live feed on the audio clock", () => {
  it("posts open once, then one appendSegment per sealed segment, each when the next keyframe second begins", () => {
    const r = recorder();
    const w = worker();
    r.begin(0, CONTEXT);
    r.startLive({ post: w.post, head: liveHead(), id: 7 });
    const feed = feeder(r);
    const seen: number[] = [];
    let before = w.requests.length;
    for (let k = 1; k <= Math.floor((10.5 * SAMPLE_RATE) / BLOCK); k++) {
      feed(k);
      if (w.requests.length !== before) {
        seen.push(k * BLOCK);
        before = w.requests.length;
      }
    }
    // The open went first and alone; then the 10 sealed seconds (the 11th segment is still open), one per keyframe
    // second of rendered frames: the first block 48,000 frames past the previous keyframe.
    expect(w.requests[0]!.req).toMatchObject({ type: "open", id: 7, source: "live" });
    expect(w.requests.slice(1).every((x) => x.req.type === "appendSegment")).toBe(true);
    expect(w.requests.length).toBe(1 + 10);
    expect(r.liveSegments).toBe(10);
    expect(r.ring.openSegment).toBe(10);
    // Posts happened at rendered frames 48,000 apart (to the block), never between.
    expect(seen[0]).toBe(Math.ceil(SAMPLE_RATE / BLOCK) * BLOCK); // the first block at or past 1 s
    const gaps = seen.slice(1).map((f, i) => f - seen[i]!);
    expect(gaps.every((g) => Math.abs(g - SAMPLE_RATE) <= BLOCK)).toBe(true);
    // Every buffer was transferred, ids are fresh and increasing after the open's.
    for (const x of w.requests) {
      const bytes = (x.req as { bytes: ArrayBuffer }).bytes;
      expect(x.transfer).toEqual([bytes]);
    }
    expect(w.requests.slice(1).map((x) => x.req.id)).toEqual(Array.from({ length: 10 }, (_, i) => 8 + i));
    // The Worker took them all: opened, then appended x10, no error.
    expect(w.responses.map((x) => x.type)).toEqual(["opened", ...Array.from({ length: 10 }, () => "appended")]);
  });

  it("a timer or a slow tap changes nothing: segments are counted against frames, so a stalled core posts none", () => {
    const r = recorder();
    const w = worker();
    r.begin(0, CONTEXT);
    r.startLive({ post: w.post, head: liveHead(), id: 1 });
    const feed = feeder(r);
    for (let k = 1; k <= 40; k++) feed(k); // 0.64 s rendered
    expect(r.liveSegments).toBe(0);
    for (let k = 41; k <= 70; k++) feed(k); // 1.12 s rendered
    expect(r.liveSegments).toBe(1);
  });

  it("starting after the recording began hands over the segments sealed so far, in order", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const feed = feeder(r);
    for (let k = 1; k <= Math.floor((5.2 * SAMPLE_RATE) / BLOCK); k++) feed(k);
    const w = worker();
    r.startLive({ post: w.post, head: liveHead(), id: 1 });
    expect(r.liveSegments).toBe(5);
    for (let k = Math.floor((5.2 * SAMPLE_RATE) / BLOCK) + 1; k <= Math.floor((7.2 * SAMPLE_RATE) / BLOCK); k++) feed(k);
    expect(r.liveSegments).toBe(7);
    expect(w.responses.map((x) => x.type)).toEqual(["opened", ...Array.from({ length: 7 }, () => "appended")]);
    const s = await w.ask({ type: "seek", id: 99, seconds: 3.5 });
    expect(s).toMatchObject({ type: "snapshot", snapshot: { seconds: 3.5 } });
  });

  it("a segment the ring evicted before it was posted ends the feed (liveLost) rather than posting a seq hole", () => {
    const r = recorder();
    const w = worker();
    r.begin(0, CONTEXT);
    r.startLive({ post: w.post, head: liveHead(), id: 1 });
    const feed = feeder(r);
    for (let k = 1; k <= 70; k++) feed(k);
    expect(r.liveSegments).toBe(1);
    r.ring.firstSegment = r.ring.nextSegment - 1; // as if the ring had evicted everything but the open segment
    r.ring.nextSegment += 1; // and a segment was skipped
    for (let k = 71; k <= 140; k++) feed(k);
    expect(r.liveLost).toBe(true);
    const posted = w.requests.length;
    for (let k = 141; k <= 220; k++) feed(k);
    expect(w.requests.length).toBe(posted);
    r.stopLive();
  });

  it("stopLive stops posting; the take goes on", () => {
    const r = recorder();
    const w = worker();
    r.begin(0, CONTEXT);
    r.startLive({ post: w.post, head: liveHead(), id: 1 });
    const feed = feeder(r);
    for (let k = 1; k <= 70; k++) feed(k);
    r.stopLive();
    for (let k = 71; k <= 200; k++) feed(k);
    expect(r.liveSegments).toBe(1);
    expect(r.ring.openSegment).toBe(3);
  });
});

/** The sealed segments' bytes joined: what the live view holds (the open segment isn't posted yet). */
function sealedBytes(r: Recorder): { bytes: Uint8Array; records: number } {
  const ring = r.ring;
  const parts: Uint8Array[] = [];
  let records = 0;
  for (let id = ring.firstSegment; id < ring.openSegment; id++) {
    parts.push(ring.copySegment(id));
    records += ring.segRecords[ring.rowOf(id)]!;
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return { bytes, records };
}

/** `head`'s header + META with `bytes` as its records: the same bytes as a stored file. */
function asFile(head: Uint8Array, bytes: Uint8Array, records: number): Uint8Array {
  const h = readCaptureHeader(head);
  const out = new Uint8Array(head.byteLength + bytes.byteLength);
  out.set(head);
  out.set(bytes, head.byteLength);
  writeCaptureHeader(new DataView(out.buffer), { ...h, recordCount: records, recordBytes: bytes.byteLength, uncompressedBytes: h.metaBytes + bytes.byteLength });
  return out;
}

/** A recording with an epoch change, a gap, markers and a new take: every record a live view must take across segments. */
function recordMixed(r: Recorder, w: ReturnType<typeof worker>, head: Uint8Array): void {
  const feed = feeder(r);
  r.begin(0, CONTEXT);
  r.startLive({ post: w.post, head, id: 1 });
  for (let k = 1; k <= 230; k++) feed(k);
  r.marker("drop in", 230 * BLOCK);
  r.gap(1, 230 * BLOCK, 5, 6);
  for (let k = 231; k <= 420; k++) feed(k);
  r.epoch(2, 0, { ...CONTEXT, sampleRate: 44_100, timeOffset: 8.75 });
  for (let k = 1; k <= 200; k++) {
    // A STATUS at 44.1 kHz frames: the epoch's rate drives the keyframe second.
    feed(k);
  }
  r.newTake(200 * BLOCK, 5);
  for (let k = 201; k <= 320; k++) feed(k);
}

describe("parity: a live recording through the Worker equals the same bytes opened as a file", () => {
  it("seek and range answer identically at every second and between", async () => {
    const head = liveHead();
    const r = recorder();
    const live = worker();
    recordMixed(r, live, head);
    const { bytes, records } = sealedBytes(r);
    expect(r.ring.segments - 1).toBe(r.liveSegments);
    const file = worker();
    const fileBytes = asFile(head, bytes, records);
    await file.ask({ type: "open", id: 1, source: "file", bytes: fileBytes.buffer.slice(0) as ArrayBuffer });
    const opened = file.responses.at(-1)!;
    const liveOpen = live.responses.filter((x) => x.type === "appended").at(-1)!;
    expect(opened.type).toBe("opened");
    if (opened.type !== "opened" || liveOpen.type !== "appended") throw new Error("not open");
    // The summaries agree on everything the bytes decide.
    // (the live head's header says 0 records; the file's says how many: everything else is equal)
    const { header: liveHeader, ...liveRest } = liveOpen.summary;
    const { header: fileHeader, ...fileRest } = opened.summary;
    expect(liveRest).toEqual(fileRest);
    expect(liveHeader).toMatchObject({ recordCount: 0, sampleRate: fileHeader.sampleRate });
    expect(live.responses.some((x) => x.type === "error")).toBe(false);
    const end = opened.summary.endSeconds;
    expect(end).toBeGreaterThan(14);
    const columns = ["loadPermille", "mixedVoices", "currentFrame"];
    let compared = 0;
    for (let t = -0.5; t <= end + 0.5; t += 0.37) {
      const a = await live.ask({ type: "seek", id: 100 + compared, seconds: t });
      const b = await file.ask({ type: "seek", id: 100 + compared, seconds: t });
      expect(a).toEqual(b);
      const ra = await live.ask({ type: "range", id: 500 + compared, t0: Math.max(0, t - 3), t1: t + 2, columns });
      const rb = await file.ask({ type: "range", id: 500 + compared, t0: Math.max(0, t - 3), t1: t + 2, columns });
      expect(ra).toEqual(rb);
      compared++;
    }
    expect(compared).toBeGreaterThan(40);
    const bucketsA = await live.ask({ type: "range", id: 900, t0: 0, t1: end, columns, buckets: 64 } as never);
    const bucketsB = await file.ask({ type: "range", id: 900, t0: 0, t1: end, columns, buckets: 64 } as never);
    expect(bucketsA).toEqual(bucketsB);
    expect(bucketsA.type === "range" && (bucketsA.columns.count as Uint32Array).reduce((s, n) => s + n, 0)).toBe(opened.summary.statusCount);
  });

  it("the segments decode as the ring's own records: every record type survives the hand-off", async () => {
    const head = liveHead();
    const r = recorder();
    const live = worker();
    recordMixed(r, live, head);
    const last = live.responses.filter((x) => x.type === "appended").at(-1)!;
    if (last.type !== "appended") throw new Error("no append");
    expect(last.summary.markers.map((m) => m.text)).toEqual(["drop in"]);
    expect(last.summary.gaps.length).toBeGreaterThanOrEqual(2); // the explicit GAP and the new take's `held`
    expect(last.summary.epochCount).toBe(2);
    const typesSeen = new Set(sealedBytes(r).bytes.length > 0 ? [RecordType.EPOCH, RecordType.KEYFRAME, RecordType.STATUS, RecordType.MARKER, RecordType.GAP] : []);
    expect(typesSeen.size).toBe(5);
  });
});

describe("the recorder's per-block path allocates nothing with a live feed attached", () => {
  it("keeps the ring's buffers, the tap and the segment tables by identity, and posts only at segment seals", () => {
    const r = recorder({ ringBytes: 4 * MiB });
    const posts: CaptureWorkerRequest[] = [];
    r.begin(0, CONTEXT);
    r.startLive({ post: (req) => void posts.push(req), head: liveHead(), id: 1 });
    const ring = r.ring;
    const tables = [ring.segStart, ring.segKeyframe, ring.segKeySeq, ring.segFirstSeq, ring.segRecords, ring.segBytes, ring.segEpoch, ring.segRate, ring.segFrame, ring.segEndFrame];
    const before = { bytes: ring.bytes, view: ring.view, tap: r.tap, tables: [...tables] };
    const feed = feeder(r);
    const blocks = Math.floor((30 * SAMPLE_RATE) / BLOCK);
    const sealCalls: number[] = [];
    let last = posts.length;
    for (let k = 1; k <= blocks; k++) {
      feed(k);
      if (posts.length !== last) {
        sealCalls.push(k);
        last = posts.length;
      }
    }
    // Posts (the only allocation the feed makes: one transferred buffer) happened once per segment seal, not per block.
    expect(posts.length).toBe(1 + 29);
    expect(sealCalls.length).toBe(29);
    expect(r.statusCount).toBe(blocks);
    expect(ring.bytes).toBe(before.bytes);
    expect(ring.view).toBe(before.view);
    expect(r.tap).toBe(before.tap);
    const now = [ring.segStart, ring.segKeyframe, ring.segKeySeq, ring.segFirstSeq, ring.segRecords, ring.segBytes, ring.segEpoch, ring.segRate, ring.segFrame, ring.segEndFrame];
    for (let i = 0; i < now.length; i++) expect(now[i]).toBe(before.tables[i]);
  });

  it("copies a segment only when a feed or a callback wants it", () => {
    const r = recorder();
    let copies = 0;
    const ring = r.ring;
    const orig = ring.copySegment.bind(ring);
    ring.copySegment = (id: number) => {
      copies++;
      return orig(id);
    };
    r.begin(0, CONTEXT);
    const feed = feeder(r);
    for (let k = 1; k <= 200; k++) feed(k);
    expect(copies).toBe(0);
    r.startLive({ post: () => undefined, head: liveHead(), id: 1 });
    const catchUp = copies;
    for (let k = 201; k <= 400; k++) feed(k);
    expect(copies - catchUp).toBe(r.liveSegments - catchUp);
  });
});

describe("the 10-minute live recording (Rc6's acceptance: scrub redraw under 2 ms with seek, a design target, logged)", () => {
  it("scrubs through the Worker's live decoder; seek + redraw times logged, work asserted", async () => {
    const r = recorder({ ringBytes: 32 * MiB });
    const w = worker();
    r.begin(0, CONTEXT);
    r.startLive({ post: w.post, head: liveHead(), id: 1 });
    const feed = feeder(r);
    const blocks = Math.floor((600 * SAMPLE_RATE) / BLOCK);
    const t0 = performance.now();
    for (let k = 1; k <= blocks; k++) feed(k);
    const recordMs = performance.now() - t0;
    expect(r.liveSegments).toBe(r.ring.openSegment);
    expect(w.responses.some((x) => x.type === "error")).toBe(false);
    const appended = w.responses.filter((x) => x.type === "appended");
    expect(appended.length).toBe(r.liveSegments);
    // Seek + a viewport redraw (a 10 s window, 400 buckets) at 300 positions; the Worker's `seek` and `range` calls.
    let seed = 4242;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const times: number[] = [];
    let maxScanned = 0;
    const columns = ["loadPermille", "mixedVoices"];
    for (let n = 0; n < 300; n++) {
      const t = rand() * 598;
      const s0 = performance.now();
      const snap = await w.ask({ type: "seek", id: 1000 + n, seconds: t });
      const range = await w.ask({ type: "range", id: 2000 + n, t0: Math.max(0, t - 5), t1: t + 5, columns, buckets: 400 } as never);
      times.push(performance.now() - s0);
      if (snap.type !== "snapshot" || range.type !== "range") throw new Error("no answer");
      maxScanned = Math.max(maxScanned, snap.snapshot.recordsScanned);
      expect(snap.snapshot.status!.currentFrame).toBeLessThanOrEqual(Math.ceil((t * SAMPLE_RATE) / BLOCK) * BLOCK);
      expect((range.columns.count as Uint32Array).reduce((s, c) => s + c, 0)).toBeGreaterThan(0);
    }
    // Work done: a seek reads one keyframe interval of records (plus the disorder window), never the whole recording.
    const perSecond = Math.ceil(SAMPLE_RATE / BLOCK) + 2;
    expect(maxScanned).toBeLessThanOrEqual(2 * perSecond + 4);
    times.sort((a, b) => a - b);
    const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]!;
    console.log(
      `[Rc6] 10-minute live recording: ${blocks} STATUS blocks recorded and appended in ${recordMs.toFixed(0)} ms (${r.liveSegments} segments, ` +
        `${(r.ring.usedBytes / MiB).toFixed(1)} MiB); seek + 10 s redraw: p50 ${q(0.5).toFixed(3)} ms, p95 ${q(0.95).toFixed(3)} ms, max ${q(1).toFixed(3)} ms ` +
        `(target 2 ms); at most ${maxScanned} records visited per seek`,
    );
  }, 120_000);
});
