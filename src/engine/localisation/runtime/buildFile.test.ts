// ADR 0356 §11: a build's string files (`strings/<code>.json`, `myco.strings.build@1`): the writer the export uses,
// the reader, and the player loading one file per language switch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Locale, MemoryStorage, type ProjectSettingsInput } from "../../index";
import { parseLanguages } from "../languages";
import { BUILD_STRINGS_FORMAT, buildStringsFile, formatBuildStrings, parseBuildStrings, readBuildLocalisation } from "./buildFile";
import { installBuildStrings } from "./boot";
import { ProjectStrings } from "./strings";

const { languages } = parseLanguages({ list: [{ code: "en" }, { code: "fr" }, { code: "fr-CA", fallback: ["fr"] }], reference: "en", useSystemLanguage: false });

const project = new ProjectStrings([
  ["strings/a.strings.json", { format: "myco.strings@1", language: "en", strings: [{ key: "a", text: "A" }, { key: "b", text: "B {n}" }, { key: "c", text: "C" }] }],
  ["strings/a.fr.strings.json", { format: "myco.translation@1", language: "fr", strings: { a: "A-fr", b: "{broken" } }],
  ["strings/a.fr-CA.strings.json", { format: "myco.translation@1", language: "fr-CA", strings: { c: "C-ca" } }],
]);

afterEach(() => vi.unstubAllGlobals());

describe("build string files", () => {
  it("resolves every key through the language's chain, skipping messages that don't parse", () => {
    const { file, fellBack } = buildStringsFile(languages, "fr-CA", project);
    expect(file).toEqual({ format: BUILD_STRINGS_FORMAT, language: "fr-CA", direction: "ltr", strings: { a: "A-fr", b: "B {n}", c: "C-ca" }, sources: { a: "fr", b: "en" } });
    expect(fellBack).toEqual([{ key: "a", from: "fr" }, { key: "b", from: "en" }]);
    expect(parseBuildStrings(JSON.parse(formatBuildStrings(file))).file).toEqual(file);
  });

  it("records the language a fallback message is written in, only where it differs, and reads old files without it", () => {
    const { file } = buildStringsFile(languages, "fr-CA", project);
    expect(file.sources).toEqual({ a: "fr", b: "en" });
    expect(JSON.parse(formatBuildStrings(file))).toEqual({ format: BUILD_STRINGS_FORMAT, language: "fr-CA", direction: "ltr", strings: { a: "A-fr", b: "B {n}", c: "C-ca" }, sources: { fr: ["a"], en: ["b"] } });
    expect(parseBuildStrings(JSON.parse(formatBuildStrings(file))).file).toEqual(file);
    // Nothing fell back: no `sources` written. A file written before `sources` reads as every message in its language.
    const en = buildStringsFile(languages, "en", project).file;
    expect(en.sources).toEqual({});
    expect(Object.keys(JSON.parse(formatBuildStrings(en)))).not.toContain("sources");
    expect(parseBuildStrings({ format: BUILD_STRINGS_FORMAT, language: "fr", strings: { a: "A" } })).toEqual({ file: { format: BUILD_STRINGS_FORMAT, language: "fr", direction: "ltr", strings: { a: "A" }, sources: {} }, problems: [] });
    // Leniently: keys without a message, the file's own language and bad entries are dropped with a problem each.
    const { file: lenient, problems } = parseBuildStrings({ format: BUILD_STRINGS_FORMAT, language: "fr", strings: { a: "A", b: "B" }, sources: { en: ["a", "zz", 3], fr: ["b"], de: "b" } });
    expect(lenient.sources).toEqual({ a: "en" });
    expect(problems).toHaveLength(4);
  });

  it("reads leniently", () => {
    const { file, problems } = parseBuildStrings({ format: "x", language: "ar", strings: { ok: "fine", "bad key": "x", n: 3 } });
    expect(file).toEqual({ format: BUILD_STRINGS_FORMAT, language: "ar", direction: "rtl", strings: { ok: "fine" }, sources: {} });
    expect(problems).toHaveLength(3);
    expect(readBuildLocalisation(undefined)).toBeNull();
    expect(readBuildLocalisation({ strings: { fr: { url: "strings/fr.json", bytes: 10 }, en: "strings/en.json" }, fonts: { ja: ["fonts/ja.woff2", 3] } })).toEqual({ strings: { fr: "strings/fr.json", en: "strings/en.json" }, fonts: { ja: ["fonts/ja.woff2"] }, pseudo: false });
  });

  // Before the next test: it installs build strings for every later Engine in this file.
  it("format a fallback message with its own language's plural rules, in a build as in the editor (Q12)", async () => {
    // French puts 0 in `one`, English in `other`: an English message shown in French must still say "0 items".
    const tables = {
      "strings/p.strings.json": { format: "myco.strings@1", language: "en", strings: [{ key: "items", text: "{n, plural, one {# item} other {# items}}" }, { key: "fr.items", text: "{n, plural, one {# item} other {# items}}" }] },
      "strings/p.fr.strings.json": { format: "myco.translation@1", language: "fr", strings: { "fr.items": "{n, plural, one {# objet} other {# objets}}" } },
    };
    const langs = { list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], default: "fr", useSystemLanguage: false };
    const run = async (assets?: ReturnType<typeof Assets.fromObject>): Promise<string[]> => {
      const engine = await Engine.create({ headless: true, project: { languages: langs } as ProjectSettingsInput, ...(assets ? { assets } : {}), storage: new MemoryStorage() });
      try {
        expect(Locale.language).toBe("fr");
        return [0, 1, 2].flatMap((n) => [Locale.t("items", { n }), Locale.t("fr.items", { n })]);
      } finally {
        engine.dispose();
      }
    };
    const editor = await run(Assets.fromObject(tables));
    expect(editor).toEqual(["0 items", "0 objet", "1 item", "1 objet", "2 items", "2 objets"]);

    const source = new ProjectStrings(Object.entries(tables));
    const { languages: settings } = parseLanguages(langs);
    const files: Record<string, object> = { "b/strings/en.json": buildStringsFile(settings, "en", source).file, "b/strings/fr.json": JSON.parse(formatBuildStrings(buildStringsFile(settings, "fr", source).file)) };
    vi.stubGlobal("fetch", async (url: string) => ({ ok: !!files[url], status: files[url] ? 200 : 404, json: async () => files[url] }));
    installBuildStrings({ strings: { en: "strings/en.json", fr: "strings/fr.json" } }, (p) => `b/${p}`);
    expect(await run()).toEqual(editor);
  });

  it("are what the player's Locale loads, one per language when it becomes current", async () => {
    const files: Record<string, object> = {
      "game/strings/en.json": buildStringsFile(languages, "en", project).file,
      "game/strings/fr.json": buildStringsFile(languages, "fr", project).file,
    };
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      const body = files[url];
      return { ok: !!body, status: body ? 200 : 404, json: async () => body };
    });
    installBuildStrings({ strings: { en: { url: "strings/en.json" }, fr: { url: "strings/fr.json" } } }, (p) => `game/${p}`);
    const engine = await Engine.create({ headless: true, project: { languages: { list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], useSystemLanguage: false } } as ProjectSettingsInput, storage: new MemoryStorage() });
    try {
      expect(fetched).toEqual(["game/strings/en.json"]); // the start language, before the first scene
      expect(Locale.t("a")).toBe("A");
      await Locale.setLanguage("fr");
      expect(fetched).toEqual(["game/strings/en.json", "game/strings/fr.json"]);
      expect(Locale.t("a")).toBe("A-fr");
      expect(Locale.t("b", { n: 2 })).toBe("B 2"); // the file already holds the fallback
    } finally {
      engine.dispose();
    }
  });
});
