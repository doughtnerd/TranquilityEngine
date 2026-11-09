import { describe, expect, it } from "vitest";
import {
  encodeVoiceId,
  isVoiceId,
  nextVoiceGen,
  voiceGen,
  voiceIndex,
} from "./ids";

// A1.1-L1 fills these (api-and-models §3 "Handle encoding"): `id = (gen << 16 | index) >>> 0`, 0 invalid,
// generations 1..65535 bumped on free, skipping 0.
describe("voice ids (§3)", () => {
  it("encodeVoiceId packs gen in the high 16 bits and index in the low 16, as an unsigned 32-bit integer", () => {
    expect(encodeVoiceId(5, 2)).toBe(0x00020005);
    expect(encodeVoiceId(0x1234, 0xabcd)).toBe(0xabcd1234);
    expect(encodeVoiceId(0, 1)).toBe(0x00010000);
  });

  it("voiceIndex and voiceGen recover index and gen for corner values (index 0, 0xffff; gen 1, 0x8000, 0xffff)", () => {
    for (const index of [0, 0xffff]) {
      for (const gen of [1, 0x8000, 0xffff]) {
        const id = encodeVoiceId(index, gen);
        expect(voiceIndex(id)).toBe(index);
        expect(voiceGen(id)).toBe(gen);
      }
    }
  });

  it("an id with gen 0x8000 or above stays positive (>>> 0), never negative", () => {
    for (const gen of [0x8000, 0x8001, 0xffff]) {
      const id = encodeVoiceId(7, gen);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(id)).toBe(true);
    }
    expect(encodeVoiceId(0, 0xffff)).toBe(0xffff0000);
  });

  it("isVoiceId is false for 0, for gen 0, for negatives, non-integers, NaN and values above 0xffffffff", () => {
    expect(isVoiceId(0)).toBe(false);
    expect(isVoiceId(0x00000007)).toBe(false); // gen 0, index 7
    expect(isVoiceId(0x0000ffff)).toBe(false); // gen 0
    expect(isVoiceId(-1)).toBe(false);
    expect(isVoiceId(-0x00010000)).toBe(false);
    expect(isVoiceId(1.5)).toBe(false);
    expect(isVoiceId(0x00010000 + 0.5)).toBe(false);
    expect(isVoiceId(NaN)).toBe(false);
    expect(isVoiceId(Infinity)).toBe(false);
    expect(isVoiceId(0x100000000)).toBe(false);
    expect(isVoiceId(0x1ffff0000)).toBe(false);
  });

  it("isVoiceId is true for every encodeVoiceId(index, gen) with gen 1..65535", () => {
    for (const index of [0, 1, 0x7fff, 0xffff]) {
      for (let gen = 1; gen <= 0xffff; gen += 257) {
        expect(isVoiceId(encodeVoiceId(index, gen))).toBe(true);
      }
      expect(isVoiceId(encodeVoiceId(index, 0xffff))).toBe(true);
      expect(isVoiceId(encodeVoiceId(index, 1))).toBe(true);
    }
  });

  it("nextVoiceGen counts up and wraps 65535 to 1, never returning 0", () => {
    expect(nextVoiceGen(1)).toBe(2);
    expect(nextVoiceGen(0x7fff)).toBe(0x8000);
    expect(nextVoiceGen(0xfffe)).toBe(0xffff);
    expect(nextVoiceGen(0xffff)).toBe(1);
    expect(nextVoiceGen(0)).toBe(1);
    let gen = 1;
    for (let i = 0; i < 0x10000; i++) {
      gen = nextVoiceGen(gen);
      expect(gen).not.toBe(0);
    }
  });

  it("round trip: 10,000 random (index, gen) pairs encode and decode unchanged", () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 10_000; i++) {
      const index = next() & 0xffff;
      const gen = (next() % 0xffff) + 1; // 1..65535
      const id = encodeVoiceId(index, gen);
      expect(voiceIndex(id)).toBe(index);
      expect(voiceGen(id)).toBe(gen);
      expect(isVoiceId(id)).toBe(true);
    }
  });
});
