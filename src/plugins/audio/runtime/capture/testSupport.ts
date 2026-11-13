// @internal Tests only (Rc1 and its leaves L-Rc1a, L-Rc1c; Rc1b, Rc5, Rc6 may reuse it): a capture holding every record
// type, built with `format.ts`'s writers. Never imported by runtime code.
import { makeStatusBlock } from "../core/mirror";
import { STATUS_BUFFER_BYTES, writeStatus, type StatusBlock } from "../wire.generated";
import { RecordType, assembleCapture, type CaptureHeaderInit, type CaptureMetaInit, type CaptureRecordInit } from "./format";

export const SAMPLE_RATE = 48_000;

/** A real wire STATUS block (all zero but `currentFrame`), as the recorder copies it. */
export function statusBytes(currentFrame: number): Uint8Array {
  const buf = new Uint8Array(STATUS_BUFFER_BYTES);
  const n = writeStatus(new DataView(buf.buffer), 0, makeStatusBlock({ currentFrame }), 1);
  return buf.slice(0, n);
}

/** A KEYFRAME payload until Rc1b's codec: opaque bytes (the reader only frames it before Rc1b). */
export function keyframeBytesPlaceholder(): Uint8Array {
  return new Uint8Array(32);
}

export const SAMPLE_HEADER: CaptureHeaderInit = { sampleRate: SAMPLE_RATE, preset: 1, startDateMs: 1_763_000_000_000, ringBytes: 16 * 1024 * 1024, firstFrame: 0 };

export const SAMPLE_META: CaptureMetaInit = {
  project: { name: "Sample", version: "1.0.0" },
  engine: "myco test",
  device: { preset: 1, sampleRate: SAMPLE_RATE, deviceMemory: 8, userAgent: "vitest" },
  audio: { buses: [{ name: "Music" }] },
  target: { name: "Console", integrated: -23 },
  names: { clips: { 1: "jump.ogg" }, buses: { 0: "Master", 1: "Music" }, events: {}, parameters: {}, snapshots: {}, targets: { 0: "Console" } },
};

/** One record of every type §5.3 defines for a file (EPOCH, KEYFRAME, STATUS, EVENT with and without its f32, MARKER, NAMES, MIXOP, GAP), one deferred record and one unknown skippable type, seq 1.. in order. */
export function sampleRecords(): CaptureRecordInit[] {
  let seq = 0;
  const r: CaptureRecordInit[] = [];
  const push = (x: Omit<CaptureRecordInit, "seq">) => r.push({ ...x, seq: ++seq } as CaptureRecordInit);
  push({ type: RecordType.EPOCH, epoch: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000.5 } });
  push({ type: RecordType.KEYFRAME, epoch: 0, frame: 768, payload: keyframeBytesPlaceholder() });
  push({ type: RecordType.STATUS, epoch: 0, frame: 768, payload: statusBytes(768) });
  push({ type: RecordType.EVENT, epoch: 0, frame: 800, payload: { perfMs: 1016, kind: 1, reason: 0, args: [7, 1, 1, 0, 800], f32: 0.5 } });
  push({ type: RecordType.EVENT, epoch: 0, frame: 900, payload: { perfMs: 1018, kind: 2, reason: 2, args: [7] } });
  push({ type: RecordType.MARKER, epoch: 0, frame: 1000, payload: { perfMs: 1020, text: "owner joined ✓" } });
  push({ type: RecordType.NAMES, epoch: 0, frame: 1100, payload: { table: 0, id: 2, name: "land.ogg" } });
  push({ type: RecordType.MIXOP, epoch: 0, frame: 1200, payload: { op: 0, class: 0, words: Uint32Array.from([1, 0, 3, 0, 0x3fe00000]), perfMs: 1022, origin: 0 } });
  push({ type: RecordType.EVENT, epoch: 0, frame: 1300, stamp: 200_000, payload: { perfMs: 1024, kind: 11, reason: 0, args: [3], f32: 2 } });
  push({ type: 0x40, epoch: 0, frame: 1400, payload: new Uint8Array([1, 2, 3]) });
  push({ type: RecordType.STATUS, epoch: 0, frame: 1536, payload: statusBytes(1536) });
  push({ type: RecordType.GAP, epoch: 0, frame: 1536, payload: { reason: 1, perfFrom: 1030, perfTo: 2030, firstSeq: 0, lastSeq: 0 } });
  push({ type: RecordType.EPOCH, epoch: 1, frame: 0, payload: { reason: 2, sampleRate: 44_100, limiterLatencyFrames: 64, outputLatencyFrames: 441, timeOffset: 3.25, perfMs: 2031 } });
  push({ type: RecordType.KEYFRAME, epoch: 1, frame: 768, payload: keyframeBytesPlaceholder() });
  push({ type: RecordType.STATUS, epoch: 1, frame: 768, payload: statusBytes(768) });
  return r;
}

/** A real wire STATUS block with the given fields (Rc5's range tests). */
export function statusBytesWith(fields: Partial<StatusBlock> & { currentFrame: number }): Uint8Array {
  const buf = new Uint8Array(STATUS_BUFFER_BYTES);
  const n = writeStatus(new DataView(buf.buffer), 0, makeStatusBlock(fields), 1);
  return buf.slice(0, n);
}

/** Rc5: the STATUS fields `longCaptureRecords` writes for block `k` (so tests can check `range` against them). */
export function longStatusFields(k: number, frame: number): Partial<StatusBlock> & { currentFrame: number } {
  return { currentFrame: frame, underruns: k >> 9, loadPermille: (k * 7) % 1000, mixedVoices: k % 37, minSlackFrames: (k % 101) - 50, busyMsTotal: k * 0.25 };
}

/**
 * Rc5: a synthetic capture of `seconds` at 48 kHz in one epoch: a STATUS every 768 frames (6 quanta, varying fields),
 * a KEYFRAME (Rc1b's placeholder payload) before the first STATUS of each second, a voiceStart EVENT every 4th block and
 * its voiceStop two blocks later, and a MARKER every 60 s. Ten minutes is ≈ 57,000 records, ≈ 11.6 MB stored.
 */
export function longCaptureRecords(seconds: number): CaptureRecordInit[] {
  const r: CaptureRecordInit[] = [];
  let seq = 0;
  const push = (x: Omit<CaptureRecordInit, "seq">) => r.push({ ...x, seq: ++seq } as CaptureRecordInit);
  push({ type: RecordType.EPOCH, epoch: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } });
  const blocks = Math.floor((seconds * SAMPLE_RATE) / 768);
  let second = -1;
  for (let k = 0; k < blocks; k++) {
    const frame = 768 * (k + 1);
    const s = Math.floor(frame / SAMPLE_RATE);
    if (s !== second) {
      second = s;
      push({ type: RecordType.KEYFRAME, epoch: 0, frame, payload: keyframeBytesPlaceholder() });
      if (s % 60 === 0) push({ type: RecordType.MARKER, epoch: 0, frame, payload: { perfMs: 1000 + frame / 48, text: `minute ${s / 60}` } });
    }
    if (k % 4 === 0) push({ type: RecordType.EVENT, epoch: 0, frame: frame + 100, payload: { perfMs: 1000 + frame / 48, kind: 1, reason: 0, args: [k, 1, 1, 0, frame + 100], f32: 0.5 } });
    if (k % 4 === 2) push({ type: RecordType.EVENT, epoch: 0, frame: frame + 200, payload: { perfMs: 1000 + frame / 48, kind: 2, reason: 1, args: [k - 2] } });
    push({ type: RecordType.STATUS, epoch: 0, frame, payload: statusBytesWith(longStatusFields(k, frame)) });
  }
  return r;
}

/** Rc5: `longCaptureRecords(seconds)` as a stored file with an INDEX. */
export function longCapture(seconds: number): Uint8Array {
  return assembleCapture(SAMPLE_HEADER, SAMPLE_META, longCaptureRecords(seconds), { index: true });
}

/** The sample as a stored (uncompressed) file with an INDEX. */
export function sampleCapture(opts: { index?: boolean } = { index: true }): Uint8Array {
  return assembleCapture(SAMPLE_HEADER, SAMPLE_META, sampleRecords(), opts);
}
