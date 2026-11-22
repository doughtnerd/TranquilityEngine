import { describe, expect, it } from "vitest";
import { textHash } from "../textHash";
import {
  emptyStringTable, formatStringTable, parseStringTable, stringsPathKind, stringTableToJson, translationPath, STRINGS_LIMITS,
} from "./format";
import { effectiveStatus, formatTranslation, parseTranslation, translatedEntry, translationToJson } from "./translation";
import { validateStringTable, validateTranslation } from "./validate";

const MENU = {
  format: "myco.strings@1",
  language: "en",
  strings: [
    { key: "menu.start", text: "Start game", notes: "Main menu button. Verb.", maxLength: 18, tags: ["menu"], examples: {} },
    { key: "hud.coins", text: "{count, plural, =0 {No coins} one {# coin} other {# coins}}", examples: { count: 12 } },
  ],
};

const MENU_FR = {
  format: "myco.translation@1",
  language: "fr",
  strings: {
    "menu.start": { text: "Commencer", status: "translated", source: textHash("Start game") },
    "hud.coins": { text: "{count, plural, =0 {Aucune pièce} one {# pièce} many {# de pièces} other {# pièces}}", status: "needsReview" },
  },
};

describe("string tables", () => {
  it("parse the record's example and round-trip", () => {
    const { table, problems } = parseStringTable(MENU, "strings/menu.strings.json");
    expect(problems).toEqual([]);
    expect(table.strings[0]).toEqual({ key: "menu.start", text: "Start game", notes: "Main menu button. Verb.", maxLength: 18, tags: ["menu"], examples: {} });
    expect(table.strings[1].examples).toEqual({ count: 12 });
    expect(parseStringTable(stringTableToJson(table))).toEqual({ table, problems: [] });
    expect(stringTableToJson(table).strings).toEqual([
      { key: "menu.start", text: "Start game", notes: "Main menu button. Verb.", maxLength: 18, tags: ["menu"] },
      { key: "hud.coins", text: MENU.strings[1].text, examples: { count: 12 } },
    ]);
    expect(formatStringTable(emptyStringTable("fr"))).toBe('{\n  "format": "myco.strings@1",\n  "language": "fr",\n  "strings": []\n}\n');
  });

  it("drop bad and repeated keys and bad values, one problem each", () => {
    const { table, problems } = parseStringTable({
      format: "myco.strings@1", language: "EN",
      strings: [{ key: "a b", text: "x" }, { key: "ok", text: 3 }, { key: "ok", text: "1" }, { key: "ok", text: "2" }, { key: "m", text: "y", maxLength: 0, tags: [1], examples: { n: {}, __proto__: 1 } }, "junk"],
    }, "t");
    expect(table.language).toBe("en");
    expect(table.strings.map((s) => [s.key, s.text])).toEqual([["ok", "1"], ["m", "y"]]);
    expect(problems).toEqual([
      't.strings[0].key: "a b" isn\'t a key (letters, digits, _ . -, at most 128); dropped.',
      "t.strings[1].text: must be a string; dropped.",
      't.strings[3].key: "ok" is used twice; dropped.',
      "t.strings[4].maxLength: must be a whole number of characters ≥ 1; dropped.",
      "t.strings[4].tags[0]: must be a string; dropped.",
      "t.strings[4].examples.n: must be a string or a number; dropped.",
      "t.strings[5]: a string must be an object with a key and text; dropped.",
    ]);
  });

  it("cut a message over the limit and never throw", () => {
    const { table, problems } = parseStringTable({ format: "myco.strings@1", language: "en", strings: [{ key: "k", text: "x".repeat(STRINGS_LIMITS.message + 5) }] });
    expect(table.strings[0].text.length).toBe(STRINGS_LIMITS.message);
    expect(problems).toEqual([`strings.strings[0].text: at most ${STRINGS_LIMITS.message} characters; cut.`]);
    for (const junk of [null, 1, "x", [], { strings: {} }, { language: 5, strings: [null] }]) expect(() => parseStringTable(junk)).not.toThrow();
  });

  it("name translations beside the table", () => {
    expect(stringsPathKind("strings/menu.strings.json")).toEqual({ kind: "table", stem: "menu" });
    expect(stringsPathKind("strings/menu.fr-CA.strings.json")).toEqual({ kind: "translation", stem: "menu", code: "fr-CA", table: "strings/menu.strings.json" });
    expect(stringsPathKind("menu.strings.json")).toEqual({ kind: "table", stem: "menu" });
    expect(stringsPathKind("strings/menu.fr.extra.strings.json")).toBeNull();
    expect(stringsPathKind("strings/menu.json")).toBeNull();
    expect(translationPath("strings/menu.strings.json", "ja")).toBe("strings/menu.ja.strings.json");
  });
});

describe("translations", () => {
  it("parse the record's example and round-trip", () => {
    const { translation, problems } = parseTranslation(MENU_FR, "strings/menu.fr.strings.json");
    expect(problems).toEqual([]);
    expect(translation.strings["menu.start"]).toEqual({ text: "Commencer", status: "translated", source: textHash("Start game") });
    expect(translation.strings["hud.coins"].source).toBeNull();
    expect(parseTranslation(translationToJson(translation), "strings/menu.fr.strings.json")).toEqual({ translation, problems: [] });
    expect(translationToJson(translation).strings).toEqual({
      "menu.start": { text: "Commencer", source: textHash("Start game") },
      "hud.coins": { text: MENU_FR.strings["hud.coins"].text, status: "needsReview" },
    });
    expect(formatTranslation(translation).endsWith("}\n")).toBe(true);
  });

  it("report a language that differs from the file name and repair bad entries", () => {
    const { translation, problems } = parseTranslation({
      format: "myco.translation@1", language: "de",
      strings: { "a": { text: "x", status: "done", source: "XYZ" }, "b c": { text: "y" }, "d": 4, "e": "short form" },
    }, "strings/menu.fr.strings.json");
    expect(translation.language).toBe("fr");
    expect(translation.strings).toEqual({ a: { text: "x", status: "translated", source: null }, e: { text: "short form", status: "translated", source: null } });
    expect(problems).toEqual([
      'strings/menu.fr.strings.json.language: "de" differs from the file name\'s "fr"; using "fr".',
      'strings/menu.fr.strings.json.strings.a.status: must be one of translated, needsReview; using "translated".',
      "strings/menu.fr.strings.json.strings.a.source: must be 16 lower-case hex digits; dropped.",
      "strings/menu.fr.strings.json.strings.b c: isn't a key; dropped.",
      "strings/menu.fr.strings.json.strings.d: must be an object with text; dropped.",
    ]);
  });

  it("become needsReview when the reference text changes, without a write", () => {
    const entry = translatedEntry("Commencer", "Start game");
    expect(effectiveStatus(entry, "Start game")).toBe("translated");
    expect(effectiveStatus(entry, "Start the game")).toBe("needsReview");
    expect(effectiveStatus({ text: "x", status: "needsReview", source: textHash("a") }, "a")).toBe("needsReview");
    expect(effectiveStatus({ text: "x", status: "translated", source: null }, "anything")).toBe("translated");
    expect(effectiveStatus(undefined, "a")).toBe("missing");
  });
});

describe("validation", () => {
  const { table } = parseStringTable(MENU);
  it("checks a translation against the table: names, kinds, plural categories, unknown keys", () => {
    const { translation } = parseTranslation({
      format: "myco.translation@1", language: "pl",
      strings: {
        "menu.start": { text: "Rozpocznij {grę}" },
        "hud.coins": { text: "{count, plural, one {# moneta} other {# monet}}" },
        "gone": { text: "x" },
      },
    });
    const problems = validateTranslation(table, translation, "pl", "Polish");
    expect(problems.map((k) => [k.key, k.problems.map((p) => p.message)])).toEqual([
      ["menu.start", ['"grę" isn\'t an argument of the reference text']],
      ["hud.coins", ['Polish needs few and many in the plural of "count"']],
      ["gone", ['"gone" isn\'t a key of the table; it is never used']],
    ]);
  });

  it("passes a good translation and checks reference text in its language", () => {
    const { translation } = parseTranslation(MENU_FR);
    expect(validateTranslation(table, translation)).toEqual([]);
    expect(validateStringTable(table)).toEqual([]);
    const { table: broken } = parseStringTable({ format: "myco.strings@1", language: "en", strings: [{ key: "x", text: "{n, plural, one {#}" }] });
    expect(validateStringTable(broken).map((k) => k.key)).toEqual(["x"]);
  });
});
