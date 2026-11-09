import { describe, expect, it } from "vitest";
import { interleaveF32, interleaveI16 } from "./pcm";

describe("pcm (A1.3a-L1)", () => {
  it("interleaveF32 interleaves planar channels from a start frame", () => {
    const left = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const right = new Float32Array([-0.1, -0.2, -0.3, -0.4]);
    const dst = new Float32Array(4);
    interleaveF32([left, right], 1, 2, dst);
    expect(Array.from(dst)).toEqual([0.2, -0.2, 0.3, -0.3].map((v) => Math.fround(v)));
  });

  it("interleaveF32 handles mono and a zero-frame range", () => {
    const mono = new Float32Array([0.5, -0.5, 0.25]);
    const dst = new Float32Array(3);
    interleaveF32([mono], 0, 3, dst);
    expect(Array.from(dst)).toEqual([0.5, -0.5, 0.25]);

    const untouched = new Float32Array([9, 9]);
    interleaveF32([mono, mono], 0, 0, untouched);
    expect(Array.from(untouched)).toEqual([9, 9]);
  });

  it("interleaveI16 maps -1 to -32768, +1 to 32767, 0 to 0", () => {
    const dst = new Int16Array(3);
    interleaveI16([new Float32Array([-1, 1, 0])], 0, 3, dst);
    expect(Array.from(dst)).toEqual([-32768, 32767, 0]);
  });

  it("interleaveI16 clamps beyond [-1, 1] and maps NaN to 0", () => {
    const dst = new Int16Array(4);
    interleaveI16([new Float32Array([-3, 3, NaN, Infinity])], 0, 4, dst);
    expect(Array.from(dst)).toEqual([-32768, 32767, 0, 32767]);
  });

  it("interleaveI16 rounds to nearest, ties away from zero", () => {
    // 0.5 * 32767 = 16383.5 rounds away to 16384; -0.5 * 32768 = -16384 exactly.
    const dst = new Int16Array(2);
    interleaveI16([new Float32Array([0.5, -0.5])], 0, 2, dst);
    expect(dst[0]).toBe(16384);
    expect(dst[1]).toBe(-16384);

    // Negative side scales by 32768, so -2.5/32768 is an exact tie at -2.5, which goes away from zero to -3.
    const tie = new Int16Array(1);
    interleaveI16([new Float32Array([-2.5 / 32768])], 0, 1, tie);
    expect(tie[0]).toBe(-3);
  });

  it("interleaveI16 interleaves stereo from a start frame", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, -1, 1]);
    const dst = new Int16Array(4);
    interleaveI16([left, right], 1, 2, dst);
    expect(Array.from(dst)).toEqual([0, -32768, -32768, 32767]);
  });
});
