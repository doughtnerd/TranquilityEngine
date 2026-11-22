// The Localisation panel's Strings tab (ADR 0342 §9): the grid's rows — key, reference text, a cell per language with
// its status (translated, needs review, missing), over-length and check results, notes and max length, and a status
// summary per row — found by search and filters ("missing in fr", "needs review in de", "over length", "check
// failed"), and the edits behind it, each refused or next (0313): add, duplicate, rename and delete a key (unique
// across the project), reference text, notes and max length in the table; a translation's text and its review status
// in the language's translation file.
//
// Pure. The panel applies each edit to the files' asset documents, so it is one undo step per document.
import { intlTagOf, languageOf } from "../../../engine/localisation/languages";
import type { MessageProblem } from "../../../engine/localisation/message/ast";
import { checkMessage, checkTranslation } from "../../../engine/localisation/message/check";
import { isStringKey, STRINGS_LIMITS, type StringEntry, type StringTable } from "../../../engine/localisation/strings/format";
import { effectiveStatus, emptyTranslation, translatedEntry, type EffectiveStatus, type TranslationFile } from "../../../engine/localisation/strings/translation";
import { messageLength } from "../../../engine/localisation/exchange/length";
import { translationOf, type ExchangeProject, type ExchangeTable } from "../../../engine/localisation/exchange/model";
import { accept, refuse, type EditResult } from "./editResult";

/** One language's cell of a row. */
export interface StringCell {
  readonly language: string;
  readonly text: string;
  readonly status: EffectiveStatus;
  /** Graphemes (`messageLength`) when the key has a `maxLength`, else null. */
  readonly length: number | null;
  readonly overLength: boolean;
  /** Check results (errors make the translation skipped at runtime); none for a missing cell. */
  readonly problems: readonly MessageProblem[];
}

/** One key of the grid. */
export interface StringRow {
  readonly key: string;
  readonly table: string;
  readonly entry: StringEntry;
  /** The reference language's cell (always translated). */
  readonly reference: StringCell;
  /** One per target language, in list order. */
  readonly cells: readonly StringCell[];
  /** The row's status column: "2 missing · 1 needs review", "Translated", "Check failed". */
  readonly summary: string;
  readonly worst: "ok" | "needsReview" | "missing" | "problem";
}

export type StringsFilterKind = "all" | "missing" | "needsReview" | "overLength" | "problems";

export interface StringsQuery {
  /** Matches keys, reference text, translations and notes (case-insensitive). */
  readonly search: string;
  /** One table, or null for every table. */
  readonly table: string | null;
  readonly filter: StringsFilterKind;
  /** The filter's language; null: any language. */
  readonly language: string | null;
}

export const ALL_STRINGS: StringsQuery = { search: "", table: null, filter: "all", language: null };

const hasError = (p: readonly MessageProblem[]) => p.some((x) => x.severity === "error");

function cellOf(project: ExchangeProject, t: ExchangeTable, e: StringEntry, code: string): StringCell {
  const s = project.languages;
  const def = languageOf(s, code);
  const tag = intlTagOf(s, code);
  if (code === s.reference) {
    const length = e.maxLength !== undefined ? messageLength(e.text, e.examples) : null;
    return { language: code, text: e.text, status: "translated", length, overLength: length !== null && length > e.maxLength!, problems: checkMessage(e.text, tag, def?.name) };
  }
  const tr = translationOf(t, code)?.strings[e.key];
  const status = effectiveStatus(tr, e.text);
  if (!tr) return { language: code, text: "", status, length: null, overLength: false, problems: [] };
  const length = e.maxLength !== undefined ? messageLength(tr.text, e.examples) : null;
  return { language: code, text: tr.text, status, length, overLength: length !== null && length > e.maxLength!, problems: checkTranslation(e.text, tr.text, tag, def?.name) };
}

function summaryOf(cells: readonly StringCell[], reference: StringCell): Pick<StringRow, "summary" | "worst"> {
  const missing = cells.filter((c) => c.status === "missing").length;
  const review = cells.filter((c) => c.status === "needsReview").length;
  const broken = [reference, ...cells].filter((c) => hasError(c.problems)).length;
  const over = [reference, ...cells].filter((c) => c.overLength).length;
  const parts = [broken && "check failed", over && `${over} over length`, missing && `${missing} missing`, review && `${review} needs review`].filter(Boolean) as string[];
  return { summary: parts.length ? parts.join(" · ") : "Translated", worst: broken || over ? "problem" : missing ? "missing" : review ? "needsReview" : "ok" };
}

/** The target languages, in list order (every listed language but the reference). */
export const targetLanguagesOf = (project: ExchangeProject): string[] => project.languages.list.map((l) => l.code).filter((c) => c !== project.languages.reference);

/** Every row of the project, tables in path order, keys in table order. */
export function stringRows(project: ExchangeProject): StringRow[] {
  const targets = targetLanguagesOf(project);
  const out: StringRow[] = [];
  for (const t of project.tables) {
    for (const e of t.table.strings) {
      const reference = cellOf(project, t, e, project.languages.reference);
      const cells = targets.map((c) => cellOf(project, t, e, c));
      out.push({ key: e.key, table: t.path, entry: e, reference, cells, ...summaryOf(cells, reference) });
    }
  }
  return out;
}

/** The rows `query` keeps. */
export function filterRows(rows: readonly StringRow[], query: StringsQuery): StringRow[] {
  const needle = query.search.trim().toLowerCase();
  const inLanguage = (row: StringRow, test: (c: StringCell) => boolean, withReference = false) =>
    (query.language === null ? [...(withReference ? [row.reference] : []), ...row.cells] : [row.reference, ...row.cells].filter((c) => c.language === query.language)).some(test);
  return rows.filter((row) => {
    if (query.table !== null && row.table !== query.table) return false;
    if (needle && ![row.key, row.entry.notes ?? "", row.reference.text, ...row.cells.map((c) => c.text)].some((s) => s.toLowerCase().includes(needle))) return false;
    switch (query.filter) {
      case "all": return true;
      case "missing": return inLanguage(row, (c) => c.status === "missing");
      case "needsReview": return inLanguage(row, (c) => c.status === "needsReview");
      case "overLength": return inLanguage(row, (c) => c.overLength, true);
      case "problems": return inLanguage(row, (c) => hasError(c.problems), true);
    }
  });
}

// --- edits -----------------------------------------------------------------------------------------------------------

/** Where `key` is defined in the project (the first table in path order), or null. */
export const tableOfKey = (project: ExchangeProject, key: string): string | null => project.tables.find((t) => t.table.strings.some((e) => e.key === key))?.path ?? null;

function newKeyProblem(project: ExchangeProject, key: string): string | null {
  if (!isStringKey(key)) return `"${key}" isn't a key (letters, digits, _ . -, at most ${STRINGS_LIMITS.keyLength})`;
  const owner = tableOfKey(project, key);
  return owner ? `"${key}" is a key of ${owner} already (keys are unique across the project)` : null;
}

const tableOf = (project: ExchangeProject, path: string) => project.tables.find((t) => t.path === path);

/** A new key with reference text, at the end of the table (or after `after`). */
export function addKey(project: ExchangeProject, table: string, rawKey: string, text = "", after?: string): EditResult<StringTable> {
  const t = tableOf(project, table);
  if (!t) return refuse(`${table} isn't a string table`);
  const key = rawKey.trim();
  const problem = newKeyProblem(project, key);
  if (problem) return refuse(problem);
  if (t.table.strings.length >= STRINGS_LIMITS.keys) return refuse(`a table has at most ${STRINGS_LIMITS.keys} keys`);
  const entry: StringEntry = { key, text, tags: [], examples: {} };
  const strings = [...t.table.strings];
  const at = after === undefined ? -1 : strings.findIndex((e) => e.key === after);
  strings.splice(at < 0 ? strings.length : at + 1, 0, entry);
  return accept({ ...t.table, strings });
}

/** A free key for a copy of `key`: `key_2`, `key_3`, … */
export function copyKeyName(project: ExchangeProject, key: string): string {
  for (let n = 2; ; n++) {
    const k = `${key.slice(0, STRINGS_LIMITS.keyLength - String(n).length - 1)}_${n}`;
    if (!tableOfKey(project, k)) return k;
  }
}

/** Duplicate a key (its text, notes, limit, tags and examples) under a free name, right after it. */
export function duplicateKey(project: ExchangeProject, table: string, key: string): EditResult<StringTable> {
  const t = tableOf(project, table);
  const e = t?.table.strings.find((x) => x.key === key);
  if (!t || !e) return refuse(`"${key}" isn't a key of ${table}`);
  const copy = { ...e, key: copyKeyName(project, key), tags: [...e.tags], examples: { ...e.examples } };
  const strings = [...t.table.strings];
  strings.splice(strings.indexOf(e) + 1, 0, copy);
  return accept({ ...t.table, strings });
}

/** A key's table changes after a rename or delete, with the translations that change with it (by language). */
export interface KeyChange {
  readonly table: StringTable;
  readonly translations: Readonly<Record<string, TranslationFile>>;
}

/**
 * Rename a key in its table and every translation of it. References elsewhere (documents, scenes, scripts) aren't
 * rewritten here; the Report tab lists them as undefined until they are.
 */
export function renameKey(project: ExchangeProject, table: string, key: string, rawNext: string): EditResult<KeyChange> {
  const t = tableOf(project, table);
  const e = t?.table.strings.find((x) => x.key === key);
  if (!t || !e) return refuse(`"${key}" isn't a key of ${table}`);
  const next = rawNext.trim();
  if (next === key) return refuse("that is its name already");
  const problem = newKeyProblem(project, next);
  if (problem) return refuse(problem);
  const translations: Record<string, TranslationFile> = {};
  for (const [code, tr] of Object.entries(t.translations)) {
    if (!tr.strings[key]) continue;
    translations[code] = { ...tr, strings: Object.fromEntries(Object.entries(tr.strings).map(([k, v]) => [k === key ? next : k, v])) };
  }
  return accept({ table: { ...t.table, strings: t.table.strings.map((x) => (x === e ? { ...x, key: next } : x)) }, translations });
}

/** Delete a key from its table and every translation. */
export function deleteKey(project: ExchangeProject, table: string, key: string): EditResult<KeyChange> {
  const t = tableOf(project, table);
  if (!t?.table.strings.some((x) => x.key === key)) return refuse(`"${key}" isn't a key of ${table}`);
  const translations: Record<string, TranslationFile> = {};
  for (const [code, tr] of Object.entries(t.translations)) {
    if (!tr.strings[key]) continue;
    const { [key]: _gone, ...strings } = tr.strings;
    translations[code] = { ...tr, strings };
  }
  return accept({ table: { ...t.table, strings: t.table.strings.filter((x) => x.key !== key) }, translations });
}

function editEntry(project: ExchangeProject, table: string, key: string, change: (e: StringEntry) => StringEntry | string): EditResult<StringTable> {
  const t = tableOf(project, table);
  const e = t?.table.strings.find((x) => x.key === key);
  if (!t || !e) return refuse(`"${key}" isn't a key of ${table}`);
  const next = change(e);
  if (typeof next === "string") return refuse(next);
  return accept({ ...t.table, strings: t.table.strings.map((x) => (x === e ? next : x)) });
}

/** The reference text (the message in the table's language). Translations made from the old text then need review. */
export const setReferenceText = (project: ExchangeProject, table: string, key: string, text: string): EditResult<StringTable> =>
  editEntry(project, table, key, (e) => (text.length > STRINGS_LIMITS.message ? `a message has at most ${STRINGS_LIMITS.message} characters` : { ...e, text }));

export const setNotes = (project: ExchangeProject, table: string, key: string, notes: string): EditResult<StringTable> =>
  editEntry(project, table, key, (e) => {
    const n = notes.trim();
    const { notes: _old, ...rest } = e;
    return n ? { ...rest, notes: n } : rest;
  });

/** The key's length limit in graphemes; null removes it. */
export const setMaxLength = (project: ExchangeProject, table: string, key: string, max: number | null): EditResult<StringTable> =>
  editEntry(project, table, key, (e) => {
    const { maxLength: _old, ...rest } = e;
    if (max === null) return rest;
    return Number.isInteger(max) && max >= 1 ? { ...rest, maxLength: max } : "a length limit is a whole number of characters, 1 or more";
  });

/**
 * A translation's text, translated now from the current reference text; empty text removes it (missing). The file is
 * created when the language has none yet.
 */
export function setTranslation(project: ExchangeProject, table: string, key: string, code: string, text: string): EditResult<TranslationFile> {
  const t = tableOf(project, table);
  const e = t?.table.strings.find((x) => x.key === key);
  if (!t || !e) return refuse(`"${key}" isn't a key of ${table}`);
  const def = languageOf(project.languages, code);
  if (!def) return refuse(`"${code}" isn't a project language`);
  if (def.code === project.languages.reference) return refuse(`${def.code} is the reference language: edit the reference text`);
  if (text.length > STRINGS_LIMITS.message) return refuse(`a message has at most ${STRINGS_LIMITS.message} characters`);
  const tr = translationOf(t, def.code) ?? emptyTranslation(def.code);
  const strings = { ...tr.strings };
  if (text === "") delete strings[key];
  else strings[key] = translatedEntry(text, e.text);
  return accept({ ...tr, strings });
}

/** Mark a translation as needing review, or as reviewed (translated from the current reference text). */
export function setReviewed(project: ExchangeProject, table: string, key: string, code: string, reviewed: boolean): EditResult<TranslationFile> {
  const t = tableOf(project, table);
  const e = t?.table.strings.find((x) => x.key === key);
  const tr = t && translationOf(t, code);
  const entry = tr?.strings[key];
  if (!t || !e || !tr || !entry) return refuse(`"${key}" has no ${code} translation to review`);
  const next = reviewed ? translatedEntry(entry.text, e.text) : { ...entry, status: "needsReview" as const };
  return accept({ ...tr, strings: { ...tr.strings, [key]: next } });
}
