// ADR 0340 §6 (L3): a build's package with language parts at runtime, on the fake backend, through the public `Audio`
// API and `Locale`: a load fetches the base part and the voice language's part, a localised sound whose part isn't
// loaded is refused (`notLoaded`), and an audio language switch (`switchPackageLanguage`, and `Locale.setLanguage`
// under `voice: "followText"`) loads the new part before it unloads the old one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Audio, Engine, Locale } from "../../../../myco";
import { writeAudioPack } from "../../../../engine/audio/packaging/format";
import { parseLanguages } from "../../../../engine/localisation/languages";
import type { AudioManifest } from "../../../../export/format";
import { setAudioBackend } from "../backend";
import { endAudioSession, makeFakeBackend, type FakeVoice } from "../testing";
import { installAudioMedia } from "./mediaTable";
import { switchPackageLanguage } from "./packages";

const fake = makeFakeBackend();
let engine: Engine | null = null;
const WAV = "data:audio/wav;base64,AAAA";

const EN_INTRO = "audio/vo/en/ch1/intro_01.wav";
const FR_INTRO = "audio/vo/fr/ch1/intro_01.wav";
const EN_ONLY = "audio/vo/en/ch1/intro_02.wav"; // French falls back to it

/** Dialogue: a base part (a beep) and an English and a French part, as the export writes them. */
function build() {
  const entry = (path: string) => ({ entry: { path, codec: "vorbis" as const, rate: 48000, channels: 1, frames: 4800, load: "decode" as const, hash: "h", prefetch: null }, data: new Uint8Array(400).fill(1) });
  const base = writeAudioPack("Dialogue", "web", [entry("audio/sfx/beep.wav")]);
  const en = writeAudioPack("Dialogue.en", "web", [entry(EN_INTRO), entry(EN_ONLY)]);
  const fr = writeAudioPack("Dialogue.fr", "web", [entry(EN_ONLY), entry(FR_INTRO)]);
  const media = { codec: "vorbis" as const, load: "decode" as const, rate: 48000, channels: 1, frames: 4800 };
  const manifest: AudioManifest = {
    platform: "web",
    packages: [{
      name: "Dialogue", url: "audio/packages/Dialogue.mycopak", bytes: base.length, preload: false,
      languages: { en: { url: "audio/packages/Dialogue.en.mycopak", bytes: en.length }, fr: { url: "audio/packages/Dialogue.fr.mycopak", bytes: fr.length } },
    }],
    media: {
      "audio/sfx/beep.wav": { package: "Dialogue", ...media },
      [EN_INTRO]: { package: "Dialogue", language: "en", ...media },
      [EN_ONLY]: { package: "Dialogue", language: "en", languages: ["en", "fr"], ...media },
      [FR_INTRO]: { package: "Dialogue", language: "fr", ...media },
    },
  };
  return { manifest, files: { [manifest.packages[0].url]: base, "audio/packages/Dialogue.en.mycopak": en, "audio/packages/Dialogue.fr.mycopak": fr } as Record<string, Uint8Array> };
}

/** `fetch` serving `files`, noting each URL. */
function stubFetch(files: Record<string, Uint8Array>) {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace(/^https:\/\/game\.test\//, "");
    fetched.push(path);
    const bytes = files[path];
    if (!bytes) return { ok: false, status: 404 };
    return { ok: true, status: 200, headers: new Headers({ "content-length": String(bytes.length) }), body: null, arrayBuffer: async () => bytes.slice().buffer };
  });
  return fetched;
}

async function boot(voice: "followText" | "separate" = "followText") {
  const { manifest, files } = build();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "audio.json": { format: "myco.audio@1", localisation: { roots: ["audio/vo"] } },
    "audio/sfx/beep.wav": WAV, [EN_INTRO]: WAV, [FR_INTRO]: WAV, [EN_ONLY]: WAV,
  }));
  installAudioMedia(manifest, (p) => `https://game.test/${p}`);
  const fetched = stubFetch(files);
  engine = await Engine.create({
    headless: true,
    project: { languages: parseLanguages({ list: [{ code: "en" }, { code: "fr" }], reference: "en", voice, useSystemLanguage: false }).languages },
  });
  engine.world.render = {} as never; // a World that plays sound
  return { fetched, files };
}

beforeEach(() => {
  endAudioSession();
  fake.clear();
  fake.ready = true;
  setAudioBackend(fake);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  engine?.dispose();
  engine = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  installAudioMedia(null);
  setAudioBackend(null);
  endAudioSession();
});

describe("package language parts (ADR 0340 §6)", () => {
  it("loads the base part and the voice language's part, and counts both", async () => {
    const { fetched, files } = await boot();
    const dialogue = Audio.package("Dialogue");
    expect(dialogue.languages).toEqual(["en", "fr"]);
    await dialogue.load();
    expect(fetched.sort()).toEqual(["audio/packages/Dialogue.en.mycopak", "audio/packages/Dialogue.mycopak"]);
    expect(dialogue).toMatchObject({ state: "loaded", progress: 1 });
    expect(dialogue.bytes).toBe(files["audio/packages/Dialogue.mycopak"].length + files["audio/packages/Dialogue.en.mycopak"].length);
    expect(dialogue.memoryBytes).toBe(3 * 4800 * 2); // the beep and the two English lines, decoded
    expect(Audio.playOneShot("audio/sfx/beep.wav").playing).toBe(true);
    expect(Audio.playOneShot(EN_INTRO).playing).toBe(true);
    expect(Audio.debug().packages).toEqual([expect.objectContaining({ name: "Dialogue", state: "loaded", refs: 1 })]);
  });

  it("refuses a localised sound whose language part isn't loaded (strict, per part)", async () => {
    await boot("separate");
    await Audio.package("Dialogue").load();
    // The audio language changes without its part: the French file it resolves to is refused.
    await Audio.setLanguage("fr");
    expect(Audio.playOneShot(EN_INTRO).reason).toBe("notLoaded");
  });

  it("switchPackageLanguage loads the new part, then unloads the old one, letting its voices finish", async () => {
    const { fetched } = await boot("separate");
    const dialogue = Audio.package("Dialogue");
    await dialogue.load();
    Audio.playOneShot(EN_INTRO);
    const english = fake.voices.at(-1) as FakeVoice;
    fetched.length = 0;
    await switchPackageLanguage("fr");
    await Audio.setLanguage("fr");
    expect(fetched).toEqual(["audio/packages/Dialogue.fr.mycopak"]);
    expect(english.events.filter((e) => e.kind === "stop")).toEqual([]); // "finish": it plays on
    expect(Audio.playOneShot(FR_INTRO).playing).toBe(true);
    expect(Audio.playOneShot(EN_ONLY).playing).toBe(true); // in the French part too
    expect(Audio.debug().packages[0].state).toBe("loaded");
    // The English part went: back in English without it, the English file is refused.
    english.end();
    await Audio.setLanguage("en");
    expect(Audio.playOneShot(EN_INTRO).reason).toBe("notLoaded");
  });

  it("stops the old part's voices with a 50 ms fade with playing: stop", async () => {
    await boot();
    await Audio.package("Dialogue").load();
    Audio.playOneShot(EN_INTRO);
    const english = fake.voices.at(-1) as FakeVoice;
    await switchPackageLanguage("fr", { playing: "stop" });
    expect(english.events.filter((e) => e.kind === "stop")).toEqual([{ kind: "stop", fadeSeconds: 0.05 }]);
  });

  it("swaps the parts inside Locale.setLanguage's switch when voice follows text, before the language changes", async () => {
    const { fetched } = await boot("followText");
    await Audio.package("Dialogue").load();
    fetched.length = 0;
    await Locale.setLanguage("fr");
    expect(fetched).toEqual(["audio/packages/Dialogue.fr.mycopak"]);
    expect(Audio.language).toBe("fr");
    expect(Audio.playOneShot(FR_INTRO).playing).toBe(true);
  });

  it("unloads the parts with the package, and a package loaded later takes the current language's part", async () => {
    const { fetched } = await boot();
    const dialogue = Audio.package("Dialogue");
    await dialogue.load();
    dialogue.unload();
    expect(dialogue.state).toBe("unloaded");
    expect(Audio.playOneShot(EN_INTRO).reason).toBe("notLoaded");
    await switchPackageLanguage("fr"); // nothing loaded: nothing fetched
    fetched.length = 0;
    await dialogue.load();
    expect(fetched.sort()).toEqual(["audio/packages/Dialogue.fr.mycopak", "audio/packages/Dialogue.mycopak"]);
  });
});
