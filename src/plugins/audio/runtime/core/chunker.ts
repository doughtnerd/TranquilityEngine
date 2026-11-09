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
  throw new Error("not implemented: A1.3a-L1");
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

export function createChunkPacer(): ChunkPacer {
  throw new Error("not implemented: A1.3a-L1");
}
