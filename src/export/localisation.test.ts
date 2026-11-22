// ADR 0342 §10–§11 (T5, T8) and 0340 §6 (L3, amended by 0343 §1): an export of a project with two shipped languages
// (and one `ship: false`), string tables with a translation, a localised texture, a language font and localised voice
// lines in a package, planned (`planWebBuild`) and written (`writeWebBuild`) the way the exporter and the editor do:
// the string files with fallbacks resolved and the warnings for keys that fell back, `game.json`'s `localisation`,
// `--languages` and `ship: false`, the package split into a base part and a part per language, and the line index.
import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../editor/memoryFs";
import { readAudioPack } from "../engine/audio/packaging/format";
import { encodeWavFloat32 } from "../engine/audio/sample/wavEncode";
import { decodeWavPcm } from "../engine/audio/sample/wavPcm";
import { parseBuildStrings } from "../engine/localisation/runtime/buildFile";
import type { DecodeAudio } from "./audio";
import { fileSystemFolder, writeWebBuild, type FileSource } from "./buildWriter";
import type { GameManifest } from "./format";
import { parseArgs } from "./main";
import { planWebBuild, type BuildOptions } from "./webBuild";

const OUT = "C:\\Out\\game";
const text = (v: unknown) => JSON.stringify(v);

function tone(seconds: number, rate = 8000): Uint8Array {
  const frames = Math.round(seconds * rate);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) pcm[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return encodeWavFloat32(pcm, 1, rate);
}

const decode: DecodeAudio = async (bytes) => {
  const wav = decodeWavPcm(bytes);
  if (!wav) throw new Error("not a WAV");
  return { pcm: wav.pcm, channels: wav.channels, sampleRate: wav.rate };
};

/** The fixture project. */
function project(over: Record<string, string | Uint8Array> = {}): Record<string, string | Uint8Array> {
  return {
    "project.json": text({
      name: "Loc",
      languages: {
        list: [
          { code: "en", name: "English" },
          { code: "fr", name: "Français", fonts: ["fonts/NotoSans.woff2"] },
          { code: "de", name: "Deutsch", ship: false },
        ],
        reference: "en",
        assetRoots: ["images/loc"],
      },
    }),
    "scenes/main.scene.json": text({ format: "myco.scene@1", nodes: [] }),
    "strings/menu.strings.json": text({
      format: "myco.strings@1",
      language: "en",
      strings: [
        { key: "menu.start", text: "Start", notes: "Main menu button" },
        { key: "menu.quit", text: "Quit" },
        { key: "hud.coins", text: "{count, plural, one {# coin} other {# coins}}" },
        { key: "ch1.late", text: "Sorry I'm late." },
      ],
    }),
    "strings/menu.fr.strings.json": text({
      format: "myco.translation@1",
      language: "fr",
      strings: {
        "menu.start": { text: "Démarrer", status: "translated" },
        "hud.coins": { text: "{n} pièces", status: "translated" }, // {n} isn't an argument of the reference: fails the checks
        "ch1.late": { text: "Désolée du retard.", status: "needsReview" },
      },
    }),
    "strings/menu.de.strings.json": text({ format: "myco.translation@1", language: "de", strings: { "menu.start": { text: "Starten", status: "translated" } } }),
    "images/loc/en/logo.png": new Uint8Array([1, 1, 1]),
    "images/loc/fr/logo.png": new Uint8Array([2, 2, 2]),
    "images/loc/de/logo.png": new Uint8Array([3, 3, 3]),
    "images/plain.png": new Uint8Array([4]),
    "fonts/NotoSans.woff2": new Uint8Array([5]),
    "audio.json": text({
      format: "myco.audio@1",
      localisation: { roots: ["audio/vo"] },
      packages: [{ name: "Dialogue", include: ["audio/vo/ch1.lines.json", "audio/sfx/beep.wav"] }],
    }),
    "audio/sfx/beep.wav": tone(0.25),
    "audio/vo/ch1.lines.json": text({
      format: "myco.lines@1",
      folder: "ch1",
      lines: [
        { key: "intro_01", speaker: "Ava", notes: "Whispered" },
        { key: "intro_02", speaker: "Ava", textKey: "ch1.late" },
      ],
    }),
    "audio/vo/en/ch1/intro_01.wav": tone(0.5),
    "audio/vo/fr/ch1/intro_01.wav": tone(0.75),
    "audio/vo/en/ch1/intro_02.wav": tone(1),
    "audio/vo/de/ch1/intro_01.wav": tone(0.5),
    ...over,
  };
}

function source(files: Record<string, string | Uint8Array>): FileSource {
  return {
    read: async (path) => {
      const v = files[path];
      if (v === undefined) throw new Error(`no ${path}`);
      return v;
    },
  };
}

const PLAYER = source({ "files.json": text({ files: ["assets/player-x.js", "myco.js", "player.html"] }), "assets/player-x.js": "//", "myco.js": "export {};", "player.html": "<title>p</title>" });

/** Plans and writes a build of `files` (audio packaged from its sources, `--no-audio-convert`). */
async function exportBuild(files: Record<string, string | Uint8Array>, options: BuildOptions = {}) {
  const json = new Map(Object.entries(files).filter(([p]) => p.endsWith(".json")).map(([p, v]) => [p, v as string]));
  const plan = await planWebBuild({ name: "loc", settings: JSON.parse(files["project.json"] as string), files: Object.keys(files), scripts: new Map(), json }, options);
  const fs = new MemoryFileSystem();
  const lines: string[] = [];
  const written = await writeWebBuild(plan, {
    project: source(files),
    player: PLAYER,
    playerWhere: "the test player",
    folder: fileSystemFolder(fs, OUT),
    platform: "web",
    transcode: async () => {
      throw new Error("no transcoding here");
    },
    bake: async () => ({ bytes: new Uint8Array(), dropped: [] }),
    audio: { encoder: null, decode },
    log: (l) => lines.push(l),
  });
  const file = (p: string) => fs.files.get(`${OUT}\\${p.replace(/\//g, "\\")}`);
  const json2 = (p: string) => JSON.parse(file(p) as string) as unknown;
  const bytes = (p: string) => file(p) as Uint8Array;
  return { plan: written, file, json: json2, bytes, lines, manifest: json2("game.json") as GameManifest };
}

describe("string files (ADR 0342 §11, T8)", () => {
  it("writes one complete strings/<code>.json per shipped language with fallbacks resolved, and warns about keys that fell back", async () => {
    const { json, file, lines } = await exportBuild(project());
    const en = parseBuildStrings(json("strings/en.json"));
    const fr = parseBuildStrings(json("strings/fr.json"));
    expect(en.problems).toEqual([]);
    expect(en.file).toMatchObject({ language: "en", direction: "ltr", strings: { "menu.start": "Start", "menu.quit": "Quit", "ch1.late": "Sorry I'm late." } });
    expect(fr.file.strings).toEqual({
      "menu.start": "Démarrer",
      "menu.quit": "Quit", // missing in French: English
      "hud.coins": "{count, plural, one {# coin} other {# coins}}", // the French fails the checks: English
      "ch1.late": "Désolée du retard.", // needs review is still French
    });
    expect(file("strings/de.json")).toBeUndefined(); // ship: false
    // Notes, status and sources never ship: the tables and translations aren't in the build.
    expect(file("project/strings/menu.strings.json")).toBeUndefined();
    expect(file("project/strings/menu.fr.strings.json")).toBeUndefined();
    const warnings = lines.filter((l) => l.startsWith("warning:"));
    expect(warnings).toContainEqual(expect.stringMatching(/strings\/fr\.json: 2 keys fell back to another language: menu\.quit \(en\), hud\.coins \(en\)/));
    expect(warnings).toContainEqual(expect.stringMatching(/the fr translation of "hud\.coins" fails the checks \("n" isn't an argument of the reference text\)/));
    expect(warnings.some((w) => w.includes("strings/en.json"))).toBe(false);
  });

  it("gives game.json a localisation section: each language's string file and size, and its fonts", async () => {
    const { manifest, file } = await exportBuild(project());
    const loc = manifest.localisation!;
    expect(Object.keys(loc.strings)).toEqual(["en", "fr"]);
    expect(loc.strings.fr).toEqual({ url: "strings/fr.json", bytes: new TextEncoder().encode(file("strings/fr.json") as string).length });
    expect(loc.fonts).toEqual({ fr: ["project/fonts/NotoSans.woff2"] });
    expect(loc.pseudo).toBeUndefined();
    expect(manifest.files).not.toContain("strings/menu.strings.json");
  });

  it("adds the pseudo-languages with --pseudo", async () => {
    const { manifest } = await exportBuild(project(), { pseudo: true });
    expect(manifest.localisation?.pseudo).toBe(true);
    expect(parseArgs(["game", "--pseudo", "--languages", "en, fr"])).toMatchObject({ projectDir: "game", pseudo: true, languages: ["en", "fr"] });
  });

  it("leaves a project without languages or string tables as it was", async () => {
    const { manifest, file } = await exportBuild({ "project.json": text({ name: "Plain" }), "scenes/main.scene.json": "{}" });
    expect(manifest.localisation).toBeUndefined();
    expect(file("strings/en.json")).toBeUndefined();
  });
});

describe("localised files and languages (ADR 0342 §10, 0340 §6)", () => {
  it("ships the shipped languages' variants under asset and audio roots, and leaves out a ship: false language's", async () => {
    const { manifest, bytes, file } = await exportBuild(project());
    expect(bytes("project/images/loc/en/logo.png")).toEqual(new Uint8Array([1, 1, 1]));
    expect(bytes("project/images/loc/fr/logo.png")).toEqual(new Uint8Array([2, 2, 2]));
    expect(file("project/images/loc/de/logo.png")).toBeUndefined();
    expect(manifest.files).toContain("images/loc/fr/logo.png");
    expect(manifest.files).not.toContain("images/loc/de/logo.png");
    expect(manifest.files).not.toContain("audio/vo/de/ch1/intro_01.wav");
    expect(manifest.files).toContain("images/plain.png");
  });

  it("narrows to --languages: one string file, one variant, one language part, and a project.json that ships only it", async () => {
    const { manifest, file, json } = await exportBuild(project(), { languages: ["en", "de", "xx"] });
    expect(Object.keys(manifest.localisation!.strings)).toEqual(["en"]);
    expect(file("strings/fr.json")).toBeUndefined();
    expect(file("project/images/loc/fr/logo.png")).toBeUndefined();
    expect(Object.keys(manifest.audio!.packages[0].languages!)).toEqual(["en"]);
    const languages = (json("project/project.json") as { languages: { list: { code: string; ship?: boolean }[] } }).languages.list;
    expect(languages.map((l) => [l.code, l.ship ?? true])).toEqual([["en", true], ["fr", false], ["de", false]]);
    expect(manifest.localisation!.fonts).toEqual({});
  });

  it("warns about --languages codes that don't ship, and refuses a build left with none", async () => {
    const plan = await planWebBuild({ name: "loc", settings: {}, files: Object.keys(project()), scripts: new Map(), json: new Map(Object.entries(project()).filter(([p]) => p.endsWith(".json")) as [string, string][]) }, { languages: ["en", "de", "xx"] });
    expect(plan.warnings).toEqual([
      '--languages: "de" has ship: false in project.json; left out.',
      '--languages: "xx" isn\'t a language of the project (en, fr, de); ignored.',
    ]);
    await expect(planWebBuild({ name: "loc", settings: {}, files: Object.keys(project()), scripts: new Map(), json: new Map(Object.entries(project()).filter(([p]) => p.endsWith(".json")) as [string, string][]) }, { languages: ["de"] })).rejects.toThrow(/No language ships/);
  });
});

describe("per-language packages and the line index (ADR 0340 §6 L3, 0343 §1)", () => {
  it("splits a package reaching localised files into a base part and a part per shipped language", async () => {
    const { manifest, bytes, file } = await exportBuild(project());
    const pkg = manifest.audio!.packages.find((p) => p.name === "Dialogue")!;
    expect(pkg.url).toBe("audio/packages/Dialogue.mycopak");
    expect(Object.keys(pkg.languages ?? {})).toEqual(["en", "fr"]);
    expect(pkg.languages!.fr).toEqual({ url: "audio/packages/Dialogue.fr.mycopak", bytes: bytes("audio/packages/Dialogue.fr.mycopak").length });
    const toc = (url: string) => {
      const read = readAudioPack(bytes(url));
      if ("error" in read) throw new Error(read.error);
      return read.pack.toc.entries.map((e) => e.path);
    };
    expect(toc("audio/packages/Dialogue.mycopak")).toEqual(["audio/sfx/beep.wav"]);
    expect(toc("audio/packages/Dialogue.en.mycopak")).toEqual(["audio/vo/en/ch1/intro_01.wav", "audio/vo/en/ch1/intro_02.wav"]);
    // French has no intro_02: its part holds the English file its chain resolves to.
    expect(toc("audio/packages/Dialogue.fr.mycopak")).toEqual(["audio/vo/en/ch1/intro_02.wav", "audio/vo/fr/ch1/intro_01.wav"]);
    expect(manifest.audio!.media["audio/vo/fr/ch1/intro_01.wav"]).toMatchObject({ package: "Dialogue", language: "fr" });
    expect(manifest.audio!.media["audio/vo/en/ch1/intro_02.wav"]).toMatchObject({ package: "Dialogue", language: "en", languages: ["en", "fr"] });
    expect(manifest.audio!.media["audio/sfx/beep.wav"].language).toBeUndefined();
    // Packaged sounds aren't written loose; an unshipped language's file is in no part.
    expect(file("project/audio/vo/fr/ch1/intro_01.wav")).toBeUndefined();
    expect(file("audio/packages/Dialogue.de.mycopak")).toBeUndefined();
  });

  it("never puts string files or fonts into packages, even when a package's globs match them", async () => {
    const files = project({ "audio.json": text({ format: "myco.audio@1", localisation: { roots: ["audio/vo"] }, packages: [{ name: "All", include: ["**"] }] }) });
    const { manifest, bytes } = await exportBuild(files);
    const all = manifest.audio!.packages[0];
    const paths = [all.url, ...Object.values(all.languages ?? {}).map((l) => l.url)].flatMap((url) => {
      const read = readAudioPack(bytes(url));
      if ("error" in read) throw new Error(read.error);
      return read.pack.toc.entries.map((e) => e.path);
    });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.endsWith(".wav"))).toBe(true);
  });

  it("writes the line index the runtime reads, and ships line tables with textKey but without notes or text", async () => {
    const withText = project({
      "audio/barks.dialogue.json": text({ format: "myco.dialogue@1", events: [] }),
      "audio/vo/ch1.lines.json": text({
        format: "myco.lines@1",
        folder: "ch1",
        lines: [
          { key: "intro_01", speaker: "Ava", notes: "Whispered", text: { en: "Hello there" } },
          { key: "intro_02", speaker: "Ava", textKey: "ch1.late" },
        ],
      }),
    });
    const { manifest, json, file } = await exportBuild(withText);
    expect(json("project/audio/lines/index.json")).toEqual({ format: "myco.lineindex@1", tables: ["audio/vo/ch1.lines.json"], dialogue: ["audio/barks.dialogue.json"] });
    expect(manifest.files).toContain("audio/lines/index.json");
    expect(manifest.files).toContain("audio/vo/ch1.lines.json");
    const table = file("project/audio/vo/ch1.lines.json") as string;
    expect(JSON.parse(table)).toEqual({
      format: "myco.lines@1",
      folder: "ch1",
      lines: [{ key: "intro_01", speaker: "Ava" }, { key: "intro_02", speaker: "Ava", textKey: "ch1.late" }],
    });
    expect(table).not.toMatch(/Whispered|Hello there/);
  });

  it("writes no line index for a project without line tables or dialogue files", async () => {
    const files = project();
    delete files["audio/vo/ch1.lines.json"];
    const { manifest, file } = await exportBuild(files);
    expect(file("project/audio/lines/index.json")).toBeUndefined();
    expect(manifest.files).not.toContain("audio/lines/index.json");
  });
});
