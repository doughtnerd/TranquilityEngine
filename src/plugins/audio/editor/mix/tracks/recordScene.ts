// @internal Tests only (Pf3d): a scene recorded through the real `EventSink` into a recorder ring and opened as a live capture
// through the in-process Worker handler (as `voiceRoundTrip.test.ts` does), with a STATUS feed the script advances. An event
// is stamped at the newest STATUS frame, so `advance` is what places events on the axis.
import { assembleCapture } from "../../../runtime/capture/format";
import { createEventSink, type EventSink } from "../../../runtime/capture/events";
import { createRecorder, type EpochContext, type KeyframeSource } from "../../../runtime/capture/recorder";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, keyframeCodecForTests, statusBytes } from "../../../runtime/capture/testSupport";
import { CaptureSource } from "../profilerSource";
import { inProcessWorker } from "../voiceSceneSupport";

export const STATUS_FRAMES = 768;
const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };

export interface Scene {
  readonly sink: EventSink;
  /** Feeds STATUS blocks up to `seconds` of audio (the capture's frame 0 is the first STATUS at `STATUS_FRAMES`). */
  advance(seconds: number): void;
  /** Feeds one more STATUS block. */
  step(): void;
  /** The newest STATUS frame. */
  frame(): number;
}

/** Runs `script`, then opens the ring's span as a live capture. `keyframeSource` fills the keyframes (default: empty). */
export async function recordScene(script: (scene: Scene) => void, opts: { keyframeSource?: KeyframeSource } = {}): Promise<CaptureSource> {
  let t = 1000;
  const now = () => (t += 1);
  const r = createRecorder({ ringBytes: 4 * 1024 * 1024, codec: keyframeCodecForTests(), now, ...(opts.keyframeSource ? { keyframeSource: opts.keyframeSource } : {}) });
  r.begin(0, CONTEXT);
  const sink = createEventSink(r, { now });
  let frame = 0;
  const feed = (f: number) => {
    const block = statusBytes(f);
    const data = block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength) as ArrayBuffer;
    r.tap(data, block.byteLength, new DataView(data));
    frame = f;
  };
  feed(STATUS_FRAMES);
  script({
    sink,
    frame: () => frame,
    step: () => feed(frame + STATUS_FRAMES),
    advance(seconds) {
      for (let f = frame + STATUS_FRAMES; f <= seconds * SAMPLE_RATE + STATUS_FRAMES; f += STATUS_FRAMES) feed(f);
    },
  });
  const meta = { ...SAMPLE_META, names: { ...SAMPLE_META.names, clips: {}, buses: {} } };
  const source = await CaptureSource.openLive(assembleCapture(SAMPLE_HEADER, meta, []).slice().buffer, { worker: inProcessWorker() });
  await source.appendSegment(r.takeSpan().bytes.slice().buffer);
  return source;
}

/** A viewport time for a STATUS-stamped event: the frame it was recorded at, as seconds from the capture's first record. */
export function viewportTime(source: CaptureSource, frame: number): number {
  return frame / SAMPLE_RATE - source.startSeconds;
}
