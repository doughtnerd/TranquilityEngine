// Pools of transferable ArrayBuffers for the worklet's port (ADR 0157; architecture §4.7, api-and-models §4.3).
// A buffer is posted with a transfer list, so the sender loses it until the other side posts it back; a pool
// keeps a fixed number of same-sized buffers circulating instead of allocating one per message (no GC in the
// audio thread, little on main). The shell holds the STATUS pool (8 × 20,480 B, STATUS_BUFFER_BYTES); the host holds the BATCH pool
// (4 × 64 KB). Plain data structure: no timers, no ports, no globals.
import { BATCH_MAX_BYTES, STATUS_BUFFER_BYTES, STATUS_POOL_BUFFERS } from "../wire.generated";

/** §4.7: buffers in the host's BATCH pool. */
export const BATCH_POOL_BUFFERS = 4;

/** @internal A fixed pool of `count` buffers of exactly `bytes` bytes each. */
export class BufferPool {
  /** The buffers not currently taken out; preallocated, so `acquire`/`release` never grow it past `count`. */
  private readonly free: ArrayBuffer[];
  /** The one transfer-list array, reused by every `transferList` call (§4.3). */
  private readonly list: [ArrayBuffer];

  /**
   * Allocates all `count` buffers up front (so `available === count`). `count` and `bytes` are positive integers;
   * anything else throws a `RangeError`.
   */
  constructor(
    readonly count: number,
    readonly bytes: number,
  ) {
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(bytes) || bytes <= 0) {
      throw new RangeError(`BufferPool needs a positive integer count and bytes (got ${count} and ${bytes})`);
    }
    this.free = [];
    for (let i = 0; i < count; i++) this.free.push(new ArrayBuffer(bytes));
    this.list = [new ArrayBuffer(0)];
  }

  /** How many buffers are in the pool now (0..count). */
  get available(): number {
    return this.free.length;
  }

  /** Takes a buffer out of the pool, or `null` when it's empty (the caller skips its post, §4.3). Never allocates. */
  acquire(): ArrayBuffer | null {
    return this.free.pop() ?? null;
  }

  /**
   * Puts a buffer (back) into the pool and returns `true`. A buffer that came back through `postMessage` is a new
   * object, so any buffer of exactly `bytes` bytes is accepted. Returns `false` and keeps nothing when the buffer
   * is detached (byteLength 0), has another size, is already in the pool (the same object), or the pool already
   * holds `count` buffers.
   */
  release(buffer: ArrayBuffer): boolean {
    // A detached buffer has byteLength 0, which never equals `bytes` (a positive integer), so one size check covers it.
    if (buffer.byteLength !== this.bytes) return false;
    if (this.free.length >= this.count) return false;
    for (const held of this.free) {
      if (held === buffer) return false;
    }
    this.free.push(buffer);
    return true;
  }

  /**
   * A transfer list holding just `buffer`, for `postMessage(buffer, list)`. The same array object every call
   * (§4.3: "a preallocated transfer-list array"), so posting allocates nothing; use it before the next call.
   */
  transferList(buffer: ArrayBuffer): [ArrayBuffer] {
    this.list[0] = buffer;
    return this.list;
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
