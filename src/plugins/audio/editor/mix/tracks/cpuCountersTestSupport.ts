// @internal Tests only (Pf3b): captures of STATUS records with chosen fields, opened through the capture Worker's handler
// run in process, as `profilerSource.test.ts` does, and the `TrackContext` a track factory takes.
import { RecordType, assembleCapture, type CaptureRecordInit } from "../../../runtime/capture/format";
import type { StatusBlock } from "../../../runtime/wire.generated";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, keyframeBytesPlaceholder, statusBytesWith } from "../../../runtime/capture/testSupport";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../../runtime/capture/worker";
import { CaptureSource, type CaptureWorkerLike } from "../profilerSource";
import type { TrackContext } from "./types";

/** One STATUS every 6 quanta of 128 frames. */
export const FRAMES = 768;
export const QUANTA_PER_STATUS = 6;
export const QUANTUM_MS = (128 * 1000) / SAMPLE_RATE;
/** Seconds between two STATUS records. */
export const STATUS_SECONDS = FRAMES / SAMPLE_RATE;

export function inProcessWorker(): CaptureWorkerLike {
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

export type Fields = Partial<StatusBlock>;

/** EPOCH, a KEYFRAME placeholder, then `n` STATUS records (block k at frame 768 (k + 1)) with `fields(k)`. */
export function records(n: number, fields: (k: number) => Fields): CaptureRecordInit[] {
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

export async function open(recs: CaptureRecordInit[]): Promise<CaptureSource> {
  const bytes = assembleCapture(SAMPLE_HEADER, SAMPLE_META, recs, { index: true }).slice().buffer;
  return CaptureSource.openFile(bytes, { worker: inProcessWorker() });
}

export function context(source: CaptureSource): TrackContext {
  return { source, names: { clip: () => undefined, bus: () => undefined, event: () => undefined } };
}

/** The viewport time of STATUS block k (0 = the capture's first record). */
export const timeOf = (source: CaptureSource, k: number): number => (FRAMES * (k + 1)) / SAMPLE_RATE - source.startSeconds;
