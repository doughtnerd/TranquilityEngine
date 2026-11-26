// ADR 0357 §5: the built-in subtitle display and the player settings through the public `myco` API in a headless engine:
// `Audio.line` on the fake audio backend shows and hides the row on the heard clock (not wall clock), speaker names and
// colours from `project.json`, the settings turning rows off, a live language change, and the settings' first-run
// defaults and persistence under `settings/myco.subtitles`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Audio, Engine, GameObject, Locale, MemoryStorage, SceneManager, Storage, SubtitleDisplay, Subtitles, UICanvas, UIText, UIView } from "../../../myco";
import { parseLanguages } from "../../../engine/localisation/languages";
import { setAudioBackend } from "../../audio/runtime/backend";
import { endAudioSession, makeFakeBackend, type FakeVoice } from "../../audio/runtime/testing";
// The built-in UI components, as the editor provides them (ADR 0419 wave B).
import "../builtinUI";
import * as MySubtitles from "./testComponents/MySubtitles.svelte";
import { SUBTITLE_LOOK } from "./look";

const fake = makeFakeBackend();
let engine: Engine | null = null;
const WAV = "data:,";

const FILES: Record<string, unknown> = {
  "s.json": { format: "myco.scene@1", nodes: [] },
  "audio.json": { format: "myco.audio@1", localisation: { roots: ["audio/vo"] } },
  "audio/lines/index.json": { format: "myco.lineindex@1", tables: ["audio/vo/ch1.lines.json"] },
  "audio/vo/ch1.lines.json": { format: "myco.lines@1", folder: "ch1", lines: [{ key: "intro_01", speaker: "Ava" }, { key: "guard_01", speaker: "Guard" }] },
  "audio/vo/ch1.strings.json": {
    format: "myco.strings@1", language: "en",
    strings: [{ key: "intro_01", text: "We're late." }, { key: "guard_01", text: "Halt!" }, { key: "speaker.ava", text: "Ava" }, { key: "subtitles.speaker", text: "{name}:" }],
  },
  "audio/vo/ch1.fr.strings.json": { format: "myco.translation@1", language: "fr", strings: { intro_01: "On est en retard.", "speaker.ava": "Ava", "subtitles.speaker": "{name} :" } },
  "audio/vo/en/ch1/intro_01.wav": WAV,
  "audio/vo/en/ch1/guard_01.wav": WAV,
  "ui/subs.svelte": MySubtitles,
};

const LANGUAGES = { list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], reference: "en", default: "en", useSystemLanguage: false, remember: false };

async function boot(options: { storage?: MemoryStorage; subtitles?: Record<string, unknown> } = {}): Promise<void> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(FILES));
  engine = await Engine.create({
    headless: true,
    audioOnly: true, // a World that plays sound without a view
    storage: options.storage ?? new MemoryStorage(),
    project: {
      audio: { buses: [{ name: "Master" }, { name: "Voice", parent: "Master" }] },
      languages: parseLanguages(LANGUAGES).languages,
      subtitles: { defaults: { enabled: true, size: "medium", background: 0.6, speakerNames: true, captions: false }, readingSpeed: 15, minDisplay: 1.5, speakers: { Ava: { name: "speaker.ava", color: "#ff0000" } }, ...options.subtitles },
    } as never,
  });
  await SceneManager.load("s.json");
}

/** A node with a SubtitleDisplay, once its view is mounted. */
async function display(init: { component?: string; speakerNames?: SubtitleDisplay["speakerNames"] } = {}): Promise<{ display: SubtitleDisplay; doc: UIView }> {
  const display = GameObject.create("HUD").addBehavior(SubtitleDisplay, init);
  const doc = display.node.getComponentInChildren(UIView)!;
  await doc.ready;
  frame();
  return { display, doc };
}

const frame = (dt = 1 / 60) => engine!.step(dt);
const lines = (doc: UIView) => doc.queryAll(".line").map((e) => e.as(UIText).text);
const speakers = (doc: UIView) => doc.queryAll(".speaker").map((e) => e.as(UIText));
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
  endAudioSession();
  setAudioBackend(null);
});

describe("SubtitleDisplay", () => {
  it("mounts the built-in component, on its own screen canvas (sortOrder 1000)", async () => {
    await boot();
    const { doc } = await display();
    expect(doc.component).toBe("asset:@myco/ui/Subtitles.svelte");
    const canvas = doc.root!.as(UICanvas);
    expect(canvas.mode).toBe("screen");
    expect(canvas.sortOrder).toBe(1000);
    expect(doc.query("#subtitles")).not.toBeNull();
  });

  it("draws the built-in look, themes through a game component's global variables, and takes a replacement component", async () => {
    await boot();
    const themed = await display();
    Audio.line("intro_01");
    frame();
    const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
    expect(hex(themed.doc.queryAll(".line")[0].as(UIText).color)).toBe(SUBTITLE_LOOK.color);
    expect(hex(speakers(themed.doc)[0].color)).toBe("#ff0000"); // the speaker's own colour
    // A component's global rules reach every view (ADR 0419), so a game's component can carry the theme.
    await import("./testComponents/SubtitleTheme.svelte");
    frame();
    expect(hex(themed.doc.queryAll(".line")[0].as(UIText).color)).toBe("#00ff00");
    const own = await display({ component: "asset:ui/subs.svelte" });
    expect(own.doc.query("#mine")).not.toBeNull();
    Audio.line("guard_01");
    frame();
    expect(lines(own.doc)).toEqual(["Halt!"]);
  });

  it("shows a line's row from Audio.line until the audio's end on the heard clock, then fades it out", async () => {
    await boot();
    const { doc } = await display();
    fake.durations.set("audio/vo/en/ch1/intro_01.wav", 2);
    Audio.line("intro_01");
    frame();
    expect(lines(doc)).toEqual(["We're late."]);
    expect(speakers(doc)[0].text).toBe("Ava:");
    frame(); // a new row's restyle wins its first frame; the display writes the colour again on the next
    expect(speakers(doc)[0].color.r).toBe(1); // the speaker's colour from project.json
    expect(speakers(doc)[0].color.g).toBe(0);
    // Wall clock doesn't move it: five seconds of frames at heard time 1 keep it.
    fake.advanceTo(1);
    for (let i = 0; i < 5; i++) frame(1);
    expect(lines(doc)).toEqual(["We're late."]);
    fake.advanceTo(2);
    lastVoice().end();
    frame();
    expect(lines(doc)).toEqual(["We're late."]); // fading out over 0.2 s
    fake.advanceTo(2.3);
    frame();
    frame();
    expect(lines(doc)).toEqual([]);
  });

  it("shows speaker names only while several speak with whenSeveral, and none when the player turns them off", async () => {
    await boot();
    const { doc } = await display({ speakerNames: "whenSeveral" });
    fake.durations.set("audio/vo/en/ch1/intro_01.wav", 3);
    fake.durations.set("audio/vo/en/ch1/guard_01.wav", 3);
    Audio.line("intro_01");
    frame();
    expect(speakers(doc).map((s) => s.display)).toEqual(["none"]);
    Audio.line("guard_01");
    frame();
    expect(speakers(doc).map((s) => [s.text, s.display])).toEqual([["Ava:", "flex"], ["Guard:", "flex"]]);
    Subtitles.set({ speakerNames: false });
    frame();
    expect(speakers(doc).map((s) => s.display)).toEqual(["none", "none"]);
  });

  it("sizes text by the player's size preset (% of the canvas reference height)", async () => {
    await boot();
    const { doc } = await display();
    Audio.line("intro_01");
    frame();
    const line = () => doc.queryAll(".line")[0].as(UIText);
    expect(line().fontSize).toBeCloseTo(28.8, 5); // medium: 4% of 720
    Subtitles.set({ size: "extraLarge" });
    frame();
    expect(line().fontSize).toBeCloseTo(46.08, 5); // 6.4% of 720
  });

  it("hides speech rows while the player's subtitles are off", async () => {
    await boot();
    const { doc } = await display();
    fake.durations.set("audio/vo/en/ch1/intro_01.wav", 3);
    Audio.line("intro_01");
    frame();
    expect(lines(doc)).toHaveLength(1);
    Subtitles.set({ enabled: false });
    frame();
    frame();
    expect(lines(doc)).toEqual([]);
  });

  it("updates the text live on a language change, with the language's speaker format", async () => {
    await boot();
    const { doc } = await display();
    fake.durations.set("audio/vo/en/ch1/intro_01.wav", 3);
    Audio.line("intro_01");
    frame();
    await Locale.setLanguage("fr");
    frame();
    expect(lines(doc)).toEqual(["On est en retard."]);
    expect(speakers(doc)[0].text).toBe("Ava :");
  });
});

describe("Subtitles settings", () => {
  it("first run: the project's defaults (on, medium, background 0.6, speaker names on, captions off)", async () => {
    await boot();
    expect(Subtitles.settings).toEqual({ enabled: true, size: "medium", background: 0.6, speakerNames: true, captions: false });
    expect(Object.isFrozen(Subtitles.settings)).toBe(true);
  });

  it("set applies at once, tells onChange and persists under settings/myco.subtitles; a new game loads them before the first scene", async () => {
    const storage = new MemoryStorage();
    await boot({ storage });
    const seen: unknown[] = [];
    const off = Subtitles.onChange((s) => seen.push({ ...s }));
    Subtitles.set({ size: "large", captions: true });
    expect(Subtitles.settings).toMatchObject({ size: "large", captions: true, enabled: true });
    expect(seen).toEqual([{ enabled: true, size: "large", background: 0.6, speakerNames: true, captions: true }]);
    off();
    await vi.waitFor(async () => expect(await Storage.load("myco.subtitles", "settings")).toMatchObject({ size: "large", captions: true }));
    engine!.dispose();
    engine = null;
    await boot({ storage });
    expect(Subtitles.settings).toMatchObject({ size: "large", captions: true });
  });

  it("bad values keep the current setting with a warning; reset goes back to the project's defaults and deletes the saved values", async () => {
    const storage = new MemoryStorage();
    await boot({ storage, subtitles: { defaults: { size: "small" } } });
    expect(Subtitles.settings.size).toBe("small");
    Subtitles.set({ size: "huge" as never, background: 0.3 });
    expect(Subtitles.settings).toMatchObject({ size: "small", background: 0.3 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Subtitles.set.size"));
    Subtitles.reset();
    expect(Subtitles.settings).toMatchObject({ size: "small", background: 0.6 });
    await vi.waitFor(async () => expect(await Storage.load("myco.subtitles", "settings")).toBeUndefined());
  });

  it("a change made while the saved values are still loading isn't overwritten when they arrive", async () => {
    let release!: () => void;
    let reading!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (reading = r));
    class SlowStorage extends MemoryStorage {
      override async load(ns: Parameters<MemoryStorage["load"]>[0], key: string) {
        if (ns === "settings" && key === "myco.subtitles") {
          reading();
          await gate;
        }
        return super.load(ns, key);
      }
    }
    const storage = new SlowStorage();
    await storage.save("settings", "myco.subtitles", { enabled: true, size: "small", background: 0.6, speakerNames: true, captions: false });
    const booting = boot({ storage });
    await started;
    Subtitles.set({ size: "large" });
    release();
    await booting;
    expect(Subtitles.settings.size).toBe("large");
  });

  it("speaker(id): the name string in the current language, else the id, and the colour", async () => {
    await boot();
    expect(Subtitles.speaker("Ava")).toMatchObject({ name: "Ava" });
    expect(Subtitles.speaker("Ava").color?.toHex()).toBe("#ff0000");
    expect(Subtitles.speaker("Guard")).toEqual({ name: "Guard", color: null });
  });
});
