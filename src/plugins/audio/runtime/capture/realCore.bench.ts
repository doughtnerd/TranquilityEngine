// ADR 0171 amended by 0172 (M5a, task Bn2; architecture §7.4 "S3 re-run idle", api-and-models §4.4 R15): spike S3's
// capture scene re-run through the REAL core. The loopback host (`testing.ts`) runs the committed wasm in Node, delivers the
// real STATUS blocks through `CoreLink` (the recorder's `recorderTap` fires where it does in production), and the real
// `CoreBackend`, voice table, mixer, clip registry, `EventSink` and recorder run on main. Run alone (about 3 minutes):
//
//   npx vitest run --config tools/audio-bench/capture.vitest.config.mts realCore.bench
//
// **The scene** is S3's (`spikes/audio-mix/capture/sim.mjs` `SCENES`): 64 / 256 / 1,024 live voices (mixed cap 64 / 128 / 256,
// 8 / 12 / 16 buses, mean voice life 3 / 2.5 / 2 s, 25 / 30 / 30 % looping). "Idle" is the editor's sense: nothing but the
// scene runs (no Profiler panel, no edits, no listener movement); every voice that ends is replaced in the next frame by a
// new one, as S3's did. Clips are generated silence-free constants (the mix's content does not change a STATUS block's
// size; the voices, their churn and the core's own reports do).
//
// **Two arms, same scene and seed.** `off`: no recorder. `on`: the recorder attached through `backend.recorderTap`, the
// `EventSink` through `backend.setProfileSink`, a keyframe source over the real voice table. Each run: 10 s of audio to fill
// the scene (clips load, the cap fills), then 60 s measured (3,750 STATUS blocks).
//
// **Measured.** Per quantum, the loopback host's `renderQuanta(1)` (the core's `process` plus the delivery and handling of the
// STATUS that quantum carries): quanta without a STATUS (the core alone, plus the host's two output copies) and quanta
// with one, each median / p95 / max in microseconds; per frame the main side (`mixer.update`, `backend.update`, which is
// where the event taps run); the recorder's tap alone, timed around the call; and the bytes the recorder wrote (ring bytes
// per minute, by record type, and the take deflated, as the save does) against 0172's sizes.
//
// No wall-clock assertion (ground rules): the cases assert the audio clock (60 s of frames recorded), the scene (live
// voices near the target), and the sizes' arithmetic.
import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings, type BusSettings } from "../../../../engine/audio/settings";
import type { CorePreset } from "../worklet/coreDriver";
import type { AudioHost, CoreLink } from "../core/context";
import { CoreBackend, type CoreBackendHost } from "../core/coreBackend";
import { createClipRegistry } from "../core/clipRegistry";
import { fakeDecoder } from "../core/fakeDecoder";
import { encodeVoiceId } from "../core/ids";
import { VoiceState } from "../core/voiceTable";
import { createLoopbackHost, LOOPBACK_PRESET } from "../testing";
import { KEYFRAME_BUS_LANES, RecordType, encodeKeyframe, keyframeBytes, type KeyframePayload, type KeyframeVoice } from "./format";
import { openLiveCapture } from "./reader";
import { createRecorder, type EpochContext } from "./recorder";
import { createEventSink } from "./events";
import { SAMPLE_RATE, liveHead } from "./testSupport";

const RATE = 48_000;
const QUANTUM = 128;
const FRAME_QUANTA = 6;
const WARM_SECONDS = 10;
const MEASURE_SECONDS = 60;
const MiB = 1024 * 1024;
const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };

interface Scene {
  name: string;
  live: number;
  mixed: number;
  buses: number;
  life: number;
  loopFrac: number;
  /** 0172's sizes for this scene, MB per minute: the take deflated (the compressed raw stream) and the raw records (S3). */
  s3Deflated: number;
  s3Raw: number;
}
const SCENES: Scene[] = [
  { name: "64 live", live: 64, mixed: 64, buses: 8, life: 3, loopFrac: 0.25, s3Deflated: 0.27, s3Raw: 1.7 },
  { name: "256 live", live: 256, mixed: 128, buses: 12, life: 2.5, loopFrac: 0.3, s3Deflated: 0.84, s3Raw: 4.08 },
  { name: "1,024 live", live: 1024, mixed: 256, buses: 16, life: 2, loopFrac: 0.3, s3Deflated: 2.45, s3Raw: 10.85 },
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const q = (sorted: Float64Array, n: number, p: number): number => sorted[Math.min(n - 1, Math.floor(p * n))]!;
interface Stat { n: number; median: number; p95: number; max: number }
function stat(values: Float64Array, n: number): Stat {
  const sorted = values.slice(0, n).sort();
  return { n, median: q(sorted, n, 0.5), p95: q(sorted, n, 0.95), max: sorted[n - 1] ?? 0 };
}

interface Result {
  scene: Scene;
  armed: boolean;
  quantaPlain: Stat;
  quantaStatus: Stat;
  mainFrame: Stat;
  tap: Stat | null;
  liveAvg: number;
  mixedAvg: number;
  statusBytesAvg: number;
  seconds: number;
  ringBytes: number;
  statusBytes: number;
  keyframeBytes: number;
  eventBytes: number;
  otherBytes: number;
  records: Record<string, number>;
  deflated: number;
  eventsPerSecond: number;
  keyframeBytesEach: number;
}

async function runScene(scene: Scene, armed: boolean): Promise<Result | null> {
  const preset: CorePreset = { ...LOOPBACK_PRESET, maxLogical: scene.live + 32, maxMixed: scene.mixed, maxBuses: Math.max(8, scene.buses), arenaInitialBytes: 4 * MiB, clipCeilingBytes: 96 * MiB };
  let loop: Awaited<ReturnType<typeof createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await createLoopbackHost({ preset })) as typeof loop;
  } catch {
    return null;
  }
  const rand = rng(1);
  // Clips: one-shot lengths spread over 0.25 s .. (2 x life - 0.25) s (mean = life), plus short loop clips.
  const ONE_SHOTS = 40;
  const LOOPS = 8;
  const frames = new Map<string, number>();
  const oneShot = (i: number) => `shot${i}.wav`;
  const loopClip = (i: number) => `loop${i}.wav`;
  for (let i = 0; i < ONE_SHOTS; i++) frames.set(oneShot(i), Math.round((0.25 + (i / (ONE_SHOTS - 1)) * (2 * scene.life - 0.5)) * RATE));
  for (let i = 0; i < LOOPS; i++) frames.set(loopClip(i), Math.round((0.6 + i * 0.15) * RATE));
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => {
      const bytes = new ArrayBuffer(8);
      new DataView(bytes).setUint32(0, frames.get(path) ?? RATE, true);
      return bytes;
    },
    decodeWorker: fakeDecoder(async (encoded) => {
      const n = new DataView(encoded).getUint32(0, true);
      return { frames: n, channels: 1, sampleRate: RATE, channelData: [new Float32Array(n).fill(0.1)] };
    }),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const settings: AudioSettings = defaultAudioSettings();
  const buses: BusSettings[] = [{ name: "Master", volume: 1, mute: false, effects: [] }];
  for (let i = 1; i < scene.buses; i++) buses.push({ name: `Bus${i}`, parent: "Master", volume: 1, mute: false, effects: [] });
  settings.buses = buses;
  settings.voices = { mixed: scene.mixed, logical: scene.live + 32, hrtf: 8 };
  const host: CoreBackendHost = {
    link, status: "running", preset: { maxLogical: scene.live + 32, maxMixed: scene.mixed }, worldCount: 1, sampleRate: RATE,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(settings);
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  const table = backend.table;
  const names = backend.busNames;

  // --- the scene: top up to `live` voices each frame; a voice's life ends at its deadline (looped) or with its clip ---
  const deadline = new Float64Array(table.capacity).fill(Infinity);
  const handles: ({ stop(fade?: number): void } | null)[] = new Array(table.capacity).fill(null);
  let audioSeconds = 0;
  const countLive = (): number => {
    let n = 0;
    for (let i = 0; i < table.capacity; i++) {
      const st = table.state[i]!;
      if (st === VoiceState.PLAYING || st === VoiceState.VIRTUAL || st === VoiceState.WAITING_FOR_DATA || st === VoiceState.LOCKED) n++;
    }
    return n;
  };
  const spawn = (): void => {
    const looping = rand() < scene.loopFrac;
    const path = looping ? loopClip((rand() * LOOPS) | 0) : oneShot((rand() * ONE_SHOTS) | 0);
    const bus = names[1 + ((rand() * (names.length - 1)) | 0)] ?? "Master";
    const v = backend.play({
      path, url: path, loop: looping, stream: false, bus, volume: 0.2 + rand() * 0.8,
      pitch: rand() < 0.9 ? 1 : 0.8 + rand() * 0.4, priority: (rand() * 128) | 0,
    });
    if (v) {
      const slot = v.id & 0xffff;
      handles[slot] = v;
      deadline[slot] = looping ? audioSeconds + 0.5 + rand() * (2 * scene.life - 0.5) : Infinity;
    }
  };

  // --- the recorder (armed run only) ---
  const recorder = armed ? createRecorder({ ringBytes: 64 * MiB }) : null;
  const sink = recorder ? createEventSink(recorder) : null;
  let tapNs: Float64Array | null = null;
  let tapN = 0;
  const payloadVoices: KeyframeVoice[] = Array.from({ length: table.capacity }, () => ({ id: 0, clip: 0, slot: 0, state: 0, priority: 0, reason: 0, gain: 0, pitch: 4096, audibility: 0, playheadFrames: 0 }));
  const payload: KeyframePayload = {
    voices: [], buses: Array.from({ length: Math.min(32, names.length) }, (_, i) => ({ slot: i, gen: 1, flags: 0, lanes: new Array<number>(KEYFRAME_BUS_LANES).fill(1), duck: 1, automation: 1 })),
    metered: [], events: [], music: [],
    mix: { slotTableVersion: 1, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 },
  };
  /** The real voice table as a keyframe's voice rows (§5.5), rows reused: the source allocates nothing per call. */
  const rows = payload.voices as KeyframeVoice[];
  const keyframeSource = (): KeyframePayload => {
    let n = 0;
    rows.length = 0;
    for (let i = 0; i < table.capacity; i++) {
      const st = table.state[i]!;
      if (st === VoiceState.FREE) continue;
      const row = payloadVoices[n++]!;
      rows.push(row);
      row.id = encodeVoiceId(i, table.gen[i]!);
      row.clip = table.clip[i]!;
      row.slot = table.bus[i]!;
      row.state = st === VoiceState.PLAYING ? 0 : st === VoiceState.VIRTUAL ? 1 : st === VoiceState.LOCKED ? 5 : 3;
      row.priority = table.priority[i]!;
      row.reason = table.reason[i]!;
      row.gain = table.gain[i]!;
      row.audibility = Math.min(65535, Math.round(table.audibility[i]! * 65535));
    }
    return payload;
  };

  const dt = (FRAME_QUANTA * QUANTUM) / RATE;
  const frameCount = Math.round((MEASURE_SECONDS * RATE) / (FRAME_QUANTA * QUANTUM));
  const plain = new Float64Array(frameCount * FRAME_QUANTA);
  const withStatus = new Float64Array(frameCount);
  const mainMs = new Float64Array(frameCount);
  let nPlain = 0;
  let nStatus = 0;
  let nMain = 0;
  let liveSum = 0;
  let mixedSum = 0;
  let statusCount = 0;
  let startFrame = 0;

  const frameStep = async (measure: boolean): Promise<void> => {
    const t0 = performance.now();
    mixer.update(dt);
    backend.update(dt);
    // Replace what ended (S3: the replacement starts in the same frame) and stop loopers at their deadline.
    for (let i = 0; i < table.capacity; i++) {
      if (deadline[i]! <= audioSeconds) {
        handles[i]?.stop(0.005);
        deadline[i] = Infinity;
      }
    }
    for (let n = countLive(); n < scene.live; n++) spawn();
    const t1 = performance.now();
    if (measure) mainMs[nMain++] = t1 - t0;
    await Promise.resolve();
    for (let k = 0; k < FRAME_QUANTA; k++) {
      const before = loop.statuses.length;
      const a = performance.now();
      loop.renderQuanta(1);
      const b = performance.now();
      if (measure) {
        if (loop.statuses.length > before) withStatus[nStatus++] = (b - a) * 1000;
        else plain[nPlain++] = (b - a) * 1000;
      }
    }
    audioSeconds += dt;
  };

  for (let f = 0; f < Math.round((WARM_SECONDS * RATE) / (FRAME_QUANTA * QUANTUM)); f++) await frameStep(false);
  expect(countLive()).toBeGreaterThanOrEqual(Math.floor(scene.live * 0.9));

  if (recorder && sink) {
    const tap = recorder.tap;
    tapNs = new Float64Array(frameCount + 16);
    recorder.setKeyframeSource(keyframeSource);
    backend.setProfileSink(sink);
    backend.recorderTap = (data, byteLength, view) => {
      const a = performance.now();
      tap(data, byteLength, view);
      tapNs![tapN++] = (performance.now() - a) * 1000;
    };
    startFrame = loop.frame;
    recorder.begin(startFrame, CONTEXT);
  }
  const statusesBefore = loop.statuses.length;
  for (let f = 0; f < frameCount; f++) await frameStep(true);
  for (const s of loop.statuses.slice(statusesBefore)) {
    liveSum += s.liveVoices;
    mixedSum += s.mixedVoices;
    statusCount++;
  }

  let result: Result;
  const base = { scene, armed, quantaPlain: stat(plain, nPlain), quantaStatus: stat(withStatus, nStatus), mainFrame: stat(mainMs.map((v) => v * 1000), nMain), liveAvg: liveSum / Math.max(1, statusCount), mixedAvg: mixedSum / Math.max(1, statusCount) };
  if (recorder && sink) {
    backend.recorderTap = null;
    backend.setProfileSink(null);
    const seconds = (recorder.newestStatusFrame - startFrame) / RATE;
    const span = recorder.takeSpan();
    const d = openLiveCapture(liveHead());
    d.appendRecords(span.bytes);
    const t = d.contents.records;
    expect(t.count).toBe(span.recordCount);
    const byType: Record<string, number> = {};
    let statusBytes = 0;
    let kfBytes = 0;
    let evBytes = 0;
    let kfCount = 0;
    for (let i = 0; i < t.count; i++) {
      const name = Object.entries(RecordType).find(([, v]) => v === t.type[i])?.[0] ?? `0x${t.type[i]!.toString(16)}`;
      const bytes = t.len[i]! + 20;
      byType[name] = (byType[name] ?? 0) + bytes;
      if (t.type[i] === RecordType.STATUS) statusBytes += bytes;
      else if (t.type[i] === RecordType.KEYFRAME) { kfBytes += bytes; kfCount++; }
      else if (t.type[i] === RecordType.EVENT) evBytes += bytes;
    }
    const deflated = deflateRawSync(span.bytes).byteLength;
    result = {
      ...base, tap: stat(tapNs!, tapN), statusBytesAvg: statusBytes / Math.max(1, tapN), seconds, ringBytes: span.bytes.byteLength, statusBytes,
      keyframeBytes: kfBytes, eventBytes: evBytes, otherBytes: span.bytes.byteLength - statusBytes - kfBytes - evBytes, records: byType, deflated,
      eventsPerSecond: sink.eventsWritten / seconds, keyframeBytesEach: kfBytes / Math.max(1, kfCount),
    };
    expect(recorder.badStatus).toBe(0);
    expect(recorder.ring.dropped).toBe(0);
    expect(recorder.ring.evicted).toBe(0);
    expect(Math.abs(seconds - MEASURE_SECONDS)).toBeLessThan(0.1); // the audio clock covered the minute
  } else {
    result = { ...base, tap: null, statusBytesAvg: 0, seconds: MEASURE_SECONDS, ringBytes: 0, statusBytes: 0, keyframeBytes: 0, eventBytes: 0, otherBytes: 0, records: {}, deflated: 0, eventsPerSecond: 0, keyframeBytesEach: 0 };
  }
  backend.dispose();
  return result;
}

const us = (s: Stat): string => `${s.median.toFixed(1)} / ${s.p95.toFixed(1)} / ${s.max.toFixed(0)}`;
const mb = (bytes: number, seconds: number): string => ((bytes / seconds) * 60 / 1e6).toFixed(2);

describe("spike S3's capture scene, idle, through the real core (§7.4)", () => {
  it("records sizes and costs for 64 / 256 / 1,024 live voices, recorder off and on", async (ctx) => {
    const cost: string[] = [
      "| scene | recorder | core quantum without STATUS us (median / p95 / max) | quantum with STATUS | main frame us (mixer + backend.update + scene) | recorder tap us | live / mixed voices (avg) |",
      "|---|---|---|---|---|---|---|",
    ];
    const sizes: string[] = [
      "| scene | STATUS B/block (avg) | ring MB/min raw | STATUS | KEYFRAME | EVENT | other | S3 raw MB/min | take deflated MB/min | 0172 MB/min | events/s | keyframe B each |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ];
    for (const scene of SCENES) {
      for (const armed of [false, true]) {
        const r = await runScene(scene, armed);
        if (!r) return ctx.skip();
        cost.push(`| ${scene.name} | ${armed ? "on" : "off"} | ${us(r.quantaPlain)} | ${us(r.quantaStatus)} | ${us(r.mainFrame)} | ${r.tap ? us(r.tap) : "-"} | ${r.liveAvg.toFixed(0)} / ${r.mixedAvg.toFixed(0)} |`);
        if (armed) {
          sizes.push(`| ${scene.name} | ${r.statusBytesAvg.toFixed(0)} | ${mb(r.ringBytes, r.seconds)} | ${mb(r.statusBytes, r.seconds)} | ${mb(r.keyframeBytes, r.seconds)} | ${mb(r.eventBytes, r.seconds)} | ${mb(r.otherBytes, r.seconds)} | ${scene.s3Raw} | ${mb(r.deflated, r.seconds)} | ${scene.s3Deflated} | ${r.eventsPerSecond.toFixed(0)} | ${r.keyframeBytesEach.toFixed(0)} |`);
          expect(r.ringBytes).toBeGreaterThan(0);
          expect(r.liveAvg).toBeGreaterThan(scene.live * 0.5);
        }
      }
    }
    console.log(`Bn2 S3 scene through the real core, ${WARM_SECONDS} s warm-up and ${MEASURE_SECONDS} s measured per run (container):\n${cost.join("\n")}\n\n${sizes.join("\n")}`);
  });
});
