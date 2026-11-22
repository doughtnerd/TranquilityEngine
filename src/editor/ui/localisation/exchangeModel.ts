// The Localisation panel's Exchange tab (ADR 0342 §8): export the chosen tables and languages (or only what needs work)
// as CSV, XLIFF 1.2 (one file per language) or gettext PO (one per language, plus the `.pot` template), and import a
// translator's file with a preview — what changes, what is skipped and why — before writing, one undo step per
// translation file. Which format a file is comes from its extension.
//
// Pure: the panel reads and offers the files and applies the result to the asset documents.
import { writeStringsCsv, readStringsCsv } from "../../../engine/localisation/exchange/csvExchange";
import { applyImport, previewImport, type ImportChange, type ImportedFile, type ImportPreview, type ImportSkip } from "../../../engine/localisation/exchange/importPreview";
import { targetLanguages, type ExchangeProject, type ExportOptions, type ImportRead } from "../../../engine/localisation/exchange/model";
import { readPo, writePo, writePot } from "../../../engine/localisation/exchange/po";
import { readXliff, writeXliff } from "../../../engine/localisation/exchange/xliff";

export type ExchangeFormat = "csv" | "xliff" | "po";

export const EXCHANGE_FORMATS: readonly { readonly value: ExchangeFormat; readonly label: string; readonly title: string }[] = [
  { value: "csv", label: "CSV", title: "One sheet: a row per key, a column per language and its status (spreadsheets, vendors)" },
  { value: "xliff", label: "XLIFF 1.2", title: "One .xlf per language, which every CAT tool reads" },
  { value: "po", label: "PO", title: "One gettext .po per language and a .pot template (Poedit, Weblate, Crowdin)" },
];

/** A file an export writes. */
export interface ExportFile {
  readonly name: string;
  readonly text: string;
  readonly mime: string;
}

/** The export's files: `stem` names them (`strings` → `strings.csv`, `strings.fr.xlf`, `strings.fr.po`, `strings.pot`). */
export function exportFiles(project: ExchangeProject, format: ExchangeFormat, options: ExportOptions, stem = "strings"): ExportFile[] {
  if (format === "csv") return [{ name: `${stem}.csv`, text: writeStringsCsv(project, options), mime: "text/csv" }];
  const langs = targetLanguages(project, options);
  if (format === "xliff") return langs.map((l) => ({ name: `${stem}.${l}.xlf`, text: writeXliff(project, { ...options, languages: [l] }), mime: "application/xliff+xml" }));
  return [
    ...langs.map((l) => ({ name: `${stem}.${l}.po`, text: writePo(project, l, options), mime: "text/x-gettext-translation" })),
    { name: `${stem}.pot`, text: writePot(project, options), mime: "text/x-gettext-translation" },
  ];
}

/** The format a file name's extension says, or null. */
export function formatOfFile(name: string): ExchangeFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".xlf") || n.endsWith(".xliff")) return "xliff";
  if (n.endsWith(".po")) return "po";
  return null;
}

/** A PO file's language from its name (`strings.fr.po` → `fr`), for files without a Language header. */
const poLanguage = (name: string): string | undefined => /\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.po$/i.exec(name)?.[1];

/** Read an exchange file by its extension. */
export function readExchangeFile(project: ExchangeProject, name: string, text: string): ImportRead {
  switch (formatOfFile(name)) {
    case "csv": return readStringsCsv(text, project.languages);
    case "xliff": return readXliff(text);
    case "po": return readPo(text, poLanguage(name));
    default: return { entries: [], problems: [`${name} isn't a .csv, .xlf, .xliff or .po file.`] };
  }
}

/** The import preview of several files at once (later files win for the same key and language). */
export function importPreviewOf(project: ExchangeProject, files: readonly { readonly name: string; readonly text: string }[]): ImportPreview {
  const reads = files.map((f) => {
    const r = readExchangeFile(project, f.name, f.text);
    return { entries: r.entries, problems: r.problems.map((p) => (files.length > 1 ? `${f.name}: ${p}` : p)) };
  });
  return previewImport(project, { entries: reads.flatMap((r) => r.entries), problems: reads.flatMap((r) => r.problems) });
}

/** The preview grouped for the view: change counts by kind and language, and skips grouped by reason. */
export interface PreviewSummary {
  readonly added: number;
  readonly changed: number;
  readonly statusOnly: number;
  readonly stale: number;
  readonly unchanged: number;
  readonly skipped: Readonly<Partial<Record<ImportSkip["reason"], number>>>;
  /** Changes by language. */
  readonly byLanguage: Readonly<Record<string, number>>;
}

export function previewSummary(p: ImportPreview): PreviewSummary {
  const skipped: Partial<Record<ImportSkip["reason"], number>> = {};
  for (const s of p.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
  const byLanguage: Record<string, number> = {};
  for (const c of p.changes) byLanguage[c.language] = (byLanguage[c.language] ?? 0) + 1;
  return {
    added: p.changes.filter((c) => c.kind === "new").length,
    changed: p.changes.filter((c) => c.kind === "changed").length,
    statusOnly: p.changes.filter((c) => c.kind === "status").length,
    stale: p.changes.filter((c) => c.stale).length,
    unchanged: p.unchanged,
    skipped,
    byLanguage,
  };
}

export const SKIP_REASONS: Readonly<Record<ImportSkip["reason"], string>> = {
  unknownKey: "unknown key",
  unknownLanguage: "not a project language",
  reference: "the reference language",
  check: "fails the message checks",
  maxLength: "over its length limit",
};

/**
 * The translation files to write for the changes the user keeps (`keep`: default all), and those it can't write
 * because their table is read-only now (`writable`).
 */
export function importWrites(project: ExchangeProject, preview: ImportPreview, writable: (table: string) => boolean, keep?: (c: ImportChange) => boolean): { files: ImportedFile[]; blocked: string[] } {
  const blocked = [...new Set(preview.changes.filter((c) => (keep ? keep(c) : true) && !writable(c.table)).map((c) => c.table))];
  const files = applyImport(project, preview, (c) => (keep ? keep(c) : true) && writable(c.table));
  return { files, blocked };
}
