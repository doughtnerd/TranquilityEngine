// ADR 0162 (A1, leaf L-A1b): the status reader's M3 parse (api-and-models §4.3, contract C7): the 144-byte header's
// fields at 112..143 and the `beds`, `zones` and `zoneEvents` sections. Skeleton by the A1 lead: every case is skipped
// with its intent; L-A1b fills `validateM3` and `readM3` in statusReader.ts and un-skips these.
import { describe, it } from "vitest";

describe("StatusReader, ADR 0162 header and sections", () => {
  it.skip("reads every M3 header field (bedVoices, fxVoices, ambisonicVoices, zonesActive, zonesRinging, bedsRefused, zoneUsedKB, workBed, workZones) at its offset, distinct values", () => {});
  it.skip("reads beds, zones and zoneEvents after peaks, equal to the generated readStatus for the same bytes (M1/M2 sections non-empty too)", () => {});
  it.skip("flags bit 6 (STATUS_FLAGS_BED_DECODER_READY) comes through in flags", () => {});
  it.skip("a message with every section at its cap is STATUS_WORST_CASE_BYTES (15,904 B) and reads back equal to readStatus", () => {});
  it.skip("bedsActive above MAX_BEDS, zoneSlots above MAX_ZONE_SLOTS, zoneEventCount above 16 throw WireError OVERSIZE", () => {});
  it.skip("an M3 section that overruns bodyBytes throws WireError OVERSIZE and leaves the previous block unchanged", () => {});
  it.skip("reuses the same block, items and arrays across reads (no allocation): a shorter second message shortens each M3 array", () => {});
});
