// The Localisation panel's Report tab (ADR 0356 §7, §8, §9): per-language translated / needs review / missing counts,
// then the lists — keys used but missing a translation, keys used but defined nowhere, unused keys, unkeyed text in
// Svelte UI, keys defined twice, and the text fit check's overflows — each row naming the file (and line) that opens it.
// Built from the engine's key gathering (`exchange/gather.ts`), the components' unkeyed text
// (`uiEdit/svelteStrings.ts`, ADR 0423 wave F) and the fit check (`textFit.ts`).
//
// Pure.
import type { GatherReport } from "../../../engine/localisation/exchange/gather";
import { unkeyedId, type UnkeyedText } from "../../uiEdit/svelteStrings";
import type { FitResult } from "./textFit";

export type ReportSectionId = "missing" | "undefined" | "unused" | "unkeyed" | "duplicates" | "fit";

/** One row of a report list: what it says and the file it opens. */
export interface ReportRow {
  readonly id: string;
  readonly key: string;
  readonly detail: string;
  /** The file to open (a component, script or table). */
  readonly path: string;
  /** The line to open it at (1-based), when the row is about one place in a component or script. */
  readonly line?: number;
  /** For unkeyed text: the dismissal id (`.myco/localisation-ignore.json`). */
  readonly dismiss?: string;
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

/** What the report adds to the gathering: Svelte UI's unkeyed text (dismissed ones left out), and the fit check once it has run. */
export interface ReportExtras {
  readonly unkeyed?: readonly UnkeyedText[];
  /** Dismissed unkeyed text, by `unkeyedId`. */
  readonly ignore?: readonly string[];
  readonly fit?: FitResult | null;
}

const lineOf = (where: string): number | undefined => {
  const m = /^line (\d+)$/.exec(where);
  return m ? Number(m[1]) : undefined;
};

/** The report from a gathering run, the components' unkeyed text and, when it was run, the fit check. */
export function localisationReport(gather: GatherReport, extras: ReportExtras = {}): LocalisationReport {
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
        line: lineOf(u.uses[0].where),
      })),
    },
    {
      id: "unused",
      title: "Unused keys",
      hint: "In a table, but nothing uses them (keys built at runtime in scripts aren't seen). Delete them, or ignore this if a script builds them.",
      rows: gather.unused.map((d) => ({ id: `unused|${d.key}`, key: d.key, detail: d.table, path: d.table })),
    },
    {
      id: "unkeyed",
      title: "Unkeyed text",
      hint: "Literal text in Svelte UI that isn't localised: select its element and use Localise or Extract to string table in the Inspector (text mixed with {…} needs t() in the Code panel), mark it translate=\"no\", or dismiss it.",
      rows: (extras.unkeyed ?? [])
        .filter((u) => !(extras.ignore ?? []).includes(unkeyedId(u)))
        .map((u) => ({ id: `unkeyed|${unkeyedId(u)}`, key: u.text, detail: `${u.path} ${u.where}${u.field === "text" ? "" : ` (${u.field})`}${u.literal ? "" : " · mixed with expressions or elements"}`, path: u.path, line: u.line, dismiss: unkeyedId(u) })),
    },
    {
      id: "duplicates",
      title: "Keys in two tables",
      hint: "Keys are unique across the project: the first table in path order wins and the others are ignored.",
      rows: gather.duplicates.map((d) => ({ id: `dup|${d.key}`, key: d.key, detail: d.tables.join(", "), path: d.tables[1] ?? d.tables[0] })),
    },
  ];
  const fit = extras.fit;
  if (fit) {
    sections.push({
      id: "fit",
      title: "Text that doesn't fit",
      hint: `Laid out in ${fit.languages.join(", ")} with each key's examples (long stand-ins otherwise), in the boxes the open scene's views render: ${fit.checked} element${fit.checked === 1 ? "" : "s"} checked, ${fit.skipped} skipped (no fixed width, or not rendered in the open scene).`,
      rows: fit.overflows.map((o) => ({
        id: `fit|${o.path}|${o.line}|${o.where}|${o.language}`,
        key: o.key,
        detail: `${o.language}: ${o.reason === "lines" ? `${Math.round(o.needed.height)} px tall, box ${Math.round(o.box.height ?? 0)} px` : `${Math.round(o.needed.width)} px wide, box ${Math.round(o.box.width ?? 0)} px`} · ${o.path} ${o.where}`,
        path: o.path,
        line: o.line,
      })),
    });
  }
  const issues = sections.reduce((n, s) => n + s.rows.length, 0);
  return { languages, sections, issues };
}
