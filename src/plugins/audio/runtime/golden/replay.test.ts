// The golden replay module's generators and digest (`replay.ts`), against values worked by hand from their native twins
// (`audio-dsp/tests/bed_identity.rs`' FNV-1a 64, `in_voice_goldens.rs`' clips, `gate_common::noise32`). The replays
// themselves are checked by every golden suite matching its native digest.
import { describe, expect, it } from "vitest";
import { clipSamples, fnv1a64, noise32 } from "./replay";

describe("golden replay", () => {
  it("fnv1a64: the empty input is the offset basis, and one f32 1.0 hashes as its four bytes", () => {
    expect(fnv1a64(new Float32Array(0), new Float32Array(0))).toBe("cbf29ce484222325");
    // 1.0f32 is 0x3f800000, little-endian bytes 00 00 80 3f; folded byte by byte, by hand.
    let h = 0xcbf29ce484222325n;
    for (const b of [0x00, 0x00, 0x80, 0x3f]) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    expect(fnv1a64(new Float32Array([1]), new Float32Array(0))).toBe(h.toString(16).padStart(16, "0"));
  });

  it("clipSamples: dc and lcg clips are built exactly", () => {
    expect(Array.from(clipSamples({ id: 0, frames: 4, fill: "dc", value: 0.5 }))).toEqual([0.5, 0.5, 0.5, 0.5]);
    // seed 1: state = 1 * 1664525 + 1013904223 = 1015568748; the first sample is (state >>> 8) / 2^24 - 0.5.
    const lcg = clipSamples({ id: 1, frames: 2, fill: "lcg", seed: 1, amp: 1 });
    expect(lcg.length).toBe(2);
    expect(lcg[0]).toBe((1015568748 >>> 8) / 16777216 - 0.5);
  });

  it("noise32 matches the Rust generator's first values", () => {
    // Worked by hand from gate_common::noise32 for seed 0, frame 0: h = 0 throughout, so (0 >>> 8) / 2^24 - 0.5 = -0.5.
    expect(noise32(0, 0, 0)).toBe(-0.125);
    // Every value is a 24-bit fraction times 0.25: exact in f32.
    for (let k = 0; k < 64; k++) for (const ch of [0, 1]) expect(Math.fround(noise32(0x1234, k, ch))).toBe(noise32(0x1234, k, ch));
  });
});
