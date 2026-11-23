// ADR 0354 (localised audio, voice-over lines), 0357 (subtitles from string tables, captions): the audio localisation
// runtime through the public `Audio` API on the fake backend: language state and the atomic switch, fallback chains,
// `missingLanguage`, `Audio.line` (template, output, subtitle-only lines, markers, live text), `Audio.onLine`, playlist
// line entries, voice following the text language, captions, the start language and `Audio.debug().language`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Audio, Engine, MemoryStorage, SceneManager, Storage, type AudioCaptionEvent, type AudioLineEvent } from "../../../../myco";
import { Locale } from "../../../../engine";
import { parseLanguages } from "../../../../engine/localisation/languages";
import { setAudioBackend } from "../backend";
import { endAudioSession, makeFakeBackend, type FakeVoice } from "../testing";

const fake = makeFakeBackend();
let engine: Engine | null = null;
const WAV = "data:,";

const LANGUAGES = {
  list: [
    { code: "en", name: "English" },
    { code: "fr", name: "Français" },
    { code: "fr-CA", name: "Français (Canada)", fallback: ["fr"] },
    { code: "de", name: "Deutsch" },
    { code: "ja", name: "日本語", voice: false },
  ],
  reference: "en", default: "en", useSystemLanguage: false, remember: false,
};

/** A project with one localised root, a line table (with its string table and a French translation) and some files. */
function files(extra: Record<string, unknown> = {}, table: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "s.json": { format: "myco.scene@1", nodes: [] },
    "audio.json": { format: "myco.audio@1", localisation: { roots: ["audio/vo"] } },
    "audio/lines/index.json": { format: "myco.lineindex@1", tables: ["audio/vo/ch1.lines.json"] },
    "audio/vo/ch1.lines.json": {
      format: "myco.lines@1", folder: "ch1",
      lines: [
        { key: "intro_01", speaker: "Ava" },
        { key: "intro_02", speaker: "Ava" },
        { key: "only_de", speaker: "Guard" },
        { key: "long_missing", speaker: "Guard" },
        { key: "breath_01", speaker: "Ava", textKey: null },
      ],
      ...table,
    },
    "audio/vo/ch1.strings.json": {
      format: "myco.strings@1", language: "en",
      strings: [
        { key: "intro_01", text: "We're late." },
        { key: "intro_02", text: "Run." },
        { key: "only_de", text: "Halt!" },
        { key: "long_missing", text: "This sentence is exactly sixty characters long, give or take." },
      ],
    },
    "audio/vo/ch1.fr.strings.json": { format: "myco.translation@1", language: "fr", strings: { intro_01: { text: "On est en retard.", status: "translated" } } },
    "audio/vo/en/ch1/intro_01.wav": WAV,
    "audio/vo/fr/ch1/intro_01.wav": WAV,
    "audio/vo/en/ch1/intro_02.wav": WAV,
    "audio/vo/de/ch1/only_de.wav": WAV,
    "audio/vo/en/grunt.wav": WAV,
    "audio/vo/fr/grunt.wav": WAV,
    "audio/vo/de/hey.wav": WAV,
    ...extra,
  };
}

async function boot(assets: Record<string, unknown> = files(), languages: Record<string, unknown> = {}, storage?: MemoryStorage): Promise<void> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(assets));
  engine = await Engine.create({
    headless: true,
    ...(storage ? { storage } : {}),
    // `project.json`'s languages section as written, parsed as the project loader does.
    project: { audio: { buses: [{ name: "Master" }, { name: "Voice", parent: "Master" }, { name: "SFX", parent: "Master" }], seed: 7 }, languages: parseLanguages({ ...LANGUAGES, ...languages }).languages },
  });
  engine.world.render = {} as never; // a World that plays sound
  await SceneManager.load("s.json");
}

const frame = (dt = 1 / 60) => engine!.step(dt);
const lastVoice = () => fake.voices.at(-1) as FakeVoice;

beforeEach(() => {
  fake.clear();
  fake.ready = true;
  fake.advanceTo(0);
  setAudioBackend(fake);
  endAudioSession();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  engine?.dispose();
  engine = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  endAudioSession();
  setAudioBackend(null);
});

describe("language state", () => {
  it("starts in the default, lists the shipped voice languages, and refuses an unknown or text-only code", async () => {
    await boot();
    expect(Audio.language).toBe("en");
    expect(Audio.pendingLanguage).toBeNull();
    expect(Audio.languages.map((l) => l.code)).toEqual(["en", "fr", "fr-CA", "de"]); // ja is text-only (voice: false)
    expect(Audio.languages.find((l) => l.code === "fr-CA")!.fallback).toEqual(["fr"]);
    await expect(Audio.setLanguage("es")).rejects.toThrow();
    await expect(Audio.setLanguage("ja")).rejects.toThrow();
    expect(Audio.language).toBe("en");
    Audio.language = "fr"; // shorthand for setLanguage
    expect(Audio.language).toBe("fr");
  });

  it("a switch is atomic: the language changes in the call, and voice-over playing in the old language finishes by default", async () => {
    await boot();
    const old = Audio.line("intro_01");
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/en/ch1/intro_01.wav");
    const voice = lastVoice();
    const switching = Audio.setLanguage("fr");
    expect(Audio.language).toBe("fr"); // already changed: no package parts to load
    expect(Audio.pendingLanguage).toBeNull();
    await switching;
    expect(voice.stopped).toBe(false); // finishes in English
    expect(old.playing).toBe(true);
    expect(old.language).toBe("en");
    const next = Audio.line("intro_01");
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/fr/ch1/intro_01.wav");
    expect(next.language).toBe("fr");
  });

  it('playing: "stop" stops voices playing a localised file in the old language with a 50 ms fade, not other sounds', async () => {
    await boot(files({ "sfx/boom.wav": WAV }));
    Audio.line("intro_01");
    const vo = lastVoice();
    Audio.playOneShot("sfx/boom.wav");
    const sfx = lastVoice();
    await Audio.setLanguage("fr", { playing: "stop" });
    expect(vo.events.at(-1)).toEqual({ kind: "stop", fadeSeconds: 0.05 });
    expect(sfx.stopped).toBe(false);
  });

  it("starts in the remembered language (player storage) before the first scene, else a match for the system language", async () => {
    const storage = new MemoryStorage();
    await storage.save("settings", "myco.audio.language", "de");
    await boot(files(), { remember: true, voice: "separate" }, storage);
    expect(Audio.language).toBe("de");
    await Audio.setLanguage("fr");
    expect(await Storage.load("myco.audio.language", "settings")).toBe("fr");
    engine!.dispose();
    endAudioSession();
    vi.stubGlobal("navigator", { languages: ["fr-CA", "en-US"] });
    await boot(files(), { useSystemLanguage: true, voice: "separate" });
    expect(Audio.language).toBe("fr-CA");
  });
});

describe("the clip resolver swaps a localised path through the fallback chain", () => {
  it("plays the current language's file, else the first language of its chain that has it", async () => {
    await boot();
    Audio.playOneShot("audio/vo/en/grunt.wav");
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/en/grunt.wav");
    await Audio.setLanguage("fr-CA"); // fr-CA → fr → en
    Audio.playOneShot("audio/vo/en/grunt.wav");
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/fr/grunt.wav");
    await Audio.setLanguage("de"); // de → en
    Audio.play("audio/vo/fr/grunt.wav"); // a reference into another language's folder is swapped the same way
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/en/grunt.wav");
  });

  it("a path outside every root plays unchanged", async () => {
    await boot(files({ "sfx/boom.wav": WAV }));
    await Audio.setLanguage("fr");
    Audio.playOneShot("sfx/boom.wav");
    expect(fake.plays.at(-1)!.path).toBe("sfx/boom.wav");
  });

  it('a localised sample no language of the chain has plays nothing, with reason "missingLanguage" and a debug row', async () => {
    await boot(files({ "p.playlist.json": { format: "myco.playlist@1", type: "clip", entries: [{ sample: "audio/vo/en/hey.wav" }] } }));
    await Audio.setLanguage("fr"); // fr → en; only de has hey.wav
    const one = Audio.playOneShot("audio/vo/en/hey.wav");
    expect(one.playing).toBe(false);
    expect(one.reason).toBe("missingLanguage");
    const pl = Audio.play("p.playlist.json");
    expect(pl.playing).toBe(false);
    expect(pl.reason).toBe("missingLanguage");
    expect(fake.plays).toHaveLength(0);
    expect(Audio.debug().language).toEqual({ current: "fr", subtitles: "en", pending: null, missing: [{ path: "audio/vo/en/hey.wav", language: "fr" }] });
    await Audio.setLanguage("de");
    expect(Audio.play("p.playlist.json").playing).toBe(true);
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/de/hey.wav");
  });
});

describe("Audio.line", () => {
  it("plays a line by key as a Clip on its table's output (Voice by default), with speaker, language, duration and subtitle", async () => {
    await boot();
    fake.durations.set("audio/vo/en/ch1/intro_01.wav", 1.25);
    const h = Audio.line("intro_01");
    expect(h.playing).toBe(true);
    expect(h.state).toBe("playing");
    expect(h.key).toBe("intro_01");
    expect(h.speaker).toBe("Ava");
    expect(h.language).toBe("en");
    expect(h.text).toBe("We're late.");
    expect(h.duration).toBe(1.25);
    expect(h.event).toBeNull();
    expect(fake.plays.at(-1)!.bus).toBe("Voice");
  });

  it("finds the line tables the asset sources list when the project has no line index file", async () => {
    const { ["audio/lines/index.json"]: _index, ...rest } = files();
    await boot(rest);
    expect(Audio.line("intro_01").playing).toBe(true);
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/en/ch1/intro_01.wav");
  });

  it("an unknown key gives an inert handle with reason unknownLine, and finished resolves refused", async () => {
    await boot();
    const h = Audio.line("nope");
    expect(h.playing).toBe(false);
    expect(h.reason).toBe("unknownLine");
    await expect(h.finished).resolves.toBe("refused");
    expect(fake.plays).toHaveLength(0);
  });

  it("the table's output and template decide where it plays; the template's programmer entry gets the key", async () => {
    await boot(files({
      "radio.playlist.json": { format: "myco.playlist@1", type: "clip", output: "SFX", entries: [{ line: null, volume: -6 }] },
    }, { template: "radio.playlist.json" }));
    const h = Audio.line("intro_02");
    expect(h.playing).toBe(true);
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/en/ch1/intro_02.wav");
    expect(fake.plays.at(-1)!.bus).toBe("SFX");
    expect(fake.plays.at(-1)!.volume).toBeCloseTo(Math.pow(10, -6 / 20), 5);
    engine!.dispose();
    endAudioSession();
    await boot(files({}, { output: "SFX" }));
    Audio.line("intro_02");
    expect(fake.plays.at(-1)!.bus).toBe("SFX");
  });

  it("onLine hears start, Cue markers of the heard file and end; finished resolves ended", async () => {
    await boot(files({ "audio/vo/en/ch1/intro_01.wav.meta.json": { format: "myco.import@1", sample: { markers: [{ id: "m1", at: 0.5, type: "cue", name: "beat" }] } } }));
    fake.durations.set("audio/vo/en/ch1/intro_01.wav", 2);
    const events: AudioLineEvent[] = [];
    const off = Audio.onLine((e) => events.push(e));
    const h = Audio.line("intro_01");
    expect(events.map((e) => e.phase)).toEqual(["start"]);
    expect(events[0]).toMatchObject({ key: "intro_01", speaker: "Ava", language: "en", text: "We're late.", textKey: "intro_01", duration: 2 });
    fake.advanceTo(0.6);
    frame();
    expect(events.at(-1)).toMatchObject({ phase: "marker", key: "intro_01", marker: { type: "cue", name: "beat" } });
    lastVoice().end();
    frame();
    expect(events.at(-1)).toMatchObject({ phase: "end", reason: "ended", key: "intro_01" });
    await expect(h.finished).resolves.toBe("ended");
    expect(h.state).toBe("ended");
    off();
  });

  it("viseme() reads the heard file's lipsync keys at the voice's playhead (audio clock, trim applied), blending over the last 60 ms", async () => {
    const lipsync = { set: "rhubarb", keys: [[0, "X"], [0.5, "B"], [1, "E"], [1.4, "X"]] };
    await boot(files({ "audio/vo/en/ch1/intro_01.wav.meta.json": { format: "myco.import@1", sample: { lipsync } } }));
    fake.durations.set("audio/vo/en/ch1/intro_01.wav", 2);
    fake.advanceTo(10); // the line starts at heard time 10
    const h = Audio.line("intro_01");
    expect(h.viseme()).toEqual({ viseme: "X", next: "B", blend: 0 });
    fake.advanceTo(10.47); // 30 ms before B: halfway into the blend
    const v = h.viseme()!;
    expect(v.viseme).toBe("X");
    expect(v.next).toBe("B");
    expect(v.blend).toBeCloseTo(0.5, 5);
    fake.advanceTo(10.5);
    expect(h.viseme()).toEqual({ viseme: "B", next: "E", blend: 0 });
    fake.advanceTo(11.5);
    expect(h.viseme()).toEqual({ viseme: "X", next: null, blend: 0 });
    // A line without lip-sync data, and a line that has ended, give null.
    expect(Audio.line("intro_02").viseme()).toBeNull();
    h.stop(0);
    expect(h.viseme()).toBeNull();
  });

  it("viseme() counts the playhead from the trim's start (keys are file seconds)", async () => {
    const lipsync = { set: "rhubarb", keys: [[0, "X"], [0.5, "B"], [1, "E"]] };
    await boot(files({ "audio/vo/en/ch1/intro_01.wav.meta.json": { format: "myco.import@1", sample: { trim: [0.5, 2], lipsync } } }));
    fake.durations.set("audio/vo/en/ch1/intro_01.wav", 2);
    const h = Audio.line("intro_01");
    expect(h.viseme()?.viseme).toBe("B"); // heard 0 = file 0.5
    fake.advanceTo(0.5);
    expect(h.viseme()?.viseme).toBe("E");
  });

  it("stop ends it stopped (onLine end reason stopped)", async () => {
    await boot();
    const events: AudioLineEvent[] = [];
    Audio.onLine((e) => events.push(e));
    const h = Audio.line("intro_01");
    h.stop(0.1);
    expect(lastVoice().events.at(-1)).toEqual({ kind: "stop", fadeSeconds: 0.1 });
    expect(events.at(-1)).toMatchObject({ phase: "end", reason: "stopped" });
    await expect(h.finished).resolves.toBe("stopped");
  });

  it("a line missing in every language runs subtitle-only for its reading time, then ends", async () => {
    await boot();
    const events: AudioLineEvent[] = [];
    Audio.onLine((e) => events.push(e));
    const short = Audio.line("only_de"); // only German has it; en has no file
    expect(short.playing).toBe(true);
    expect(short.language).toBeNull();
    expect(short.text).toBe("Halt!");
    expect(short.duration).toBe(1.5); // max(minDisplay 1.5, 5 characters / 15)
    const long = Audio.line("long_missing");
    expect(long.duration).toBeCloseTo(61 / 15, 5); // 61 graphemes at 15 per second
    expect(fake.plays).toHaveLength(0);
    expect(events.filter((e) => e.phase === "start").map((e) => e.key)).toEqual(["only_de", "long_missing"]);
    fake.advanceTo(1.6);
    frame();
    expect(short.playing).toBe(false);
    expect(long.playing).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "end", key: "only_de", reason: "ended" });
    await expect(short.finished).resolves.toBe("ended");
  });

  it('with localisation.missing "silent" a line missing in every language is refused with missingLanguage', async () => {
    await boot(files({ "audio.json": { format: "myco.audio@1", localisation: { roots: ["audio/vo"], missing: "silent" } } }));
    const h = Audio.line("only_de");
    expect(h.playing).toBe(false);
    expect(h.reason).toBe("missingLanguage");
    await expect(h.finished).resolves.toBe("refused");
  });

  it("the subtitle resolves in the subtitle language and follows a change mid-line; textKey null is never subtitled", async () => {
    await boot();
    const h = Audio.line("intro_01");
    expect(h.text).toBe("We're late.");
    Audio.subtitleLanguage = "fr";
    expect(Audio.subtitleLanguage).toBe("fr");
    expect(h.text).toBe("On est en retard.");
    expect(h.language).toBe("en"); // the voice stays what was heard
    Audio.subtitleLanguage = "de"; // de → en: no German subtitle
    expect(h.text).toBe("We're late.");
    expect(Audio.line("breath_01").text).toBeNull();
  });
});

describe("playlist line entries (ADR 0354 §5)", () => {
  it("plays a fixed line entry and a programmer one with EventOptions.line, in the current language", async () => {
    await boot(files({
      "fixed.playlist.json": { format: "myco.playlist@1", type: "clip", entries: [{ line: "intro_01" }] },
      "prog.playlist.json": { format: "myco.playlist@1", type: "clip", entries: [{ line: null }] },
    }));
    Audio.play("fixed.playlist.json");
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/en/ch1/intro_01.wav");
    await Audio.setLanguage("fr");
    Audio.play("prog.playlist.json", { line: "intro_01" });
    expect(fake.plays.at(-1)!.path).toBe("audio/vo/fr/ch1/intro_01.wav");
    const none = Audio.play("prog.playlist.json");
    expect(none.playing).toBe(false);
    const unknown = Audio.play("prog.playlist.json", { line: "nope" });
    expect(unknown.reason).toBe("unknownLine");
  });
});

describe("voice follows the text language (0357 §2)", () => {
  it("followText: a text language switch switches the voice language in the same step; subtitles follow the text language", async () => {
    await boot();
    const h = Audio.line("intro_01");
    let seen: { voice: string; text: string | null } | null = null;
    const off = Locale.onChange(() => { seen = { voice: Audio.language, text: h.text }; });
    await Locale.setLanguage("fr");
    off();
    expect(seen).toEqual({ voice: "fr", text: "On est en retard." }); // already switched when text listeners hear it
    expect(Audio.language).toBe("fr");
    expect(Audio.debug().language.subtitles).toBe("fr");
    expect(h.text).toBe(Locale.t("intro_01")); // the subtitle is Locale's text, live
    await Locale.setLanguage("ja"); // text-only: voice goes to the first voice language of its chain (ja → en)
    expect(Audio.language).toBe("en");
    expect(Audio.debug().language.subtitles).toBe("ja");
  });

  it("separate: the text language leaves the voice language alone", async () => {
    await boot(files(), { voice: "separate" });
    await Locale.setLanguage("fr");
    expect(Audio.language).toBe("en");
  });
});

describe("Audio.onCaption (0357 §4)", () => {
  const captions = (extra: Record<string, unknown> = {}) => files({
    "strings/captions.strings.json": { format: "myco.strings@1", language: "en", strings: [{ key: "cc.door", text: "[door slams]" }] },
    "strings/captions.fr.strings.json": { format: "myco.translation@1", language: "fr", strings: { "cc.door": { text: "[porte claquée]", status: "translated" } } },
    "sfx/door.wav": WAV,
    "door.playlist.json": { format: "myco.playlist@1", type: "clip", entries: [{ sample: "sfx/door.wav" }], caption: { key: "cc.door", minGap: 2 } },
    "plain.playlist.json": { format: "myco.playlist@1", type: "clip", entries: [{ sample: "sfx/door.wav" }] },
    ...extra,
  });

  it("fires start when an instance sounds and end when it stops, in the subtitle language, not within minGap", async () => {
    await boot(captions());
    fake.durations.set("sfx/door.wav", 0.8);
    const seen: AudioCaptionEvent[] = [];
    Audio.onCaption((e) => seen.push(e));
    Audio.play("plain.playlist.json");
    expect(seen).toEqual([]);
    Audio.play("door.playlist.json");
    expect(seen).toEqual([{ phase: "start", playlist: "door.playlist.json", key: "cc.door", text: "[door slams]", time: 0, duration: 0.8, pan: null }]);
    fake.advanceTo(0.5);
    Audio.play("door.playlist.json"); // within minGap: no caption
    expect(seen).toHaveLength(1);
    fake.voices[1]!.end();
    frame();
    expect(seen.at(-1)).toMatchObject({ phase: "end", key: "cc.door", time: 0.5 });
    fake.advanceTo(3);
    Audio.subtitleLanguage = "fr";
    Audio.play("door.playlist.json");
    expect(seen.at(-1)).toMatchObject({ phase: "start", text: "[porte claquée]" });
  });

  it("a virtual instance gets no caption until it sounds", async () => {
    await boot(captions());
    const seen: AudioCaptionEvent[] = [];
    Audio.onCaption((e) => seen.push(e));
    // The fake's voices start virtual for this play (the core would report it from its voice selection).
    const play = fake.play;
    fake.play = (req) => {
      const v = play.call(fake, req);
      if (v) (v as unknown as { reason: string | null }).reason = "virtual";
      return v;
    };
    try {
      Audio.play("door.playlist.json");
    } finally {
      fake.play = play;
    }
    expect(seen).toEqual([]);
    (lastVoice() as unknown as { reason: string | null }).reason = null;
    frame();
    expect(seen.map((e) => e.phase)).toEqual(["start"]);
  });
});
