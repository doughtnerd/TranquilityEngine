/**
 * The string CSV (ADR 0342 §8): UTF-8 with a BOM, RFC 4180 (`csv.ts`), one row per key, columns
 * `key, table, notes, maxLength, <reference>, <lang>, <lang>:status, …` — the layout spreadsheets, vendors and
 * Unity's and Godot's CSV workflows use. A status cell is `translated`, `needsReview` or `missing`.
 *
 * Reading takes any column order and ignores columns it doesn't know. `key` is required; the reference language's
 * column, when present, is the source text each translation on the row was made from (a changed reference marks the
 * row's translations as needing review on import); an empty translation cell is no translation (skipped). A status
 * column's `needsReview` (also `needs review`, `fuzzy`) imports as needing review.
 *
 * Pure; no plugin, no DOM.
 */
import { canonicalLanguageCode, languageOf, type LanguageSettings } from "../languages";
import { csvRecords, formatCsv, parseCsv } from "./csv";
import { exportTables, exportUnits, targetLanguages, type ExchangeProject, type ExportOptions, type ImportedEntry, type ImportRead } from "./model";

const STATUS_SUFFIX = ":status";

/** The project as a string CSV: the chosen tables, their keys (with "only needs work", keys needing it in some chosen language), the chosen languages. */
export function writeStringsCsv(project: ExchangeProject, options: ExportOptions = {}): string {
  const reference = project.languages.reference;
  const langs = targetLanguages(project, options);
  const header = ["key", "table", "notes", "maxLength", reference, ...langs.flatMap((l) => [l, `${l}${STATUS_SUFFIX}`])];
  const units = exportUnits(project, options);
  const byKey = new Map<string, Map<string, (typeof units)[number]>>();
  for (const u of units) {
    const id = `${u.table}\n${u.entry.key}`;
    let m = byKey.get(id);
    if (!m) byKey.set(id, (m = new Map()));
    m.set(u.language, u);
  }
  const rows: (string | number)[][] = [header];
  for (const t of exportTables(project, options)) {
    for (const entry of t.table.strings) {
      const units = byKey.get(`${t.path}\n${entry.key}`);
      if (!units) continue;
      const row: (string | number)[] = [entry.key, t.path, entry.notes ?? "", entry.maxLength ?? "", entry.text];
      for (const l of langs) {
        const u = units.get(l);
        row.push(u?.text ?? "", u?.status ?? "");
      }
      rows.push(row);
    }
  }
  return formatCsv(rows);
}

const REVIEW = new Set(["needsreview", "needs review", "needs-review", "fuzzy", "review"]);

/**
 * The translations a string CSV holds, for the project's languages (`languages`): one entry per non-empty cell of a
 * language column other than the reference's. Problems: no `key` column, no language column, rows without a key,
 * unknown statuses.
 */
export function readStringsCsv(text: string, languages: LanguageSettings): ImportRead {
  const problems: string[] = [];
  const { header, records } = csvRecords(parseCsv(text));
  if (!header.includes("key")) return { entries: [], problems: ['The CSV has no "key" column.'] };
  const reference = header.find((h) => languageOf(languages, h)?.code === languages.reference) ?? null;
  const columns = header.filter((h) => h !== reference && !h.endsWith(STATUS_SUFFIX) && canonicalLanguageCode(h) !== null && !["key", "table", "notes"].includes(h));
  if (columns.length === 0) problems.push("The CSV has no translation column (a column named by a language code, such as fr).");
  const entries: ImportedEntry[] = [];
  records.forEach((rec, i) => {
    const key = rec.key?.trim() ?? "";
    if (key === "") {
      if (Object.values(rec).some((v) => v.trim() !== "")) problems.push(`Row ${i + 2} has no key; skipped.`);
      return;
    }
    const table = rec.table?.trim() || null;
    const source = reference !== null ? rec[reference] : null;
    for (const col of columns) {
      const value = rec[col] ?? "";
      if (value === "") continue;
      const raw = (rec[`${col}${STATUS_SUFFIX}`] ?? "").trim();
      const lower = raw.toLowerCase();
      if (raw !== "" && lower !== "translated" && lower !== "missing" && !REVIEW.has(lower)) problems.push(`Row ${i + 2}, ${col}${STATUS_SUFFIX}: "${raw}" isn't translated, needsReview or missing; read as translated.`);
      entries.push({ key, table, language: col, text: value, status: REVIEW.has(lower) ? "needsReview" : "translated", source });
    }
  });
  return { entries, problems };
}
