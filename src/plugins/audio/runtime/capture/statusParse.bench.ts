// ADR 0171 amended by 0172 (M5a, task Bn2; architecture §7.3, api-and-models §4.3): the main-thread cost of one STATUS
// block at the wire's worst case, 17,824 B (every section at its cap, M5's loudness and duck sections included). Run alone:
//
//   npx vitest run --config tools/audio-bench/capture.vitest.config.mts statusParse.bench     (about 10 s)
//
// Measured, per block, in microseconds (median, p95, max over 4,000 samples of 50 calls each, divided by 50):
//   read      `StatusReader.read` on the worst-case envelope: the whole decode into the reader's own block (what `CoreLink`
//             runs on every STATUS)
//   read+apply the same, then `StatusMirror.apply`: the decode and the main-side mirror of the voice table, header values and
//             M5 arrays (`mirror.ts`), the rest of what main does per block besides the recorder's tap
//   generated `readStatus`, the allocating decoder `StatusReader` replaced (for scale only; production never calls it)
//   copy      the recorder's tap alone on the same block (the word copy into the ring, no keyframe: its frame is mid-second)
// and per second of audio at the worst case's 62.5 blocks a second. The block is the worst case, which the core never
// sustains (S3's 1,024-voice stream averages ≈ 2.4 KB a block); the smaller profile is measured too, for the ratio.
// No wall-clock assertion (ground rules): the cases assert sizes and structure (the reader's block, arrays and items keep
// their identity over the run).
import { describe, expect, it } from "vitest";
import { StatusReader } from "../core/statusReader";
import { StatusMirror } from "../core/mirror";
import { VoiceTable } from "../core/voiceTable";
import { createRecorder, type EpochContext } from "./recorder";
import { SAMPLE_RATE, statusBytesWith } from "./testSupport";
import { LOUD_METERS, MAX_DUCK_RULES, MAX_LOUD_ENERGIES, STATUS_WORST_CASE_BYTES, readStatus } from "../wire.generated";

const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };
const BATCHES = 4000;
const PER_BATCH = 50;
const WARMUP_BATCHES = 600;

function worstBlock(): Uint8Array {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  return statusBytesWith({
    currentFrame: 768, musicRingsOpen: 16, mixedVoices: 256, liveVoices: 1024,
    ended: ids(1024), demoted: ids(1024), starved: ids(1024),
    playheads: Array.from({ length: 256 }, (_, i) => ({ id: i, clipFrame: i * 480 })),
    clipEvents: Array.from({ length: 64 }, (_, i) => ({ clipId: i, code: 1 + (i % 5) })),
    streamEvents: Array.from({ length: 64 }, (_, i) => ({ id: i, code: 1 + (i % 4) })),
    peaks: Array.from({ length: 32 }, (_, i) => ({ l: i / 64, r: 0.5 })),
    beds: Array.from({ length: 4 }, (_, i) => ({ bus: i, voices: 8 * i, work: 100 * i })),
    zones: Array.from({ length: 4 }, (_, i) => ({ kernelId: 0xffff0200 + i, state: i, pad: 0, quantaSinceInput: i, wetPeak: 0.25 })),
    zoneEvents: Array.from({ length: 16 }, (_, i) => ({ slot: i % 4, code: 1 + (i % 3), reserved: 0 })),
    musicRings: Array.from({ length: 16 }, (_, i) => ({ streamId: i + 1, epochFlags: i })),
    groupStarts: Array.from({ length: 8 }, (_, i) => ({ groupId: i + 1, flags: i % 8, slipFrames: 96 * i, startFrameLo: i, startFrameHi: 0 })),
    loudBuses: Array.from({ length: LOUD_METERS }, (_, i) => ({ slot: i, flags: MAX_LOUD_ENERGIES / LOUD_METERS, firstSeq: 1000 + i, truePeak: i / 8, gatedQuanta: i * 7 })),
    loudEnergies: Array.from({ length: MAX_LOUD_ENERGIES }, (_, i) => i / 1024),
    busDuck: Array.from({ length: MAX_DUCK_RULES }, (_, i) => ({ slot: i, pad: 0, gain: 1 - i / 64 })),
  });
}

/** S3's 1,024-voice average block. */
function typicalBlock(): Uint8Array {
  return statusBytesWith({
    currentFrame: 768, mixedVoices: 256, liveVoices: 1024,
    ended: Array.from({ length: 33 }, (_, i) => i + 1),
    playheads: Array.from({ length: 256 }, (_, i) => ({ id: i + 1, clipFrame: i * 17 })),
    peaks: Array.from({ length: 32 }, (_, i) => ({ l: i / 64, r: i / 32 })),
  });
}

const q = (sorted: Float64Array, p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

/** Per-call microseconds over `BATCHES` batches: median, p95, max. */
function time(fn: () => void): { median: number; p95: number; max: number } {
  for (let b = 0; b < WARMUP_BATCHES; b++) for (let i = 0; i < PER_BATCH; i++) fn();
  const samples = new Float64Array(BATCHES);
  for (let b = 0; b < BATCHES; b++) {
    const t0 = performance.now();
    for (let i = 0; i < PER_BATCH; i++) fn();
    samples[b] = ((performance.now() - t0) * 1000) / PER_BATCH;
  }
  samples.sort();
  return { median: q(samples, 0.5), p95: q(samples, 0.95), max: samples[BATCHES - 1]! };
}

describe("STATUS parse at the wire's worst case (§4.3, §7.3)", () => {
  it("reports the decode, decode + mirror, the allocating decoder and the recorder's copy, per block and per second of audio", () => {
    const rows: string[] = ["| block | operation | median us | p95 | max | ms per audio second at 62.5 blocks/s (median) |", "|---|---|---|---|---|---|"];
    for (const [name, make] of [["worst case", worstBlock], ["S3 1,024-voice average", typicalBlock]] as const) {
      const bytes = make();
      if (name === "worst case") expect(bytes.byteLength).toBe(STATUS_WORST_CASE_BYTES);
      const buffer = bytes.slice().buffer as ArrayBuffer;
      const reader = new StatusReader();
      const mirror = new StatusMirror(new VoiceTable(1024));
      const recorder = createRecorder({ ringBytes: 8 * 1024 * 1024 });
      recorder.begin(0, CONTEXT);
      const view = new DataView(buffer);
      let frame = 0;
      const cases: [string, () => void][] = [
        ["StatusReader.read", () => void reader.read(buffer)],
        ["read + StatusMirror.apply", () => void mirror.apply(reader.read(buffer))],
        ["generated readStatus (allocates)", () => void readStatus(bytes)],
        ["recorder tap (word copy)", () => {
          frame += 768;
          view.setFloat64(16, frame, true);
          recorder.tap(buffer, bytes.byteLength, view);
        }],
      ];
      for (const [op, fn] of cases) {
        const t = time(fn);
        rows.push(`| ${name} (${bytes.byteLength} B) | ${op} | ${t.median.toFixed(2)} | ${t.p95.toFixed(2)} | ${t.max.toFixed(2)} | ${((t.median * 62.5) / 1000).toFixed(3)} |`);
      }
      expect(recorder.badStatus).toBe(0);
    }
    console.log(`Bn2 STATUS parse (container; ${BATCHES} samples of ${PER_BATCH} calls per cell):\n${rows.join("\n")}`);
  });

  it("allocates nothing per block: the reader's block, every section array and every item keep their identity across 3,000 worst-case reads", () => {
    const worst = worstBlock().slice().buffer as ArrayBuffer;
    const reader = new StatusReader();
    const a = reader.read(worst);
    const owned = (blk: typeof a): unknown[] => [
      blk, blk.ended, blk.demoted, blk.starved, blk.playheads, blk.clipEvents, blk.streamEvents, blk.peaks, blk.loudBuses, blk.loudEnergies, blk.busDuck,
      ...blk.playheads, ...blk.clipEvents, ...blk.streamEvents, ...blk.peaks, ...blk.loudBuses, ...blk.busDuck,
    ];
    const first = owned(a);
    expect(a.ended).toHaveLength(1024);
    expect(a.loudEnergies).toHaveLength(MAX_LOUD_ENERGIES);
    for (let i = 0; i < 3000; i++) reader.read(worst);
    const last = owned(reader.read(worst));
    expect(last.length).toBe(first.length);
    for (let i = 0; i < first.length; i++) expect(last[i]).toBe(first[i]);
  });
});
