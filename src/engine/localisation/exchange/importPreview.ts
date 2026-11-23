/**
 * Importing translations (ADR 0356 §8): what an exchange file would change, shown before anything is written
 * (`previewImport`), then the changed translation files (`applyImport`), one per affected table and language, which
 * the editor writes as one undo step per document.
 *
 * The preview sorts every imported entry into:
 * - **changes**: new translations, changed text, and status changes (a translation marked as needing review, or no
 *   longer);
 * - **unchanged** entries (counted);
 * - **skipped** entries, each with its reason: a key no table has (or a table the file names that doesn't have it), a
 *   language the project doesn't list, the reference language (its text is the table's, not a translation), a message
 *   that fails the checks (`message/check.ts`: syntax, argument names and kinds, the language's plural categories),
 *   or a translation longer than the key's `maxLength` (graphemes, `length.ts`).
 *
 * **Stale sources.** A translation made against older reference text (the file's XLIFF `<source>`, PO `msgid` or CSV
 * reference column differs from the table's current text) is imported as `needsReview`, with `source` set to the hash
 * of the text it was made from, so it stays flagged until someone reviews it. A translation whose source matches gets
 * the current text's hash; one whose file gives no source keeps no hash.
 *
 * Pure; no plugin, no DOM.
 */
import { canonicalLanguageCode, intlTagOf, languageOf } from "../languages";
import type { MessageProblem } from "../message/ast";
import { checkTranslation } from "../message/check";
import type { StringEntry } from "../strings/format";
import { translationPath } from "../strings/format";
import { effectiveStatus, emptyTranslation, type TranslationEntry, type TranslationFile } from "../strings/translation";
import { textHash } from "../textHash";
import { messageLength } from "./length";
import { translationOf, type ExchangeProject, type ExchangeTable, type ImportRead } from "./model";

/** A translation the import writes. */
export interface ImportChange {
  readonly key: string;
  /** The table's path. */
  readonly table: string;
  /** The language, as the project lists it. */
  readonly language: string;
  /** `new`: no translation before; `changed`: different text; `status`: same text, different status. */
  readonly kind: "new" | "changed" | "status";
  readonly before: TranslationEntry | null;
  readonly after: TranslationEntry;
  /** Made against older reference text, so imported as needing review. */
  readonly stale: boolean;
  /** Check warnings (lints that don't stop it). */
  readonly warnings: readonly MessageProblem[];
}

export type ImportSkipReason = "unknownKey" | "unknownLanguage" | "reference" | "check" | "maxLength";

/** An entry the import leaves out, and why. */
export interface ImportSkip {
  readonly key: string;
  readonly table: string | null;
  readonly language: string;
  readonly text: string;
  readonly reason: ImportSkipReason;
  /** One sentence for the preview. */
  readonly message: string;
  /** The check errors, for `check`. */
  readonly problems: readonly MessageProblem[];
}

export interface ImportPreview {
  readonly changes: readonly ImportChange[];
  /** Entries identical to what the project has. */
  readonly unchanged: number;
  readonly skipped: readonly ImportSkip[];
  /** What reading the file reported. */
  readonly problems: readonly string[];
}

/** Each key's table and entry; the first table in path order owns a key used twice (the runtime's rule). */
function keyIndex(project: ExchangeProject): Map<string, { table: ExchangeTable; entry: StringEntry }> {
  const out = new Map<string, { table: ExchangeTable; entry: StringEntry }>();
  const tables = [...project.tables].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const table of tables) for (const entry of table.table.strings) if (!out.has(entry.key)) out.set(entry.key, { table, entry });
  return out;
}

/** Same text and the same status against the current reference text (a source hash added or dropped alone isn't a change). */
const sameEntry = (a: TranslationEntry, b: TranslationEntry, reference: string): boolean => a.text === b.text && effectiveStatus(a, reference) === effectiveStatus(b, reference);

/** What importing `read` into `project` would do. A later entry for the same key and language replaces an earlier one. */
export function previewImport(project: ExchangeProject, read: ImportRead): ImportPreview {
  const index = keyIndex(project);
  const s = project.languages;
  const accepted = new Map<string, { key: string; table: ExchangeTable; language: string; reference: string; after: TranslationEntry; stale: boolean; warnings: MessageProblem[] }>();
  const skipped: ImportSkip[] = [];
  for (const e of read.entries) {
    const skip = (reason: ImportSkipReason, message: string, problems: readonly MessageProblem[] = []) =>
      skipped.push({ key: e.key, table: e.table, language: e.language, text: e.text, reason, message, problems });
    const code = canonicalLanguageCode(e.language.trim());
    const def = code === null ? undefined : languageOf(s, code);
    if (!def) {
      skip("unknownLanguage", `"${e.language}" isn't a project language.`);
      continue;
    }
    if (def.code === s.reference) {
      skip("reference", `${def.code} is the reference language: its text is edited in the table, not imported.`);
      continue;
    }
    const hit = index.get(e.key);
    if (!hit) {
      skip("unknownKey", `"${e.key}" isn't a key of any table.`);
      continue;
    }
    if (e.table !== null && e.table !== hit.table.path && project.tables.some((t) => t.path === e.table)) {
      skip("unknownKey", `"${e.key}" isn't in ${e.table} (it is in ${hit.table.path}).`);
      continue;
    }
    const reference = hit.entry.text;
    const problems = checkTranslation(reference, e.text, intlTagOf(s, def.code), def.name);
    const errors = problems.filter((p) => p.severity === "error");
    if (errors.length) {
      skip("check", `${e.key} (${def.code}): ${errors.map((p) => p.message).join("; ")}.`, errors);
      continue;
    }
    const max = hit.entry.maxLength;
    if (max !== undefined) {
      const length = messageLength(e.text, hit.entry.examples);
      if (length > max) {
        skip("maxLength", `${e.key} (${def.code}) is ${length} characters, over its limit of ${max}.`);
        continue;
      }
    }
    const stale = e.source !== null && e.source !== reference;
    const after: TranslationEntry = {
      text: e.text,
      status: stale ? "needsReview" : e.status,
      source: e.source === null ? null : textHash(e.source),
    };
    const id = `${hit.table.path}\n${def.code}\n${e.key}`;
    accepted.delete(id); // a later entry for the same key and language replaces an earlier one, in file order
    accepted.set(id, { key: e.key, table: hit.table, language: def.code, reference, after, stale, warnings: problems.filter((p) => p.severity === "warning") });
  }
  const changes: ImportChange[] = [];
  let unchanged = 0;
  for (const a of accepted.values()) {
    const before = translationOf(a.table, a.language)?.strings[a.key] ?? null;
    if (before && sameEntry(before, a.after, a.reference)) {
      unchanged++;
      continue;
    }
    const kind = before === null ? "new" : before.text === a.after.text ? "status" : "changed";
    changes.push({ key: a.key, table: a.table.path, language: a.language, kind, before, after: a.after, stale: a.stale, warnings: a.warnings });
  }
  return { changes, unchanged, skipped, problems: read.problems };
}

/** A translation file the import writes. */
export interface ImportedFile {
  /** The translation's path (`<stem>.<code>.strings.json` beside its table). */
  readonly path: string;
  readonly table: string;
  readonly language: string;
  readonly translation: TranslationFile;
  /** The file didn't exist. */
  readonly created: boolean;
}

/** The translation files `preview`'s changes give, each with every change to it applied (keys in table order). */
export function applyImport(project: ExchangeProject, preview: ImportPreview, only?: (change: ImportChange) => boolean): ImportedFile[] {
  const files = new Map<string, { table: ExchangeTable; language: string; strings: Record<string, TranslationEntry>; created: boolean }>();
  for (const c of preview.changes) {
    if (only && !only(c)) continue;
    const table = project.tables.find((t) => t.path === c.table);
    if (!table) continue;
    const id = `${c.table}\n${c.language}`;
    let f = files.get(id);
    if (!f) {
      const existing = translationOf(table, c.language);
      files.set(id, (f = { table, language: c.language, strings: { ...(existing?.strings ?? {}) }, created: existing === undefined }));
    }
    f.strings[c.key] = c.after;
  }
  return [...files.values()].map((f) => {
    const order = f.table.table.strings.map((e) => e.key);
    const strings: Record<string, TranslationEntry> = {};
    for (const k of order) if (f.strings[k]) strings[k] = f.strings[k];
    for (const [k, v] of Object.entries(f.strings)) if (!(k in strings)) strings[k] = v; // keys the table lost stay as they were
    const translation: TranslationFile = { ...emptyTranslation(f.language), strings };
    return { path: translationPath(f.table.path, f.language), table: f.table.path, language: f.language, translation, created: f.created };
  });
}
