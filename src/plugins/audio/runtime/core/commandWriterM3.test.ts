// ADR 0162 (A1, leaf L-A1c): the command writer's M3 records (api-and-models §4.2, contracts C1-C5): SET_VOICE_FX,
// BED_CONFIG, ZONE_CONFIG, LISTENER and PLAY bit 7. Skeleton by the A1 lead: every case is skipped with its intent;
// L-A1c fills the methods in commandWriter.ts and un-skips these.
import { describe, it } from "vitest";

describe("CommandWriter, ADR 0162 records", () => {
  it.skip("setVoiceFx writes a 52-byte SET_VOICE_FX that readSetVoiceFx reads back field for field (mask, ramp, hpHz, four sends, yaw, aux)", () => {});
  it.skip("setVoiceFx is stamped like PLAY: with atFrame it sorts and gets a frameOffset; without, it is asap", () => {});
  it.skip("setVoiceFx copies the sends without keeping the caller's array (a later edit to it changes nothing posted)", () => {});
  it.skip("bedConfig writes 20 + pad4(buses) + pad4(2 x slots) bytes (5 buses, 3 slots: 36 B) with zero padding, read back by readBedConfig", () => {});
  it.skip("bedConfig with more than MAX_BEDS slots writes nothing, counts a drop and flags the next batch overflowed", () => {});
  it.skip("zoneConfig writes 24 + 16n bytes (n = 0, 3, 4) read back by readZoneConfig; more than MAX_ZONE_SLOTS slots is dropped and flagged", () => {});
  it.skip("listener writes a 36-byte LISTENER, asap, with flags bit0 set only for snap", () => {});
  it.skip("PLAY with PLAY_FLAGS_AMBISONIC (bit 7) and panner PANNER_BED keeps both bits on the wire", () => {});
  it.skip("the M3 records go out in a BATCH beside M1/M2 records in staging order, and a full staging area drops them like any other record", () => {});
});
