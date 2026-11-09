import { describe, it } from "vitest";

describe("pcm (A1.3a-L1)", () => {
  it.todo("interleaveF32 interleaves planar channels from a start frame");
  it.todo("interleaveF32 handles mono and a zero-frame range");
  it.todo("interleaveI16 maps -1 to -32768, +1 to 32767, 0 to 0");
  it.todo("interleaveI16 clamps beyond [-1, 1] and maps NaN to 0");
  it.todo("interleaveI16 rounds to nearest, ties away from zero");
  it.todo("interleaveI16 interleaves stereo from a start frame");
});
