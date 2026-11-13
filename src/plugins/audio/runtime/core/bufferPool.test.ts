import { describe, expect, it } from "vitest";
import { STATUS_BUFFER_BYTES, STATUS_POOL_BUFFERS } from "../wire.generated";
import { BufferPool, createBatchPool, createStatusPool } from "./bufferPool";

// A0.3-L1 fills these (architecture §4.7, api-and-models §4.3).
describe("BufferPool", () => {
  it("starts full: available === count, every buffer bytes long", () => {
    const pool = new BufferPool(3, 16);
    expect(pool.available).toBe(3);
    for (let i = 0; i < 3; i++) {
      const buf = pool.acquire();
      expect(buf).not.toBeNull();
      expect(buf!.byteLength).toBe(16);
    }
  });

  it("refuses a count or size that isn't a positive integer (RangeError)", () => {
    expect(() => new BufferPool(0, 16)).toThrow(RangeError);
    expect(() => new BufferPool(-1, 16)).toThrow(RangeError);
    expect(() => new BufferPool(1.5, 16)).toThrow(RangeError);
    expect(() => new BufferPool(NaN, 16)).toThrow(RangeError);
    expect(() => new BufferPool(Infinity, 16)).toThrow(RangeError);
    expect(() => new BufferPool(2, 0)).toThrow(RangeError);
    expect(() => new BufferPool(2, -16)).toThrow(RangeError);
    expect(() => new BufferPool(2, 16.5)).toThrow(RangeError);
  });

  it("acquire hands out count distinct buffers, then null", () => {
    const pool = new BufferPool(4, 8);
    const taken = new Set<ArrayBuffer>();
    for (let i = 0; i < 4; i++) {
      const buf = pool.acquire();
      expect(buf).not.toBeNull();
      taken.add(buf!);
    }
    expect(taken.size).toBe(4);
    expect(pool.available).toBe(0);
    expect(pool.acquire()).toBeNull();
  });

  it("release takes back a buffer of the right size, even a different object (as after postMessage)", () => {
    const pool = new BufferPool(2, 32);
    const original = pool.acquire()!;
    expect(pool.available).toBe(1);
    // Simulate the buffer coming back through postMessage: a new object, same size, original detached.
    const returned = structuredClone(original, { transfer: [original] });
    expect(returned).not.toBe(original);
    expect(pool.release(returned)).toBe(true);
    expect(pool.available).toBe(2);
  });

  it("release refuses a detached buffer, a wrong size, a duplicate, and a full pool", () => {
    const pool = new BufferPool(2, 32);

    // Detached: transfer the buffer away, leaving the original with byteLength 0.
    const detached = pool.acquire()!;
    structuredClone(detached, { transfer: [detached] });
    expect(detached.byteLength).toBe(0);
    expect(pool.release(detached)).toBe(false);
    expect(pool.available).toBe(1);

    // Wrong size.
    expect(pool.release(new ArrayBuffer(31))).toBe(false);
    expect(pool.release(new ArrayBuffer(33))).toBe(false);
    expect(pool.available).toBe(1);

    // Duplicate: a buffer already in the pool (the same object) is refused.
    const held = pool.acquire()!;
    expect(pool.available).toBe(0);
    expect(pool.release(held)).toBe(true);
    expect(pool.release(held)).toBe(false);
    expect(pool.available).toBe(1);

    // Full pool: once the pool holds count buffers, a right-sized new buffer is refused.
    expect(pool.release(new ArrayBuffer(32))).toBe(true);
    expect(pool.available).toBe(2);
    expect(pool.release(new ArrayBuffer(32))).toBe(false);
    expect(pool.available).toBe(2);
  });

  it("transferList returns the same array each call, holding the buffer given", () => {
    const pool = new BufferPool(2, 16);
    const first = new ArrayBuffer(16);
    const second = new ArrayBuffer(16);
    const listA = pool.transferList(first);
    expect(listA).toHaveLength(1);
    expect(listA[0]).toBe(first);
    const listB = pool.transferList(second);
    expect(listB).toBe(listA);
    expect(listB).toHaveLength(1);
    expect(listB[0]).toBe(second);
  });

  it("createStatusPool is STATUS_POOL_BUFFERS × STATUS_BUFFER_BYTES (8 × 20,480 B) and createBatchPool is 4 × 65,536 B", () => {
    const status = createStatusPool();
    expect(status.count).toBe(STATUS_POOL_BUFFERS);
    expect(status.bytes).toBe(STATUS_BUFFER_BYTES);
    expect(STATUS_BUFFER_BYTES).toBe(20480);
    expect(status.available).toBe(STATUS_POOL_BUFFERS);
    expect(status.acquire()!.byteLength).toBe(STATUS_BUFFER_BYTES);

    const batch = createBatchPool();
    expect(batch.count).toBe(4);
    expect(batch.bytes).toBe(65536);
    expect(batch.available).toBe(4);
    expect(batch.acquire()!.byteLength).toBe(65536);
  });
});
