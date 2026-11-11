import { describe, expect, it } from "vitest";
import { defaultAudioSettings, parseAudioSettings, busBed, busBedPriority, type AudioSettings } from "../audio/settings";

const bus = (s: AudioSettings, name: string) => s.buses.find((b) => b.name === name)!;

// L-A6a. ADR 0162 api-and-models §2.1, one block per row; each case checks the range (clamp plus the problem text),
// the default (absent key, no problem) and the refusal (wrong type: default plus the problem text). The material
// cases (`occlusion.defaultMaterial and materials`) depend on the material leaf and stay skipped.
describe("audio settings: the M3 keys (ADR 0162 §2.1)", () => {
  describe("defaults", () => {
    it("no audio section gives bed.maxBeds 2, ambisonic.maxClips 1, occlusion {layers null, budgetMs 0.25, defaultMaterial concrete, smoothingMs 100, the six built-in materials}, zones {2, 1, 2}, doppler.maxSpeed 150, speedOfSound 343, no problems", () => {
      const { settings, problems } = parseAudioSettings(undefined);
      expect(problems).toEqual([]);
      expect(settings.bed).toEqual({ maxBeds: 2 });
      expect(settings.ambisonic).toEqual({ maxClips: 1 });
      expect(settings.occlusion.layers).toBeNull();
      expect(settings.occlusion.budgetMs).toBe(0.25);
      expect(settings.occlusion.defaultMaterial).toBe("concrete");
      expect(settings.occlusion.smoothingMs).toBe(100);
      expect(settings.occlusion.materials.map((m) => m.name)).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete"]);
      expect(settings.zones).toEqual({ maxActive: 2, standby: 1, maxIrSeconds: 2 });
      expect(settings.doppler).toEqual({ maxSpeed: 150 });
      expect(settings.speedOfSound).toBe(343);
      expect(defaultAudioSettings().speedOfSound).toBe(343);
    });
    it("voices.hrtf stays 16 (the A6b flip is not this task)", () => {
      expect(parseAudioSettings(undefined).settings.voices.hrtf).toBe(16);
      expect(parseAudioSettings({}).settings.voices.hrtf).toBe(16);
    });
    it("a section with only the old keys gives every M3 default and no problem", () => {
      const { settings, problems } = parseAudioSettings({
        buses: [{ name: "Master" }, { name: "Music", parent: "Master", volume: 0.8 }],
        snapshots: [{ name: "Paused", volumes: { Music: 0.3 }, lowpass: {} }],
        ducking: [{ target: "Music", trigger: "Master", amount: 0.4, attack: 0.1, release: 0.6 }],
        voices: { mixed: 64 },
        backend: "babylon",
      });
      expect(problems).toEqual([]);
      expect(settings.bed).toEqual({ maxBeds: 2 });
      expect(settings.ambisonic).toEqual({ maxClips: 1 });
      expect(settings.occlusion.layers).toBeNull();
      expect(settings.occlusion.budgetMs).toBe(0.25);
      expect(settings.occlusion.smoothingMs).toBe(100);
      expect(settings.zones).toEqual({ maxActive: 2, standby: 1, maxIrSeconds: 2 });
      expect(settings.doppler.maxSpeed).toBe(150);
      expect(settings.speedOfSound).toBe(343);
    });
  });

  describe("bed.maxBeds", () => {
    it("integer 0..4: 3 is kept, 2.6 rounds to 3, 0 is kept without a problem", () => {
      const three = parseAudioSettings({ bed: { maxBeds: 3 } });
      expect(three.settings.bed.maxBeds).toBe(3);
      expect(three.problems).toEqual([]);
      const rounded = parseAudioSettings({ bed: { maxBeds: 2.6 } });
      expect(rounded.settings.bed.maxBeds).toBe(3);
      expect(rounded.problems).toEqual([]);
      const zero = parseAudioSettings({ bed: { maxBeds: 0 } });
      expect(zero.settings.bed.maxBeds).toBe(0);
      expect(zero.problems).toEqual([]);
    });
    it("5 clamps to 4 with `audio.bed.maxBeds: 5 is outside 0..4; using 4.`, -1 clamps to 0", () => {
      const high = parseAudioSettings({ bed: { maxBeds: 5 } });
      expect(high.settings.bed.maxBeds).toBe(4);
      expect(high.problems).toEqual(["audio.bed.maxBeds: 5 is outside 0..4; using 4."]);
      const low = parseAudioSettings({ bed: { maxBeds: -1 } });
      expect(low.settings.bed.maxBeds).toBe(0);
      expect(low.problems).toEqual(["audio.bed.maxBeds: -1 is outside 0..4; using 0."]);
    });
    it("a string gives 2 plus `audio.bed.maxBeds: must be a whole number from 0 to 4.`; a non-object `bed` gives `audio.bed must be an object.`", () => {
      const str = parseAudioSettings({ bed: { maxBeds: "3" } });
      expect(str.settings.bed.maxBeds).toBe(2);
      expect(str.problems).toEqual(["audio.bed.maxBeds: must be a whole number from 0 to 4."]);
      const notObject = parseAudioSettings({ bed: 5 });
      expect(notObject.settings.bed.maxBeds).toBe(2);
      expect(notObject.problems).toEqual(["audio.bed must be an object."]);
    });
  });

  describe("buses[].bed", () => {
    it("absent: busBed gives own for the root and parent for the others, nothing stored on the bus", () => {
      const { settings, problems } = parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }] });
      expect(problems).toEqual([]);
      expect(busBed(settings, "Master")).toBe("own");
      expect(busBed(settings, "SFX")).toBe("parent");
      expect(bus(settings, "Master")).not.toHaveProperty("bed");
      expect(bus(settings, "SFX")).not.toHaveProperty("bed");
    });
    it("own, parent and none are kept as authored", () => {
      const { settings, problems } = parseAudioSettings({
        buses: [{ name: "Master", bed: "own" }, { name: "A", parent: "Master", bed: "parent" }, { name: "B", parent: "Master", bed: "none" }],
      });
      expect(problems).toEqual([]);
      expect(bus(settings, "Master").bed).toBe("own");
      expect(bus(settings, "A").bed).toBe("parent");
      expect(bus(settings, "B").bed).toBe("none");
      expect(busBed(settings, "B")).toBe("none");
    });
    it("an unknown value is not stored (the default applies) plus `audio.buses[1].bed: must be one of own, parent, none; using \"parent\".` (\"own\" for the root)", () => {
      const other = parseAudioSettings({ buses: [{ name: "Master" }, { name: "Music", parent: "Master", bed: "loud" }] });
      expect(other.problems).toEqual([`audio.buses[1].bed: must be one of own, parent, none; using "parent".`]);
      expect(bus(other.settings, "Music")).not.toHaveProperty("bed");
      expect(busBed(other.settings, "Music")).toBe("parent");
      const root = parseAudioSettings({ buses: [{ name: "Master", bed: "loud" }, { name: "SFX", parent: "Master" }] });
      expect(root.problems).toEqual([`audio.buses[0].bed: must be one of own, parent, none; using "own".`]);
      expect(bus(root.settings, "Master")).not.toHaveProperty("bed");
      expect(busBed(root.settings, "Master")).toBe("own");
    });
  });

  describe("buses[].bedPriority", () => {
    it("absent: busBedPriority gives 255 for the root and 128 for the others", () => {
      const { settings, problems } = parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }] });
      expect(problems).toEqual([]);
      expect(busBedPriority(settings, "Master")).toBe(255);
      expect(busBedPriority(settings, "SFX")).toBe(128);
      expect(bus(settings, "SFX")).not.toHaveProperty("bedPriority");
    });
    it("an authored 0, 200 and 255 are kept; 12.4 rounds to 12", () => {
      const { settings, problems } = parseAudioSettings({
        buses: [
          { name: "Master", bedPriority: 0 },
          { name: "A", parent: "Master", bedPriority: 200 },
          { name: "B", parent: "Master", bedPriority: 255 },
          { name: "C", parent: "Master", bedPriority: 12.4 },
        ],
      });
      expect(problems).toEqual([]);
      expect(bus(settings, "Master").bedPriority).toBe(0);
      expect(bus(settings, "A").bedPriority).toBe(200);
      expect(bus(settings, "B").bedPriority).toBe(255);
      expect(bus(settings, "C").bedPriority).toBe(12);
    });
    it("300 clamps to 255 with `audio.buses[1].bedPriority: 300 is outside 0..255; using 255.`; a string is not stored plus `...: must be a whole number from 0 to 255.`", () => {
      const high = parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master", bedPriority: 300 }] });
      expect(bus(high.settings, "SFX").bedPriority).toBe(255);
      expect(high.problems).toEqual([`audio.buses[1].bedPriority: 300 is outside 0..255; using 255.`]);
      const str = parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master", bedPriority: "12" }] });
      expect(str.settings.buses[1]).not.toHaveProperty("bedPriority");
      expect(busBedPriority(str.settings, "SFX")).toBe(128);
      expect(str.problems).toEqual([`audio.buses[1].bedPriority: must be a whole number from 0 to 255.`]);
    });
    it("a duplicate bus name's bed fields are ignored, as maxVoices is", () => {
      const { settings, problems } = parseAudioSettings({
        buses: [
          { name: "Master" },
          { name: "SFX", parent: "Master", bed: "none", bedPriority: 5 },
          { name: "SFX", parent: "Master", bed: "own", bedPriority: 9 },
        ],
      });
      expect(settings.buses).toHaveLength(2);
      expect(busBed(settings, "SFX")).toBe("none");
      expect(busBedPriority(settings, "SFX")).toBe(5);
      expect(problems).toEqual([`audio.buses[2]: another bus is already named "SFX".`]);
    });
  });

  describe("ambisonic.maxClips", () => {
    it("integer 0..4: 2 kept, 0 kept without a problem, 9 clamps to 4 with the problem text, a string gives 1 plus the whole-number problem", () => {
      const two = parseAudioSettings({ ambisonic: { maxClips: 2 } });
      expect(two.settings.ambisonic.maxClips).toBe(2);
      expect(two.problems).toEqual([]);
      const zero = parseAudioSettings({ ambisonic: { maxClips: 0 } });
      expect(zero.settings.ambisonic.maxClips).toBe(0);
      expect(zero.problems).toEqual([]);
      const high = parseAudioSettings({ ambisonic: { maxClips: 9 } });
      expect(high.settings.ambisonic.maxClips).toBe(4);
      expect(high.problems).toEqual(["audio.ambisonic.maxClips: 9 is outside 0..4; using 4."]);
      const str = parseAudioSettings({ ambisonic: { maxClips: "2" } });
      expect(str.settings.ambisonic.maxClips).toBe(1);
      expect(str.problems).toEqual(["audio.ambisonic.maxClips: must be a whole number from 0 to 4."]);
    });
  });

  describe("occlusion.layers", () => {
    it("absent or null is null (every layer) with no problem", () => {
      expect(parseAudioSettings({}).settings.occlusion.layers).toBeNull();
      const explicit = parseAudioSettings({ occlusion: { layers: null } });
      expect(explicit.settings.occlusion.layers).toBeNull();
      expect(explicit.problems).toEqual([]);
      const absent = parseAudioSettings({ occlusion: {} });
      expect(absent.settings.occlusion.layers).toBeNull();
      expect(absent.problems).toEqual([]);
    });
    it("a list of names is kept (repeats dropped); an empty list stays [] (occlusion off)", () => {
      const list = parseAudioSettings({ occlusion: { layers: ["Ground", "Walls", "Ground"] } });
      expect(list.settings.occlusion.layers).toEqual(["Ground", "Walls"]);
      expect(list.problems).toEqual([]);
      const empty = parseAudioSettings({ occlusion: { layers: [] } });
      expect(empty.settings.occlusion.layers).toEqual([]);
      expect(empty.problems).toEqual([]);
    });
    it("with options.physicsLayers an unknown name is dropped plus `audio.occlusion.layers[1]: unknown layer \"Nope\"; dropped.`; without the option names are kept", () => {
      const physicsLayers = ["Ground", "Walls"];
      const checked = parseAudioSettings({ occlusion: { layers: ["Ground", "Nope"] } }, { physicsLayers });
      expect(checked.settings.occlusion.layers).toEqual(["Ground"]);
      expect(checked.problems).toEqual([`audio.occlusion.layers[1]: unknown layer "Nope"; dropped.`]);
      const unchecked = parseAudioSettings({ occlusion: { layers: ["Ground", "Nope"] } });
      expect(unchecked.settings.occlusion.layers).toEqual(["Ground", "Nope"]);
      expect(unchecked.problems).toEqual([]);
    });
    it("a non-list gives null plus `audio.occlusion.layers: must be a list of layer names or null; using null (every layer).`; a non-string entry is dropped plus `audio.occlusion.layers[0]: must be a layer name; dropped.`", () => {
      const notList = parseAudioSettings({ occlusion: { layers: "Ground" } });
      expect(notList.settings.occlusion.layers).toBeNull();
      expect(notList.problems).toEqual([`audio.occlusion.layers: must be a list of layer names or null; using null (every layer).`]);
      const entry = parseAudioSettings({ occlusion: { layers: [5, "Ground"] } });
      expect(entry.settings.occlusion.layers).toEqual(["Ground"]);
      expect(entry.problems).toEqual([`audio.occlusion.layers[0]: must be a layer name; dropped.`]);
    });
  });

  describe("occlusion.budgetMs", () => {
    it("number 0.02..2: 0.5 kept (not rounded), 0.02 and 2 kept, absent 0.25", () => {
      const half = parseAudioSettings({ occlusion: { budgetMs: 0.5 } });
      expect(half.settings.occlusion.budgetMs).toBe(0.5);
      expect(half.problems).toEqual([]);
      expect(parseAudioSettings({ occlusion: { budgetMs: 0.02 } }).settings.occlusion.budgetMs).toBe(0.02);
      expect(parseAudioSettings({ occlusion: { budgetMs: 2 } }).settings.occlusion.budgetMs).toBe(2);
      const absent = parseAudioSettings({ occlusion: {} });
      expect(absent.settings.occlusion.budgetMs).toBe(0.25);
      expect(absent.problems).toEqual([]);
    });
    it("0.001 clamps to 0.02 with `audio.occlusion.budgetMs: 0.001 is outside 0.02..2; using 0.02.`, 5 clamps to 2; a string gives 0.25 plus `...: must be a number from 0.02 to 2; using 0.25.`", () => {
      const low = parseAudioSettings({ occlusion: { budgetMs: 0.001 } });
      expect(low.settings.occlusion.budgetMs).toBe(0.02);
      expect(low.problems).toEqual([`audio.occlusion.budgetMs: 0.001 is outside 0.02..2; using 0.02.`]);
      const high = parseAudioSettings({ occlusion: { budgetMs: 5 } });
      expect(high.settings.occlusion.budgetMs).toBe(2);
      expect(high.problems).toEqual([`audio.occlusion.budgetMs: 5 is outside 0.02..2; using 2.`]);
      const str = parseAudioSettings({ occlusion: { budgetMs: "fast" } });
      expect(str.settings.occlusion.budgetMs).toBe(0.25);
      expect(str.problems).toEqual([`audio.occlusion.budgetMs: must be a number from 0.02 to 2; using 0.25.`]);
    });
  });

  describe("occlusion.smoothingMs", () => {
    it("10..1000: 250 kept, absent 100, 5 clamps to 10, 5000 to 1000 with the problem text, a string gives 100 plus the number problem", () => {
      const kept = parseAudioSettings({ occlusion: { smoothingMs: 250 } });
      expect(kept.settings.occlusion.smoothingMs).toBe(250);
      expect(kept.problems).toEqual([]);
      const absent = parseAudioSettings({ occlusion: {} });
      expect(absent.settings.occlusion.smoothingMs).toBe(100);
      expect(absent.problems).toEqual([]);
      const low = parseAudioSettings({ occlusion: { smoothingMs: 5 } });
      expect(low.settings.occlusion.smoothingMs).toBe(10);
      expect(low.problems).toEqual([`audio.occlusion.smoothingMs: 5 is outside 10..1000; using 10.`]);
      const high = parseAudioSettings({ occlusion: { smoothingMs: 5000 } });
      expect(high.settings.occlusion.smoothingMs).toBe(1000);
      expect(high.problems).toEqual([`audio.occlusion.smoothingMs: 5000 is outside 10..1000; using 1000.`]);
      const str = parseAudioSettings({ occlusion: { smoothingMs: "slow" } });
      expect(str.settings.occlusion.smoothingMs).toBe(100);
      expect(str.problems).toEqual([`audio.occlusion.smoothingMs: must be a number from 10 to 1000; using 100.`]);
    });
  });

  describe("occlusion.defaultMaterial and materials", () => {
    it("absent: concrete, and the table is the six built-ins in order", () => {
      const { settings, problems } = parseAudioSettings({ occlusion: {} });
      expect(problems).toEqual([]);
      expect(settings.occlusion.defaultMaterial).toBe("concrete");
      expect(settings.occlusion.materials.map((m) => m.name)).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete"]);
    });
    it("an authored material is appended; one named like a built-in replaces it in place", () => {
      const { settings, problems } = parseAudioSettings({ occlusion: { materials: [{ name: "brick", transmissionDb: -20, cutoffHz: 900, wetOcclusion: 0.5 }, { name: "glass", transmissionDb: -10, cutoffHz: 4000, wetOcclusion: 0.4 }] } });
      expect(problems).toEqual([]);
      const names = settings.occlusion.materials.map((m) => m.name);
      expect(names).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete", "brick"]);
      expect(settings.occlusion.materials[2].transmissionDb).toBe(-10);
    });
    it("an unknown defaultMaterial falls back (concrete) plus a problem; one that names an authored material is kept", () => {
      const bad = parseAudioSettings({ occlusion: { defaultMaterial: "paper" } });
      expect(bad.settings.occlusion.defaultMaterial).toBe("concrete");
      expect(bad.problems).toEqual([`audio.occlusion.defaultMaterial: unknown material "paper"; using "concrete".`]);
      const ok = parseAudioSettings({ occlusion: { defaultMaterial: "brick", materials: [{ name: "brick" }] } });
      expect(ok.settings.occlusion.defaultMaterial).toBe("brick");
    });
    it("a duplicate name is dropped plus a problem; more than 32 authored entries: the rest ignored plus a problem", () => {
      const dup = parseAudioSettings({ occlusion: { materials: [{ name: "brick" }, { name: "brick" }] } });
      expect(dup.settings.occlusion.materials.filter((m) => m.name === "brick")).toHaveLength(1);
      expect(dup.problems).toHaveLength(1);
      const many = parseAudioSettings({ occlusion: { materials: Array.from({ length: 40 }, (_, i) => ({ name: `m${i}` })) } });
      expect(many.settings.occlusion.materials.length).toBeLessThanOrEqual(32);
      expect(many.problems.length).toBeGreaterThan(0);
    });
  });

  describe("zones.maxActive", () => {
    it("integer 0..2: 1 kept, 0 kept without a problem, 3 clamps to 2 with the problem text, a string gives 2 plus the whole-number problem", () => {
      const one = parseAudioSettings({ zones: { maxActive: 1 } });
      expect(one.settings.zones.maxActive).toBe(1);
      expect(one.problems).toEqual([]);
      const zero = parseAudioSettings({ zones: { maxActive: 0 } });
      expect(zero.settings.zones.maxActive).toBe(0);
      expect(zero.problems).toEqual([]);
      const high = parseAudioSettings({ zones: { maxActive: 3 } });
      expect(high.settings.zones.maxActive).toBe(2);
      expect(high.problems).toEqual([`audio.zones.maxActive: 3 is outside 0..2; using 2.`]);
      const str = parseAudioSettings({ zones: { maxActive: "1" } });
      expect(str.settings.zones.maxActive).toBe(2);
      expect(str.problems).toEqual([`audio.zones.maxActive: must be a whole number from 0 to 2.`]);
    });
  });

  describe("zones.standby", () => {
    it("integer 0..1: 0 kept, 1 kept, absent 1, 2 clamps to 1 with `audio.zones.standby: 2 is outside 0..1; using 1.`, a string gives 1 plus the whole-number problem", () => {
      const zero = parseAudioSettings({ zones: { standby: 0 } });
      expect(zero.settings.zones.standby).toBe(0);
      expect(zero.problems).toEqual([]);
      const one = parseAudioSettings({ zones: { standby: 1 } });
      expect(one.settings.zones.standby).toBe(1);
      expect(one.problems).toEqual([]);
      const absent = parseAudioSettings({ zones: {} });
      expect(absent.settings.zones.standby).toBe(1);
      expect(absent.problems).toEqual([]);
      const high = parseAudioSettings({ zones: { standby: 2 } });
      expect(high.settings.zones.standby).toBe(1);
      expect(high.problems).toEqual([`audio.zones.standby: 2 is outside 0..1; using 1.`]);
      const str = parseAudioSettings({ zones: { standby: "0" } });
      expect(str.settings.zones.standby).toBe(1);
      expect(str.problems).toEqual([`audio.zones.standby: must be a whole number from 0 to 1.`]);
    });
  });

  describe("zones.maxIrSeconds", () => {
    it("number 0.5..8: 4 kept, 0.7 kept (not rounded), absent 2, 0.1 clamps to 0.5, 20 to 8 with the problem text, a string gives 2 plus the number problem", () => {
      const four = parseAudioSettings({ zones: { maxIrSeconds: 4 } });
      expect(four.settings.zones.maxIrSeconds).toBe(4);
      expect(four.problems).toEqual([]);
      const frac = parseAudioSettings({ zones: { maxIrSeconds: 0.7 } });
      expect(frac.settings.zones.maxIrSeconds).toBe(0.7);
      expect(frac.problems).toEqual([]);
      const absent = parseAudioSettings({ zones: {} });
      expect(absent.settings.zones.maxIrSeconds).toBe(2);
      expect(absent.problems).toEqual([]);
      const low = parseAudioSettings({ zones: { maxIrSeconds: 0.1 } });
      expect(low.settings.zones.maxIrSeconds).toBe(0.5);
      expect(low.problems).toEqual([`audio.zones.maxIrSeconds: 0.1 is outside 0.5..8; using 0.5.`]);
      const high = parseAudioSettings({ zones: { maxIrSeconds: 20 } });
      expect(high.settings.zones.maxIrSeconds).toBe(8);
      expect(high.problems).toEqual([`audio.zones.maxIrSeconds: 20 is outside 0.5..8; using 8.`]);
      const str = parseAudioSettings({ zones: { maxIrSeconds: "long" } });
      expect(str.settings.zones.maxIrSeconds).toBe(2);
      expect(str.problems).toEqual([`audio.zones.maxIrSeconds: must be a number from 0.5 to 8; using 2.`]);
    });
  });

  describe("doppler.maxSpeed", () => {
    it("a number above 0 is kept (1, 150, 100000 all kept, no upper clamp), absent 150", () => {
      for (const v of [1, 150, 100000]) {
        const { settings, problems } = parseAudioSettings({ doppler: { maxSpeed: v } });
        expect(settings.doppler.maxSpeed).toBe(v);
        expect(problems).toEqual([]);
      }
      const absent = parseAudioSettings({ doppler: {} });
      expect(absent.settings.doppler.maxSpeed).toBe(150);
      expect(absent.problems).toEqual([]);
    });
    it("0, -5, NaN and a string give 150 plus `audio.doppler.maxSpeed: must be a number above 0; using 150.`; a non-object `doppler` gives `audio.doppler must be an object.`", () => {
      for (const v of [0, -5, Number.NaN, "fast"]) {
        const { settings, problems } = parseAudioSettings({ doppler: { maxSpeed: v } });
        expect(settings.doppler.maxSpeed).toBe(150);
        expect(problems).toEqual([`audio.doppler.maxSpeed: must be a number above 0; using 150.`]);
      }
      const notObject = parseAudioSettings({ doppler: 150 });
      expect(notObject.settings.doppler.maxSpeed).toBe(150);
      expect(notObject.problems).toEqual([`audio.doppler must be an object.`]);
    });
  });

  describe("speedOfSound", () => {
    it("10..100000: 340 kept, absent 343, 1 clamps to 10, 1e6 to 100000 with the problem text, a string gives 343 plus the number problem", () => {
      const kept = parseAudioSettings({ speedOfSound: 340 });
      expect(kept.settings.speedOfSound).toBe(340);
      expect(kept.problems).toEqual([]);
      const absent = parseAudioSettings({});
      expect(absent.settings.speedOfSound).toBe(343);
      expect(absent.problems).toEqual([]);
      const low = parseAudioSettings({ speedOfSound: 1 });
      expect(low.settings.speedOfSound).toBe(10);
      expect(low.problems).toEqual([`audio.speedOfSound: 1 is outside 10..100000; using 10.`]);
      const high = parseAudioSettings({ speedOfSound: 1e6 });
      expect(high.settings.speedOfSound).toBe(100000);
      expect(high.problems).toEqual([`audio.speedOfSound: 1000000 is outside 10..100000; using 100000.`]);
      const str = parseAudioSettings({ speedOfSound: "fast" });
      expect(str.settings.speedOfSound).toBe(343);
      expect(str.problems).toEqual([`audio.speedOfSound: must be a number from 10 to 100000; using 343.`]);
    });
  });

  describe("the whole section", () => {
    const authored = {
      buses: [
        { name: "Master", bed: "own", bedPriority: 255 },
        { name: "Music", parent: "Master", bed: "none", bedPriority: 40, maxVoices: 8 },
        { name: "SFX", parent: "Master", bed: "parent", bedPriority: 200 },
      ],
      bed: { maxBeds: 3 },
      ambisonic: { maxClips: 2 },
      occlusion: { layers: ["Ground", "Walls"], budgetMs: 0.5, smoothingMs: 250 },
      zones: { maxActive: 1, standby: 0, maxIrSeconds: 4 },
      doppler: { maxSpeed: 200 },
      speedOfSound: 340,
      voices: { hrtf: 8 },
    };

    it("a section authoring every M3 key parses to those values with no problems and no throw", () => {
      let result: ReturnType<typeof parseAudioSettings> | undefined;
      expect(() => { result = parseAudioSettings(authored); }).not.toThrow();
      const { settings, problems } = result!;
      expect(problems).toEqual([]);
      expect(settings.bed.maxBeds).toBe(3);
      expect(settings.ambisonic.maxClips).toBe(2);
      expect(settings.occlusion).toMatchObject({ layers: ["Ground", "Walls"], budgetMs: 0.5, defaultMaterial: "concrete", smoothingMs: 250 });
      expect(settings.zones).toEqual({ maxActive: 1, standby: 0, maxIrSeconds: 4 });
      expect(settings.doppler.maxSpeed).toBe(200);
      expect(settings.speedOfSound).toBe(340);
      expect(settings.voices.hrtf).toBe(8);
      expect(busBed(settings, "Master")).toBe("own");
      expect(busBed(settings, "Music")).toBe("none");
      expect(busBed(settings, "SFX")).toBe("parent");
      expect(busBedPriority(settings, "Master")).toBe(255);
      expect(busBedPriority(settings, "Music")).toBe(40);
      expect(busBedPriority(settings, "SFX")).toBe(200);
      expect(bus(settings, "Music").maxVoices).toBe(8);
    });
    it("parse(settings) of a parsed section equals it (round trip), and an M3-free section's buses carry no bed or bedPriority", () => {
      const once = parseAudioSettings(authored).settings;
      const twice = parseAudioSettings(once);
      expect(twice.problems).toEqual([]);
      expect(twice.settings).toEqual(once);
      const plain = parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }] });
      expect(plain.settings.buses.every((b) => !("bed" in b) && !("bedPriority" in b))).toBe(true);
    });
    it("garbage in every M3 section (numbers, nulls, arrays) never throws and leaves every default", () => {
      for (const g of [null, "x", true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
        const input = {
          bed: { maxBeds: g },
          ambisonic: { maxClips: g },
          occlusion: { layers: 5, budgetMs: g, smoothingMs: g },
          zones: { maxActive: g, standby: g, maxIrSeconds: g },
          doppler: { maxSpeed: g },
          speedOfSound: g,
          buses: [{ name: "Master", bed: g, bedPriority: g }, { name: "SFX", parent: "Master", bed: g, bedPriority: g }],
        };
        let result: ReturnType<typeof parseAudioSettings> | undefined;
        expect(() => { result = parseAudioSettings(input); }).not.toThrow();
        const { settings, problems } = result!;
        expect(problems.length).toBeGreaterThan(0);
        expect(settings.bed.maxBeds).toBe(2);
        expect(settings.ambisonic.maxClips).toBe(1);
        expect(settings.occlusion.layers).toBeNull();
        expect(settings.occlusion.budgetMs).toBe(0.25);
        expect(settings.occlusion.smoothingMs).toBe(100);
        expect(settings.zones).toEqual({ maxActive: 2, standby: 1, maxIrSeconds: 2 });
        expect(settings.doppler.maxSpeed).toBe(150);
        expect(settings.speedOfSound).toBe(343);
        expect(busBed(settings, "Master")).toBe("own");
        expect(busBed(settings, "SFX")).toBe("parent");
        expect(busBedPriority(settings, "Master")).toBe(255);
        expect(busBedPriority(settings, "SFX")).toBe(128);
      }
      for (const g of [null, 5, "x", []]) {
        const { settings, problems } = parseAudioSettings({ bed: g, ambisonic: g, occlusion: g, zones: g, doppler: g });
        expect(problems).toHaveLength(5);
        expect(settings.bed.maxBeds).toBe(2);
        expect(settings.ambisonic.maxClips).toBe(1);
        expect(settings.occlusion.layers).toBeNull();
        expect(settings.zones).toEqual({ maxActive: 2, standby: 1, maxIrSeconds: 2 });
        expect(settings.doppler.maxSpeed).toBe(150);
      }
    });
  });
});
