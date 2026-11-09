import { describe, it } from "vitest";

// A0.3-L1 fills these (architecture §4.7, api-and-models §4.3).
describe("BufferPool", () => {
  it.todo("starts full: available === count, every buffer bytes long");
  it.todo("refuses a count or size that isn't a positive integer (RangeError)");
  it.todo("acquire hands out count distinct buffers, then null");
  it.todo("release takes back a buffer of the right size, even a different object (as after postMessage)");
  it.todo("release refuses a detached buffer, a wrong size, a duplicate, and a full pool");
  it.todo("transferList returns the same array each call, holding the buffer given");
  it.todo("createStatusPool is 8 × 16,384 B and createBatchPool is 4 × 65,536 B");
});
