// M4 wire, TypeScript side (task W1; leaf L-W1b fills the skipped cases): the shape word, PLAY `gate` and
// `fadeZero`, STREAM_OPEN `music`, the `musicRings` and `groupStarts` STATUS sections, read against the
// vectors in `native/audio/crates/audio-wire/vectors/wire.json` (which L-Z1a, L-W1a and the generator own).
// The first two cases are live and pin the packers and the older-record rule.
import { describe, expect, it } from "vitest";
import * as wire from "./wire.generated";

describe("M4 wire packers", () => {
  it("shape word and gate packers", () => {
    const shape = wire.packShape(wire.FadeLaw.EqualPowerIn, 0x4000);
    expect(wire.shapeLaw(shape)).toBe(wire.FadeLaw.EqualPowerIn);
    expect(wire.shapeStartPhase(shape)).toBe(0x4000);
    expect(wire.packGate(1023, 64)).toBe(0xffff);
    expect([wire.gateGroupId(0xffff), wire.gateGroupSize(0xffff)]).toEqual([1023, 64]);
    expect(wire.packGate(0, 5)).toBe(0);
  });

  it("an older FADE without the shape word reads shape 0; the writer always writes 28 B", () => {
    const view = new DataView(new ArrayBuffer(64));
    expect(wire.writeFade(view, 0, { voiceId: 1, frameOffset: 2, target: 1, frames: 3, flags: 0 })).toBe(28);
    view.setUint16(2, 6, true);
    expect(wire.readFade(new DataView(view.buffer, 0, 24), 0).shape).toBe(0);
  });
});

describe("M4 wire vectors (L-W1b)", () => {
  /** Every record of `wire.json` for the longer per-voice records, a gated PLAY, STREAM_OPEN with `music`, and the music STATUS sections reads back to its `values` and writes back to its `hex`. */
  it.skip("L-W1b: the gate-family vectors round trip (read, then write, equals hex)", () => {
    throw new Error("L-W1b");
  });

  /** A STATUS with 16 musicRings and 8 groupStarts is STATUS_WORST_CASE_BYTES (16,192) and `readStatus` returns every item; a header count above its cap throws WireError OVERSIZE. */
  it.skip("L-W1b: the STATUS music sections at their caps", () => {
    throw new Error("L-W1b");
  });

  /** Every truncation of a STATUS carrying both sections throws a WireError (never a RangeError); PLAY with gate 0xffff reads group 1023 and size 64. */
  it.skip("L-W1b: truncation fuzz and the corner gate", () => {
    throw new Error("L-W1b");
  });
});
