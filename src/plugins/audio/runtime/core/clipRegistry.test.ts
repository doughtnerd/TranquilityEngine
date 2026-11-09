import { describe, it } from "vitest";

// Written in the lead's core step (A1.3a), against fakes for send / fetchBytes / decode.
describe("clipRegistry (A1.3a)", () => {
  it.todo("acquire runs idle, fetching, decoding, copying and sends CLIP_BEGIN then paced CLIP_CHUNKs");
  it.todo("the resident clip event makes the clip ready and calls onResident once");
  it.todo("refcounts: the same path gives the same id; unload one frame after refs and holders reach 0");
  it.todo("releaseWorld drops a holder");
  it.todo("a refusal event fails the clip with one warning");
  it.todo("a fetch or decode failure fails the clip");
  it.todo("ids carry a generation and never fall in the reserved range");
});
