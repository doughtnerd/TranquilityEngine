import { describe, expect, it } from "vitest";
import { defaultAudioSettings, parseAudioSettings } from "../audio/settings";

// §2 of docs/design/0157-audio-core/api-and-models.md, one block per key (K13).
describe("audio settings: the §2 keys (ADR 0157)", () => {
  describe("defaults", () => {
    it("no audio section gives every default: voices 128/4096/16, background mute, clipFormat i16, codecs.aac false, spatial hrtf, backend babylon, no clipMemoryMB", () => {
      const { settings, problems } = parseAudioSettings(undefined);
      expect(problems).toEqual([]);
      expect(settings.voices).toEqual({ mixed: 128, logical: 4096, hrtf: 16 });
      expect(settings.background).toBe("mute");
      expect(settings.clipFormat).toBe("i16");
      expect(settings.codecs).toEqual({ aac: false });
      expect(settings.spatial).toBe("hrtf");
      expect(settings.backend).toBe("babylon");
      expect(settings.clipMemoryMB).toBeUndefined();
      expect(settings).not.toHaveProperty("clipMemoryMB");
      expect(settings).not.toHaveProperty("fmod");
    });
    it("a section with only buses keeps the old buses, snapshots and ducking and fills the new keys with defaults, with no problems", () => {
      const { settings, problems } = parseAudioSettings({
        buses: [
          { name: "Master" },
          { name: "Music", parent: "Master", volume: 0.8, effects: [{ type: "lowpass", frequency: 18000 }] },
          { name: "Voice", parent: "Master" },
        ],
        snapshots: [{ name: "Paused", volumes: { Music: 0.3 }, lowpass: { Music: 800 } }],
        ducking: [{ target: "Music", trigger: "Voice", amount: 0.4, attack: 0.1, release: 0.6 }],
      });
      expect(problems).toEqual([]);
      expect(settings.buses).toEqual([
        { name: "Master", volume: 1, mute: false, effects: [] },
        { name: "Music", parent: "Master", volume: 0.8, mute: false, effects: [{ type: "lowpass", frequency: 18000, q: 1 }] },
        { name: "Voice", parent: "Master", volume: 1, mute: false, effects: [] },
      ]);
      expect(settings.snapshots).toEqual([{ name: "Paused", volumes: { Music: 0.3 }, lowpass: { Music: 800 } }]);
      expect(settings.ducking).toEqual([{ target: "Music", trigger: "Voice", amount: 0.4, attack: 0.1, release: 0.6 }]);
      expect(settings.voices).toEqual({ mixed: 128, logical: 4096, hrtf: 16 });
      expect(settings.background).toBe("mute");
      expect(settings.backend).toBe("babylon");
      expect(settings.buses.every((b) => !("maxVoices" in b))).toBe(true);
    });
  });

  describe("buses[].maxVoices", () => {
    it("rounds a fraction, clamps to 1..voices.logical (with a problem when clamped), absent or null is unlimited", () => {
      const { settings, problems } = parseAudioSettings({
        buses: [
          { name: "Master", maxVoices: 3.6 },
          { name: "SFX", parent: "Master", maxVoices: 0 },
          { name: "UI", parent: "Master", maxVoices: 9000 },
          { name: "Voice", parent: "Master", maxVoices: null },
          { name: "Music", parent: "Master" },
        ],
        voices: { logical: 256 },
      });
      expect(settings.buses.map((b) => b.maxVoices)).toEqual([4, 1, 256, undefined, undefined]);
      expect(settings.buses[3]).not.toHaveProperty("maxVoices");
      expect(settings.buses[4]).not.toHaveProperty("maxVoices");
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/^audio\.buses\[1\]\.maxVoices: /);
      expect(problems[1]).toMatch(/^audio\.buses\[2\]\.maxVoices: /);
    });
    it("a wrong type is dropped with a problem", () => {
      const { settings, problems } = parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master", maxVoices: "8" }] });
      expect(settings.buses[1]).not.toHaveProperty("maxVoices");
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^audio\.buses\[1\]\.maxVoices: /);
    });
  });

  describe("buses[].effects on the audio core", () => {
    it("more than 4 effects or a second compressor on a bus are kept, with a problem naming what the core skips", () => {
      const lp = { type: "lowpass", frequency: 1000 };
      const comp = { type: "compressor" };
      const { settings, problems } = parseAudioSettings({ buses: [{ name: "Master", effects: [lp, lp, lp, lp, lp] }, { name: "SFX", parent: "Master", effects: [comp, comp] }] });
      expect(settings.buses[0]!.effects).toHaveLength(5);
      expect(settings.buses[1]!.effects).toHaveLength(2);
      expect(problems).toEqual([
        "audio.buses[0]: the audio core runs only the first 4 effects of a bus; the rest are skipped.",
        "audio.buses[1]: the audio core runs one compressor per bus (the first); the others are skipped.",
      ]);
    });
    it("4 effects with one compressor give no problem", () => {
      const { problems } = parseAudioSettings({ buses: [{ name: "Master", effects: [{ type: "lowpass", frequency: 1000 }, { type: "highpass", frequency: 80 }, { type: "compressor" }, { type: "reverb", send: 0.2 }] }] });
      expect(problems).toEqual([]);
    });
  });

  describe("voices", () => {
    it("mixed clamps to 8..512 with a problem when clamped, and rounds", () => {
      const high = parseAudioSettings({ voices: { mixed: 600 } });
      expect(high.settings.voices.mixed).toBe(512);
      expect(high.problems).toEqual(["audio.voices.mixed: 600 is outside 8..512; using 512."]);
      const rounded = parseAudioSettings({ voices: { mixed: 10.4 } });
      expect(rounded.settings.voices.mixed).toBe(10);
      expect(rounded.problems).toEqual([]);
    });
    it("logical clamps to mixed..8192; below mixed raises it to mixed", () => {
      const high = parseAudioSettings({ voices: { logical: 9000 } });
      expect(high.settings.voices.logical).toBe(8192);
      expect(high.problems).toHaveLength(1);
      const below = parseAudioSettings({ voices: { mixed: 256, logical: 100 } });
      expect(below.settings.voices).toEqual({ mixed: 256, logical: 256, hrtf: 16 });
      expect(below.problems).toEqual(["audio.voices.logical: 100 is outside 256..8192; using 256."]);
    });
    it("hrtf clamps to 0..32 with a problem when clamped; 0 is kept", () => {
      const high = parseAudioSettings({ voices: { hrtf: 40 } });
      expect(high.settings.voices.hrtf).toBe(32);
      expect(high.problems).toEqual(["audio.voices.hrtf: 40 is outside 0..32; using 32."]);
      const zero = parseAudioSettings({ voices: { hrtf: 0 } });
      expect(zero.settings.voices.hrtf).toBe(0);
      expect(zero.problems).toEqual([]);
    });
    it("a non-object voices, or a non-number member, gives the default plus a problem", () => {
      const notObject = parseAudioSettings({ voices: 5 });
      expect(notObject.settings.voices).toEqual({ mixed: 128, logical: 4096, hrtf: 16 });
      expect(notObject.problems).toEqual(["audio.voices must be an object."]);
      const member = parseAudioSettings({ voices: { mixed: "big" } });
      expect(member.settings.voices).toEqual({ mixed: 128, logical: 4096, hrtf: 16 });
      expect(member.problems).toHaveLength(1);
      expect(member.problems[0]).toMatch(/^audio\.voices\.mixed: /);
    });
  });

  describe("background", () => {
    it("accepts mute, pause and play", () => {
      for (const v of ["mute", "pause", "play"] as const) {
        const { settings, problems } = parseAudioSettings({ background: v });
        expect(settings.background).toBe(v);
        expect(problems).toEqual([]);
      }
    });
    it("an unknown value gives mute plus a problem", () => {
      const { settings, problems } = parseAudioSettings({ background: "loud" });
      expect(settings.background).toBe("mute");
      expect(problems).toEqual([`audio.background: must be one of mute, pause, play; using "mute".`]);
    });
  });

  describe("clipMemoryMB", () => {
    it("clamps to 16..1024 and rounds; absent stays undefined", () => {
      const high = parseAudioSettings({ clipMemoryMB: 2000 });
      expect(high.settings.clipMemoryMB).toBe(1024);
      expect(high.problems).toHaveLength(1);
      const rounded = parseAudioSettings({ clipMemoryMB: 64.6 });
      expect(rounded.settings.clipMemoryMB).toBe(65);
      expect(rounded.problems).toEqual([]);
      const absent = parseAudioSettings({});
      expect(absent.settings.clipMemoryMB).toBeUndefined();
      expect(absent.settings).not.toHaveProperty("clipMemoryMB");
      expect(absent.problems).toEqual([]);
    });
    it("a wrong type is dropped with a problem", () => {
      const { settings, problems } = parseAudioSettings({ clipMemoryMB: "big" });
      expect(settings).not.toHaveProperty("clipMemoryMB");
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^audio\.clipMemoryMB: /);
    });
  });

  describe("limiterLookaheadMs", () => {
    it("absent is 1.5 ms with no problem, and the defaults carry it", () => {
      const { settings, problems } = parseAudioSettings({});
      expect(settings.limiterLookaheadMs).toBe(1.5);
      expect(problems).toEqual([]);
      expect(defaultAudioSettings().limiterLookaheadMs).toBe(1.5);
    });
    it("keeps a number in 0..5 as given, 0 included (no look-ahead, no latency)", () => {
      for (const ms of [0, 0.75, 1.5, 2.25, 5]) {
        const { settings, problems } = parseAudioSettings({ limiterLookaheadMs: ms });
        expect(settings.limiterLookaheadMs).toBe(ms);
        expect(problems).toEqual([]);
      }
    });
    it("clamps to 0..5 with a problem", () => {
      const high = parseAudioSettings({ limiterLookaheadMs: 12 });
      expect(high.settings.limiterLookaheadMs).toBe(5);
      expect(high.problems).toEqual(["audio.limiterLookaheadMs: 12 is outside 0..5; using 5."]);
      const low = parseAudioSettings({ limiterLookaheadMs: -1 });
      expect(low.settings.limiterLookaheadMs).toBe(0);
      expect(low.problems).toEqual(["audio.limiterLookaheadMs: -1 is outside 0..5; using 0."]);
    });
    it("a wrong type, NaN or Infinity gives 1.5 plus a problem", () => {
      for (const raw of ["2", null, true, Number.NaN, Infinity]) {
        const { settings, problems } = parseAudioSettings({ limiterLookaheadMs: raw });
        expect(settings.limiterLookaheadMs).toBe(1.5);
        expect(problems).toEqual(["audio.limiterLookaheadMs: must be a number of milliseconds from 0 to 5; using 1.5."]);
      }
    });
  });

  describe("clipFormat", () => {
    it("accepts i16 and f32; an unknown value gives i16 plus a problem", () => {
      expect(parseAudioSettings({ clipFormat: "f32" }).settings.clipFormat).toBe("f32");
      expect(parseAudioSettings({ clipFormat: "i16" }).problems).toEqual([]);
      const bad = parseAudioSettings({ clipFormat: "f64" });
      expect(bad.settings.clipFormat).toBe("i16");
      expect(bad.problems).toEqual([`audio.clipFormat: must be one of i16, f32; using "i16".`]);
    });
  });

  describe("codecs.aac", () => {
    it("accepts true and false; a non-boolean gives false plus a problem", () => {
      expect(parseAudioSettings({ codecs: { aac: true } }).settings.codecs).toEqual({ aac: true });
      const off = parseAudioSettings({ codecs: { aac: false } });
      expect(off.settings.codecs).toEqual({ aac: false });
      expect(off.problems).toEqual([]);
      const bad = parseAudioSettings({ codecs: { aac: "yes" } });
      expect(bad.settings.codecs).toEqual({ aac: false });
      expect(bad.problems).toEqual(["audio.codecs.aac: must be true or false; using false."]);
    });
  });

  describe("spatial", () => {
    it("accepts hrtf and equalPower; an unknown value gives hrtf plus a problem", () => {
      expect(parseAudioSettings({ spatial: "equalPower" }).settings.spatial).toBe("equalPower");
      expect(parseAudioSettings({ spatial: "hrtf" }).problems).toEqual([]);
      const bad = parseAudioSettings({ spatial: "stereo" });
      expect(bad.settings.spatial).toBe("hrtf");
      expect(bad.problems).toEqual([`audio.spatial: must be one of hrtf, equalPower; using "hrtf".`]);
    });
  });

  describe("backend", () => {
    it("accepts babylon and core", () => {
      for (const v of ["babylon", "core"] as const) {
        const { settings, problems } = parseAudioSettings({ backend: v });
        expect(settings.backend).toBe(v);
        expect(problems).toEqual([]);
      }
    });
    it('"howler" gives babylon plus the problem `audio.backend "howler" was replaced by "babylon" (ADR 0157); using "babylon".`', () => {
      const { settings, problems } = parseAudioSettings({ backend: "howler" });
      expect(settings.backend).toBe("babylon");
      expect(problems).toEqual([`audio.backend "howler" was replaced by "babylon" (ADR 0157); using "babylon".`]);
    });
    it('"fmod" gives the default plus the problem `audio.backend "fmod" was removed (ADR 0157); using "babylon".`, and the fmod object is dropped silently', () => {
      const bare = parseAudioSettings({ backend: "fmod" });
      expect(bare.settings.backend).toBe("babylon");
      expect(bare.problems).toEqual([`audio.backend "fmod" was removed (ADR 0157); using "babylon".`]);
      const withObject = parseAudioSettings({ backend: "fmod", fmod: { sdkPath: "C:/fmod", banks: ["a.bank"] } });
      expect(withObject.settings.backend).toBe("babylon");
      expect(withObject.settings).not.toHaveProperty("fmod");
      expect(withObject.problems).toEqual([`audio.backend "fmod" was removed (ADR 0157); using "babylon".`]);
    });
    it("an unknown value gives babylon plus a problem", () => {
      const { settings, problems } = parseAudioSettings({ backend: "loud" });
      expect(settings.backend).toBe("babylon");
      expect(problems).toEqual([`audio.backend must be "babylon" or "core".`]);
    });
  });

  describe("lenient parsing", () => {
    it("a non-object audio section gives defaults plus the problem 'audio must be an object.' (unchanged)", () => {
      const { settings, problems } = parseAudioSettings("nope");
      expect(problems).toEqual(["audio must be an object."]);
      expect(settings).toEqual(defaultAudioSettings());
    });
    it("the pre-0157 corpus in audioMixer.test.ts still parses to the same buses, snapshots and ducking", () => {
      const { settings, problems } = parseAudioSettings({
        buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Battle", parent: "Music" }, { name: "SFX", parent: "Master" }, { name: "Voice", parent: "Master" }],
        snapshots: [{ name: "Paused", volumes: { Music: 0.2, SFX: 0 }, lowpass: { Music: 800 } }],
        ducking: [{ target: "Music", trigger: "Voice", amount: 0.4, attack: 0.1, release: 0.5 }],
      });
      expect(problems).toEqual([]);
      expect(settings.buses).toEqual([
        { name: "Master", volume: 1, mute: false, effects: [] },
        { name: "Music", parent: "Master", volume: 1, mute: false, effects: [] },
        { name: "Battle", parent: "Music", volume: 1, mute: false, effects: [] },
        { name: "SFX", parent: "Master", volume: 1, mute: false, effects: [] },
        { name: "Voice", parent: "Master", volume: 1, mute: false, effects: [] },
      ]);
      expect(settings.snapshots).toEqual([{ name: "Paused", volumes: { Music: 0.2, SFX: 0 }, lowpass: { Music: 800 } }]);
      expect(settings.ducking).toEqual([{ target: "Music", trigger: "Voice", amount: 0.4, attack: 0.1, release: 0.5 }]);
    });
  });
});
