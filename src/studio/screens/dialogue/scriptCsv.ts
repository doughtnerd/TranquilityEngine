// The script CSV (ADR 0354 §9, 0357 §1): keys, table, speaker, notes and one text column per language, the format
// translators and recording studios exchange. Export writes every line; import reads one back as a diff — keys added,
// changed (which fields) and removed — and turns it into document edits (line tables, string tables, translations),
// each applied as one undo step of its document. Text goes through the string tables like the Text column
// (`textEdit`). ADR 0356 T6's CSV adds string-table columns later; this keeps to the line columns. Pure.
import { isLineKey, lineRow, subtitleKeyOf } from "../../../engine/audio/localisation/lines/format";
import type { LineRow, LineTable } from "../../../engine/audio/localisation/types";
import { canonicalLanguageCode, languageOf } from "../../../engine/localisation/languages";
import { translationPath, type StringTable } from "../../../engine/localisation/strings/format";
import type { TranslationFile } from "../../../engine/localisation/strings/translation";
import { allLines, findLine, textIn, type DialogueData, type LineRef, type TableDoc } from "./dialogueData";
import { csvRecords, formatCsv, parseCsv } from "./csv";
import { textEdit } from "./linesModel";

const FIXED = ["key", "table", "speaker", "notes"] as const;

/** The table column's value: the table's file name without `.lines.json`. */
export const tableStem = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.lines\.json$/i, "");

/** Every line as the script CSV (one text column per project language, in list order). */
export function scriptCsv(data: DialogueData): string {
  const codes = data.languages.list.map((l) => l.code);
  const rows: string[][] = [[...FIXED, ...codes]];
  for (const ref of allLines(data)) {
    rows.push([ref.line.key, tableStem(ref.doc.path), ref.line.speaker ?? "", ref.line.notes ?? "", ...codes.map((c) => textIn(data, ref, c) ?? "")]);
  }
  return formatCsv(rows);
}

export type ScriptField = "speaker" | "notes" | `text:${string}`;

export interface ScriptDiff {
  readonly added: readonly { readonly key: string; readonly table: string }[];
  readonly changed: readonly { readonly key: string; readonly fields: readonly ScriptField[] }[];
  /** Keys of the tables the CSV names that it doesn't have. */
  readonly removed: readonly string[];
  /** Rows and columns skipped, each with why. */
  readonly problems: readonly string[];
  /** What the CSV says per key (for applying). */
  readonly rows: ReadonlyMap<string, ScriptRow>;
  readonly languages: readonly string[];
}

export interface ScriptRow {
  readonly key: string;
  readonly table: string;
  readonly speaker: string;
  readonly notes: string;
  /** Language → text; a language column the CSV lacks is absent. */
  readonly text: Readonly<Record<string, string>>;
}

/** The table a CSV row names (by stem or path), else `fallback`. */
function tableFor(data: DialogueData, name: string, fallback: TableDoc | undefined): TableDoc | undefined {
  const n = name.trim();
  if (n === "") return fallback;
  return data.tables.find((t) => t.path === n || tableStem(t.path) === n);
}

/** Read a script CSV against the project: the diff to show before applying. */
export function readScriptCsv(data: DialogueData, text: string): ScriptDiff {
  const { header, records } = csvRecords(parseCsv(text));
  const problems: string[] = [];
  if (!header.includes("key")) return { added: [], changed: [], removed: [], problems: ["the CSV has no \"key\" column"], rows: new Map(), languages: [] };
  const languages: string[] = [];
  for (const h of header) {
    if ((FIXED as readonly string[]).includes(h) || h === "") continue;
    const code = canonicalLanguageCode(h);
    const def = code ? languageOf(data.languages, code) : undefined;
    if (!def) problems.push(`column "${h}" isn't a project language; skipped`);
    else languages.push(def.code);
  }
  const rows = new Map<string, ScriptRow>();
  const added: { key: string; table: string }[] = [];
  const changed: { key: string; fields: ScriptField[] }[] = [];
  const named = new Set<string>();
  records.forEach((r, i) => {
    const key = r.key.trim();
    if (!isLineKey(key)) return void problems.push(`row ${i + 2}: "${key}" isn't a line key; skipped`);
    if (rows.has(key)) return void problems.push(`row ${i + 2}: "${key}" is listed twice; the first is kept`);
    const existing = findLine(data, key);
    const doc = existing?.doc ?? tableFor(data, r.table ?? "", data.tables[0]);
    if (!doc) return void problems.push(`row ${i + 2}: table "${r.table}" isn't a line table of the project; skipped`);
    named.add(doc.path);
    const row: ScriptRow = {
      key, table: doc.path, speaker: header.includes("speaker") ? r.speaker : existing?.line.speaker ?? "", notes: header.includes("notes") ? r.notes : existing?.line.notes ?? "",
      text: Object.fromEntries(languages.map((c) => [c, r[header.find((h) => canonicalLanguageCode(h) === c)!] ?? ""])),
    };
    rows.set(key, row);
    if (!existing) return void added.push({ key, table: doc.path });
    const fields: ScriptField[] = [];
    if (header.includes("speaker") && (existing.line.speaker ?? "") !== row.speaker.trim()) fields.push("speaker");
    if (header.includes("notes") && (existing.line.notes ?? "") !== row.notes) fields.push("notes");
    if (subtitleKeyOf(existing.line) !== null) for (const c of languages) if ((textIn(data, existing, c) ?? "") !== row.text[c]) fields.push(`text:${c}`);
    if (fields.length) changed.push({ key, fields });
  });
  const removed = data.tables.filter((t) => named.has(t.path)).flatMap((t) => t.table.lines.map((l) => l.key)).filter((k) => !rows.has(k));
  return { added, changed, removed, problems, rows, languages };
}

/** One document's new value. */
export type DocEdit =
  | { readonly kind: "lines"; readonly path: string; readonly next: LineTable }
  | { readonly kind: "strings"; readonly path: string; readonly next: StringTable }
  | { readonly kind: "translation"; readonly path: string; readonly next: TranslationFile };

/** A view of `data` with documents replaced by pending edits, so later edits build on earlier ones. */
function overlay(data: DialogueData, edits: Map<string, DocEdit>): DialogueData {
  return {
    ...data,
    tables: data.tables.map((t) => {
      const e = edits.get(t.path);
      return e?.kind === "lines" ? { path: t.path, table: e.next } : t;
    }),
    strings: (p) => {
      const e = edits.get(p);
      return e?.kind === "strings" ? e.next : data.strings(p);
    },
    translation: (p, code) => {
      const e = edits.get(translationPath(p, code));
      return e?.kind === "translation" ? e.next : data.translation(p, code);
    },
  };
}

/** Lines still holding 0354's retired `text` (0357 §1: "Move subtitles to the string table" moves them). */
export const linesWithOldText = (data: DialogueData): LineRef[] => allLines(data).filter((r) => r.line.text !== undefined);

/**
 * 0357 §1's fix: every retired `text` moved into the string tables (the reference language's into the table, others
 * into translations, a string already there kept) and removed from the line tables. One edit per document.
 */
export function moveSubtitles(data: DialogueData): { edits: DocEdit[]; problems: string[] } {
  const edits = new Map<string, DocEdit>();
  const problems: string[] = [];
  const refs = linesWithOldText(data);
  const order = (codes: string[]) => codes.sort((a, b) => (a === data.languages.reference ? -1 : b === data.languages.reference ? 1 : 0));
  for (const ref of refs) {
    for (const code of order(Object.keys(ref.line.text!))) {
      const view = overlay(data, edits);
      const now = findLine(view, ref.line.key)!;
      if (textIn(view, now, code) !== null) continue; // the string table already has it
      const r = textEdit(view, now, code, ref.line.text![code]);
      if ("refused" in r) { problems.push(`${ref.line.key} (${code}): ${r.refused}`); continue; }
      edits.set(r.next.path, r.next);
    }
  }
  for (const doc of data.tables) {
    if (!doc.table.lines.some((l) => l.text !== undefined)) continue;
    edits.set(doc.path, { kind: "lines", path: doc.path, next: { ...doc.table, lines: doc.table.lines.map(({ text: _old, ...rest }) => rest) } });
  }
  return { edits: [...edits.values()], problems };
}

/**
 * The document edits that apply `diff`: rows added and changed (speaker, notes, text through the string tables, the
 * reference language first so translations are made from it) and, with `remove`, rows removed. One edit per document.
 */
export function applyScript(data: DialogueData, diff: ScriptDiff, options: { remove: boolean }): { edits: DocEdit[]; problems: string[] } {
  const edits = new Map<string, DocEdit>();
  const problems: string[] = [];
  const table = (path: string): LineTable => {
    const e = edits.get(path);
    return e?.kind === "lines" ? e.next : data.tables.find((t) => t.path === path)!.table;
  };
  const setTable = (path: string, next: LineTable) => edits.set(path, { kind: "lines", path, next });
  for (const { key, table: path } of diff.added) {
    const row = diff.rows.get(key)!;
    const line: LineRow = { ...lineRow(key, row.speaker.trim() || null), ...(row.notes ? { notes: row.notes } : {}) };
    setTable(path, { ...table(path), lines: [...table(path).lines, line] });
  }
  for (const { key, fields } of diff.changed) {
    const row = diff.rows.get(key)!;
    const ref = findLine(data, key)!;
    if (fields.includes("speaker") || fields.includes("notes")) {
      const t = table(ref.doc.path);
      setTable(ref.doc.path, {
        ...t,
        lines: t.lines.map((l) => {
          if (l.key !== key) return l;
          const { notes: _n, ...rest } = l;
          const notes = fields.includes("notes") ? row.notes : l.notes ?? "";
          return { ...rest, speaker: fields.includes("speaker") ? row.speaker.trim() || null : l.speaker, ...(notes ? { notes } : {}) };
        }),
      });
    }
  }
  if (options.remove) {
    for (const key of diff.removed) {
      const ref = findLine(data, key);
      if (!ref) continue;
      const t = table(ref.doc.path);
      setTable(ref.doc.path, { ...t, lines: t.lines.filter((l) => l.key !== key) });
    }
  }
  // Texts, reference first: a translation is marked against the reference text it was made from.
  const order = [...diff.languages].sort((a, b) => (a === data.languages.reference ? -1 : b === data.languages.reference ? 1 : 0));
  for (const c of order) {
    for (const [key, row] of diff.rows) {
      const isAdded = diff.added.some((a) => a.key === key);
      const isChanged = diff.changed.find((x) => x.key === key)?.fields.includes(`text:${c}`) ?? false;
      if (!(isChanged || (isAdded && row.text[c]))) continue;
      const view = overlay(data, edits);
      const ref: LineRef | null = findLine(view, key);
      if (!ref) continue;
      const r = textEdit(view, ref, c, row.text[c]);
      if ("refused" in r) { problems.push(`${key} (${c}): ${r.refused}`); continue; }
      edits.set(r.next.path, r.next);
    }
  }
  return { edits: [...edits.values()], problems };
}
