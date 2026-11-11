import { describe, it } from "vitest";
// import { defaultAudioSettings, parseAudioSettings, busBed, busBedPriority } from "../audio/settings";

// L-A6a. ADR 0162 api-and-models §2.1, one block per row; each case checks the range (clamp plus the problem text),
// the default (absent key, no problem) and the refusal (wrong type: default plus the problem text). Skeleton: the
// named cases below are skipped until the leaf fills them.
describe("audio settings: the M3 keys (ADR 0162 §2.1)", () => {
  describe("defaults", () => {
    it.skip("no audio section gives bed.maxBeds 2, ambisonic.maxClips 1, occlusion {layers null, budgetMs 0.25, defaultMaterial concrete, smoothingMs 100, the six built-in materials}, zones {2, 1, 2}, doppler.maxSpeed 150, speedOfSound 343, no problems", () => {});
    it.skip("voices.hrtf stays 16 (the A6b flip is not this task)", () => {});
    it.skip("a section with only the old keys gives every M3 default and no problem", () => {});
  });
  describe("bed.maxBeds", () => {
    it.skip("integer 0..4: 3 is kept, 2.6 rounds to 3, 0 is kept without a problem", () => {});
    it.skip("5 clamps to 4 with `audio.bed.maxBeds: 5 is outside 0..4; using 4.`, -1 clamps to 0", () => {});
    it.skip("a string gives 2 plus `audio.bed.maxBeds: must be a whole number from 0 to 4.`; a non-object `bed` gives `audio.bed must be an object.`", () => {});
  });
  describe("buses[].bed", () => {
    it.skip("absent: busBed gives own for the root and parent for the others, nothing stored on the bus", () => {});
    it.skip("own, parent and none are kept as authored", () => {});
    it.skip("an unknown value is not stored (the default applies) plus `audio.buses[1].bed: must be one of own, parent, none; using \"parent\".` (\"own\" for the root)", () => {});
  });
  describe("buses[].bedPriority", () => {
    it.skip("absent: busBedPriority gives 255 for the root and 128 for the others", () => {});
    it.skip("an authored 0, 200 and 255 are kept; 12.4 rounds to 12", () => {});
    it.skip("300 clamps to 255 with `audio.buses[1].bedPriority: 300 is outside 0..255; using 255.`; a string is not stored plus `...: must be a whole number from 0 to 255.`", () => {});
    it.skip("a duplicate bus name's bed fields are ignored, as maxVoices is", () => {});
  });
  describe("ambisonic.maxClips", () => {
    it.skip("integer 0..4: 2 kept, 0 kept without a problem, 9 clamps to 4 with the problem text, a string gives 1 plus the whole-number problem", () => {});
  });
  describe("occlusion.layers", () => {
    it.skip("absent or null is null (every layer) with no problem", () => {});
    it.skip("a list of names is kept (repeats dropped); an empty list stays [] (occlusion off)", () => {});
    it.skip("with options.physicsLayers an unknown name is dropped plus `audio.occlusion.layers[1]: unknown layer \"Nope\"; dropped.`; without the option names are kept", () => {});
    it.skip("a non-list gives null plus `audio.occlusion.layers: must be a list of layer names or null; using null (every layer).`; a non-string entry is dropped plus `audio.occlusion.layers[0]: must be a layer name; dropped.`", () => {});
  });
  describe("occlusion.budgetMs", () => {
    it.skip("number 0.02..2: 0.5 kept (not rounded), 0.02 and 2 kept, absent 0.25", () => {});
    it.skip("0.001 clamps to 0.02 with `audio.occlusion.budgetMs: 0.001 is outside 0.02..2; using 0.02.`, 5 clamps to 2; a string gives 0.25 plus `...: must be a number from 0.02 to 2; using 0.25.`", () => {});
  });
  describe("occlusion.smoothingMs", () => {
    it.skip("10..1000: 250 kept, absent 100, 5 clamps to 10, 5000 to 1000 with the problem text, a string gives 100 plus the number problem", () => {});
  });
  describe("occlusion.defaultMaterial and materials", () => {
    it.skip("absent: concrete, and the table is the six built-ins in order", () => {});
    it.skip("an authored material is appended; one named like a built-in replaces it in place", () => {});
    it.skip("an unknown defaultMaterial gives the table's first material plus a problem; one that names an authored material is kept", () => {});
    it.skip("a duplicate name is dropped plus a problem; more than 32 authored entries: the rest ignored plus a problem", () => {});
  });
  describe("zones.maxActive", () => {
    it.skip("integer 0..2: 1 kept, 0 kept without a problem, 3 clamps to 2 with the problem text, a string gives 2 plus the whole-number problem", () => {});
  });
  describe("zones.standby", () => {
    it.skip("integer 0..1: 0 kept, 1 kept, absent 1, 2 clamps to 1 with `audio.zones.standby: 2 is outside 0..1; using 1.`, a string gives 1 plus the whole-number problem", () => {});
  });
  describe("zones.maxIrSeconds", () => {
    it.skip("number 0.5..8: 4 kept, 0.7 kept (not rounded), absent 2, 0.1 clamps to 0.5, 20 to 8 with the problem text, a string gives 2 plus the number problem", () => {});
  });
  describe("doppler.maxSpeed", () => {
    it.skip("a number above 0 is kept (1, 150, 100000 all kept, no upper clamp), absent 150", () => {});
    it.skip("0, -5, NaN and a string give 150 plus `audio.doppler.maxSpeed: must be a number above 0; using 150.`; a non-object `doppler` gives `audio.doppler must be an object.`", () => {});
  });
  describe("speedOfSound", () => {
    it.skip("10..100000: 340 kept, absent 343, 1 clamps to 10, 1e6 to 100000 with the problem text, a string gives 343 plus the number problem", () => {});
  });
  describe("the whole section", () => {
    it.skip("a section authoring every M3 key parses to those values with no problems and no throw", () => {});
    it.skip("parse(settings) of a parsed section equals it (round trip), and an M3-free section's buses carry no bed or bedPriority", () => {});
    it.skip("garbage in every M3 section (numbers, nulls, arrays) never throws and leaves every default", () => {});
  });
});
