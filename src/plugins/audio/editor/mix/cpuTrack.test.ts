// ADR 0171/0172 (Pf1; api-and-models §7, architecture §4.3, §9): the profiler's series over real captures read through
// `CaptureSource` (the Worker's handler run in process) with `capture/testSupport.ts` records. Pure: no clock, no DOM.
import { describe, expect, it } from "vitest";
import { RecordType, assembleCapture, encodeRecords, type CaptureRecordInit } from "../../runtime/capture/format";
import type { StatusBlock } from "../../runtime/wire.generated";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, keyframeBytesPlaceholder, statusBytesWith } from "../../runtime/capture/testSupport";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../runtime/capture/worker";
import { CPU_WINDOW_QUANTA } from "../../runtime/mix/cpuMeter";
import { CaptureSource, statusColumns, type CaptureWorkerLike } from "./profilerSource";
import { downsampleTicks, type Viewport } from "./timelineModel";
import { COUNTER_COLUMNS, CPU_COLUMNS, CpuState, CpuTrack, LADDER_COLUMNS, VOICE_COLUMNS, counterTicks, cpuLevel, ladderSeries, slackLevel, slackSeries, voiceSeries } from "./cpuTrack";

const QUANTA_PER_STATUS = 6;
const FRAMES = 768; // one STATUS every 6 quanta of 128 frames
const QUANTUM_MS = (128 * 1000) / SAMPLE_RATE;

function inProcessWorker(): CaptureWorkerLike {
  const w: CaptureWorkerLike = {
    onmessage: null, onerror: null,
    postMessage(message: CaptureRequest, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      setTimeout(() => void handler.handle(copy), 0);
    },
    terminate() {},
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => w.onmessage?.({ data: copy }), 0);
    },
  });
  return w;
}

type Fields = Partial<StatusBlock>;

/** EPOCH, a KEYFRAME placeholder, then `n` STATUS records (block k at frame 768 (k + 1)) with `fields(k)`. */
function records(n: number, fields: (k: number) => Fields): CaptureRecordInit[] {
  const out: CaptureRecordInit[] = [];
  let seq = 0;
  out.push({ type: RecordType.EPOCH, epoch: 0, seq: ++seq, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } });
  out.push({ type: RecordType.KEYFRAME, epoch: 0, seq: ++seq, frame: FRAMES, payload: keyframeBytesPlaceholder() });
  for (let k = 0; k < n; k++) {
    const frame = FRAMES * (k + 1);
    out.push({ type: RecordType.STATUS, epoch: 0, seq: ++seq, frame, payload: statusBytesWith({ ...fields(k), currentFrame: frame }) });
  }
  return out;
}

const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

async function open(recs: CaptureRecordInit[]): Promise<CaptureSource> {
  return CaptureSource.openFile(buf(assembleCapture(SAMPLE_HEADER, SAMPLE_META, recs, { index: true })), { worker: inProcessWorker() });
}

/** A steady load: `share` of every quantum busy. Cumulative counters, as the shell writes them. */
const steady = (share: number, extra: (k: number) => Fields = () => ({})) => (k: number): Fields => ({
  quantaTotal: (k + 1) * QUANTA_PER_STATUS,
  busyMsTotal: (k + 1) * QUANTA_PER_STATUS * QUANTUM_MS * share,
  clockStepMs: 1,
  ...extra(k),
});

describe("CpuTrack", () => {
  const windowSamples = CPU_WINDOW_QUANTA / QUANTA_PER_STATUS; // 16

  it("shows NaN and 'notMeasured' until the first window fills, never 0, then the figure in permille", async () => {
    const n = 40;
    const s = await open(records(n, steady(0.25)));
    const track = new CpuTrack(SAMPLE_RATE);
    expect(track.extend(await statusColumns(s, CPU_COLUMNS), 0)).toBe(n);
    expect(track.length).toBe(n);
    const first = track.states.findIndex((x) => x === CpuState.measured);
    expect(first).toBe(windowSamples); // 16 samples back to reach 96 quanta older: the 17th is the first window
    for (let i = 0; i < first; i++) {
      expect(track.states[i]).toBe(CpuState.notMeasured);
      expect(Number.isNaN(track.permille[i]!)).toBe(true);
    }
    for (let i = first; i < n; i++) expect(track.permille[i]!).toBeCloseTo(250, 6);
    // The drawn line holds only measured samples: no zeros before the window.
    expect(track.line.times.length).toBe(n - first);
    expect(Math.min(...track.line.values)).toBeGreaterThan(0);
    expect(track.line.times[0]).toBeCloseTo(((first + 1) * FRAMES) / SAMPLE_RATE, 12);
    expect(track.latestState).toBe(CpuState.measured);
    expect(track.debug().windowMs).toBeCloseTo(CPU_WINDOW_QUANTA * QUANTUM_MS, 9);
    s.close();
  });

  it("a capture too short for one window is 'not measured' throughout (the first sample is 0 only because nothing was read)", async () => {
    const s = await open(records(5, steady(0.5)));
    const track = new CpuTrack(SAMPLE_RATE);
    track.extend(await statusColumns(s, CPU_COLUMNS));
    expect(Array.from(track.states)).toEqual([0, 0, 0, 0, 0]);
    expect(track.permille.every(Number.isNaN)).toBe(true);
    expect(track.line.times.length).toBe(0);
    s.close();
  });

  it("a coarse clock hides the figure with the meter's reason", async () => {
    const s = await open(records(40, steady(0.25, () => ({ clockStepMs: 5 }))));
    const track = new CpuTrack(SAMPLE_RATE);
    track.extend(await statusColumns(s, CPU_COLUMNS));
    expect(track.states.every((x) => x === CpuState.hidden)).toBe(true);
    expect(track.line.times.length).toBe(0);
    expect(track.debug().hidden).toBe("clock too coarse (5 ms)");
    s.close();
  });

  it("extend takes only later samples, so overlapping re-reads (a live view) equal one read", async () => {
    const all = await open(records(60, steady(0.4)));
    const full = new CpuTrack(SAMPLE_RATE);
    full.extend(await statusColumns(all, CPU_COLUMNS));
    const inc = new CpuTrack(SAMPLE_RATE);
    // Three overlapping windows over the same capture.
    const d = all.duration;
    expect(inc.extend(await statusColumns(all, CPU_COLUMNS, 0, d * 0.4))).toBeGreaterThan(0);
    const mid = inc.length;
    expect(inc.extend(await statusColumns(all, CPU_COLUMNS, d * 0.2, d * 0.7))).toBeGreaterThan(0);
    expect(inc.length).toBeGreaterThan(mid);
    inc.extend(await statusColumns(all, CPU_COLUMNS, 0, d));
    expect(inc.length).toBe(full.length);
    expect(Array.from(inc.permille)).toEqual(Array.from(full.permille));
    expect(inc.extend(await statusColumns(all, CPU_COLUMNS))).toBe(0);
    all.close();
  });

  it("a counter that goes back (a rebuild's new core) restarts the window: not measured again", async () => {
    const f = (k: number): Fields => (k < 30 ? steady(0.25)(k) : steady(0.25)(k - 30));
    const s = await open(records(60, f));
    const track = new CpuTrack(SAMPLE_RATE);
    track.extend(await statusColumns(s, CPU_COLUMNS));
    expect(track.states[29]).toBe(CpuState.measured);
    expect(track.states[30]).toBe(CpuState.notMeasured);
    expect(Number.isNaN(track.permille[30]!)).toBe(true);
    expect(track.states[30 + windowSamples]).toBe(CpuState.measured);
    s.close();
  });

  it("reads the same on a live source after segments are appended", async () => {
    const live = await CaptureSource.openLive(buf(assembleCapture(SAMPLE_HEADER, SAMPLE_META, [])), { worker: inProcessWorker() });
    expect(live.live).toBe(true);
    const track = new CpuTrack(SAMPLE_RATE);
    const all = records(50, steady(0.25));
    const head = all.slice(0, 2 + 20); // EPOCH, KEYFRAME, 20 STATUS
    await live.appendSegment(buf(encodeRecords(head)));
    track.extend(await statusColumns(live, CPU_COLUMNS));
    expect(track.length).toBe(20);
    expect(track.line.times.length).toBe(20 - windowSamples);
    await live.appendSegment(buf(encodeRecords(all.slice(22))));
    track.extend(await statusColumns(live, CPU_COLUMNS));
    expect(track.length).toBe(50);
    expect(track.permille[49]!).toBeCloseTo(250, 6);
    live.close();
  });
});

describe("voices, counters, ladder", () => {
  it("voiceSeries maps live, mixed, virtual (live - mixed), cap and the subsets", async () => {
    const s = await open(records(4, (k) => ({ liveVoices: 10 * (k + 1), mixedVoices: 7 * (k + 1), mixedCap: 24 - k, hrtfVoices: k, bedVoices: 2 * k, fxVoices: 3 * k })));
    const v = voiceSeries(await statusColumns(s, VOICE_COLUMNS));
    expect(Array.from(v.live)).toEqual([10, 20, 30, 40]);
    expect(Array.from(v.mixed)).toEqual([7, 14, 21, 28]);
    expect(Array.from(v.virtual)).toEqual([3, 6, 9, 12]);
    expect(Array.from(v.cap)).toEqual([24, 23, 22, 21]);
    expect(Array.from(v.hrtf)).toEqual([0, 1, 2, 3]);
    expect(Array.from(v.bed)).toEqual([0, 2, 4, 6]);
    expect(Array.from(v.fx)).toEqual([0, 3, 6, 9]);
    expect(v.times[0]).toBeCloseTo(FRAMES / SAMPLE_RATE, 12);
    expect(v.times.length).toBe(4);
    s.close();
  });

  it("virtual never goes negative when mixed exceeds live (a block's two counts read at different instants)", () => {
    const v = voiceSeries({ seconds: Float64Array.of(0, 1), liveVoices: Float64Array.of(3, 5), mixedVoices: Float64Array.of(4, 5), mixedCap: Float64Array.of(8, 8), hrtfVoices: Float64Array.of(0, 0), bedVoices: Float64Array.of(0, 0), fxVoices: Float64Array.of(0, 0) });
    expect(Array.from(v.virtual)).toEqual([0, 0]);
  });

  it("counterTicks marks each sample at which underruns or late commands rose; the first sample is a baseline", async () => {
    const under = [0, 0, 1, 1, 4, 4, 4, 5];
    const late = [2, 2, 2, 3, 3, 3, 3, 3];
    const s = await open(records(8, (k) => ({ underruns: under[k]!, lateCommands: late[k]!, minSlackFrames: 100 - 30 * k, underrunFrames: 128 * under[k]! })));
    const cols = await statusColumns(s, COUNTER_COLUMNS);
    const at = (k: number) => ((k + 1) * FRAMES) / SAMPLE_RATE;
    expect(Array.from(counterTicks(cols, "underruns"))).toEqual([at(2), at(4), at(7)]);
    expect(Array.from(counterTicks(cols, "lateCommands"))).toEqual([at(3)]);
    const slack = slackSeries(cols);
    expect(Array.from(slack.minSlackFrames)).toEqual([100, 70, 40, 10, -20, -50, -80, -110]);
    expect(slack.underrunFrames[7]).toBe(128 * 5);
    s.close();
  });

  it("a counter that falls is a restart: a non-zero value after it is a tick, zero is not", () => {
    const cols = { seconds: Float64Array.of(1, 2, 3, 4, 5), underruns: Uint32Array.of(5, 0, 2, 2, 0) };
    expect(Array.from(counterTicks(cols, "underruns"))).toEqual([3]);
    expect(Array.from(counterTicks(cols, "underruns", 0.5))).toEqual([2.5]);
  });

  it("ladderSeries reads steps in force (m3Shed + loudShed) and marks each shed and restore", async () => {
    const m3 = [0, 0, 0, 1, 2, 2, 1, 0, 0];
    const loud = [0, 0, 1, 1, 1, 1, 1, 1, 0];
    const s = await open(records(9, (k) => ({ m3Shed: m3[k]!, loudShed: loud[k]! })));
    const l = ladderSeries(await statusColumns(s, LADDER_COLUMNS));
    const at = (k: number) => ((k + 1) * FRAMES) / SAMPLE_RATE;
    expect(Array.from(l.level)).toEqual([0, 0, 1, 2, 3, 3, 2, 1, 0]);
    expect(Array.from(l.shed)).toEqual([at(2), at(3), at(4)]);
    expect(Array.from(l.restored)).toEqual([at(6), at(7), at(8)]);
    expect(Array.from(l.loudShed)).toEqual(loud);
    s.close();
  });

  it("levels follow architecture section 9's table, and an unmeasured CPU has no colour", () => {
    expect([slackLevel(65), slackLevel(64), slackLevel(1), slackLevel(0), slackLevel(-12)]).toEqual(["green", "amber", "amber", "red", "red"]);
    expect([cpuLevel(499), cpuLevel(500), cpuLevel(800), cpuLevel(801), cpuLevel(null), cpuLevel(NaN)]).toEqual(["green", "amber", "amber", "red", null, null]);
  });
});

// --- acceptance: downsampling keeps every underrun tick -------------------------------------------------------------
//
// Through the merged `timelineModel.ts` (L-Pf1a).

describe("underrun ticks survive downsampling", () => {
  const N = 6000; // 96 s of STATUS blocks
  const BURST_FROM = 1000;
  const BURST_TO = 4000; // 3,000 consecutive blocks each with a new underrun
  const ISOLATED = [100, 5000, 5900];

  it("a dense burst of thousands of ticks in one bucket and isolated single ticks all show", async () => {
    let count = 0;
    const underruns: number[] = [];
    for (let k = 0; k < N; k++) {
      if ((k >= BURST_FROM && k < BURST_TO) || ISOLATED.includes(k)) count++;
      underruns.push(count);
    }
    const s = await open(records(N, (k) => ({ underruns: underruns[k]! })));
    const ticks = counterTicks(await statusColumns(s, ["underruns"]), "underruns");
    expect(ticks.length).toBe(3000 + ISOLATED.length);
    // The viewport reaches just past the last sample (a viewport's end is exclusive).
    const v: Viewport = { start: 0, end: s.duration + 1, followLive: false };
    for (const buckets of [1, 2, 3, 7, 64, 333, 1000, 4096]) {
      const out = downsampleTicks(ticks, v, buckets);
      // The truth, computed apart from the model: the set of buckets that hold a tick.
      const want = new Set<number>();
      for (const t of ticks) want.add(Math.min(buckets - 1, Math.floor((t / v.end) * buckets)));
      const got = new Set<number>();
      out.forEach((x, i) => { if (x) got.add(i); });
      expect([...got].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b));
      // Each isolated tick's own bucket is set, wherever the burst is.
      for (const k of ISOLATED) expect(out[Math.min(buckets - 1, Math.floor((((k + 1) * FRAMES) / SAMPLE_RATE / v.end) * buckets))]).toBe(1);
    }
    // At 2 buckets each holds over a thousand ticks of the burst, still set.
    expect(Array.from(downsampleTicks(ticks, v, 2))).toEqual([1, 1]);
    s.close();
  }, 30_000);
});
