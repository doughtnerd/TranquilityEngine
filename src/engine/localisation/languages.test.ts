import { describe, expect, it } from "vitest";
import {
  canonicalLanguageCode, defaultDirection, defaultLanguages, fallbackChain, intlTagOf, languagesToJson, lookupLanguage, parseLanguages, shippedLanguages,
  voiceLanguageFor, LANGUAGE_LIMITS,
} from "./languages";

const roundTrip = (raw: unknown) => {
  const { languages } = parseLanguages(raw);
  return { languages, again: parseLanguages(languagesToJson(languages)) };
};

const ADR = {
  list: [
    { code: "en", name: "English" },
    { code: "fr", name: "Français" },
    { code: "fr-CA", name: "Français (Canada)", fallback: ["fr"] },
    { code: "de", name: "Deutsch", ship: false },
    { code: "ja", name: "日本語", fonts: ["fonts/NotoSansJP-Regular.woff2"], voice: false },
    { code: "ar", name: "العربية", fonts: ["fonts/NotoNaskhArabic.woff2"], fontReplace: { "fonts/Pirata.ttf": "fonts/ArefRuqaa.ttf" }, intl: "ar-u-nu-latn", readingSpeed: 12 },
  ],
  reference: "en", default: "en", fallback: ["en"], useSystemLanguage: true, remember: true,
  assetRoots: ["images/loc"], voice: "separate",
};

describe("parseLanguages", () => {
  it("reads the records' example without problems and round-trips", () => {
    const { languages, problems } = parseLanguages(ADR);
    expect(problems).toEqual([]);
    expect(languages.list.map((l) => l.code)).toEqual(["en", "fr", "fr-CA", "de", "ja", "ar"]);
    expect(languages.list[2].fallback).toEqual(["fr"]);
    expect(languages.list[3].ship).toBe(false);
    expect(languages.list[4]).toMatchObject({ voice: false, direction: "ltr", fonts: ["fonts/NotoSansJP-Regular.woff2"] });
    expect(languages.list[5]).toMatchObject({ direction: "rtl", intl: "ar-u-nu-latn", readingSpeed: 12, fontReplace: { "fonts/Pirata.ttf": "fonts/ArefRuqaa.ttf" } });
    expect(languages).toMatchObject({ reference: "en", default: "en", fallback: ["en"], assetRoots: ["images/loc"], voice: "separate" });
    const { again } = roundTrip(ADR);
    expect(again).toEqual({ languages, problems: [] });
  });

  it("gives a project without the section English only, and writes the defaults minimal", () => {
    expect(parseLanguages(undefined)).toEqual({ languages: defaultLanguages(), problems: [] });
    expect(languagesToJson(defaultLanguages())).toEqual({ list: [{ code: "en", name: "English" }], reference: "en", default: "en" });
  });

  it("fixes case, refuses malformed tags and codes that differ only in case", () => {
    const { languages, problems } = parseLanguages({ list: ["EN-gb", "en-GB", "zh-hans-cn", "nope!", "x", { code: 3 }, "pt-BR"] });
    expect(languages.list.map((l) => l.code)).toEqual(["en-GB", "zh-Hans-CN", "pt-BR"]);
    expect(problems).toEqual([
      'languages.list[0].code: "EN-gb" is written "en-GB"; using "en-GB".',
      'languages.list[1].code: "en-GB" is listed twice; dropped.',
      'languages.list[2].code: "zh-hans-cn" is written "zh-Hans-CN"; using "zh-Hans-CN".',
      'languages.list[3].code: "nope!" isn\'t a language tag such as "fr" or "pt-BR"; dropped.',
      'languages.list[4].code: "x" isn\'t a language tag such as "fr" or "pt-BR"; dropped.',
      'languages.list[5].code: must be a language tag such as "fr" or "pt-BR"; dropped.',
    ]);
  });

  it("repairs references to unlisted languages, one problem each", () => {
    const { languages, problems } = parseLanguages({ list: [{ code: "fr", fallback: ["fr", "es"] }, "de"], reference: "en", default: "it", fallback: ["es", "de"] });
    expect(languages).toMatchObject({ reference: "fr", default: "fr", fallback: ["de"] });
    expect(languages.list[0].fallback).toEqual([]);
    expect(problems).toEqual([
      "languages.list[0].fallback[0]: a language can't fall back to itself; dropped.",
      'languages.list[0].fallback[1]: "es" isn\'t a listed language; dropped.',
      'languages.reference: "en" isn\'t a listed language; using "fr".',
      'languages.default: "it" isn\'t a listed language; using "fr".',
      'languages.fallback[0]: "es" isn\'t a listed language; dropped.',
    ]);
  });

  it("never throws on junk and applies the language limit", () => {
    for (const junk of [null, 3, "en", [], { list: 5 }, { list: [null, [], {}] }, { list: ["en"], fallback: "fr", voice: 2, assetRoots: ["../x", "/a/b/"] }]) {
      expect(() => parseLanguages(junk)).not.toThrow();
    }
    expect(parseLanguages({ list: ["en"], assetRoots: ["../x", "/a/b/"] }).languages.assetRoots).toEqual(["a/b"]);
    const many = Array.from({ length: 70 }, (_, i) => `l${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    const { languages, problems } = parseLanguages({ list: many.map((c) => c.slice(1)) });
    expect(languages.list.length).toBeLessThanOrEqual(LANGUAGE_LIMITS.languages);
    expect(problems.some((p) => p.includes(`at most ${LANGUAGE_LIMITS.languages} languages`))).toBe(true);
  });
});

describe("fallbackChain", () => {
  const { languages } = parseLanguages({
    list: ["en", "fr", { code: "fr-CA", fallback: ["fr"] }, { code: "pt-BR", fallback: ["pt"] }, "pt", { code: "gsw", fallback: ["de-CH", "de"] }, "de-CH", "de"],
    reference: "en", fallback: ["en", "fr"],
  });
  const table: [string, string[]][] = [
    ["en", ["en", "fr"]],
    ["fr", ["fr", "en"]],
    ["fr-CA", ["fr-CA", "fr", "en"]],
    ["pt-BR", ["pt-BR", "pt", "en", "fr"]],
    ["gsw", ["gsw", "de-CH", "de", "en", "fr"]],
    ["FR-ca", ["fr-CA", "fr", "en"]],
    ["xx", ["xx", "en", "fr"]],
  ];
  for (const [code, chain] of table) it(`${code} → ${chain.join(", ")}`, () => expect(fallbackChain(languages, code)).toEqual(chain));
});

describe("BCP 47", () => {
  it("canonicalises case and refuses malformed tags", () => {
    expect(canonicalLanguageCode("ZH-hant-tw")).toBe("zh-Hant-TW");
    expect(canonicalLanguageCode("es-419")).toBe("es-419");
    expect(canonicalLanguageCode("de-ch-1996")).toBe("de-CH-1996");
    expect(canonicalLanguageCode("ar-u-nu-latn")).toBe("ar-u-nu-latn");
    for (const bad of ["", "e", "english", "en_GB", "en-", "en--GB", "en-u", "1en"]) expect(canonicalLanguageCode(bad)).toBeNull();
  });

  it("looks up by exact tag, then dropping subtags", () => {
    const available = ["en", "fr", "fr-CA", "zh-Hans", "pt"];
    expect(lookupLanguage(["fr-CA"], available)).toBe("fr-CA");
    expect(lookupLanguage(["fr-BE"], available)).toBe("fr");
    expect(lookupLanguage(["zh-hans-cn"], available)).toBe("zh-Hans");
    expect(lookupLanguage(["de-DE", "pt-BR"], available)).toBe("pt");
    expect(lookupLanguage(["en-x-private-a"], available)).toBe("en");
    expect(lookupLanguage(["ja"], available)).toBeNull();
  });

  it("gives right-to-left by language and script", () => {
    for (const code of ["ar", "he", "fa", "ur", "ckb", "az-Arab", "yi"]) expect(defaultDirection(code)).toBe("rtl");
    for (const code of ["en", "ja", "az-Latn", "tr"]) expect(defaultDirection(code)).toBe("ltr");
  });
});

describe("voice and shipping", () => {
  const { languages } = parseLanguages({
    list: ["en", { code: "fr", voice: false, fallback: ["de"] }, { code: "de", ship: false }, { code: "es", voice: false }, { code: "es-MX", intl: "es-MX-u-nu-latn" }],
    reference: "en",
  });
  it("follows a text language to the first voice language of its chain that ships", () => {
    expect(voiceLanguageFor(languages, "en")).toBe("en");
    expect(voiceLanguageFor(languages, "fr")).toBe("en"); // de is a voice language but isn't shipped
    expect(voiceLanguageFor(languages, "es")).toBe("en");
    expect(voiceLanguageFor(languages, "es-MX")).toBe("es-MX");
  });
  it("lists shipped languages and the Intl tag", () => {
    expect(shippedLanguages(languages).map((l) => l.code)).toEqual(["en", "fr", "es", "es-MX"]);
    expect(intlTagOf(languages, "es-MX")).toBe("es-MX-u-nu-latn");
    expect(intlTagOf(languages, "fr")).toBe("fr");
  });
});
