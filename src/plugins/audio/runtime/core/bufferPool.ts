// Pools of transferable ArrayBuffers for the worklet's port (ADR 0157; architecture §4.7, api-and-models §4.3).
// A buffer is posted with a transfer list, so the sender loses it until the other side posts it back; a pool
// keeps a fixed number of same-sized buffers circulating instead of allocating one per message (no GC in the
// audio thread, little on main). The shell holds the STATUS pool (8 × 16 KB); the host holds the BATCH pool
// (4 × 64 KB). Plain data structure: no timers, no ports, no globals.
import { BATCH_MAX_BYTES, STATUS_BUFFER_BYTES, STATUS_POOL_BUFFERS } from "../wire.generated";

/** §4.7: buffers in the host's BATCH pool. */
export const BATCH_POOL_BUFFERS = 4;

/** @internal A fixed pool of `count` buffers of exactly `bytes` bytes each. */
export class BufferPool {
  /**
   * Allocates all `count` buffers up front (so `available === count`). `count` and `bytes` are positive integers;
   * anything else throws a `RangeError`.
   */
  constructor(
    readonly count: number,
    readonly bytes: number,
  ) {
    throw new Error("not implemented: A0.3-L1");
  }

  /** How many buffers are in the pool now (0..count). */
  get available(): number {
    throw new Error("not implemented: A0.3-L1");
  }

  /** Takes a buffer out of the pool, or `null` when it's empty (the caller skips its post, §4.3). Never allocates. */
  acquire(): ArrayBuffer | null {
    throw new Error("not implemented: A0.3-L1");
  }

  /**
   * Puts a buffer (back) into the pool and returns `true`. A buffer that came back through `postMessage` is a new
   * object, so any buffer of exactly `bytes` bytes is accepted. Returns `false` and keeps nothing when the buffer
   * is detached (byteLength 0), has another size, is already in the pool (the same object), or the pool already
   * holds `count` buffers.
   */
  release(buffer: ArrayBuffer): boolean {
    throw new Error("not implemented: A0.3-L1");
  }

  /**
   * A transfer list holding just `buffer`, for `postMessage(buffer, list)`. The same array object every call
   * (§4.3: "a preallocated transfer-list array"), so posting allocates nothing; use it before the next call.
   */
  transferList(buffer: ArrayBuffer): [ArrayBuffer] {
    throw new Error("not implemented: A0.3-L1");
  }
}

/** @internal The shell's STATUS pool: 8 buffers of 16,384 bytes (§4.3, §4.7). */
export function createStatusPool(): BufferPool {
  return new BufferPool(STATUS_POOL_BUFFERS, STATUS_BUFFER_BYTES);
}

/** @internal The host's BATCH pool: 4 buffers of 64 KB (§4.7). */
export function createBatchPool(): BufferPool {
  return new BufferPool(BATCH_POOL_BUFFERS, BATCH_MAX_BYTES);
}
