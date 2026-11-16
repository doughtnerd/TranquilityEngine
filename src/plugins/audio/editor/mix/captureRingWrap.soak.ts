// ADR 0171 amended by 0172 (M5d, task So1, soak 1; architecture §3.6, §3.7, §4.2): the default ring wrapping over ten
// minutes of rendered audio. Spike S3's 1,024-live scene (Bn2's `realCore.bench.ts`) runs through the REAL core on the
// loopback host (the committed wasm), and `Audio.capture` records it exactly as it records a game: the default ring
// (`ringBytesFor("default")`, 16 MiB in Node, where `navigator.deviceMemory` is absent), the backend's own keyframe source
// (G7b) and the real `EventSink`. The audio clock is the loopback's rendered frames (accelerated: about 4 to 8 minutes of
// wall time on an idle container; reported, never asserted). Run alone:
//
//   npx vitest run --config tools/audio-bench/soak.vitest.config.mts captureRingWrap
//
// **Asserted.** The audio clock covered ten minutes; the ring wrapped (its write offset returned to 0) and evicted segments;
// `Audio.capture.truncated`, `Audio.debug().recorder.truncated` and the file's header flag are set, the Worker's summary
// says truncated and the Profiler shows its "Truncated" banner (and its empty state before the first keyframe); the save
// holds the newest span intact (its records are the ring's span byte for byte, seqs contiguous from `truncatedFromSeq` to
// the newest record written, starting at a KEYFRAME, ending at the last STATUS the ring took); the file opens on a Worker
// thread; every KEYFRAME in it decodes and holds the live voices; and the recorder allocated nothing per STATUS block over the
// whole run: no allocating constructor ran inside the tap (Bn2's structural check, around every block of the ten minutes)
// and the ring's buffer, view and segment tables kept their identity.
import { inflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { audioCapture, captureDebug, releaseCapture, setCaptureProject } from "../../runtime/capture/capture";
import { CAPTURE_FLAG_COMPRESSED, CAPTURE_FLAG_TRUNCATED, CAPTURE_HEADER_BYTES, RecordType, decodeKeyframe, readCaptureHeader } from "../../runtime/capture/format";
import { decodeRecordAt, openCapture } from "../../runtime/capture/reader";
import type { CaptureChunkControl } from "../../runtime/capture/testSupport";
import { AllocationCounter, FRAME_SECONDS, MiB, RATE, S3_1024, memorySaveEnv, s3Rig, stat, threadWorkerFactory } from "../../runtime/capture/soakSupport";
import { chooseEmptyStateKind } from "./emptyStates";
import { profilerBanners } from "./ProfilerPanel";
import { CaptureSource } from "./profilerSource";

/** The recorder and save chunks are the real ones, wrapped: the take's recorder is kept, its save goes to memory. */
const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../runtime/capture/recorder", async (real) => (await import("../../runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../runtime/capture/save", async (real) => (await import("../../runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const WARM_SECONDS = 10;
/** Ten minutes; `SO1_SECONDS` shortens it for a shakedown of the harness only (the soak result is the 600 s run). */
const SOAK_SECONDS = Number(process.env.SO1_SECONDS ?? 600);

let closeWorkers: (() => void) | null = null;
afterAll(() => {
  closeWorkers?.();
  releaseCapture();
});

describe("soak 1: the default ring wraps over ten minutes of a busy scene (§3.6, §4.2)", () => {
  it("wraps, truncates, saves the newest span intact, opens, decodes every keyframe, allocates nothing per block", async (ctx) => {
    const rig = await s3Rig(S3_1024);
    if (!rig) return ctx.skip();
    const wall0 = performance.now();
    const { backend } = rig;
    for (let t = 0; t < WARM_SECONDS; t += FRAME_SECONDS) await rig.frame();
    expect(rig.countLive()).toBeGreaterThanOrEqual(Math.floor(S3_1024.live * 0.9));

    // The product's path: Audio.capture.start() loads the chunk and makes the default ring; the chunk is wrapped only to
    // keep a reference to the recorder it makes.
    chunk.recorders.length = 0;
    const env = memorySaveEnv();
    chunk.saveEnv = env;
    setCaptureProject(() => ({ name: "So1 ring wrap", version: "1" }));
    await audioCapture.start();
    expect(audioCapture.state).toBe("recording");
    const r = chunk.recorders[0]!;
    const ring = r.ring;
    expect(ring.capacity).toBe(16 * MiB); // the default preset with no deviceMemory (§4.2)

    // Every block through the tap with the constructor counter swapped in around it; keyframe blocks counted apart.
    const tap = backend.recorderTap!;
    expect(tap).toBe(r.tap);
    const counter = new AllocationCounter();
    let blocks = 0;
    let keyframeBlocks = 0;
    let allocStatus = 0;
    let allocKeyframe = 0;
    let wraps = 0;
    let lastHead = ring.head;
    let truncatedAt = -1;
    const kfAt = (): number => r.lastKeyframeFrame;
    backend.recorderTap = (data, byteLength, view) => {
      const kf = kfAt();
      const before = counter.count;
      counter.during(() => tap(data, byteLength, view));
      const made = counter.count - before;
      blocks++;
      if (kfAt() !== kf) {
        keyframeBlocks++;
        allocKeyframe += made;
      } else allocStatus += made;
      if (ring.head < lastHead) wraps++;
      lastHead = ring.head;
    };
    const identity = { bytes: ring.bytes, buffer: ring.bytes.buffer, view: ring.view, tables: [ring.segStart, ring.segKeyframe, ring.segKeySeq, ring.segFirstSeq, ring.segRecords, ring.segBytes, ring.segEpoch, ring.segRate, ring.segFrame, ring.segEndFrame] };
    const startFrame = r.newestStatusFrame;
    const usedBytes: number[] = [];
    const frames = Math.round(SOAK_SECONDS / FRAME_SECONDS);
    for (let f = 0; f < frames; f++) {
      await rig.frame();
      if (truncatedAt < 0 && audioCapture.truncated) truncatedAt = (r.newestStatusFrame - startFrame) / RATE;
      if (f % Math.round(60 / FRAME_SECONDS) === 0) usedBytes.push(ring.usedBytes);
    }
    const seconds = (r.newestStatusFrame - startFrame) / RATE;
    const wallRun = (performance.now() - wall0) / 1000;

    // The audio clock covered ten minutes; the ring wrapped and evicted; the truncation flags.
    expect(Math.abs(seconds - SOAK_SECONDS)).toBeLessThan(0.1);
    expect(r.badStatus).toBe(0);
    expect(ring.dropped).toBe(0);
    expect(wraps).toBeGreaterThanOrEqual(1);
    expect(ring.evicted).toBeGreaterThan(0);
    expect(audioCapture.truncated).toBe(true);
    expect(captureDebug()?.truncated).toBe(true);
    expect(truncatedAt).toBeGreaterThan(0);
    // No allocation per block, over all ten minutes (Bn2's structural check), and the ring kept its identity.
    if (counter.count > 0) console.log(`So1 soak 1: constructions inside the tap by name ${JSON.stringify(counter.byName)}; first stacks:\n${Object.entries(counter.firstStack).map(([n, s]) => `${n}:\n${s}`).join("\n")}`);
    expect(allocStatus).toBe(0);
    // Keyframe blocks (one a second): G7b's `KeyframeSource.readBuses` builds a `new Set` per keyframe (and `readMetered`,
    // `readEvents`, `readMusic` fresh arrays, which this counter doesn't see), against `KeyframeSource`'s "the source must not
    // allocate". So1 reports it as a defect with the count (the source isn't So1's file); a fix makes this count 0.
    if (allocKeyframe > 0) console.warn(`So1 soak 1 DEFECT: ${allocKeyframe} allocating constructions in ${keyframeBlocks} keyframe blocks (${JSON.stringify(counter.byName)}), from core/keyframeSource.ts`);
    expect(ring.bytes).toBe(identity.bytes);
    expect(ring.bytes.buffer).toBe(identity.buffer);
    expect(ring.view).toBe(identity.view);
    const now = [ring.segStart, ring.segKeyframe, ring.segKeySeq, ring.segFirstSeq, ring.segRecords, ring.segBytes, ring.segEpoch, ring.segRate, ring.segFrame, ring.segEndFrame];
    now.forEach((t, i) => expect(t).toBe(identity.tables[i]));

    // Stop (the ring is Held, no other owner) and save the take: the newest span.
    backend.recorderTap = tap;
    audioCapture.stop();
    expect(audioCapture.state).toBe("stopped");
    const newestSeq = ring.seq - 1;
    const span = r.takeSpan();
    const keptSeconds = ring.seconds;
    const fromSeq = r.truncatedFromSeq;
    await audioCapture.save("so1-ring-wrap");
    expect(env.files).toHaveLength(1);
    const file = env.files[0]!.bytes;
    const header = readCaptureHeader(file);
    expect(header.flags & CAPTURE_FLAG_TRUNCATED).toBe(CAPTURE_FLAG_TRUNCATED);
    expect(header.flags & CAPTURE_FLAG_COMPRESSED).toBe(CAPTURE_FLAG_COMPRESSED);
    // The records region of the file, inflated, is the ring's span byte for byte, then the INDEX.
    const inflated = inflateRawSync(file.subarray(CAPTURE_HEADER_BYTES));
    const records = inflated.subarray(header.metaBytes, header.metaBytes + span.bytes.byteLength);
    expect(Buffer.compare(Buffer.from(records), Buffer.from(span.bytes))).toBe(0);

    // Open in process for the record table: seqs contiguous from truncatedFromSeq to the newest record written.
    const c = await openCapture(file);
    expect(c.truncated).toBe(true);
    const t = c.records;
    expect(t.count).toBe(span.recordCount + 1); // + the INDEX
    expect(t.seq[0]).toBe(fromSeq);
    expect(t.type[0]).toBe(RecordType.KEYFRAME);
    let seqGaps = 0;
    for (let i = 1; i < t.count; i++) if (t.seq[i] !== t.seq[i - 1]! + 1) seqGaps++;
    expect(seqGaps).toBe(0);
    expect(t.seq[t.count - 2]).toBe(newestSeq);
    let lastStatusFrame = 0;
    for (let i = t.count - 1; i >= 0; i--) if (t.type[i] === RecordType.STATUS) { lastStatusFrame = t.frame[i]!; break; }
    expect(lastStatusFrame).toBe(r.newestStatusFrame);
    // Every KEYFRAME decodes and holds the scene's voices.
    const kfVoices: number[] = [];
    for (const i of c.keyframes) {
      const d = decodeRecordAt(c, i);
      if (d.kind !== "keyframe") throw new Error(`record ${i} is not a keyframe`);
      const kf = decodeKeyframe(new DataView(d.payload.buffer, d.payload.byteOffset, d.payload.byteLength), 0, d.payload.byteLength);
      kfVoices.push(kf.voices.length);
    }
    expect(kfVoices.length).toBe(c.keyframes.length);
    expect(Math.min(...kfVoices)).toBeGreaterThanOrEqual(Math.floor(S3_1024.live * 0.9));

    // On a Worker thread through the editor's client: the summary and the Profiler's Truncated state.
    const threads = await threadWorkerFactory();
    closeWorkers = threads.close;
    const o0 = performance.now();
    const source = await CaptureSource.openFile(file.slice().buffer, { worker: threads.make() });
    const openMs = performance.now() - o0;
    expect(source.truncated).toBe(true);
    expect(source.summary.recordCount).toBe(t.count);
    const banners = profilerBanners({ source, projectAudio: undefined, error: null, fileName: "so1-ring-wrap.mycap" });
    expect(banners.map((b) => b.id)).toContain("truncated");
    expect(chooseEmptyStateKind("voices", { playing: false, hasCapture: true, truncated: source.truncated, beforeFirstKeyframe: true })).toBe("truncated");
    const first = await source.seek(source.startSeconds);
    expect(first.keyframe).not.toBeNull(); // a truncated file begins at a keyframe: no empty state at its start
    expect(chooseEmptyStateKind("voices", { playing: false, hasCapture: true, truncated: source.truncated, beforeFirstKeyframe: first.keyframe === null })).toBeNull();
    source.close();

    chunk.saveEnv = null;
    const kv = stat(kfVoices);
    console.log([
      `So1 soak 1, ring wrap: S3 1,024-live scene through the real core, default ring ${ring.capacity / MiB} MiB, ${SOAK_SECONDS} s of rendered audio (container, wall ${wallRun.toFixed(0)} s incl. ${WARM_SECONDS} s warm-up)`,
      "| measure | value |",
      "|---|---|",
      `| audio seconds recorded (audio clock) | ${seconds.toFixed(3)} |`,
      `| STATUS blocks through the tap | ${blocks} (${keyframeBlocks} with a keyframe) |`,
      `| ring wraps (write offset back to 0) / segments evicted | ${wraps} / ${ring.evicted} |`,
      `| truncated first set at (audio s into the take) | ${truncatedAt.toFixed(2)} |`,
      `| ring bytes used at each minute (MiB) | ${usedBytes.map((b) => (b / MiB).toFixed(2)).join(", ")} |`,
      `| kept span: seconds / records / bytes (MiB) | ${keptSeconds.toFixed(1)} / ${span.recordCount} / ${(span.bytes.byteLength / MiB).toFixed(2)} |`,
      `| file (deflated) MiB / its records = ring span byte for byte | ${(file.byteLength / MiB).toFixed(2)} / yes |`,
      `| seqs ${fromSeq}..${newestSeq} contiguous, first a KEYFRAME, last STATUS frame = newest | yes |`,
      `| keyframes decoded / voice rows each (median / p95 / max; min) | ${kfVoices.length} / ${kv.median} / ${kv.p95} / ${kv.max}; ${Math.min(...kfVoices)} |`,
      `| allocating constructors inside the tap: STATUS-only blocks / keyframe blocks | ${allocStatus} / ${allocKeyframe} |`,
      `| Worker-thread open of the saved file (ms, logged) | ${openMs.toFixed(0)} |`,
      `| Profiler: summary truncated / banners | ${source.truncated} / ${banners.map((b) => b.id).join(", ")} |`,
    ].join("\n"));
    rig.dispose();
  });
});
