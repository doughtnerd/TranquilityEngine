// ADR 0354 §1, §8–§9, 0357 §1: the Dialogue screen through its models — rows, search and column filters, row edits with
// project-unique keys, the Text column writing the string table, the report, CSV round trips (quotes, commas, line
// breaks, BOM), the script CSV diff and apply, batch import pattern matching and preview, loudness and the voice ducking
// rule, the Languages edits and the lock rule, and the preview language.
import { describe, expect, it } from "vitest";
import { parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import { defaultSampleEdits } from "../../../engine/audio/sample/format";
import { parseLanguages } from "../../../engine/localisation/languages";
import { textHash } from "../../../engine/localisation/textHash";
import {
  batchCounts, compilePattern, copiedRows, importedBlock, lipsyncCompanions, matchFile, PATTERN_PRESETS, previewBatch, rowsToCreate, voBlock,
} from "./batchImport";
import { parseRhubarb } from "../../../engine/audio/localisation/lipsync";
import { csvRecords, formatCsv, parseCsv } from "./csv";
import { findLine } from "./dialogueData";
import { FIXTURE_LANGUAGES, fixtureData, fixtureStrings, fixtureTable, FR_PATH, INTRO_01_TEXT, STRINGS_PATH, TABLE_PATH } from "./dialogueFixture";
import {
  addLanguage, codesOf, languagesAccess, previewLanguageOf, removeLanguage, setLanguageFallback, setReference, setRoots, setShip, setTolerance,
} from "./languagesModel";
import {
  addLine, ALL_LINES, deleteLine, duplicateLine, filterFromId, filterId, filterOptions, filterRows, lineRows, renameLine, setCooldown, setNotes, setOnce, setSpeaker,
  setSubtitled, setTags, textEdit, usedKeys,
} from "./linesModel";
import { dialogueReport, reportCsv } from "./reportModel";
import { applyScript, linesWithOldText, moveSubtitles, readScriptCsv, scriptCsv } from "./scriptCsv";
import { duckMusicUnder, duckOffer, languageFiles, unnormalised, VOICE_DUCK } from "./voiceMix";

const next = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("lines table", () => {
  it("shows the text in the preview language through its chain, and filters", () => {
    const data = fixtureData();
    const rows = lineRows(data, "fr-CA");
    expect(rows.map((r) => [r.key, r.text, r.textFrom])).toEqual([
      ["intro_01", "On est en retard.", "fr"],
      ["intro_02", expect.stringContaining("Keep your head down"), "en"],
      ["guard_01", "Halt! Who goes there?", "en"],
      ["breath_03", null, null],
    ]);
    expect(filterRows(rows, { ...ALL_LINES, search: "guard" }).map((r) => r.key)).toEqual(["guard_01"]);
    expect(filterRows(rows, { ...ALL_LINES, search: "retard" }).map((r) => r.key)).toEqual(["intro_01"]);
    expect(filterRows(rows, { ...ALL_LINES, search: "main" }).map((r) => r.key)).toEqual(["intro_01"]); // a tag
    expect(filterRows(rows, { ...ALL_LINES, filter: { kind: "missing", code: "fr" } }).map((r) => r.key)).toEqual(["intro_02", "breath_03"]);
    expect(filterRows(rows, { ...ALL_LINES, filter: { kind: "mismatch" } }).map((r) => r.key)).toEqual(["intro_01"]);
    expect(filterRows(rows, { ...ALL_LINES, filter: { kind: "scriptChanged" } }).map((r) => r.key)).toEqual(["guard_01"]);
    expect(filterRows(rows, { ...ALL_LINES, filter: { kind: "readingSpeed" } }).map((r) => r.key)).toEqual(["intro_02"]);
    expect(filterRows(rows, { ...ALL_LINES, table: "other.lines.json" })).toEqual([]);
    const options = filterOptions(data, rows);
    expect(options.find((o) => o.label === "Missing in fr")?.count).toBe(2);
    expect(filterFromId(filterId({ kind: "missing", code: "fr-CA" }))).toEqual({ kind: "missing", code: "fr-CA" });
  });

  it("edits rows with keys unique across the project", () => {
    const t = fixtureTable();
    const used = usedKeys(fixtureData());
    const added = next(addLine(t, used, "intro_01", "Ava"));
    expect(added.lines.map((l) => l.key)).toEqual(["intro_01", "line_05", "intro_02", "guard_01", "breath_03"]);
    expect(renameLine(t, "intro_01", "guard_01", used)).toEqual({ refused: '"guard_01" is already a line key in this project' });
    expect(renameLine(t, "intro_01", "bad key", used)).toMatchObject({ refused: expect.stringContaining("isn't a line key") });
    const renamed = next(renameLine(t, "intro_01", "intro_00", used));
    // The subtitle and the recordings keep their names.
    expect(renamed.lines[0]).toMatchObject({ key: "intro_00", textKey: "intro_01", file: "intro_01" });
    const dup = next(duplicateLine(t, "intro_02", used));
    expect(dup.lines[2]).toMatchObject({ key: "intro_02_2", textKey: "intro_02", file: null });
    expect(next(deleteLine(t, "guard_01")).lines.map((l) => l.key)).not.toContain("guard_01");
    expect(next(setSpeaker(t, "intro_02", "  ")).lines[1].speaker).toBeNull();
    expect(next(setNotes(t, "intro_01", "")).lines[0].notes).toBeUndefined();
    expect(next(setTags(t, "intro_01", ["main", " main ", "", "act1"])).lines[0].tags).toEqual(["main", "act1"]);
    expect(setCooldown(t, "intro_01", -1)).toMatchObject({ refused: expect.any(String) });
    expect(next(setOnce(t, "intro_01", true)).lines[0].once).toBe(true);
    expect(next(setSubtitled(t, "breath_03", true)).lines[3].textKey).toBeUndefined();
    expect(next(setSubtitled(t, "intro_01", false)).lines[0].textKey).toBeNull();
  });

  it("writes the Text column into the string table, or the translation against the reference text", () => {
    const data = fixtureData();
    const intro = findLine(data, "intro_02")!;
    const en = next(textEdit(data, intro, "en", "Head down."));
    expect(en).toMatchObject({ kind: "strings", path: STRINGS_PATH });
    expect(en.kind === "strings" && en.next.strings[1].text).toBe("Head down.");
    const fr = next(textEdit(data, intro, "fr", "Tête baissée."));
    expect(fr.path).toBe(FR_PATH);
    expect(fr.kind === "translation" && fr.next.strings.intro_02).toEqual({ text: "Tête baissée.", status: "translated", source: textHash(fixtureStrings().strings[1].text) });
    expect(textEdit(data, findLine(data, "breath_03")!, "en", "x")).toEqual({ refused: "breath_03 is never subtitled" });
    const bare = fixtureData({ strings: null });
    expect(textEdit(bare, findLine(bare, "intro_01")!, "fr", "x")).toMatchObject({ refused: expect.stringContaining("write the en text") });
    const created = next(textEdit(bare, findLine(bare, "intro_01")!, "en", "New."));
    expect(created.kind === "strings" && created.next).toMatchObject({ language: "en", strings: [{ key: "intro_01", text: "New." }] });
  });
});

describe("report", () => {
  it("counts per language, lists missing keys, mismatches and script changes, and exports CSV", () => {
    const r = dialogueReport(fixtureData());
    const fr = r.languages.find((l) => l.code === "fr")!;
    expect([fr.recorded, fr.fallback, fr.missing]).toEqual([2, 2, 0]);
    expect(fr.fallbackKeys).toEqual([{ key: "intro_02", from: "en" }, { key: "breath_03", from: "en" }]);
    expect(fr.mismatches).toEqual([{ key: "intro_01", duration: 2.4, reference: 1.2 }]);
    expect(fr.scriptChanged).toEqual(["guard_01"]);
    expect(r.loudness.length).toBe(6); // nothing normalised to −23 LUFS yet
    const csv = parseCsv(reportCsv(r));
    expect(csv).toContainEqual(["fr", "intro_01", "duration mismatch", "2.40 s, reference 1.20 s"]);
    expect(csv).toContainEqual(["fr", "", "summary", "2 recorded, 2 fallback, 0 missing of 4"]);
  });
});

describe("CSV", () => {
  it("round-trips quotes, commas, line breaks, spaces and a BOM", () => {
    const rows = [["key", "text"], ["a", 'She said "go", then left.'], ["b", "two\nlines"], ["c", " padded "], ["d", "plain"], ["e", ""]];
    const text = formatCsv(rows);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain('"She said ""go"", then left."');
    expect(text.endsWith("\r\n")).toBe(true);
    expect(parseCsv(text)).toEqual(rows);
    expect(parseCsv("a,b\nc,d\n\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseCsv('x,"unclosed')).toEqual([["x", "unclosed"]]);
    expect(csvRecords([["key", "en"], ["k"]]).records).toEqual([{ key: "k", en: "" }]);
  });

  it("exports the script and reads it back as no change", () => {
    const data = fixtureData();
    const text = scriptCsv(data);
    expect(parseCsv(text)[0]).toEqual(["key", "table", "speaker", "notes", "en", "fr", "fr-CA", "de"]);
    expect(parseCsv(text)[1]).toEqual(["intro_01", "ch1", "Ava", "Whispered, out of breath", INTRO_01_TEXT, "On est en retard.", "", ""]);
    const diff = readScriptCsv(data, text);
    expect([diff.added, diff.changed, diff.removed, diff.problems]).toEqual([[], [], [], []]);
  });

  it("reads an edited script as a diff and applies it to the line, string and translation documents", () => {
    const data = fixtureData();
    const rows = parseCsv(scriptCsv(data));
    rows[1][2] = "Ava Grey"; // speaker
    rows[3][5] = "Halte ! Qui va là ?"; // French text of guard_01
    rows.splice(4, 1); // breath_03 removed
    rows.push(["intro_03", "ch1", "Ava", "", "Now!", "Maintenant !", "", ""]);
    rows.push(["bad key", "ch1", "", "", "", "", "", ""]);
    rows[0].push("es");
    const diff = readScriptCsv(data, formatCsv(rows));
    expect(diff.added).toEqual([{ key: "intro_03", table: TABLE_PATH }]);
    expect(diff.changed).toEqual([{ key: "intro_01", fields: ["speaker"] }, { key: "guard_01", fields: ["text:fr"] }]);
    expect(diff.removed).toEqual(["breath_03"]);
    expect(diff.problems).toEqual(['column "es" isn\'t a project language; skipped', 'row 6: "bad key" isn\'t a line key; skipped']);
    const keep = applyScript(data, diff, { remove: false });
    const lines = keep.edits.find((e) => e.kind === "lines")!;
    expect(lines.kind === "lines" && lines.next.lines.map((l) => [l.key, l.speaker])).toEqual([["intro_01", "Ava Grey"], ["intro_02", "Ava"], ["guard_01", "Guard"], ["breath_03", "Ava"], ["intro_03", "Ava"]]);
    const strings = keep.edits.find((e) => e.kind === "strings")!;
    expect(strings.kind === "strings" && strings.next.strings.at(-1)).toMatchObject({ key: "intro_03", text: "Now!" });
    const fr = keep.edits.find((e) => e.kind === "translation")!;
    expect(fr.kind === "translation" && [fr.next.strings.guard_01?.text, fr.next.strings.intro_03]).toEqual(["Halte ! Qui va là ?", { text: "Maintenant !", status: "translated", source: textHash("Now!") }]);
    expect(keep.edits).toHaveLength(3); // one per document
    const removing = applyScript(data, diff, { remove: true }).edits.find((e) => e.kind === "lines")!;
    expect(removing.kind === "lines" && removing.next.lines.map((l) => l.key)).not.toContain("breath_03");
  });
});

describe("moving retired subtitles (ADR 0357 §1)", () => {
  it("moves line-table text into the string table and translations, keeping strings already there", () => {
    const table = fixtureTable();
    table.lines[1].text = { en: "Old English.", fr: "Vieux français." }; // intro_02: en in the table already
    table.lines[2].text = { fr: "Halte !" }; // guard_01
    const data = fixtureData({ table, strings: fixtureStrings(), french: null });
    expect(linesWithOldText(data).map((r) => r.line.key)).toEqual(["intro_02", "guard_01"]);
    const { edits, problems } = moveSubtitles(data);
    expect(problems).toEqual([]);
    const fr = edits.find((e) => e.kind === "translation")!;
    expect(fr.kind === "translation" && Object.fromEntries(Object.entries(fr.next.strings).map(([k, v]) => [k, v.text]))).toEqual({ intro_02: "Vieux français.", guard_01: "Halte !" });
    expect(edits.some((e) => e.kind === "strings")).toBe(false); // the English text was there
    const lines = edits.find((e) => e.kind === "lines")!;
    expect(lines.kind === "lines" && lines.next.lines.every((l) => l.text === undefined)).toBe(true);
  });
});

describe("batch import", () => {
  it("matches each preset to keys and languages", () => {
    const [byFolder, suffix, prefix] = PATTERN_PRESETS.map((p) => (compilePattern(p) as { re: RegExp }).re);
    expect(matchFile(byFolder, "fr/intro_01.wav")).toEqual({ key: "intro_01", lang: "fr", table: null });
    expect(matchFile(byFolder, "delivery 3/fr-CA/intro_01.WAV")).toEqual({ key: "intro_01", lang: "fr-CA", table: null });
    expect(matchFile(suffix, "intro_01_fr.ogg")).toEqual({ key: "intro_01", lang: "fr", table: null });
    expect(matchFile(suffix, "guard_01_pt-BR.wav")).toEqual({ key: "guard_01", lang: "pt-BR", table: null });
    expect(matchFile(prefix, "de_intro_02.flac")).toEqual({ key: "intro_02", lang: "de", table: null });
    expect(matchFile(suffix, "notes.txt")).toBeNull();
    const table = (compilePattern("{table}/{lang}/{ignore}_{key}") as { re: RegExp }).re;
    expect(matchFile(table, "ch1/fr/take3_intro_01.wav")).toEqual({ key: "intro_01", lang: "fr", table: "ch1" });
    expect(compilePattern("{lang}")).toEqual({ refused: "a pattern needs {key}" });
    expect(compilePattern("{key}_{speaker}")).toMatchObject({ refused: expect.stringContaining("{speaker} isn't a token") });
  });

  it("previews matched, replace, unknown key, unknown language, conflicts, duplicates and unmatched", () => {
    const data = fixtureData();
    const files = ["fr/intro_02.wav", "fr/intro_01.wav", "fr/guard_01.wav", "es/intro_01.wav", "FR/nobody.wav", "readme.txt", "fr-CA/intro_02.wav", "fr/intro_02.wav"];
    const p = previewBatch(data, files, "{lang}/{key}", { language: "en", createIn: null });
    if ("refused" in p) throw new Error(p.refused);
    expect(p.rows.map((r) => [r.rel, r.status, r.dest])).toEqual([
      ["fr/intro_02.wav", "matched", "audio/vo/fr/ch1/intro_02.wav"],
      ["fr/intro_01.wav", "replace", "audio/vo/fr/ch1/intro_01.wav"],
      ["fr/guard_01.wav", "conflict", null], // French has guard_01.ogg
      ["es/intro_01.wav", "unknownLanguage", null],
      ["FR/nobody.wav", "unknownKey", null],
      ["readme.txt", "unmatched", null],
      ["fr-CA/intro_02.wav", "matched", "audio/vo/fr-CA/ch1/intro_02.wav"],
      ["fr/intro_02.wav", "duplicate", null],
    ]);
    expect(batchCounts(p.rows)).toMatchObject({ matched: 2, replace: 1, conflict: 1, unknownLanguage: 1, unknownKey: 1, unmatched: 1, duplicate: 1 });
    // Creating rows for unknown keys.
    const create = previewBatch(data, ["fr/nobody.wav"], "{lang}/{key}", { language: "en", createIn: TABLE_PATH });
    if ("refused" in create) throw new Error(create.refused);
    expect(create.rows[0]).toMatchObject({ status: "unknownKey", key: "nobody", dest: "audio/vo/fr/ch1/nobody.wav" });
    expect(next(rowsToCreate(fixtureTable(), create.rows, TABLE_PATH)).lines.at(-1)?.key).toBe("nobody");
    expect(copiedRows(create.rows)).toHaveLength(1);
    // Without {lang}, the chosen language.
    const plain = previewBatch(data, ["intro_02.wav"], "{key}", { language: "de", createIn: null });
    expect("rows" in plain && plain.rows[0].dest).toBe("audio/vo/de/ch1/intro_02.wav");
  });

  it("carries a Rhubarb lip-sync file picked beside a line's audio, and writes its keys into the sidecar", () => {
    const data = fixtureData();
    const files = ["fr/intro_02.wav", "fr/intro_02.txt", "fr/intro_01.json", "fr/intro_01.wav", "notes.txt", "fr/guard_01.tsv"];
    expect([...lipsyncCompanions(files)]).toEqual([["fr/intro_02", "fr/intro_02.txt"], ["fr/intro_01", "fr/intro_01.json"]]);
    const p = previewBatch(data, files, "{lang}/{key}", { language: "en", createIn: null });
    if ("refused" in p) throw new Error(p.refused);
    // The riders get no rows; a lip-sync file without its audio stays an unmatched row.
    expect(p.rows.map((r) => [r.rel, r.status, r.lipsync ?? null])).toEqual([
      ["fr/intro_02.wav", "matched", "fr/intro_02.txt"],
      ["fr/intro_01.wav", "replace", "fr/intro_01.json"],
      ["notes.txt", "unmatched", null],
      ["fr/guard_01.tsv", "unmatched", null],
    ]);
    const lipsync = parseRhubarb("0.00\tX\n0.10\tB\n", "fr/intro_02.txt").lipsync;
    const block = importedBlock(defaultSampleEdits(), voBlock(data, "intro_02"), data.localisation.loudness, null, lipsync);
    expect(block.lipsync).toEqual({ set: "rhubarb", keys: [[0, "X"], [0.1, "B"]] });
    expect(importedBlock(defaultSampleEdits(), null, data.localisation.loudness, null).lipsync).toBeUndefined();
  });

  it("writes the sidecar's vo hash and normalisation from the loudness setting", () => {
    const data = fixtureData();
    expect(voBlock(data, "intro_01")).toEqual({ key: "intro_01", textHash: textHash(INTRO_01_TEXT) });
    expect(voBlock(data, "breath_03")).toBeNull();
    const block = importedBlock(defaultSampleEdits(), voBlock(data, "intro_01"), data.localisation.loudness, { integrated: -20, peak: -3 });
    expect(block.normalize).toEqual({ mode: "loudness", target: -23, gainDb: -3 });
    expect(block.vo?.key).toBe("intro_01");
    expect(importedBlock(block, null, data.localisation.loudness, null).vo).toBeUndefined();
  });
});

describe("loudness and ducking", () => {
  const audio = (): AudioProject => parseAudioProject({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Voice", parent: "Master" }] }).project;

  it("lists a language's files not normalised to the setting", () => {
    const data = fixtureData({ normalize: { "audio/vo/fr/ch1/intro_01.wav": { mode: "loudness", target: -23, gainDb: 1 } } });
    expect(languageFiles(data, "fr")).toEqual(["audio/vo/fr/ch1/intro_01.wav", "audio/vo/fr/ch1/guard_01.ogg"]);
    expect(unnormalised(data, "fr")).toEqual(["audio/vo/fr/ch1/guard_01.ogg"]);
  });

  it("offers Duck Music under Voice until a rule is triggered by Voice, and adds an ordinary rule", () => {
    const a = audio();
    const data = fixtureData();
    expect(duckOffer(a, data)).toBe("Voice");
    const ducked = next(duckMusicUnder(a));
    expect(ducked.ducking).toEqual([expect.objectContaining({ target: "Music", trigger: "Voice", mode: "presence", ...VOICE_DUCK })]);
    expect(duckOffer(ducked, data)).toBeNull();
    expect(duckMusicUnder(ducked)).toEqual({ refused: "Voice already ducks Music" });
    const noMusic = parseAudioProject({ buses: [{ name: "Master" }, { name: "Voice", parent: "Master" }] }).project;
    expect(duckOffer(noMusic, data)).toBeNull();
  });
});

describe("languages", () => {
  it("are editable only with a writable project and no editor holding it (ADR 0354 §1)", () => {
    expect(languagesAccess({ canSave: true, editorLock: "none" })).toEqual({ editable: true });
    expect(languagesAccess({ canSave: true, editorLock: "held" })).toMatchObject({ editable: false, editInEditor: true });
    expect(languagesAccess({ canSave: true, editorLock: "unknown" })).toMatchObject({ editable: false, editInEditor: false });
    expect(languagesAccess({ canSave: false, editorLock: "none" })).toMatchObject({ editable: false, reason: "The project is read-only." });
  });

  it("add, remove and chain languages through the engine's rules", () => {
    const s = FIXTURE_LANGUAGES;
    const ptBr = next(addLanguage(next(addLanguage(s, "PT")), "pt-br"));
    expect(ptBr.list.at(-1)).toMatchObject({ code: "pt-BR", fallback: ["pt"] });
    expect(addLanguage(s, "FR")).toEqual({ refused: "fr is already a project language" });
    expect(addLanguage(s, "x")).toMatchObject({ refused: expect.stringContaining("isn't a language tag") });
    expect(removeLanguage(s, "en")).toMatchObject({ refused: expect.stringContaining("reference language") });
    expect(next(removeLanguage(s, "fr")).list.find((l) => l.code === "fr-CA")?.fallback).toEqual([]);
    expect(setLanguageFallback(s, "fr-CA", ["fr-CA"])).toEqual({ refused: "a language can't fall back to itself" });
    expect(next(setLanguageFallback(s, "de", codesOf("fr, en"))).list[3].fallback).toEqual(["fr", "en"]);
    expect(next(setReference(s, "fr"))).toMatchObject({ reference: "fr", fallback: ["fr"] });
    expect(setShip(parseLanguages({ list: [{ code: "en" }, { code: "de", ship: false }] }).languages, "en", false)).toEqual({ refused: "at least one language must ship" });
  });

  it("edit the localisation settings and resolve the preview language", () => {
    const a = parseAudioProject({}).project;
    expect(next(setRoots(a, ["audio/vo/", "audio/ui-vo"])).localisation?.roots).toEqual(["audio/vo", "audio/ui-vo"]);
    expect(setRoots(a, ["audio/vo", "audio/vo/ch1"])).toEqual({ refused: '"audio/vo/ch1" overlaps "audio/vo"' });
    expect(setTolerance(a, 9)).toMatchObject({ refused: expect.any(String) });
    expect(previewLanguageOf("FR", FIXTURE_LANGUAGES)).toBe("fr");
    expect(previewLanguageOf("es", FIXTURE_LANGUAGES)).toBe("en");
    expect(previewLanguageOf(null, FIXTURE_LANGUAGES)).toBe("en");
  });
});
