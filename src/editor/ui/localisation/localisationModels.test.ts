// ADR 0356 §8, §9 (T7): the Localisation panel's models — the project's tables and ownership, the Strings grid (rows,
// status, search and filters, ICU problems, refused-or-next edits), the Report (gathering) and the
// Exchange (export files, import preview and writes) — and the `strings` asset kind's format, through their interfaces.
import { describe, expect, it } from "vitest";
import { gatherKeys } from "../../../engine/localisation/exchange/gather";
import { parseLanguages } from "../../../engine/localisation/languages";
import { effectiveStatus } from "../../../engine/localisation/strings/translation";
import { textHash } from "../../../engine/localisation/textHash";
import type { EditResult } from "../../sdk/editResult";
import { exportFiles, formatOfFile, importPreviewOf, importWrites, previewSummary } from "./exchangeModel";
import { exchangeProjectOf, studioOwnedTables, tableAccess } from "./localisationData";
import { localisationReport } from "./reportModel";
import { stringsFormat } from "./stringsKind";
import {
  addKey, ALL_STRINGS, copyKeyName, deleteKey, duplicateKey, filterRows, renameKey, setMaxLength, setNotes, setReferenceText, setReviewed, setTranslation, stringRows,
} from "./stringsModel";

const languages = parseLanguages({ list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }, { code: "de", name: "Deutsch" }], reference: "en" }).languages;

const FILES: [string, unknown][] = [
  ["strings/menu.strings.json", {
    format: "myco.strings@1", language: "en",
    strings: [
      { key: "menu.start", text: "Start", notes: "Button", maxLength: 10 },
      { key: "menu.quit", text: "Quit game" },
      { key: "hud.coins", text: "{count, plural, one {# coin} other {# coins}}", examples: { count: 3 } },
    ],
  }],
  ["strings/menu.fr.strings.json", { format: "myco.translation@1", language: "fr", strings: { "menu.start": { text: "Commencer la partie", source: textHash("Start") }, "menu.quit": { text: "Quitter", source: textHash("Quit") }, "hud.coins": { text: "{n} pièces" } } }],
  ["strings/menu.de.strings.json", { format: "myco.translation@1", language: "de", strings: { "menu.start": { text: "Los" } } }],
  ["audio/vo/ch1.lines.json", { format: "myco.lines@1", lines: [{ key: "intro_01" }] }],
  ["audio/vo/ch1.strings.json", { format: "myco.strings@1", language: "en", strings: [{ key: "intro_01", text: "Hello." }] }],
  ["ui/Menu.svelte", '<script lang="ts">\n  import { t } from "myco";\n</script>\n\n<p id="start">{t("menu.start")}</p>\n<p id="quit">{t("menu.quit")}</p>\n<p>{t("hud.coins", { count: 3 })}</p>\n'],
];

const project = () => exchangeProjectOf(languages, FILES);
const ok = <T,>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};
const no = <T,>(r: EditResult<T>): string => ("refused" in r ? r.refused : "accepted");

describe("the project's tables and who owns them", () => {
  it("lists tables in path order with their translations by language", () => {
    const p = project();
    expect(p.tables.map((t) => [t.path, Object.keys(t.translations).sort()])).toEqual([["audio/vo/ch1.strings.json", []], ["strings/menu.strings.json", ["de", "fr"]]]);
  });

  it("reads strings files as their asset documents hold them", () => {
    const table = stringsFormat.parse(FILES[0][1], "strings/menu.strings.json").value;
    const missing = stringsFormat.parse(undefined, "strings/menu.ja.strings.json");
    expect(missing).toEqual({ value: { kind: "translation", translation: { format: "myco.translation@1", language: "ja", strings: {} } }, problems: [] });
    const p = exchangeProjectOf(languages, [["strings/menu.strings.json", table]]);
    expect(p.tables[0].table.strings).toHaveLength(3);
    expect(stringsFormat.parse(JSON.parse(stringsFormat.format(table)), "strings/menu.strings.json").value).toEqual(table);
  });

  it("gives line tables' string tables and the captions table to the Studio, and writes them only while it isn't running", () => {
    const owned = studioOwnedTables([...FILES, ["audio.json", { localisation: { captions: "strings/cc.strings.json" } }]]);
    expect([...owned].sort()).toEqual(["audio/vo/ch1.strings.json", "strings/cc.strings.json"]);
    expect(studioOwnedTables([]).has("strings/captions.strings.json")).toBe(true);
    expect(tableAccess({ canSave: true, studioOwned: false, studioLock: "held" })).toEqual({ editable: true });
    expect(tableAccess({ canSave: true, studioOwned: true, studioLock: "none" })).toEqual({ editable: true });
    expect(tableAccess({ canSave: true, studioOwned: true, studioLock: "held" })).toMatchObject({ editable: false, editInStudio: true });
    expect(tableAccess({ canSave: false, studioOwned: false, studioLock: "none" })).toMatchObject({ editable: false, reason: "The project is read-only." });
  });
});

describe("the Strings grid", () => {
  it("shows a cell per language with status, length and check problems, and a status column", () => {
    const rows = stringRows(project());
    const start = rows.find((r) => r.key === "menu.start")!;
    expect(start.cells.map((c) => [c.language, c.status, c.overLength])).toEqual([["fr", "translated", true], ["de", "translated", false]]);
    expect(start.cells[0].length).toBe(19);
    expect(start.summary).toBe("1 over length");
    const quit = rows.find((r) => r.key === "menu.quit")!;
    expect(quit.cells.map((c) => c.status)).toEqual(["needsReview", "missing"]);
    expect(quit.summary).toBe("1 missing · 1 needs review");
    const coins = rows.find((r) => r.key === "hud.coins")!;
    expect(coins.cells[0].problems.map((p) => p.message)).toContain('"n" isn\'t an argument of the reference text');
    expect(coins.worst).toBe("problem");
  });

  it("searches keys, text and notes, and filters by status in a language", () => {
    const rows = stringRows(project());
    expect(filterRows(rows, { ...ALL_STRINGS, search: "quitter" }).map((r) => r.key)).toEqual(["menu.quit"]);
    expect(filterRows(rows, { ...ALL_STRINGS, search: "button" }).map((r) => r.key)).toEqual(["menu.start"]);
    expect(filterRows(rows, { ...ALL_STRINGS, filter: "missing", language: "de" }).map((r) => r.key)).toEqual(["intro_01", "menu.quit", "hud.coins"]);
    expect(filterRows(rows, { ...ALL_STRINGS, filter: "needsReview", language: "fr" }).map((r) => r.key)).toEqual(["menu.quit"]);
    expect(filterRows(rows, { ...ALL_STRINGS, filter: "overLength" }).map((r) => r.key)).toEqual(["menu.start"]);
    expect(filterRows(rows, { ...ALL_STRINGS, filter: "problems" }).map((r) => r.key)).toEqual(["hud.coins"]);
    expect(filterRows(rows, { ...ALL_STRINGS, table: "audio/vo/ch1.strings.json" }).map((r) => r.key)).toEqual(["intro_01"]);
  });

  it("adds, duplicates, renames and deletes keys, unique across the project", () => {
    const p = project();
    expect(ok(addKey(p, "strings/menu.strings.json", "menu.options", "Options", "menu.start")).strings.map((e) => e.key)).toEqual(["menu.start", "menu.options", "menu.quit", "hud.coins"]);
    expect(no(addKey(p, "strings/menu.strings.json", "intro_01"))).toBe('"intro_01" is a key of audio/vo/ch1.strings.json already (keys are unique across the project)');
    expect(no(addKey(p, "strings/menu.strings.json", "bad key"))).toMatch(/isn't a key/);
    expect(copyKeyName(p, "menu.start")).toBe("menu.start_2");
    expect(ok(duplicateKey(p, "strings/menu.strings.json", "menu.start")).strings[1]).toMatchObject({ key: "menu.start_2", text: "Start", notes: "Button", maxLength: 10 });
    const renamed = ok(renameKey(p, "strings/menu.strings.json", "menu.start", "menu.play"));
    expect(renamed.table.strings[0].key).toBe("menu.play");
    expect(Object.keys(renamed.translations).sort()).toEqual(["de", "fr"]);
    expect(Object.keys(renamed.translations.fr.strings)).toEqual(["menu.play", "menu.quit", "hud.coins"]);
    const deleted = ok(deleteKey(p, "strings/menu.strings.json", "menu.quit"));
    expect(deleted.table.strings.map((e) => e.key)).toEqual(["menu.start", "hud.coins"]);
    expect(Object.keys(deleted.translations)).toEqual(["fr"]);
  });

  it("edits reference text, notes and length limits in the table", () => {
    const p = project();
    expect(ok(setReferenceText(p, "strings/menu.strings.json", "menu.quit", "Quit")).strings[1].text).toBe("Quit");
    expect(ok(setNotes(p, "strings/menu.strings.json", "menu.start", " ")).strings[0].notes).toBeUndefined();
    expect(ok(setMaxLength(p, "strings/menu.strings.json", "menu.start", null)).strings[0].maxLength).toBeUndefined();
    expect(no(setMaxLength(p, "strings/menu.strings.json", "menu.start", 0))).toMatch(/whole number/);
  });

  it("writes translations from the current reference text, removes empty ones, and marks review", () => {
    const p = project();
    const fr = ok(setTranslation(p, "strings/menu.strings.json", "menu.quit", "fr", "Quitter le jeu"));
    expect(fr.strings["menu.quit"]).toEqual({ text: "Quitter le jeu", status: "translated", source: textHash("Quit game") });
    expect(ok(setTranslation(p, "strings/menu.strings.json", "menu.start", "de", "")).strings["menu.start"]).toBeUndefined();
    const ja = parseLanguages({ list: ["en", "ja"], reference: "en" }).languages;
    expect(ok(setTranslation({ ...p, languages: ja }, "strings/menu.strings.json", "menu.start", "ja", "スタート")).language).toBe("ja");
    expect(no(setTranslation(p, "strings/menu.strings.json", "menu.start", "en", "x"))).toMatch(/reference language/);
    const reviewed = ok(setReviewed(p, "strings/menu.strings.json", "menu.quit", "fr", true));
    expect(effectiveStatus(reviewed.strings["menu.quit"], "Quit game")).toBe("translated");
    expect(ok(setReviewed(p, "strings/menu.strings.json", "menu.start", "fr", false)).strings["menu.start"].status).toBe("needsReview");
    expect(no(setReviewed(p, "strings/menu.strings.json", "menu.quit", "de", true))).toMatch(/no de translation/);
  });
});

describe("the Report", () => {
  it("lists counts and the gathering's lists", () => {
    const gather = gatherKeys({ files: FILES, languages });
    const report = localisationReport(gather);
    expect(report.languages.map((l) => [l.language, l.translated, l.needsReview, l.missing])).toEqual([["fr", 2, 1, 1], ["de", 1, 0, 3]]);
    const section = (id: string) => report.sections.find((s) => s.id === id)!;
    expect(section("missing").rows.map((r) => [r.key, r.detail])).toEqual([["intro_01", "missing in fr, de"], ["menu.quit", "missing in de"], ["hud.coins", "missing in de"]]);
    expect(section("unused").rows).toEqual([]);
    expect(report.sections.map((x) => x.id)).toEqual(["missing", "undefined", "unused", "duplicates"]);
    expect(report.issues).toBe(3);
  });
});

describe("the Exchange", () => {
  it("exports CSV, an XLIFF and a PO per language (with a template), for chosen languages", () => {
    expect(exportFiles(project(), "csv", {}).map((f) => f.name)).toEqual(["strings.csv"]);
    expect(exportFiles(project(), "xliff", { languages: ["fr"] }).map((f) => f.name)).toEqual(["strings.fr.xlf"]);
    expect(exportFiles(project(), "po", {}).map((f) => f.name)).toEqual(["strings.fr.po", "strings.de.po", "strings.pot"]);
    expect(formatOfFile("Game.FR.XLIFF")).toBe("xliff");
    expect(formatOfFile("notes.txt")).toBeNull();
  });

  it("previews an import, then writes only the tables the editor may write", () => {
    const [po] = exportFiles(project(), "po", { languages: ["de"] });
    const edited = po.text.replace('msgctxt "menu.quit"\nmsgid "Quit game"\nmsgstr ""', 'msgctxt "menu.quit"\nmsgid "Quit game"\nmsgstr "Beenden"').replace('msgctxt "intro_01"\nmsgid "Hello."\nmsgstr ""', 'msgctxt "intro_01"\nmsgid "Hi."\nmsgstr "Hallo."');
    const preview = importPreviewOf(project(), [{ name: "strings.de.po", text: edited }, { name: "x.txt", text: "" }]);
    expect(previewSummary(preview)).toMatchObject({ added: 2, changed: 0, stale: 1, byLanguage: { de: 2 } });
    expect(preview.problems).toEqual(["x.txt: x.txt isn't a .csv, .xlf, .xliff or .po file."]);
    const owned = studioOwnedTables(FILES);
    const { files, blocked } = importWrites(project(), preview, (t) => !owned.has(t));
    expect(files.map((f) => f.path)).toEqual(["strings/menu.de.strings.json"]);
    expect(blocked).toEqual(["audio/vo/ch1.strings.json"]);
  });
});
