import { describe, it } from "vitest";

// A1.1-L1 fills these (api-and-models §3 "Handle encoding"): `id = (gen << 16 | index) >>> 0`, 0 invalid,
// generations 1..65535 bumped on free, skipping 0.
describe("voice ids (§3)", () => {
  it.todo("encodeVoiceId packs gen in the high 16 bits and index in the low 16, as an unsigned 32-bit integer");
  it.todo("voiceIndex and voiceGen recover index and gen for corner values (index 0, 0xffff; gen 1, 0x8000, 0xffff)");
  it.todo("an id with gen 0x8000 or above stays positive (>>> 0), never negative");
  it.todo("isVoiceId is false for 0, for gen 0, for negatives, non-integers, NaN and values above 0xffffffff");
  it.todo("isVoiceId is true for every encodeVoiceId(index, gen) with gen 1..65535");
  it.todo("nextVoiceGen counts up and wraps 65535 to 1, never returning 0");
  it.todo("round trip: 10,000 random (index, gen) pairs encode and decode unchanged");
});
