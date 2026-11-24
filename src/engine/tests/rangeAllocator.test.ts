// ADR 0370: the first-fit range allocator the shared skinning palette table is cut from (`render/gpuKernels/rangeAllocator.ts`).
import { describe, expect, it } from "vitest";
import { RangeAllocator } from "../render/gpuKernels/rangeAllocator";

describe("RangeAllocator", () => {
  it("hands out ranges end to end and says how big the table must be", () => {
    const a = new RangeAllocator();
    expect(a.end).toBe(0);
    expect(a.allocate(80)).toEqual({ offset: 0, size: 80 });
    expect(a.allocate(3)).toEqual({ offset: 80, size: 3 });
    expect(a.allocate(0)).toEqual({ offset: 83, size: 1 }); // at least one unit
    expect(a.end).toBe(84);
  });

  it("reuses freed ranges first fit, splitting a bigger one, and never shrinks the table", () => {
    const a = new RangeAllocator();
    const x = a.allocate(10);
    const y = a.allocate(10);
    a.allocate(10);
    a.release(x);
    expect(a.allocate(4)).toEqual({ offset: 0, size: 4 });
    expect(a.allocate(6)).toEqual({ offset: 4, size: 6 });
    a.release(y);
    expect(a.allocate(11)).toEqual({ offset: 30, size: 11 }); // doesn't fit the freed 10
    expect(a.end).toBe(41);
  });

  it("merges adjacent freed ranges, so a bigger range fits where several were", () => {
    const a = new RangeAllocator();
    const r = [a.allocate(5), a.allocate(5), a.allocate(5), a.allocate(5)];
    a.release(r[0]);
    a.release(r[2]);
    a.release(r[1]); // joins both neighbours: 0..15 free
    expect(a.allocate(15)).toEqual({ offset: 0, size: 15 });
    expect(a.end).toBe(20);
  });
});
