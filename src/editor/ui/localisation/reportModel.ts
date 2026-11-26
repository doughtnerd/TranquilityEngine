// The Localisation panel's Report tab (ADR 0356 §7, §8, §9): per-language translated / needs review / missing counts,
// then the lists — keys used but missing a translation, keys used but defined nowhere, unused keys and keys defined
// twice — each row naming the file that opens it. Built from the engine's key gathering (`exchange/gather.ts`). (The
// unkeyed-text list and the text fit check read UI documents' markup; ADR 0419 retired them with the documents.)
//
// Pure.
import type { GatherReport } from "../../../engine/localisation/exchange/gather";

export type ReportSectionId = "missing" | "undefined" | "unused" | "duplicates";

/** One row of a report list: what it says and the file it opens. */
export interface ReportRow {
  readonly id: string;
  readonly key: string;
  readonly detail: string;
  /** The file to open (a component, script or table). */
  readonly path: string;
}

export interface ReportSection {
  readonly id: ReportSectionId;
  readonly title: string;
  /** What the list means and what to do about it. */
  readonly hint: string;
  readonly rows: readonly ReportRow[];
}

export interface LanguageSummary {
  readonly language: string;
  readonly translated: number;
  readonly needsReview: number;
  readonly missing: number;
  /** Translated share, 0..1 (1 with no keys). */
  readonly done: number;
}

export interface LocalisationReport {
  readonly languages: readonly LanguageSummary[];
  readonly sections: readonly ReportSection[];
  /** Rows over every section: zero means nothing to fix. */
  readonly issues: number;
}

const KIND_WORD = { component: "Svelte UI", script: "script", line: "line table", caption: "playlist caption" } as const;

/** The report from a gathering run. */
export function localisationReport(gather: GatherReport): LocalisationReport {
  const languages = Object.entries(gather.counts).map(([language, c]) => {
    const total = c.translated + c.needsReview + c.missing;
    return { language, ...c, done: total === 0 ? 1 : c.translated / total };
  });
  const sections: ReportSection[] = [
    {
      id: "missing",
      title: "Missing translations",
      hint: "Keys the game uses that some shipped language hasn't translated: they show in a fallback language.",
      rows: gather.missing.filter((m) => m.used).map((m) => ({ id: `missing|${m.key}`, key: m.key, detail: `missing in ${m.languages.join(", ")}`, path: m.table })),
    },
    {
      id: "undefined",
      title: "Keys defined nowhere",
      hint: "Used, but no string table has them: the game shows the key itself. Add them to a table, or fix the spelling.",
      rows: gather.undefinedKeys.map((u) => ({
        id: `undefined|${u.key}`,
        key: u.key,
        detail: u.uses.map((x) => `${KIND_WORD[x.kind]} ${x.path} (${x.where})`).join("; "),
        path: u.uses[0].path,
      })),
    },
    {
      id: "unused",
      title: "Unused keys",
      hint: "In a table, but nothing uses them (keys built at runtime in scripts aren't seen). Delete them, or ignore this if a script builds them.",
      rows: gather.unused.map((d) => ({ id: `unused|${d.key}`, key: d.key, detail: d.table, path: d.table })),
    },
    {
      id: "duplicates",
      title: "Keys in two tables",
      hint: "Keys are unique across the project: the first table in path order wins and the others are ignored.",
      rows: gather.duplicates.map((d) => ({ id: `dup|${d.key}`, key: d.key, detail: d.tables.join(", "), path: d.tables[1] ?? d.tables[0] })),
    },
  ];
  const issues = sections.reduce((n, s) => n + s.rows.length, 0);
  return { languages, sections, issues };
}
