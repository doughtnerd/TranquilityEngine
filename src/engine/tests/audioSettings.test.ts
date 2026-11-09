import { describe, it } from "vitest";
// import { defaultAudioSettings, parseAudioSettings } from "../audio/settings";

// §2 of docs/design/0157-audio-core/api-and-models.md, one block per key (K13). A0.4-L1 fills them in.
describe("audio settings: the §2 keys (ADR 0157)", () => {
  describe("defaults", () => {
    it.todo("no audio section gives every default: voices 128/4096/16, background mute, clipFormat i16, codecs.aac false, spatial hrtf, backend babylon, no clipMemoryMB");
    it.todo("a section with only buses keeps the old buses, snapshots and ducking and fills the new keys with defaults, with no problems");
  });
  describe("buses[].maxVoices", () => {
    it.todo("rounds a fraction, clamps to 1..voices.logical (with a problem when clamped), absent or null is unlimited");
    it.todo("a wrong type is dropped with a problem");
  });
  describe("voices", () => {
    it.todo("mixed clamps to 8..512 with a problem when clamped, and rounds");
    it.todo("logical clamps to mixed..8192; below mixed raises it to mixed");
    it.todo("hrtf clamps to 0..32 with a problem when clamped; 0 is kept");
    it.todo("a non-object voices, or a non-number member, gives the default plus a problem");
  });
  describe("background", () => {
    it.todo("accepts mute, pause and play");
    it.todo("an unknown value gives mute plus a problem");
  });
  describe("clipMemoryMB", () => {
    it.todo("clamps to 16..1024 and rounds; absent stays undefined");
    it.todo("a wrong type is dropped with a problem");
  });
  describe("clipFormat", () => {
    it.todo("accepts i16 and f32; an unknown value gives i16 plus a problem");
  });
  describe("codecs.aac", () => {
    it.todo("accepts true and false; a non-boolean gives false plus a problem");
  });
  describe("spatial", () => {
    it.todo("accepts hrtf and equalPower; an unknown value gives hrtf plus a problem");
  });
  describe("backend", () => {
    it.todo("accepts babylon and core");
    it.todo('"howler" gives babylon plus the problem `audio.backend "howler" was replaced by "babylon" (ADR 0157); using "babylon".`');
    it.todo('"fmod" gives the default plus the problem `audio.backend "fmod" was removed (ADR 0157); using "babylon".`, and the fmod object is dropped silently');
    it.todo("an unknown value gives babylon plus a problem");
  });
  describe("lenient parsing", () => {
    it.todo("a non-object audio section gives defaults plus the problem 'audio must be an object.' (unchanged)");
    it.todo("the pre-0157 corpus in audioMixer.test.ts still parses to the same buses, snapshots and ducking");
  });
});
