// ADR 0356 §8, §9 (T7): the Localisation panel's models — the project's tables and ownership, the Strings grid (rows,
// status, search and filters, ICU problems, refused-or-next edits), the Report (gathering, Svelte UI's unkeyed text with
// dismissals, and the fit check), the Inspector's Localise keys and the Exchange (export files, import preview and
// writes) — and the `strings` asset kind's format, through their interfaces.
import { beforeAll, describe, expect, it } from "vitest";
import { gatherKeys } from "../../../engine/localisation/exchange/gather";
import { estimateText } from "../../../engine/ui/layout";
import { UI_LINE_HEIGHT } from "../../../engine/ui/elementKinds";
import { UI_FONT_FAMILY } from "../../../engine/ui/fonts";
import { unkeyedId, unkeyedTextIn } from "../../uiEdit/svelteStrings";
import { loadSvelteParser, parseSvelte } from "../../uiEdit/svelteText";
import { parseLanguages } from "../../../engine/localisation/languages";
import { effectiveStatus } from "../../../engine/localisation/strings/translation";
import { textHash } from "../../../engine/localisation/textHash";
import type { EditResult } from "../../sdk/editResult";
import { exportFiles, formatOfFile, importPreviewOf, importWrites, previewSummary } from "./exchangeModel";
import { exchangeProjectOf, studioOwnedTables, tableAccess } from "./localisationData";
import { extractToTable, keyMatches, keyPreview, suggestKey, suggestTable, unlinkText } from "./localiseKeys";
import { localisationReport } from "./reportModel";
import { fitCheck, type FitTarget } from "./textFit";
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
  beforeAll(() => loadSvelteParser());

  const run = { fontSize: 16, fontWeight: "400", fontFamily: UI_FONT_FAMILY, lineHeight: UI_LINE_HEIGHT, wrap: "word" as const };
  const target = (where: string, key: string, box: FitTarget["box"]): FitTarget => ({ path: "ui/Menu.svelte", where, line: 5, key, run, box });

  it("lists counts and the gathering's lists, Svelte UI's unkeyed text (minus dismissed), and the fit check's overflows", () => {
    const gather = gatherKeys({ files: FILES, languages });
    const fit = fitCheck({ project: project(), targets: [target("#start", "menu.start", { width: 60, height: 20 }), target("#quit", "menu.quit", { width: 400, height: null }), target("<p>", "hud.coins", { width: null, height: null })], unrendered: 2, measure: estimateText, languages: ["en", "fr", "qps-ploc"] });
    expect(fit.checked).toBe(2);
    expect(fit.skipped).toBe(3);
    expect(fit.overflows.map((o) => [o.where, o.language, o.reason])).toEqual([["#start", "fr", "lines"], ["#start", "qps-ploc", "lines"]]);
    const hud = `<p id="hint">Press any key</p>\n<input placeholder="Your name" />\n`;
    const unkeyed = unkeyedTextIn("ui/Hud.svelte", parseSvelte(hud));
    const report = localisationReport(gather, { unkeyed, ignore: [unkeyedId(unkeyed[1])], fit });
    const section = (id: string) => report.sections.find((s) => s.id === id)!;
    expect(section("unkeyed").rows.map((r) => [r.key, r.detail, r.path, r.line, r.dismiss])).toEqual([["Press any key", "ui/Hud.svelte #hint", "ui/Hud.svelte", 1, "ui/Hud.svelte|#hint|text|Press any key"]]);
    expect(section("fit").rows[0]).toMatchObject({ key: "menu.start", path: "ui/Menu.svelte", line: 5 });
    expect(section("fit").rows[0].detail).toMatch(/^fr: \d+ px tall, box 20 px · ui\/Menu.svelte #start$/);
    expect(report.issues).toBe(6);
    expect(localisationReport(gather).sections.some((s) => s.id === "fit")).toBe(false);
  });

  it("lists counts and the gathering's lists", () => {
    const gather = gatherKeys({ files: FILES, languages });
    const report = localisationReport(gather);
    expect(report.languages.map((l) => [l.language, l.translated, l.needsReview, l.missing])).toEqual([["fr", 2, 1, 1], ["de", 1, 0, 3]]);
    const section = (id: string) => report.sections.find((s) => s.id === id)!;
    expect(section("missing").rows.map((r) => [r.key, r.detail])).toEqual([["intro_01", "missing in fr, de"], ["menu.quit", "missing in de"], ["hud.coins", "missing in de"]]);
    expect(section("unused").rows).toEqual([]);
    expect(report.sections.map((x) => x.id)).toEqual(["missing", "undefined", "unused", "unkeyed", "duplicates"]);
    expect(report.issues).toBe(3);
  });
});

describe("the Inspector's Localise control", () => {
  it("finds keys by name or text with previews in the preview language, and suggests keys and tables from the component", () => {
    const p = project();
    expect(keyMatches(p, "quitter", "fr").map((m) => [m.key, m.preview])).toEqual([["menu.quit", "Quitter"]]);
    expect(keyMatches(p, "menu.start", "de")[0]).toEqual({ key: "menu.start", table: "strings/menu.strings.json", preview: "Los" });
    expect(keyPreview(p, "menu.quit", "qps-ploc")).toBe("Quit game");
    expect(keyPreview(p, "nope", "fr")).toBeNull();
    expect(suggestKey(p, "ui/Menu.svelte", "start", "p", "text")).toBe("menu.start_2");
    expect(suggestKey(p, "ui/PauseMenu.svelte", "name", "input", "placeholder")).toBe("pauseMenu.name_placeholder");
    expect(suggestKey(p, "ui/Hud.svelte", null, "input", "placeholder")).toBe("hud.placeholder_input");
    expect(suggestTable(p, "ui/Menu.svelte")).toBe("strings/menu.strings.json");
    expect(suggestTable(p, "ui/Hud.svelte")).toBe("audio/vo/ch1.strings.json");
  });

  it("extracts literal text to a table under a new key, refusing taken keys and empty text; Unlink gives plain messages' text back", () => {
    const p = project();
    const table = ok(extractToTable(p, "strings/menu.strings.json", FILES[0][1], "menu.hint", "Press any key"));
    expect(table.strings.at(-1)).toEqual({ key: "menu.hint", text: "Press any key", tags: [], examples: {} });
    expect(ok(extractToTable(p, "strings/hud.strings.json", undefined, "hud.title", "Score")).strings).toEqual([{ key: "hud.title", text: "Score", tags: [], examples: {} }]);
    expect(no(extractToTable(p, "strings/menu.strings.json", FILES[0][1], "menu.quit", "Quit"))).toMatch(/key of strings\/menu.strings.json already/);
    expect(no(extractToTable(p, "strings/menu.strings.json", FILES[0][1], "menu.x", "  "))).toMatch(/no text/);
    expect(ok(unlinkText(p, "menu.quit"))).toBe("Quit game");
    expect(no(unlinkText(p, "hud.coins"))).toMatch(/takes arguments \(count\)/);
    expect(no(unlinkText(p, "nope"))).toMatch(/no table defines/);
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
