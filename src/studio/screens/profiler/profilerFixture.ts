// @internal Stories and tests only: a small capture file for the Profiler screen, built with the capture format's own
// writers (`assembleCapture`, the keyframe codec) and the runtime capture tests' STATUS builder, so it opens through the
// real reader and Worker. Twelve seconds of a hover-bike run: an engine loop, boosts (the third blocked by a voice
// limit), impacts (one stolen), a missing dialogue file, Music ducked from 4 s to 7 s, a Speed parameter, a marker, a
// music transition, and the Forest package loaded from 1.2 s to 9 s (the clip arena and the memory track). Never
// imported by the screen's code.
import { EventKind, RecordType, assembleCapture, encodeKeyframe, keyframeBytes, type CaptureRecordInit, type CaptureReplayOf, type KeyframeBus, type KeyframePayload } from "../../../plugins/audio/runtime/capture/format";
import { EMPTY_KEYFRAME_PAYLOAD, SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, statusBytesWith } from "../../../plugins/audio/runtime/capture/testSupport";

/** Frames per STATUS block (6 quanta of 128). */
const BLOCK = 768;
const NO_NAME = 0xffffffff;

export const FIXTURE_SECONDS = 12;

/** The fixture's names. */
export const FIXTURE_NAMES = {
  clips: { 1: "engine_loop.ogg", 2: "boost.wav", 3: "impact_01.wav", 4: "vo_rider_07.wav", 5: "music_explore.ogg" },
  buses: { 1: "Music", 2: "Vehicles", 3: "Dialogue" },
  events: { 1: "Explore", 2: "Combat" },
  parameters: { 1: "Speed", 2: "Forest" },
} as const;

const f32Bits = (v: number): number => new Uint32Array(Float32Array.of(v).buffer)[0]!;

/** A bus row: unity lanes except `duck` and the authored level. */
function busRow(slot: number, authored: number, duck = 1): KeyframeBus {
  return { slot, gen: 0, flags: 0, lanes: [authored, authored, 1, 1, 1, 1, 1, 1, 1, 1], duck, automation: 1 };
}

function keyframe(second: number): Uint8Array {
  const ducked = second >= 4 && second < 7;
  const payload: KeyframePayload = {
    ...EMPTY_KEYFRAME_PAYLOAD,
    buses: [busRow(1, 0.5, ducked ? 0.5 : 1), busRow(2, 1), busRow(3, 0.8)],
  };
  const out = new Uint8Array(keyframeBytes(payload));
  encodeKeyframe(new DataView(out.buffer), 0, payload);
  return out;
}

type EventSpec = { at: number; kind: number; reason?: number; args: number[]; f32?: number };

/** The fixture's voice and game events, by time (seconds). */
function events(): EventSpec[] {
  const start = (at: number, voice: number, clip: number, slot: number, gain = 0.8): EventSpec => ({ at, kind: EventKind.voiceStart, args: [voice, clip, slot, 0, Math.round(at * SAMPLE_RATE)], f32: gain });
  const stop = (at: number, voice: number): EventSpec => ({ at, kind: EventKind.voiceStop, reason: 1, args: [voice] });
  return [
    start(0.2, 1, 1, 2, 0.7),
    start(0.3, 2, 5, 1),
    { at: 0.4, kind: EventKind.parameter, args: [1, NO_NAME, f32Bits(20)] },
    { at: 1, kind: EventKind.audioPackage, reason: 1, args: [2, 180_000] }, // Forest starts loading
    { at: 1.2, kind: EventKind.audioPackage, reason: 2, args: [2, 180_000, 901_120] }, // Forest loaded, 880 KB resident
    start(1.5, 3, 2, 2),
    stop(2.4, 3),
    { at: 3, kind: EventKind.parameter, args: [1, NO_NAME, f32Bits(80)] },
    start(3.2, 4, 3, 2),
    start(3.4, 5, 3, 2),
    start(3.6, 6, 2, 2),
    { at: 3.7, kind: EventKind.voiceRefused, reason: 1, args: [2, 2] }, // busFull: a third boost blocked
    { at: 3.9, kind: EventKind.voiceSteal, reason: 1, args: [4, 7] }, // impact 4 stolen for voice 7
    start(3.9, 7, 3, 2),
    stop(4.4, 5),
    stop(4.6, 6),
    stop(5.0, 7),
    { at: 6, kind: EventKind.musicTransition, args: [9, 1, 2] },
    { at: 6.5, kind: EventKind.voiceRefused, reason: 4, args: [4, 3] }, // loadFailed: missing dialogue file
    { at: 8, kind: EventKind.parameter, args: [1, NO_NAME, f32Bits(118)] },
    { at: 9, kind: EventKind.audioPackage, reason: 4, args: [2, 180_000, 901_120] }, // Forest unloaded
    stop(10.5, 2),
  ];
}

/** The fixture as capture records: EPOCH, then per block the events up to it, its KEYFRAME (each second) and its STATUS. */
export function fixtureRecords(seconds = FIXTURE_SECONDS): CaptureRecordInit[] {
  const out: CaptureRecordInit[] = [];
  let seq = 0;
  const push = (r: Omit<CaptureRecordInit, "seq">) => out.push({ ...r, seq: ++seq } as CaptureRecordInit);
  push({ type: RecordType.EPOCH, epoch: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } });
  const pending = events();
  const blocks = Math.floor((seconds * SAMPLE_RATE) / BLOCK);
  let second = -1;
  let busy = 0;
  let quanta = 0;
  for (let k = 0; k < blocks; k++) {
    const frame = BLOCK * (k + 1);
    const t = frame / SAMPLE_RATE;
    const s = Math.floor(t);
    while (pending.length && pending[0]!.at <= t) {
      const e = pending.shift()!;
      const at = Math.round(e.at * SAMPLE_RATE);
      push({ type: RecordType.EVENT, epoch: 0, frame: at, payload: { perfMs: 1000 + e.at * 1000, kind: e.kind, reason: e.reason ?? 0, args: e.args, ...(e.f32 !== undefined ? { f32: e.f32 } : {}) } });
    }
    if (s !== second) {
      second = s;
      push({ type: RecordType.KEYFRAME, epoch: 0, frame, payload: keyframe(s) });
      if (s === 5) push({ type: RecordType.MARKER, epoch: 0, frame, payload: { perfMs: 1000 + t * 1000, text: "Boss spawned" } });
    }
    const voices = t < 0.2 ? 0 : t < 1.5 ? 2 : t < 3.2 ? 3 : t < 5 ? 5 : t < 10.5 ? 2 : 1;
    busy += 0.6 + voices * 0.15;
    quanta += 6;
    // ADR 0337 §6: the clip arena holds the loose clips, plus the Forest package while it is loaded (1.2 s to 9 s).
    const arenaUsedKB = 2048 + voices * 64 + (t >= 1.2 && t < 9 ? 880 : 0);
    push({ type: RecordType.STATUS, epoch: 0, frame, payload: statusBytesWith({ currentFrame: frame, liveVoices: voices, mixedVoices: voices, mixedCap: 4, busyMsTotal: busy, quantaTotal: quanta, arenaUsedKB }) });
  }
  return out;
}

/** The fixture as a stored capture file with an INDEX; `replayOf` makes it a replay capture of that take (ADR 0334). */
export function fixtureCapture(seconds = FIXTURE_SECONDS, replayOf?: CaptureReplayOf): Uint8Array {
  const meta = { ...SAMPLE_META, names: { ...SAMPLE_META.names, ...FIXTURE_NAMES }, target: null, ...(replayOf ? { replayOf } : {}) };
  return assembleCapture(SAMPLE_HEADER, meta, fixtureRecords(seconds), { index: true });
}
