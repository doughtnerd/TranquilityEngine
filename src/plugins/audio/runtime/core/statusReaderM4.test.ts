// ADR 0166 M4 (Z4, leaf L-Z4a; api-and-models §4.4): the 176-byte STATUS header and the `musicRings` and `groupStarts`
// sections. Every case compares against the generated `readStatus` / `writeStatus` for the same bytes. Skipped until
// L-Z4a fills `StatusReader.validateM4` and `readM4`.
import { describe, it } from "vitest";

describe("StatusReader, ADR 0166 header and sections (L-Z4a)", () => {
  it.skip("reads every M4 header field (musicRingsOpen 148, streamStartsLate 150, groupsLate 152, groupsHeld 154, groupsAbandoned 156, curvePoolFull 158, maxSlipFrames 160, splitQuanta 164, voiceSplits 168, reserved 172) at its offset, distinct values", () => {});
  it.skip("reads musicRings and groupStarts after zoneEvents, equal to the generated readStatus for the same bytes (every older section non-empty too)", () => {});
  it.skip("a message with every section at its cap is STATUS_WORST_CASE_BYTES (16,192 B) and reads back equal to readStatus (16 musicRings, 8 groupStarts)", () => {});
  it.skip("musicRings above MAX_MUSIC_RINGS and groupStarts above MAX_GROUP_STARTS_PER_BLOCK throw WireError OVERSIZE with the messages readStatus gives", () => {});
  it.skip("a musicRings or groupStarts section that overruns bodyBytes throws WireError OVERSIZE and leaves the previous block unchanged (M4 fields too)", () => {});
  it.skip("reuses the same block, items and arrays across reads (no allocation): a shorter second message shortens musicRings and groupStarts", () => {});
  it.skip("the epochFlags bits (epoch 0-29, primed 30, bound 31) and groupStarts flags (late, held, abandoned) come through unsigned (bit 31 does not read negative)", () => {});
});
