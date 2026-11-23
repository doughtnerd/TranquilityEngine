// The audio topic's `capture` subscription, build side (plan task A1; schema in `schema.ts`): the live capture feed a
// connected tool's Profiler follows. It joins the capture ring as an owner, as the editor's Profiler live follow does
// (`captureLiveHost.join()`, `editor/mix/liveFollow.ts`), and queues what the recorder posts: the ring's head (part 0),
// then each sealed segment in order (part = the recorder's `appendSegment` id, 1, 2, … from `startLive({ id: 0 })`). Each
// part is cut into `CAPTURE_PIECE_BYTES` pieces (`count` = ceil(bytes / CAPTURE_PIECE_BYTES), at least 1), and each sample
// takes whole pieces from the queue's front while their records fit in `AUDIO_SAMPLE_BYTES` (always at least one). If the
// ring evicted a segment before it was posted (`liveLost`), one `captureLost` record follows what was queued, the hold
// ends and nothing comes after it. Closing ends the hold (`release()`): with no take the ring is freed, a take keeps it.
// Loaded only by `import()` (through `topic.ts`), so release exports hold none of it.
import { RECORD_HEAD_BYTES, type RecordWriter } from "../../../../engine/debugLink/records";
import type { DebugSubscription } from "../../../../engine/debugLink/topics";
import type { CaptureLiveHost, CaptureLiveRecording } from "../capture/capture";
import { AUDIO_SAMPLE_BYTES, AudioLinkRecord, CAPTURE_PIECE_BYTES, encodeCapturePiece } from "./schema";

interface Queued {
  readonly type: number;
  readonly payload: Uint8Array;
}

/** A `capture` subscription over `host` (the build's `captureLiveHost`). */
export function captureSubscription(host: CaptureLiveHost): DebugSubscription {
  const queue: Queued[] = [];
  let head = 0;
  let rec: CaptureLiveRecording | null = null;
  let closed = false;
  /** The feed ended (lost, or the ring couldn't be joined): `captureLost` is queued, nothing more is. */
  let ended = false;
  let seq = 0;

  const queuePart = (type: number, part: number, bytes: Uint8Array): void => {
    const count = Math.max(1, Math.ceil(bytes.byteLength / CAPTURE_PIECE_BYTES));
    for (let index = 0; index < count; index++) {
      const piece = bytes.subarray(index * CAPTURE_PIECE_BYTES, Math.min(bytes.byteLength, (index + 1) * CAPTURE_PIECE_BYTES));
      queue.push({ type, payload: encodeCapturePiece({ part, index, count, bytes: piece }) });
    }
  };

  const release = (): void => {
    const r = rec;
    rec = null;
    if (!r) return;
    try {
      r.stopLive();
    } finally {
      r.release();
    }
  };

  const end = (): void => {
    if (ended) return;
    ended = true;
    queue.push({ type: AudioLinkRecord.captureLost, payload: new Uint8Array(0) });
    release();
  };

  host.join().then(
    (joined) => {
      if (closed) {
        joined.release(); // closed while the recorder loaded: it never held the ring
        return;
      }
      rec = joined;
      const ringHead = joined.head();
      queuePart(AudioLinkRecord.captureHead, 0, ringHead);
      joined.startLive({
        head: ringHead,
        id: 0,
        post: (request) => {
          if (request.type !== "appendSegment" || ended || closed) return; // `open` is the head, queued above
          queuePart(AudioLinkRecord.captureSegment, request.id, new Uint8Array(request.bytes));
        },
      });
    },
    () => {
      if (!closed) end(); // no ring to follow: the feed ends at once
    },
  );

  return {
    sample(out: RecordWriter, frame: number): void {
      if (rec?.liveLost) end();
      let bytes = 0;
      while (head < queue.length) {
        const next = queue[head]!;
        const size = RECORD_HEAD_BYTES + next.payload.byteLength;
        if (bytes > 0 && bytes + size > AUDIO_SAMPLE_BYTES) break;
        out.write(next.type, seq++, frame, next.payload);
        bytes += size;
        head++;
      }
      if (head === queue.length) {
        queue.length = 0;
        head = 0;
      } else if (head > 1024) {
        queue.splice(0, head);
        head = 0;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      queue.length = 0;
      head = 0;
      release();
    },
  };
}
