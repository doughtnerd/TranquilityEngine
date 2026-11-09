// A1.3a-L1: CLIP_CHUNK planning and pacing (architecture sections 4.7 and 5: the core copies at most 256 KB per
// quantum, so main sends at most that much per pacing tick; api-and-models section 4.1 CLIP_CHUNK: `frameOffset`, `frames`).

/** The core's copy budget per quantum (architecture section 5 "Copies"). */
export const CLIP_BYTES_PER_QUANTUM = 256 * 1024;

/** One planned chunk: `frames` frames starting at `frameOffset`. */
export interface ChunkPlan {
  readonly frameOffset: number;
  readonly frames: number;
}

/**
 * Splits a clip of `totalFrames` into chunks of at most `maxBytes` of sample data each:
 * `framesPerChunk = floor(maxBytes / (channels * bytesPerSample))`, at least 1; the chunks are contiguous from
 * frame 0, in order, and the last holds the remainder. `totalFrames` 0 gives no chunks.
 */
export function planChunks(_totalFrames: number, _channels: number, _bytesPerSample: number, _maxBytes: number = CLIP_BYTES_PER_QUANTUM): ChunkPlan[] {
  const chunks: ChunkPlan[] = [];
  if (_totalFrames <= 0) return chunks;
  const framesPerChunk = Math.max(1, Math.floor(_maxBytes / (_channels * _bytesPerSample)));
  for (let offset = 0; offset < _totalFrames; offset += framesPerChunk) {
    chunks.push({ frameOffset: offset, frames: Math.min(framesPerChunk, _totalFrames - offset) });
  }
  return chunks;
}

/** A chunk the pacer hands out: which clip, and which part of it. */
export interface PacedChunk extends ChunkPlan {
  readonly clipId: number;
  /** Sample bytes in this chunk (`frames * channels * bytesPerSample`). */
  readonly bytes: number;
}

/**
 * Paces chunks across clips. Clips queue their plans; each `take(budgetBytes)` (one per pacing tick) returns the
 * next chunks, round-robin across clips with pending chunks (one chunk per clip per turn, fairness), until the next
 * chunk would not fit in what is left of `budgetBytes`. It always returns at least one chunk when any is pending,
 * even if that chunk alone exceeds the budget (a chunk is never split).
 */
export interface ChunkPacer {
  /** Queues `plan` for `clipId`. Chunks of one clip are returned in order. */
  enqueue(clipId: number, plan: readonly ChunkPlan[], channels: number, bytesPerSample: number): void;
  /** Drops every pending chunk of `clipId` (the clip unloaded). Unknown ids are ignored. */
  cancel(clipId: number): void;
  /** The next chunks, at most `budgetBytes` of samples in total (see above); empty when nothing is pending. */
  take(budgetBytes?: number): PacedChunk[];
  /** Pending chunks across all clips. */
  readonly pending: number;
}

/** One clip's pending chunks; `next` indexes the first one not yet taken. */
interface ClipQueue {
  readonly items: PacedChunk[];
  next: number;
}

export function createChunkPacer(): ChunkPacer {
  // Map insertion order is the rotation order. A drained clip is removed, so a re-enqueued clip goes to the back.
  const queues = new Map<number, ClipQueue>();
  let pendingCount = 0;

  return {
    enqueue(clipId, plan, channels, bytesPerSample) {
      if (plan.length === 0) return;
      const bytesPerFrame = channels * bytesPerSample;
      let queue = queues.get(clipId);
      if (queue === undefined) {
        queue = { items: [], next: 0 };
        queues.set(clipId, queue);
      }
      for (const chunk of plan) {
        queue.items.push({
          clipId,
          frameOffset: chunk.frameOffset,
          frames: chunk.frames,
          bytes: chunk.frames * bytesPerFrame,
        });
      }
      pendingCount += plan.length;
    },

    cancel(clipId) {
      const queue = queues.get(clipId);
      if (queue === undefined) return;
      pendingCount -= queue.items.length - queue.next;
      queues.delete(clipId);
    },

    take(budgetBytes = CLIP_BYTES_PER_QUANTUM) {
      const out: PacedChunk[] = [];
      let used = 0;
      let full = false;
      while (!full && queues.size > 0) {
        // Snapshot this round's clips; drained ones leave the map as they finish.
        for (const [clipId, queue] of [...queues]) {
          const chunk = queue.items[queue.next];
          if (out.length > 0 && used + chunk.bytes > budgetBytes) {
            full = true;
            break;
          }
          out.push(chunk);
          used += chunk.bytes;
          queue.next++;
          if (queue.next === queue.items.length) queues.delete(clipId);
        }
      }
      pendingCount -= out.length;
      return out;
    },

    get pending() {
      return pendingCount;
    },
  };
}
