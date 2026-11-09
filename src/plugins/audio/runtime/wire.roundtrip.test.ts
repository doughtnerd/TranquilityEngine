// A0.2-L5: the TypeScript packers against the byte vectors (ADR 0157 section 4.4, "Round-trip test").
// Fill the todo cases. The `test-hooks` wasm cases (decode_batch, schema hash export) belong to later
// tasks and stay out of this file.
import { describe, it } from "vitest";
// import * as wire from "./wire.generated";   // A0.2-L5: the generated API is documented in the brief
// import vectors from "../../../../native/audio/crates/audio-wire/vectors/wire.json";

describe("wire round trip", () => {
  it.todo("A0.2-L5: every vector packs to its hex bytes");
  it.todo("A0.2-L5: every vector reads back to its values (readers where generated: envelope, record head, STATUS)");
  it.todo("A0.2-L5: the asap sentinel 0xFFFFFFFF is written and read as an unsigned value");
  it.todo("A0.2-L5: PLAY panner bits 5-6 and the reserved group field survive a round trip");
  it.todo("A0.2-L5: REPLAY chunk flags (first, last) and a BATCH overflowed flag");
  it.todo("A0.2-L5: STATUS with every header field and every section, including negative minSlackFrames");
  it.todo("A0.2-L5: truncated, oversize and unknown-opcode records are rejected or skipped by length, never read out of bounds");
  it.todo("A0.2-L5: fuzz 1,000 seeded random batches (no throw other than a refusal, no out-of-bounds reads)");
});
