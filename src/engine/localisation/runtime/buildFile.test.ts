// ADR 0342 §11: a build's string files (`strings/<code>.json`, `myco.strings.build@1`): the writer the export uses,
// the reader, and the player loading one file per language switch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine, Locale, MemoryStorage, type ProjectSettingsInput } from "../../index";
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
    expect(file).toEqual({ format: BUILD_STRINGS_FORMAT, language: "fr-CA", direction: "ltr", strings: { a: "A-fr", b: "B {n}", c: "C-ca" } });
    expect(fellBack).toEqual([{ key: "a", from: "fr" }, { key: "b", from: "en" }]);
    expect(parseBuildStrings(JSON.parse(formatBuildStrings(file))).file).toEqual(file);
  });

  it("reads leniently", () => {
    const { file, problems } = parseBuildStrings({ format: "x", language: "ar", strings: { ok: "fine", "bad key": "x", n: 3 } });
    expect(file).toEqual({ format: BUILD_STRINGS_FORMAT, language: "ar", direction: "rtl", strings: { ok: "fine" } });
    expect(problems).toHaveLength(3);
    expect(readBuildLocalisation(undefined)).toBeNull();
    expect(readBuildLocalisation({ strings: { fr: { url: "strings/fr.json", bytes: 10 }, en: "strings/en.json" }, fonts: { ja: ["fonts/ja.woff2", 3] } })).toEqual({ strings: { fr: "strings/fr.json", en: "strings/en.json" }, fonts: { ja: ["fonts/ja.woff2"] }, pseudo: false });
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
