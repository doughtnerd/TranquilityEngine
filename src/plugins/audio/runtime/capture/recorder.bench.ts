// ADR 0171 amended by 0172 (M5a, task Bn2; architecture §7.3, contract S12's recorder line): the recorder on the main
// thread at 1,024 voices. Run alone (it times main-thread work; a sibling build makes the figures noise):
//
//   npx vitest run --config tools/audio-bench/capture.vitest.config.mts recorder.bench     (about 20 s on an idle machine)
//
// **What it measures.** Main-thread milliseconds per second of audio, on the audio clock's seconds: a STATUS block every
// 768 frames (62.5 a second at 48 kHz, so a second holds 62 or 63 blocks), each second's blocks timed together as one
// sample, 600 seconds (ten minutes of audio) per arm, reported as median, p95 and max over the 600 samples. The block sizes:
// S3's 1,024-voice stream (≈ 2.4 KB average, spike S3's STATUS-raw column), this repo's heavy synthetic block (≈ 6.6 KB, the
// Rc2 cost run), and the wire's worst case (17,824 B, every section at its cap). The arms add what a recording at 1,024
// voices adds, one at a time:
//   tap       the STATUS word copy plus the once-a-second KEYFRAME of 1,024 voices, 16 buses and 9 metered buses (the real
//             `encodeKeyframe`, a preallocated source)
//   +handoff  the sealed segment's copy (`onSegmentSealed`) and the live view's post (R17) each second
//   +events   S3's 1,175 events a second through the real `EventSink` (voice starts and stops, with steals, virtual
//             changes, parameters and bus ramps in S3's proportions)
// The last arm is the whole recorder (§7.3's "Recorder total", ≤ 1 ms/s at 1,024 voices).
//
// **No wall-clock assertion** (ground rules). The cases assert the audio clock (the stream covered the seconds it claims)
// and the structure that makes "zero allocation per block" true: nothing the recorder owns changes identity over the run
// (the ring's buffer, view and segment tables, the tap, the keyframe source's payload, the sink's scratch), nothing was
// evicted or dropped, and no `ArrayBuffer`, typed array, `DataView`, `Map` or `Set` is constructed while a block is taken
// (constructors counted through a `Proxy`, a structural check, never a heap delta). The segment hand-off allocates its
// copy by design (§4.2: a save and the live hand-off are the allocations) and is outside that check.
import { describe, expect, it } from "vitest";
import { createEventSink, type EventSink } from "./events";
import {
  KEYFRAME_BUS_LANES, type KeyframeBus, type KeyframeEvent, type KeyframeMetered, type KeyframeMusic, type KeyframePayload, type KeyframeVoice,
  keyframeBytes, encodeKeyframe,
} from "./format";
import { createRecorder, type EpochContext, type Recorder } from "./recorder";
import { SAMPLE_RATE, liveHead, statusBytesWith, statusBytesWithVoices } from "./testSupport";
import { LOUD_METERS, MAX_DUCK_RULES, MAX_LOUD_ENERGIES, STATUS_WORST_CASE_BYTES } from "../wire.generated";

const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };
const BLOCK = 768;
const VOICES = 1024;
const SECONDS = 600;
const ALLOWANCE_MS_PER_S = 1;
const MiB = 1024 * 1024;

// --- the 1,024-voice scene's main-side state --------------------------------------------------------------------------

function keyframePayload(): KeyframePayload {
  const voices: KeyframeVoice[] = Array.from({ length: VOICES }, (_, i) => ({
    id: i + 1, clip: i % 400, slot: i % 16, state: i % 40 === 0 ? 1 : 0, priority: i % 128, reason: 0, gain: 0.5, pitch: 4096, audibility: 40_000, playheadFrames: i * 977,
  }));
  const buses: KeyframeBus[] = Array.from({ length: 16 }, (_, i) => ({
    slot: i, gen: 1, flags: 0, lanes: Array.from({ length: KEYFRAME_BUS_LANES }, () => 1), duck: 1, automation: 1,
  }));
  const metered: KeyframeMetered[] = Array.from({ length: 9 }, (_, i) => ({
    slot: i, flags: 0, momentary: -20, shortTerm: -21, integrated: -22, lra: 5, maxTruePeak: -3, maxMomentary: -18, elapsed: 60,
  }));
  const events: KeyframeEvent[] = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, asset: i, voices: 3, state: 1, paramsHash: 0x1234 + i }));
  const music: KeyframeMusic[] = Array.from({ length: 3 }, (_, i) => ({
    id: i + 1, segment: i, state: 1, pass: 0, bar: 4, beat: 1, tick: 0, tempo: 120, pendingTo: 0, pendingTimeSec: 0,
  }));
  return { voices, buses, metered, events, music, mix: { slotTableVersion: 1, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 } };
}

/** S3's 1,024-voice stream (spike S3's STATUS-raw 9.18 MB a minute is ≈ 2.4 KB a block): ids, 256 playheads, 32 peaks. */
function s3Block(): Uint8Array {
  return statusBytesWith({
    currentFrame: 0, mixedVoices: 256, liveVoices: VOICES,
    ended: Array.from({ length: 33 }, (_, i) => i + 1),
    demoted: Array.from({ length: 1 }, (_, i) => i + 1),
    playheads: Array.from({ length: 256 }, (_, i) => ({ id: i + 1, clipFrame: i * 17 })),
    peaks: Array.from({ length: 32 }, (_, i) => ({ l: i / 64, r: i / 32 })),
  });
}

/** Every section at its cap: `STATUS_WORST_CASE_BYTES` (17,824 B) with the envelope. */
function worstBlock(): Uint8Array {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  return statusBytesWith({
    currentFrame: 0, musicRingsOpen: 16, mixedVoices: 256, liveVoices: VOICES,
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

const PROFILES: { name: string; block: () => Uint8Array }[] = [
  { name: "S3 stream block", block: s3Block },
  { name: "heavy synthetic block", block: () => statusBytesWithVoices(0, VOICES) },
  { name: "worst-case block", block: worstBlock },
];

// --- the rig ----------------------------------------------------------------------------------------------------------

interface Rig {
  recorder: Recorder;
  sink: EventSink;
  data: ArrayBuffer;
  view: DataView;
  bytes: number;
  payload: KeyframePayload;
  /** Events per second to feed through the sink (S3: 1,175 at 1,024 voices); 0 for none. */
  eventsPerSecond: number;
  posted: { segments: number; bytes: number };
}

interface Arm {
  name: string;
  handOff: boolean;
  events: boolean;
}
const ARMS: Arm[] = [
  { name: "tap (STATUS copy + keyframe)", handOff: false, events: false },
  { name: "+ segment hand-off and live post", handOff: true, events: false },
  { name: "+ events (recorder total)", handOff: true, events: true },
];

function makeRig(block: Uint8Array, arm: Arm): Rig {
  const payload = keyframePayload();
  const recorder = createRecorder({ ringBytes: 32 * MiB, codec: { bytes: keyframeBytes, encode: encodeKeyframe }, keyframeSource: () => payload });
  const sink = createEventSink(recorder);
  const data = block.slice().buffer as ArrayBuffer;
  const posted = { segments: 0, bytes: 0 };
  recorder.begin(0, CONTEXT);
  if (arm.handOff) {
    // The Worker's side (R17): each sealed segment's copy is posted with its buffer transferred. The post here only counts.
    recorder.startLive({
      id: 1, head: liveHead(),
      post: (request) => {
        if (request.type === "appendSegment") {
          posted.segments++;
          posted.bytes += (request.bytes as ArrayBuffer).byteLength;
        }
      },
    });
  }
  return { recorder, sink, data, view: new DataView(data), bytes: block.byteLength, payload, eventsPerSecond: arm.events ? 1175 : 0, posted };
}

/** The events of one block, S3's proportions: starts with a steal now and then, stops, virtual changes, a parameter, a bus ramp. */
function feedEvents(rig: Rig, k: number, count: number): void {
  const { sink } = rig;
  for (let j = 0; j < count; j++) {
    const n = k * 31 + j;
    const id = (n % 4096) + 1;
    switch (n % 8) {
      case 0: case 1: case 2: sink.voiceStart(id, "clip" + (n % 24), 0x300 | (n % 16), n & 3, 0, 0.5); break;
      case 3: case 4: case 5: sink.voiceStop(id, "ended"); break;
      case 6: sink.voiceVirtual(id, "capDemoted"); break;
      default: if (n % 16 === 7) sink.busRamp(0x300 | (n % 16), "runtime", 480, 0.5); else sink.parameter("Speed" + (n % 8), 0.25, null); break;
    }
  }
}

/** Seconds of audio at 48 kHz: second `s` holds the blocks whose first frame lies in it (62 or 63 of them). */
function blocksUpTo(second: number): number {
  return Math.ceil((second * SAMPLE_RATE) / BLOCK);
}

/** Runs `seconds` of audio through the rig, returns each second's main-thread milliseconds (a second's blocks timed together). */
const EMPTY = new Float64Array(0);
function run(rig: Rig, firstBlock: number, seconds: number, record: boolean): Float64Array {
  const samples = record ? new Float64Array(seconds) : EMPTY;
  const { recorder, data, view, bytes } = rig;
  for (let s = 0; s < seconds; s++) {
    const k0 = firstBlock + blocksUpTo(s);
    const k1 = firstBlock + blocksUpTo(s + 1);
    const perBlock = rig.eventsPerSecond / 62.5;
    let owe = 0;
    const t0 = performance.now();
    for (let k = k0; k < k1; k++) {
      view.setFloat64(16, (k + 1) * BLOCK, true);
      recorder.tap(data, bytes, view);
      if (rig.eventsPerSecond > 0) {
        owe += perBlock;
        const n = Math.floor(owe);
        owe -= n;
        feedEvents(rig, k, n);
      }
    }
    if (record) samples[s] = performance.now() - t0;
  }
  return samples;
}

const q = (sorted: Float64Array, p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

function stats(samples: Float64Array): { median: number; p95: number; max: number } {
  const sorted = Float64Array.from(samples).sort();
  return { median: q(sorted, 0.5), p95: q(sorted, 0.95), max: sorted[sorted.length - 1]! };
}

/** Counts constructions of the allocating globals while `fn` runs (a `Proxy` over each constructor). */
function countConstructions(fn: () => void): number {
  const names = ["ArrayBuffer", "SharedArrayBuffer", "DataView", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "Map", "Set"] as const;
  const g = globalThis as unknown as Record<string, unknown>;
  const original = new Map<string, unknown>();
  let count = 0;
  for (const name of names) {
    const ctor = g[name];
    if (typeof ctor !== "function") continue;
    original.set(name, ctor);
    g[name] = new Proxy(ctor as new (...a: unknown[]) => unknown, {
      construct(target, args, newTarget) {
        count++;
        return Reflect.construct(target, args, newTarget === g[name] ? target : newTarget);
      },
    });
  }
  try {
    fn();
  } finally {
    for (const [name, ctor] of original) g[name] = ctor;
  }
  return count;
}

describe("the recorder at 1,024 voices (§7.3, contract S12)", () => {
  it(`reports main ms per second of audio over ${SECONDS} s: median, p95, max, for each block size and arm`, () => {
    const rows: string[] = ["| block | arm | median ms/s | p95 | max | segments posted |", "|---|---|---|---|---|---|"];
    const totals: Record<string, { median: number; p95: number; max: number }> = {};
    for (const profile of PROFILES) {
      const block = profile.block();
      for (const arm of ARMS) {
        const rig = makeRig(block, arm);
        // Warm the JIT on the same path (60 audio seconds, not timed); the timed run continues the clock.
        const warm = 60;
        run(rig, 0, warm, false);
        const first = blocksUpTo(warm);
        const samples = run(rig, first, SECONDS, true);
        const frames = (first + blocksUpTo(SECONDS)) * BLOCK;
        expect(rig.recorder.newestStatusFrame).toBe(frames); // the audio clock covered the seconds claimed
        expect(rig.recorder.badStatus).toBe(0);
        expect(rig.recorder.ring.dropped).toBe(0);
        const st = stats(samples);
        rows.push(`| ${profile.name} (${block.byteLength} B) | ${arm.name} | ${st.median.toFixed(3)} | ${st.p95.toFixed(3)} | ${st.max.toFixed(3)} | ${rig.posted.segments} |`);
        if (profile.name === "S3 stream block") totals[arm.name] = st;
        if (arm.events && st.median > ALLOWANCE_MS_PER_S) {
          console.warn(`recorder tripwire: median ${st.median.toFixed(3)} ms/s on the ${profile.name} is past ${ALLOWANCE_MS_PER_S} ms/s (log and raise; don't trade)`);
        }
      }
    }
    console.log(`Bn2 recorder at ${VOICES} voices, ${SECONDS} audio seconds per cell (container; ≤ ${ALLOWANCE_MS_PER_S} ms/s is §7.3's allowance):\n${rows.join("\n")}`);
    expect(Object.keys(totals).length).toBe(ARMS.length);
  });

  it("allocates nothing per block: the owned objects keep their identity, nothing is evicted or dropped, no buffer or typed array is constructed", () => {
    expect(worstBlock().byteLength).toBe(STATUS_WORST_CASE_BYTES);
    const arm: Arm = { name: "structural", handOff: false, events: true };
    const rig = makeRig(s3Block(), arm);
    const { recorder, payload } = rig;
    const ring = recorder.ring;
    const sink = rig.sink;
    // Intern every name the run uses, so a first use's NAMES record (the one allocation, once per name) is behind us.
    run(rig, 0, 5, false);
    const tables = [ring.segStart, ring.segKeyframe, ring.segKeySeq, ring.segFirstSeq, ring.segRecords, ring.segBytes, ring.segEpoch, ring.segRate, ring.segFrame, ring.segEndFrame];
    const before = { bytes: ring.bytes, view: ring.view, buffer: ring.bytes.buffer, tap: recorder.tap, tables: [...tables], voices: payload.voices, row0: payload.voices[0], row1023: payload.voices[VOICES - 1] };
    const first = blocksUpTo(5);
    const seconds = 120;
    const made = countConstructions(() => {
      run(rig, first, seconds, false);
    });
    expect(made).toBe(0);
    expect(recorder.newestStatusFrame).toBe((first + blocksUpTo(seconds)) * BLOCK);
    expect(sink.eventsDropped).toBe(0);
    expect(sink.eventsWritten).toBeGreaterThan(seconds * 1000);
    expect(ring.evicted).toBe(0);
    expect(ring.dropped).toBe(0);
    expect(ring.bytes).toBe(before.bytes);
    expect(ring.view).toBe(before.view);
    expect(ring.bytes.buffer).toBe(before.buffer);
    expect(recorder.tap).toBe(before.tap);
    expect(payload.voices).toBe(before.voices);
    expect(payload.voices[0]).toBe(before.row0);
    expect(payload.voices[VOICES - 1]).toBe(before.row1023);
    const now = [ring.segStart, ring.segKeyframe, ring.segKeySeq, ring.segFirstSeq, ring.segRecords, ring.segBytes, ring.segEpoch, ring.segRate, ring.segFrame, ring.segEndFrame];
    for (let i = 0; i < now.length; i++) expect(now[i]).toBe(before.tables[i]);
    // The counter does count: a path that builds a view per block (no `view` argument) is seen.
    const seen = countConstructions(() => {
      for (let k = 0; k < 10; k++) recorder.tap(rig.data, rig.bytes);
    });
    expect(seen).toBe(10);
  });
});
