/**
 * XLIFF 1.2 (OASIS; ADR 0356 §8), the version every CAT tool reads and Unity's default: one `<file>` per table and
 * target language (`original` = the table's path), a `<trans-unit id resname>` per key with `<source>`, `<target
 * state>` and `<note>` from the key's notes, and `maxwidth` with `size-unit="char"` from `maxLength`. ICU messages
 * travel as text; translation platforms detect and validate them.
 *
 * States: `translated`, `needs-review-translation` (needs review) and `needs-translation` (missing, written with an
 * empty target). Reading also takes `final` and `signed-off` (translated), any other `needs-review-*`,
 * `needs-adaptation` and `needs-l10n` (needs review), and leaves out `new`, `needs-translation` and empty targets.
 * Inline markup inside a segment (`<g>`, `<x/>`, `<mrk>`) is read as its text. The reader never throws: malformed XML
 * reads what it can, with problems.
 *
 * Pure; no plugin, no DOM.
 */
import { Parser } from "htmlparser2";
import { exportUnits, targetLanguages, type ExchangeProject, type ExportOptions, type ExportUnit, type ImportedEntry, type ImportRead } from "./model";

const XLIFF_NS = "urn:oasis:names:tc:xliff:document:1.2";

/** Text escaped for XML element content and attribute values. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const STATE: Record<ExportUnit["status"], string> = { translated: "translated", needsReview: "needs-review-translation", missing: "needs-translation" };

/**
 * The export as one XLIFF 1.2 document: a `<file>` per table and target language (tables in project order, then
 * languages in list order), each with its units. Use `languages` to write one file per language.
 */
export function writeXliff(project: ExchangeProject, options: ExportOptions = {}): string {
  const reference = project.languages.reference;
  const units = exportUnits(project, options);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<xliff version="1.2" xmlns="${XLIFF_NS}">`];
  for (const t of project.tables) {
    for (const language of targetLanguages(project, options)) {
      const mine = units.filter((u) => u.table === t.path && u.language === language);
      if (mine.length === 0) continue;
      lines.push(`  <file original="${escapeXml(t.path)}" source-language="${escapeXml(reference)}" target-language="${escapeXml(language)}" datatype="plaintext">`);
      lines.push("    <body>");
      for (const u of mine) {
        const width = u.entry.maxLength !== undefined ? ` maxwidth="${u.entry.maxLength}" size-unit="char"` : "";
        lines.push(`      <trans-unit id="${escapeXml(u.entry.key)}" resname="${escapeXml(u.entry.key)}"${width} xml:space="preserve">`);
        lines.push(`        <source>${escapeXml(u.entry.text)}</source>`);
        lines.push(`        <target state="${STATE[u.status]}">${escapeXml(u.text)}</target>`);
        if (u.entry.notes) lines.push(`        <note>${escapeXml(u.entry.notes)}</note>`);
        lines.push("      </trans-unit>");
      }
      lines.push("    </body>");
      lines.push("  </file>");
    }
  }
  lines.push("</xliff>");
  return `${lines.join("\n")}\n`;
}

const TRANSLATED = new Set(["translated", "final", "signed-off"]);
const REVIEW = new Set(["needs-adaptation", "needs-l10n"]);

/** The status a target `state` means, or null for one that holds no translation yet. */
function statusOf(state: string | undefined): "translated" | "needsReview" | null {
  if (state === undefined || state === "") return "translated";
  if (TRANSLATED.has(state)) return "translated";
  if (state.startsWith("needs-review") || REVIEW.has(state)) return "needsReview";
  return null; // new, needs-translation, unknown x- states
}

/** The translations an XLIFF 1.2 document holds: one entry per unit with a non-empty target in a translating state. */
export function readXliff(text: string): ImportRead {
  const problems: string[] = [];
  const entries: ImportedEntry[] = [];
  let file: { original: string | null; language: string | null } | null = null;
  let unit: { id: string; state: string | undefined; source: string | null; target: string | null; approved: boolean } | null = null;
  /** The segment text being collected (`source` or `target`), and how deep inside it inline markup is. */
  let collecting: { into: "source" | "target"; text: string; depth: number } | null = null;
  let sawXliff = false;
  let version: string | null = null;
  const local = (name: string) => name.slice(name.indexOf(":") + 1).toLowerCase();
  const parser = new Parser(
    {
      onopentag(rawName, attrs) {
        const name = local(rawName);
        if (collecting) {
          collecting.depth++;
          return;
        }
        if (name === "xliff") {
          sawXliff = true;
          version = attrs.version ?? null;
        } else if (name === "file") {
          file = { original: attrs.original ?? null, language: attrs["target-language"] ?? null };
          if (!file.language) problems.push(`<file${file.original ? ` original="${file.original}"` : ""}> has no target-language; its units are skipped.`);
        } else if (name === "trans-unit") {
          const id = attrs.resname || attrs.id || "";
          unit = { id, state: undefined, source: null, target: null, approved: attrs.approved === "yes" };
          if (!id) problems.push("A <trans-unit> has no id or resname; skipped.");
        } else if (unit && (name === "source" || name === "target")) {
          if (name === "target") unit.state = attrs.state;
          collecting = { into: name, text: "", depth: 0 };
        }
      },
      ontext(t) {
        if (collecting) collecting.text += t;
      },
      onclosetag(rawName) {
        const name = local(rawName);
        if (collecting) {
          if (collecting.depth > 0) {
            collecting.depth--;
            return;
          }
          if (unit) unit[collecting.into] = collecting.text;
          collecting = null;
          return;
        }
        if (name === "trans-unit" && unit) {
          const u = unit as { id: string; state: string | undefined; source: string | null; target: string | null; approved: boolean };
          unit = null;
          const f = file as { original: string | null; language: string | null } | null;
          if (!u.id || !f?.language || u.target === null || u.target === "") return;
          const status = u.approved ? "translated" : statusOf(u.state);
          if (status === null) return;
          entries.push({ key: u.id, table: f.original, language: f.language, text: u.target, status, source: u.source });
        } else if (name === "file") file = null;
      },
      onerror(err) {
        problems.push(`The XLIFF isn't well-formed: ${err.message}`);
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.end(text.replace(/^﻿/, ""));
  if (!sawXliff) problems.push("This isn't an XLIFF document (no <xliff> element).");
  else if (version !== null && !String(version).startsWith("1.")) problems.push(`XLIFF ${version} isn't 1.2; read as 1.2.`);
  return { entries, problems };
}
