// The Lines panel's model (ADR 0354 §9, 0357 §1, 0355 §4): rows over every line table with their text in the preview
// language and a status cell per language; the table filter, the search (key, speaker, text, tag) and the column
// filters (missing in a language, mismatch, script changed, reading speed); and the row edits, each refused or next
// (0313): add, delete and duplicate a row, rename a key (unique across the project), speaker, notes, tags, cooldown and
// once. The Text column's edit writes the string table (`textEdit`). Pure.
import { isLineKey, lineRow, LINE_LIMITS, subtitleKeyOf } from "../../../engine/audio/localisation/lines/format";
import type { LineRow, LineTable } from "../../../engine/audio/localisation/types";
import { emptyStringTable, isStringKey, STRINGS_LIMITS, translationPath, type StringTable } from "../../../engine/localisation/strings/format";
import { emptyTranslation, translatedEntry, type TranslationFile } from "../../../engine/localisation/strings/translation";
import type { EditResult } from "../../../editor/sdk/editResult";
import { allLines, keyIndex, referenceText, stringsPathOf, textThrough, type DialogueData, type LineRef } from "./dialogueData";
import { languageCells, type LanguageCell } from "./lineStatus";

export interface LineRowView {
  readonly ref: LineRef;
  readonly key: string;
  readonly speaker: string | null;
  /** The subtitle in the preview language (through its chain), or null. */
  readonly text: string | null;
  /** The language the text was found in, when not the preview language. */
  readonly textFrom: string | null;
  /** False for a line that is never subtitled (`textKey: null`). */
  readonly subtitled: boolean;
  readonly cells: readonly LanguageCell[];
}

export type ColumnFilter =
  | { readonly kind: "all" }
  | { readonly kind: "missing"; readonly code: string }
  | { readonly kind: "mismatch" }
  | { readonly kind: "scriptChanged" }
  | { readonly kind: "readingSpeed" };

export interface LinesQuery {
  /** A table path, or null for every table. */
  readonly table: string | null;
  readonly search: string;
  readonly filter: ColumnFilter;
}

export const ALL_LINES: LinesQuery = { table: null, search: "", filter: { kind: "all" } };

/** Every row, in table then row order. */
export function lineRows(data: DialogueData, preview: string): LineRowView[] {
  return allLines(data).map((ref) => {
    const t = textThrough(data, ref, preview);
    return {
      ref, key: ref.line.key, speaker: ref.line.speaker, text: t?.text ?? null, textFrom: t && t.language !== preview ? t.language : null,
      subtitled: subtitleKeyOf(ref.line) !== null, cells: languageCells(data, ref),
    };
  });
}

function passes(row: LineRowView, f: ColumnFilter): boolean {
  switch (f.kind) {
    case "all": return true;
    case "missing": return row.cells.some((c) => c.code === f.code && c.state.kind !== "recorded");
    case "mismatch": return row.cells.some((c) => c.mismatch !== null);
    case "scriptChanged": return row.cells.some((c) => c.scriptChanged);
    case "readingSpeed": return row.cells.some((c) => c.readingSpeed !== null);
  }
}

/** The rows a query shows: in the table, matching every word of the search in key, speaker, text or a tag, and passing the column filter. */
export function filterRows(rows: readonly LineRowView[], q: LinesQuery): LineRowView[] {
  const words = q.search.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (q.table !== null && r.ref.doc.path !== q.table) return false;
    if (!passes(r, q.filter)) return false;
    const hay = [r.key, r.speaker ?? "", r.text ?? "", ...r.ref.line.tags].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The column filter choices: missing per language, then the flags, with how many rows each would show. */
export function filterOptions(data: DialogueData, rows: readonly LineRowView[]): { filter: ColumnFilter; label: string; count: number }[] {
  const out: { filter: ColumnFilter; label: string; count: number }[] = [{ filter: { kind: "all" }, label: "All lines", count: rows.length }];
  for (const l of data.languages.list) {
    const f: ColumnFilter = { kind: "missing", code: l.code };
    out.push({ filter: f, label: `Missing in ${l.code}`, count: rows.filter((r) => passes(r, f)).length });
  }
  for (const [f, label] of [[{ kind: "mismatch" }, "Duration mismatch"], [{ kind: "scriptChanged" }, "Script changed"], [{ kind: "readingSpeed" }, "Reading speed"]] as const) {
    out.push({ filter: f, label, count: rows.filter((r) => passes(r, f)).length });
  }
  return out;
}

/** A filter's stable id (for a select). */
export const filterId = (f: ColumnFilter): string => (f.kind === "missing" ? `missing:${f.code}` : f.kind);
export const filterFromId = (id: string): ColumnFilter =>
  id.startsWith("missing:") ? { kind: "missing", code: id.slice(8) } : id === "mismatch" || id === "scriptChanged" || id === "readingSpeed" ? { kind: id } : { kind: "all" };

// --- row edits -----------------------------------------------------------------------------------------------------------

const refuse = (refused: string) => ({ refused });

/** Keys used anywhere in the project. */
export const usedKeys = (data: DialogueData): Set<string> => new Set(keyIndex(data).keys.keys());

/** `base`, else `base_2`, `base_3`… the first not in `used`. */
export function freeKey(base: string, used: ReadonlySet<string>): string {
  const stem = base.replace(/_\d+$/, "") || "line";
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${stem}_${i}`)) return `${stem}_${i}`;
}

function withLine(t: LineTable, key: string, change: (l: LineRow) => LineRow | null): EditResult<LineTable> {
  const i = t.lines.findIndex((l) => l.key === key);
  if (i < 0) return refuse(`there is no line "${key}" in this table`);
  const next = change(t.lines[i]);
  if (next === null) return { next: { ...t, lines: t.lines.filter((_, j) => j !== i) } };
  if (next === t.lines[i]) return { next: t };
  return { next: { ...t, lines: t.lines.map((l, j) => (j === i ? next : l)) } };
}

/** A new row after `after` (else at the end) with a free key ("Add line"). */
export function addLine(t: LineTable, used: ReadonlySet<string>, after: string | null = null, speaker: string | null = null): EditResult<LineTable> {
  if (t.lines.length >= LINE_LIMITS.lines) return refuse(`a table holds at most ${LINE_LIMITS.lines} lines`);
  const row = lineRow(freeKey(`line_${String(t.lines.length + 1).padStart(2, "0")}`, used), speaker);
  const at = after === null ? t.lines.length : t.lines.findIndex((l) => l.key === after) + 1;
  const lines = [...t.lines];
  lines.splice(at <= 0 ? t.lines.length : at, 0, row);
  return { next: { ...t, lines } };
}

export const deleteLine = (t: LineTable, key: string): EditResult<LineTable> => withLine(t, key, () => null);

/** A copy of `key` under a free key, right after it; the copy's subtitle is the original's string (its `textKey`). */
export function duplicateLine(t: LineTable, key: string, used: ReadonlySet<string>): EditResult<LineTable> {
  const i = t.lines.findIndex((l) => l.key === key);
  if (i < 0) return refuse(`there is no line "${key}" in this table`);
  if (t.lines.length >= LINE_LIMITS.lines) return refuse(`a table holds at most ${LINE_LIMITS.lines} lines`);
  const src = t.lines[i];
  const copy: LineRow = { ...src, key: freeKey(`${key}_2`, used), textKey: subtitleKeyOf(src), files: {}, tags: [...src.tags], file: null };
  const lines = [...t.lines];
  lines.splice(i + 1, 0, copy);
  return { next: { ...t, lines } };
}

/**
 * Rename a key: valid and unique across the project. A line subtitled by its own key keeps its subtitle by naming the
 * old key as its `textKey` (the string table isn't touched; translators' keys stay stable). The recording keeps its file
 * name through `file` when the line had none of its own.
 */
export function renameLine(t: LineTable, key: string, to: string, used: ReadonlySet<string>): EditResult<LineTable> {
  if (to === key) return { next: t };
  if (!isLineKey(to)) return refuse(`"${to}" isn't a line key (letters, digits, _ . -, at most ${LINE_LIMITS.keyLength})`);
  if (used.has(to)) return refuse(`"${to}" is already a line key in this project`);
  return withLine(t, key, (l) => ({ ...l, key: to, textKey: subtitleKeyOf(l), file: l.file ?? l.key }));
}

export const setSpeaker = (t: LineTable, key: string, speaker: string): EditResult<LineTable> =>
  withLine(t, key, (l) => ({ ...l, speaker: speaker.trim() === "" ? null : speaker.trim() }));

export const setNotes = (t: LineTable, key: string, notes: string): EditResult<LineTable> =>
  withLine(t, key, (l) => {
    const { notes: _old, ...rest } = l;
    return notes.trim() === "" ? rest : { ...rest, notes };
  });

export function setTags(t: LineTable, key: string, tags: readonly string[]): EditResult<LineTable> {
  const clean = [...new Set(tags.map((x) => x.trim()).filter(Boolean))];
  if (clean.length > LINE_LIMITS.tags) return refuse(`a line has at most ${LINE_LIMITS.tags} tags`);
  return withLine(t, key, (l) => ({ ...l, tags: clean }));
}

export function setCooldown(t: LineTable, key: string, seconds: number): EditResult<LineTable> {
  if (!(seconds >= 0 && seconds <= LINE_LIMITS.cooldown)) return refuse(`a cooldown is 0 to ${LINE_LIMITS.cooldown} seconds`);
  return withLine(t, key, (l) => ({ ...l, cooldown: seconds }));
}

export const setOnce = (t: LineTable, key: string, once: boolean): EditResult<LineTable> => withLine(t, key, (l) => ({ ...l, once }));

/** Whether the line is subtitled; off sets `textKey: null` (breaths, efforts), on goes back to the line key. */
export const setSubtitled = (t: LineTable, key: string, on: boolean): EditResult<LineTable> =>
  withLine(t, key, (l) => {
    if (on === (subtitleKeyOf(l) !== null)) return l;
    if (on) {
      const { textKey: _off, ...rest } = l;
      return rest;
    }
    return { ...l, textKey: null };
  });

// --- the Text column (0357 §1) ---------------------------------------------------------------------------------------

/** What a text edit changes: the string table (the reference text) or a translation, with its path. */
export type TextEdit =
  | { readonly kind: "strings"; readonly path: string; readonly next: StringTable }
  | { readonly kind: "translation"; readonly path: string; readonly next: TranslationFile };

/**
 * The Text column's edit: the line's string in `code` becomes `text`. In the string table's language it writes the
 * table (creating it, and the key, when missing); in another language the translation, marked translated against the
 * reference text now. Refused for a line that is never subtitled, a translation with no reference text yet, or a text
 * over the limit.
 */
export function textEdit(data: DialogueData, ref: LineRef, code: string, text: string): EditResult<TextEdit> {
  const key = subtitleKeyOf(ref.line);
  if (key === null) return refuse(`${ref.line.key} is never subtitled`);
  if (!isStringKey(key)) return refuse(`"${key}" isn't a string key`);
  if (text.length > STRINGS_LIMITS.message) return refuse(`a text has at most ${STRINGS_LIMITS.message} characters`);
  const path = stringsPathOf(ref.doc);
  const table = data.strings(path) ?? emptyStringTable(data.languages.reference);
  if (code === table.language) {
    const i = table.strings.findIndex((s) => s.key === key);
    if (i >= 0 && table.strings[i].text === text) return { next: { kind: "strings", path, next: table } };
    const strings = i >= 0 ? table.strings.map((s, j) => (j === i ? { ...s, text } : s)) : [...table.strings, { key, text, tags: [], examples: {} }];
    return { next: { kind: "strings", path, next: { ...table, strings } } };
  }
  const reference = referenceText(data, ref);
  if (reference === null) return refuse(`write the ${table.language} text of ${ref.line.key} first: translations are made from it`);
  const tPath = translationPath(path, code);
  const tr = data.translation(path, code) ?? emptyTranslation(code);
  const strings = { ...tr.strings };
  if (text === "") delete strings[key];
  else strings[key] = translatedEntry(text, reference);
  return { next: { kind: "translation", path: tPath, next: { ...tr, strings } } };
}
