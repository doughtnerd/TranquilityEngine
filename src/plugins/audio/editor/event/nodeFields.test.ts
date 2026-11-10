// L6.3b fills these: the Event editor's field descriptors (nodeFields.ts).
import { describe, it } from "vitest";

describe("nodeFields", () => {
  it.skip("clip: clip asset first, then loop, startOffset, loopRegion (optional), sustain, then the common fields, automation last", () => {});
  it.skip("random: avoidRepeat max is children - 1 (0 with none), mode, gap only when continuous", () => {});
  it.skip("sequence: mode, loop only when continuous, reset only when step, gap only when continuous", () => {});
  it.skip("switch: labelled parameter first, default (optional text), onChange, crossfade only when crossfade", () => {});
  it.skip("blend: parameter; layer: no own fields", () => {});
  it.skip("sustain: release, fade only when release is now", () => {});
  it.skip("parent-given fields: weight under random, value under switch, range and fade under blend, none at the root", () => {});
  it.skip("a sustain under a blend lists fade once", () => {});
  it.skip("limits match parseAudioEvent's (volume 0..4, pitch 0.0625..16, volumeRandom -96..24, pitchRandom -48..48, delay 0..60)", () => {});
  it.skip("every descriptor default equals parseAudioEvent's default for that key", () => {});
  it.skip("names are unique within a list and every field has a label and help", () => {});
});

describe("eventFields", () => {
  it.skip("lists bus, volume, pitch, volumeRandom, pitchRandom, priority, spatial, limit, cooldown, automation in order", () => {});
  it.skip("spatial is an optional group with minDistance, maxDistance, rolloff; limit a required group", () => {});
  it.skip("priority is an integer 0..255, maxInstances an integer 0..4096, cooldown 0..60", () => {});
});

describe("field values", () => {
  it.skip("findField finds by name at the top level", () => {});
  it.skip("readField reads a key, undefined when absent", () => {});
  it.skip("writeField copies, sets, removes an optional key on undefined, never mutates", () => {});
  it.skip("writeField gives a required field its default on undefined", () => {});
  it.skip("coerceField: number clamp, integer rounding, non-finite to default", () => {});
  it.skip("coerceField: range clamp and swap, optional undefined stays undefined", () => {});
  it.skip("coerceField: select falls back to default, asset drops asset:, optional text maps empty to undefined, boolean", () => {});
});
