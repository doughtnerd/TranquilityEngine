// The Dialogue screen's Report tab (ADR 0340 §8–§9): per language, how many lines are recorded, heard from another
// language and missing, with the missing keys; duration mismatches with both durations; script changes; files whose
// sidecar normalisation target differs from `localisation.loudness`; and the report as CSV. Pure.
import { allLines, type DialogueData } from "./dialogueData";
import { formatCsv } from "./csv";
import { languageCells } from "./lineStatus";

export interface LanguageReport {
  readonly code: string;
  readonly name: string;
  readonly ship: boolean;
  readonly recorded: number;
  readonly fallback: number;
  readonly missing: number;
  /** Keys with no file in any language of the chain. */
  readonly missingKeys: readonly string[];
  /** Keys heard from another language (key, language heard). */
  readonly fallbackKeys: readonly { readonly key: string; readonly from: string }[];
  readonly mismatches: readonly { readonly key: string; readonly duration: number; readonly reference: number }[];
  readonly scriptChanged: readonly string[];
  readonly readingSpeed: readonly { readonly key: string; readonly cps: number; readonly max: number }[];
}

export interface DialogueReport {
  readonly lines: number;
  readonly languages: readonly LanguageReport[];
  /** Recorded files whose normalisation isn't the project's setting (0340 §8). */
  readonly loudness: readonly { readonly path: string; readonly mode: string; readonly target: number | null }[];
  /** Keys defined in more than one table. */
  readonly duplicates: readonly { readonly key: string; readonly paths: readonly string[] }[];
}

/** The report over every line. */
export function dialogueReport(data: DialogueData, duplicates: readonly { key: string; paths: readonly string[] }[] = []): DialogueReport {
  const lines = allLines(data);
  const cells = lines.map((ref) => ({ ref, cells: languageCells(data, ref) }));
  const want = data.localisation.loudness;
  const loudness: { path: string; mode: string; target: number | null }[] = [];
  const seen = new Set<string>();
  for (const { cells: cs } of cells) {
    for (const c of cs) {
      if (c.state.kind !== "recorded" || seen.has(c.state.path)) continue;
      seen.add(c.state.path);
      const n = data.facts(c.state.path)?.normalize ?? null;
      const mode = n?.mode ?? "off";
      if (mode !== want.mode || (mode !== "off" && n!.target !== want.target)) loudness.push({ path: c.state.path, mode, target: mode === "off" ? null : n!.target });
    }
  }
  return {
    lines: lines.length,
    duplicates,
    loudness,
    languages: data.languages.list.map((l) => {
      const mine = cells.map(({ ref, cells: cs }) => ({ key: ref.line.key, cell: cs.find((c) => c.code === l.code)! }));
      return {
        code: l.code, name: l.name, ship: l.ship,
        recorded: mine.filter((m) => m.cell.state.kind === "recorded").length,
        fallback: mine.filter((m) => m.cell.state.kind === "fallback").length,
        missing: mine.filter((m) => m.cell.state.kind === "missing").length,
        missingKeys: mine.filter((m) => m.cell.state.kind === "missing").map((m) => m.key),
        fallbackKeys: mine.flatMap((m) => (m.cell.state.kind === "fallback" ? [{ key: m.key, from: m.cell.state.from }] : [])),
        mismatches: mine.flatMap((m) => (m.cell.mismatch ? [{ key: m.key, ...m.cell.mismatch }] : [])),
        scriptChanged: mine.filter((m) => m.cell.scriptChanged).map((m) => m.key),
        readingSpeed: mine.flatMap((m) => (m.cell.readingSpeed ? [{ key: m.key, ...m.cell.readingSpeed }] : [])),
      };
    }),
  };
}

/** The report as CSV: one row per finding (language, key, issue, detail), then a summary row per language. */
export function reportCsv(r: DialogueReport): string {
  const rows: (string | number)[][] = [["language", "key", "issue", "detail"]];
  for (const l of r.languages) {
    rows.push([l.code, "", "summary", `${l.recorded} recorded, ${l.fallback} fallback, ${l.missing} missing of ${r.lines}`]);
    for (const k of l.missingKeys) rows.push([l.code, k, "missing", ""]);
    for (const f of l.fallbackKeys) rows.push([l.code, f.key, "fallback", `heard in ${f.from}`]);
    for (const m of l.mismatches) rows.push([l.code, m.key, "duration mismatch", `${m.duration.toFixed(2)} s, reference ${m.reference.toFixed(2)} s`]);
    for (const k of l.scriptChanged) rows.push([l.code, k, "script changed", "the reference text changed after the file was imported"]);
    for (const s of l.readingSpeed) rows.push([l.code, s.key, "reading speed", `${s.cps} cps, max ${s.max}`]);
  }
  for (const f of r.loudness) rows.push(["", f.path, "loudness", f.mode === "off" ? "not normalised" : `normalised to ${f.target}`]);
  for (const d of r.duplicates) rows.push(["", d.key, "duplicate key", d.paths.join(" ")]);
  return formatCsv(rows);
}
