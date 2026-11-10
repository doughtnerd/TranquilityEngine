// Stream flow control (B3; architecture §3.4, §4.7): credits pull chunks from the decoder worker to the worklet. The
// worker keeps `buffered + inFlight <= STREAM_WINDOW_FRAMES` (32,768 frames, 0.68 s at 48 kHz, the core's ring, which
// survived a 300 ms decoder stall) and idles, with no timers, until a credit frees room; the worklet credits every
// `STREAM_CREDIT_FRAMES` (4,096) frames its stream voices consume, returning the emptied chunk buffers with the credit.
// Both halves are plain counters, shared by the worker (`streams.ts`) and the shell (`worklet/coreDriver.ts`).

/** Frames per STREAM_CHUNK (architecture §4.7). */
export const STREAM_CHUNK_FRAMES = 4096;
/** The credit window: frames buffered in the ring plus in flight (the core's ring, the wire's `STREAM_RING_FRAMES`). */
export const STREAM_WINDOW_FRAMES = 32768;
/** The shell credits once this many frames were consumed (architecture §4.7: "credit every 4,096 consumed"). */
export const STREAM_CREDIT_FRAMES = 4096;

/** The worker's side: frames sent and not yet credited back. */
export class CreditWindow {
  /** Frames sent and not credited (buffered in the ring or in flight). */
  outstanding = 0;

  constructor(readonly window = STREAM_WINDOW_FRAMES) {}

  /** Whether `frames` more may be sent now. */
  canSend(frames = STREAM_CHUNK_FRAMES): boolean {
    return this.outstanding + frames <= this.window;
  }

  /** `frames` were sent. */
  sent(frames: number): void {
    this.outstanding += frames;
  }

  /** The worklet consumed `frames` (a STREAM_CREDIT). Never below 0 (a credit for frames of an older epoch). */
  credit(frames: number): void {
    this.outstanding = Math.max(0, this.outstanding - Math.max(0, frames));
  }

  /** A new epoch (a seek or reopen): nothing is outstanding on the new ring. */
  reset(): void {
    this.outstanding = 0;
  }
}

/** The shell's side, per stream: consumed frames gathered until a credit is due. */
export class CreditAccumulator {
  /** Consumed frames not yet credited. */
  pending = 0;

  constructor(readonly every = STREAM_CREDIT_FRAMES) {}

  /** The core reported `frames` more consumed. Returns true when a credit is due. */
  add(frames: number): boolean {
    if (frames > 0) this.pending += frames;
    return this.pending >= this.every;
  }

  /** Takes what is pending (the credit's `consumedFrames`). */
  take(): number {
    const n = this.pending;
    this.pending = 0;
    return n;
  }
}
