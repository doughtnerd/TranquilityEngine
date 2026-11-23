/**
 * The translator exchange's shared model (ADR 0356 §8): the project's string tables and translations as the exchange
 * formats read them (`ExchangeProject`), what an export holds (`exportUnits`: one unit per table, key and target
 * language, chosen by tables, languages and "only missing and needs review"), and what an import reads from a file
 * (`ImportedEntry`), before `importPreview.ts` checks it against the project.
 *
 * The CSV, XLIFF 1.2 and gettext PO modules beside this one write units and read entries; nothing here knows a format.
 *
 * Pure; no plugin, no DOM.
 */
import { languageOf, type LanguageSettings } from "../languages";
import type { StringEntry, StringTable } from "../strings/format";
import { effectiveStatus, type EffectiveStatus, type TranslationFile, type TranslationStatus } from "../strings/translation";

/** One table of the project with its translations, by canonical language code. */
export interface ExchangeTable {
  /** The table's project path (`strings/menu.strings.json`). */
  readonly path: string;
  readonly table: StringTable;
  /** Language code → its translation file; a language without one has every key missing. */
  readonly translations: Readonly<Record<string, TranslationFile>>;
}

/** The project as the exchange sees it: its languages and its tables, in path order. */
export interface ExchangeProject {
  readonly languages: LanguageSettings;
  readonly tables: readonly ExchangeTable[];
}

/** What to export. */
export interface ExportOptions {
  /** Table paths to export; absent or empty: every table. */
  readonly tables?: readonly string[];
  /** Target languages (never the reference language, which is the source); absent: every language but the reference. */
  readonly languages?: readonly string[];
  /** Only keys whose translation is missing or needs review in the language. */
  readonly onlyNeedsWork?: boolean;
}

/** One key of one table for one target language, as an export writes it. */
export interface ExportUnit {
  readonly table: string;
  readonly entry: StringEntry;
  /** The target language. */
  readonly language: string;
  /** The translation as it stands (empty when missing). */
  readonly text: string;
  readonly status: EffectiveStatus;
}

/** The export's target languages: the given ones that are project languages, else every language but the reference. */
export function targetLanguages(project: ExchangeProject, options: ExportOptions = {}): string[] {
  const s = project.languages;
  const listed = options.languages?.length
    ? options.languages.map((c) => languageOf(s, c)?.code).filter((c): c is string => c !== undefined)
    : s.list.map((l) => l.code);
  return [...new Set(listed)].filter((c) => c !== s.reference);
}

/** The tables an export covers, in project order. */
export function exportTables(project: ExchangeProject, options: ExportOptions = {}): ExchangeTable[] {
  const only = options.tables?.length ? new Set(options.tables) : null;
  return project.tables.filter((t) => only === null || only.has(t.path));
}

/** The translation of `table` into `code` (canonical match first, then case-insensitive), or undefined. */
export function translationOf(table: ExchangeTable, code: string): TranslationFile | undefined {
  return table.translations[code] ?? Object.entries(table.translations).find(([c]) => c.toLowerCase() === code.toLowerCase())?.[1];
}

/** Every unit of the export: per table (project order), per key (table order), per target language (list order). */
export function exportUnits(project: ExchangeProject, options: ExportOptions = {}): ExportUnit[] {
  const langs = targetLanguages(project, options);
  const out: ExportUnit[] = [];
  for (const t of exportTables(project, options)) {
    for (const entry of t.table.strings) {
      for (const language of langs) {
        const tr = translationOf(t, language)?.strings[entry.key];
        const status = effectiveStatus(tr, entry.text);
        if (options.onlyNeedsWork && status === "translated") continue;
        out.push({ table: t.path, entry, language, text: tr?.text ?? "", status });
      }
    }
  }
  return out;
}

/** A translation an import read from a file, before it is checked against the project. */
export interface ImportedEntry {
  readonly key: string;
  /** The table the file names for it (XLIFF `original`, PO `#:`, the CSV `table` column); null when it names none. */
  readonly table: string | null;
  /** The target language, as the file writes it. */
  readonly language: string;
  readonly text: string;
  /** `needsReview` when the file marks it so (XLIFF `needs-review-*`, PO `#, fuzzy`, a CSV status column). */
  readonly status: TranslationStatus;
  /** The reference text the file says it was translated from (XLIFF `<source>`, PO `msgid`, the CSV reference column); null when it says none. */
  readonly source: string | null;
}

/** What reading an exchange file gives: its entries and what was wrong with it (never throws). */
export interface ImportRead {
  readonly entries: ImportedEntry[];
  readonly problems: string[];
}
