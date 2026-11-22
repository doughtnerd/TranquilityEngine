// ADR 0342 §8: the translator exchange — CSV, XLIFF 1.2 and gettext PO written from the project and read back, and the
// import preview: new and changed translations, status changes, unknown keys and languages skipped, ICU check
// failures skipped with the reason, maxLength enforced, and translations made against older reference text imported
// as needing review. Driven through the exchange modules' own interfaces.
import { describe, expect, it } from "vitest";
import { parseLanguages } from "../languages";
import { parseStringTable } from "../strings/format";
import { effectiveStatus, parseTranslation } from "../strings/translation";
import { textHash } from "../textHash";
import { csvRecords, formatCsv, parseCsv } from "./csv";
import { readStringsCsv, writeStringsCsv } from "./csvExchange";
import { applyImport, previewImport } from "./importPreview";
import { graphemeLength, messageLength } from "./length";
import { exportUnits, type ExchangeProject, type ImportRead } from "./model";
import { readPo, writePo, writePot } from "./po";
import { readXliff, writeXliff } from "./xliff";

const languages = parseLanguages({ list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }, { code: "pl", name: "Polski" }], reference: "en" }).languages;

const MENU = parseStringTable({
  format: "myco.strings@1", language: "en",
  strings: [
    { key: "menu.start", text: "Start game", notes: "Main menu button. Verb.", maxLength: 18 },
    { key: "hud.coins", text: "{count, plural, one {# coin} other {# coins}}", examples: { count: 12 } },
    { key: "quote", text: 'He said "hi", then left,\nlater.', notes: "Two lines" },
  ],
}).table;
const MENU_FR = parseTranslation({
  format: "myco.translation@1", language: "fr",
  strings: { "menu.start": { text: "Commencer", source: textHash("Start game") }, "hud.coins": { text: "{count, plural, one {# pièce} many {# de pièces} other {# pièces}}", status: "needsReview" } },
}).translation;

const project = (): ExchangeProject => ({ languages, tables: [{ path: "strings/menu.strings.json", table: MENU, translations: { fr: MENU_FR } }] });
const read = (entries: ImportRead["entries"]): ImportRead => ({ entries, problems: [] });
const entry = (key: string, text: string, extra: Partial<ImportRead["entries"][number]> = {}) => ({ key, table: null, language: "fr", text, status: "translated" as const, source: null, ...extra });

describe("import preview", () => {
  it("imports a translation made against older reference text as needing review", () => {
    const p = previewImport(project(), read([entry("menu.start", "Lancer", { source: "Start the game" })]));
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ key: "menu.start", language: "fr", kind: "changed", stale: true });
    expect(p.changes[0].after).toEqual({ text: "Lancer", status: "needsReview", source: textHash("Start the game") });
    const [file] = applyImport(project(), p);
    expect(effectiveStatus(file.translation.strings["menu.start"], "Start game")).toBe("needsReview");
  });

  it("keeps a translation made against the current text as translated, hashing the current text", () => {
    const p = previewImport(project(), read([entry("quote", "Il a dit « salut »", { source: MENU.strings[2].text })]));
    expect(p.changes[0]).toMatchObject({ kind: "new", stale: false });
    expect(p.changes[0].after).toEqual({ text: "Il a dit « salut »", status: "translated", source: textHash(MENU.strings[2].text) });
  });

  it("sorts entries into changes, unchanged and skipped with reasons", () => {
    const p = previewImport(project(), read([
      entry("menu.start", "Commencer", { source: "Start game" }), // unchanged
      entry("hud.coins", "{count, plural, one {# pièce} many {# de pièces} other {# pièces}}"), // status: needsReview → translated
      entry("nope", "Rien"),
      entry("menu.start", "Start", { language: "en" }),
      entry("menu.start", "Start", { language: "xx-Bogus-Thing" }),
      entry("menu.start", "Start", { language: "es" }),
      entry("hud.coins", "{n, plural, one {# pièce} many {# de pièces} other {# pièces}}", { language: "fr" }),
      entry("menu.start", "Commencer une nouvelle partie maintenant"),
    ]));
    expect(p.unchanged).toBe(1); // the later menu.start entry (over length) was skipped, the earlier one stays
    expect(p.changes.map((c) => [c.key, c.kind])).toEqual([["hud.coins", "status"]]);
    expect(p.skipped.map((s) => [s.key, s.language, s.reason])).toEqual([
      ["nope", "fr", "unknownKey"],
      ["menu.start", "en", "reference"],
      ["menu.start", "xx-Bogus-Thing", "unknownLanguage"],
      ["menu.start", "es", "unknownLanguage"],
      ["hud.coins", "fr", "check"],
      ["menu.start", "fr", "maxLength"],
    ]);
  });

  it("counts an identical translation as unchanged", () => {
    const p = previewImport(project(), read([entry("menu.start", "Commencer", { source: "Start game" })]));
    expect(p).toMatchObject({ changes: [], unchanged: 1, skipped: [] });
  });

  it("runs the ICU checks on import: syntax, argument names and the language's plural categories", () => {
    const p = previewImport(project(), read([
      entry("hud.coins", "{count, plural, one {# moneta} few {# monety} other {# monet}}", { language: "pl" }), // lacks many
      entry("quote", "Il a dit {oops", { language: "fr" }),
    ]));
    expect(p.changes).toEqual([]);
    expect(p.skipped.map((s) => s.reason)).toEqual(["check", "check"]);
    expect(p.skipped[0].message).toMatch(/Polski needs many/);
    expect(p.skipped[1].problems.length).toBeGreaterThan(0);
  });

  it("enforces maxLength in graphemes", () => {
    expect(graphemeLength("été")).toBe(3);
    expect(messageLength("{count, plural, one {# coin} other {# coins}}", { count: 12 })).toBe("12 coins".length);
    const ok = previewImport(project(), read([entry("menu.start", "Démarrer la partie")])); // 18
    expect(ok.changes).toHaveLength(1);
    const over = previewImport(project(), read([entry("menu.start", "Démarrer la partie!")])); // 19
    expect(over.skipped[0]).toMatchObject({ reason: "maxLength" });
    expect(over.skipped[0].message).toMatch(/19 characters, over its limit of 18/);
  });

  it("writes one translation file per table and language, creating missing ones, in table key order", () => {
    const p = previewImport(project(), read([entry("quote", "Citation"), entry("menu.start", "Uruchom", { language: "pl" }), entry("menu.start", "Lancer")]));
    const files = applyImport(project(), p);
    expect(files.map((f) => [f.path, f.created])).toEqual([["strings/menu.fr.strings.json", false], ["strings/menu.pl.strings.json", true]]);
    expect(Object.keys(files[0].translation.strings)).toEqual(["menu.start", "hud.coins", "quote"]);
    expect(files[1].translation.language).toBe("pl");
  });
});

describe("CSV", () => {
  it("writes the record's layout with a BOM and reads it back", () => {
    const text = writeStringsCsv(project());
    expect(text.startsWith("﻿")).toBe(true);
    const { header, records } = csvRecords(parseCsv(text));
    expect(header).toEqual(["key", "table", "notes", "maxLength", "en", "fr", "fr:status", "pl", "pl:status"]);
    expect(records[0]).toMatchObject({ key: "menu.start", table: "strings/menu.strings.json", notes: "Main menu button. Verb.", maxLength: "18", en: "Start game", fr: "Commencer", "fr:status": "translated", pl: "", "pl:status": "missing" });
    expect(records[2].en).toBe('He said "hi", then left,\nlater.');
    const back = readStringsCsv(text, languages);
    expect(back.problems).toEqual([]);
    expect(back.entries).toEqual([
      { key: "menu.start", table: "strings/menu.strings.json", language: "fr", text: "Commencer", status: "translated", source: "Start game" },
      { key: "hud.coins", table: "strings/menu.strings.json", language: "fr", text: MENU_FR.strings["hud.coins"].text, status: "needsReview", source: MENU.strings[1].text },
    ]);
    // A round trip changes nothing.
    expect(previewImport(project(), back)).toMatchObject({ changes: [], unchanged: 2, skipped: [] });
  });

  it("exports only what needs work, for chosen languages", () => {
    const rows = csvRecords(parseCsv(writeStringsCsv(project(), { languages: ["fr"], onlyNeedsWork: true }))).records;
    expect(rows.map((r) => r.key)).toEqual(["hud.coins", "quote"]);
  });

  it("reads a hand-made sheet in any column order and reports what it can't use", () => {
    const sheet = formatCsv([["fr", "key", "fr:status", "comment"], ["Quitter", "menu.start", "needs review", "x"], ["", "quote", "", ""], ["Oui", "", "", ""], ["Oui", "hud.coins", "bogus", ""]]);
    const r = readStringsCsv(sheet, languages);
    expect(r.entries.map((e) => [e.key, e.text, e.status, e.source])).toEqual([["menu.start", "Quitter", "needsReview", null], ["hud.coins", "Oui", "translated", null]]);
    expect(r.problems).toEqual(["Row 4 has no key; skipped.", 'Row 5, fr:status: "bogus" isn\'t translated, needsReview or missing; read as translated.']);
    expect(readStringsCsv("a,b\n1,2\n", languages).problems).toEqual(['The CSV has no "key" column.']);
  });
});

describe("XLIFF 1.2", () => {
  it("writes a file per table and language with states, notes and maxwidth, and reads it back", () => {
    const text = writeXliff(project(), { languages: ["fr"] });
    expect(text).toContain('<file original="strings/menu.strings.json" source-language="en" target-language="fr" datatype="plaintext">');
    expect(text).toContain('<trans-unit id="menu.start" resname="menu.start" maxwidth="18" size-unit="char" xml:space="preserve">');
    expect(text).toContain('<target state="needs-review-translation">');
    expect(text).toContain('<target state="needs-translation"></target>');
    expect(text).toContain("<source>He said &quot;hi&quot;, then left,\nlater.</source>");
    expect(text).toContain("<note>Main menu button. Verb.</note>");
    const back = readXliff(text);
    expect(back.problems).toEqual([]);
    expect(back.entries).toEqual([
      { key: "menu.start", table: "strings/menu.strings.json", language: "fr", text: "Commencer", status: "translated", source: "Start game" },
      { key: "hud.coins", table: "strings/menu.strings.json", language: "fr", text: MENU_FR.strings["hud.coins"].text, status: "needsReview", source: MENU.strings[1].text },
    ]);
    expect(previewImport(project(), back)).toMatchObject({ changes: [], unchanged: 2 });
  });

  it("reads other tools' states, inline markup and approval, and survives broken input", () => {
    const doc = `<?xml version="1.0"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file original="x" target-language="fr"><body>
      <trans-unit id="a"><source>A</source><target state="final">Un <g id="1">gras</g></target></trans-unit>
      <trans-unit id="b"><source>B</source><target state="needs-adaptation">Bé</target></trans-unit>
      <trans-unit id="c"><source>C</source><target state="new">Cé</target></trans-unit>
      <trans-unit id="d" approved="yes"><source>D</source><target state="needs-review-translation">Dé</target></trans-unit>
      <trans-unit id="e"><source>E</source></trans-unit>
    </body></file></xliff>`;
    expect(readXliff(doc).entries.map((e) => [e.key, e.text, e.status])).toEqual([["a", "Un gras", "translated"], ["b", "Bé", "needsReview"], ["d", "Dé", "translated"]]);
    expect(readXliff("not xml at all").problems).toContain("This isn't an XLIFF document (no <xliff> element).");
    expect(() => readXliff("<xliff><file target-language='fr'><body><trans-unit id='x'><target>")).not.toThrow();
  });
});

describe("gettext PO", () => {
  it("writes msgctxt keys, msgid references, notes, tables and fuzzy, and reads them back", () => {
    const text = writePo(project(), "fr");
    expect(text).toContain('"Language: fr\\n"');
    expect(text).toContain('#. Main menu button. Verb.\n#. maxLength: 18\n#: strings/menu.strings.json\nmsgctxt "menu.start"\nmsgid "Start game"\nmsgstr "Commencer"');
    expect(text).toContain('#, fuzzy\nmsgctxt "hud.coins"');
    expect(text).toContain('msgid ""\n"He said \\"hi\\", then left,\\n"\n"later."');
    const back = readPo(text);
    expect(back.problems).toEqual([]);
    expect(back.entries).toEqual([
      { key: "menu.start", table: "strings/menu.strings.json", language: "fr", text: "Commencer", status: "translated", source: "Start game" },
      { key: "hud.coins", table: "strings/menu.strings.json", language: "fr", text: MENU_FR.strings["hud.coins"].text, status: "needsReview", source: MENU.strings[1].text },
    ]);
    expect(previewImport(project(), back)).toMatchObject({ changes: [], unchanged: 2 });
  });

  it("writes a template with every key and empty translations", () => {
    const pot = writePot(project());
    expect(pot).not.toContain("Language:");
    expect(pot.match(/^msgctxt /gm)).toHaveLength(3);
    expect(pot.match(/^msgstr ""$/gm)).toHaveLength(4); // the header and three keys
  });

  it("reads a PO without a header language from the given one, skipping obsolete and empty entries", () => {
    const po = '#~ msgctxt "old"\n#~ msgid "Old"\n#~ msgstr "Vieux"\n\nmsgctxt "quote"\nmsgid "Q"\nmsgstr ""\n"Ligne un\\n"\n"ligne deux"\n\nmsgctxt "menu.start"\nmsgid "Start game"\nmsgstr ""\n';
    expect(readPo(po).problems).toEqual(["The PO names no language (no Language: header); nothing to import."]);
    expect(readPo(po, "fr").entries).toEqual([{ key: "quote", table: null, language: "fr", text: "Ligne un\nligne deux", status: "translated", source: "Q" }]);
  });

  it("round-trips through the import: a stale msgid marks the translation for review", () => {
    const po = writePo(project(), "fr").replace('msgid "Start game"', 'msgid "Start"');
    const p = previewImport(project(), readPo(po));
    expect(p.changes).toEqual([expect.objectContaining({ key: "menu.start", kind: "status", stale: true })]);
  });
});

describe("export units", () => {
  it("cover chosen tables and languages, never the reference", () => {
    expect(exportUnits(project(), { languages: ["en", "pl"] }).map((u) => [u.entry.key, u.language, u.status])).toEqual([["menu.start", "pl", "missing"], ["hud.coins", "pl", "missing"], ["quote", "pl", "missing"]]);
    expect(exportUnits(project(), { tables: ["nope.strings.json"] })).toEqual([]);
  });
});
