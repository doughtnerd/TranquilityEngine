/**
 * gettext PO (ADR 0356 §8), Unreal's and Godot's translator workflow: one `.po` per language and a `.pot` template.
 * Each key is an entry with `msgctxt` = the key, `msgid` = the reference text, `msgstr` = the translation, `#.` lines
 * for the key's notes (and its `maxLength`), `#:` for its table, and `#, fuzzy` for a translation that needs review.
 * The header names the language (`Language:`) and declares UTF-8.
 *
 * Reading takes the header's `Language:` (else the language the caller gives), skips obsolete (`#~`) entries and the
 * header, reads `msgid_plural` entries' first form with a problem (ICU plurals live inside one message), and leaves out
 * empty `msgstr`s. An entry without `msgctxt` is keyed by its `msgid` (a file made by another tool), which the import
 * preview reports as an unknown key unless the project uses it as a key. Never throws.
 *
 * Pure; no plugin, no DOM.
 */
import { exportTables, exportUnits, type ExchangeProject, type ExportOptions, type ImportedEntry, type ImportRead } from "./model";

/** A PO string literal's content: backslash, quote, newline, tab and carriage return escaped. */
function escapePo(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
}

/** `keyword "text"`, split after each newline into continuation lines as gettext writes long messages. */
function poString(keyword: string, text: string): string {
  if (!text.includes("\n") || text.indexOf("\n") === text.length - 1) return `${keyword} "${escapePo(text)}"`;
  const parts = text.split(/(?<=\n)/);
  return [`${keyword} ""`, ...parts.map((p) => `"${escapePo(p)}"`)].join("\n");
}

const comment = (prefix: string, text: string) => text.split(/\r?\n/).map((l) => `${prefix} ${l}`.trimEnd()).join("\n");

function header(language: string | null): string {
  const fields = [
    language !== null ? `Language: ${language}` : null,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Generator: Myco",
  ].filter((f): f is string => f !== null);
  return ['msgid ""', 'msgstr ""', ...fields.map((f) => `"${escapePo(`${f}\n`)}"`)].join("\n");
}

/** The `.po` of one target language `language` (with "only needs work": only keys needing it). */
export function writePo(project: ExchangeProject, language: string, options: Omit<ExportOptions, "languages"> = {}): string {
  const units = exportUnits(project, { ...options, languages: [language] });
  const blocks = [header(units[0]?.language ?? language)];
  for (const u of units) {
    const lines: string[] = [];
    if (u.entry.notes) lines.push(comment("#.", u.entry.notes));
    if (u.entry.maxLength !== undefined) lines.push(`#. maxLength: ${u.entry.maxLength}`);
    lines.push(`#: ${u.table}`);
    if (u.status === "needsReview") lines.push("#, fuzzy");
    lines.push(poString("msgctxt", u.entry.key), poString("msgid", u.entry.text), poString("msgstr", u.text));
    blocks.push(lines.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** The `.pot` template: every chosen table's keys with empty translations. */
export function writePot(project: ExchangeProject, options: Pick<ExportOptions, "tables"> = {}): string {
  const blocks = [header(null)];
  for (const t of exportTables(project, options)) {
    for (const e of t.table.strings) {
      const lines: string[] = [];
      if (e.notes) lines.push(comment("#.", e.notes));
      if (e.maxLength !== undefined) lines.push(`#. maxLength: ${e.maxLength}`);
      lines.push(`#: ${t.path}`, poString("msgctxt", e.key), poString("msgid", e.text), 'msgstr ""');
      blocks.push(lines.join("\n"));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

/** A PO string literal's content unescaped (`\n`, `\t`, `\r`, `\"`, `\\`, octal and `\xHH`). */
function unescapePo(s: string): string {
  return s.replace(/\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|.)/g, (_, c: string) => {
    if (c[0] === "x") return String.fromCharCode(parseInt(c.slice(1), 16));
    if (/^[0-7]/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "a" ? "\x07" : c === "b" ? "\b" : c === "f" ? "\f" : c === "v" ? "\v" : c;
  });
}

interface PoEntry {
  ctxt: string | null;
  id: string | null;
  plural: boolean;
  str: string | null;
  fuzzy: boolean;
  refs: string[];
  line: number;
}

/** The translations a `.po` holds. `language`: used when the header names none. */
export function readPo(text: string, language?: string): ImportRead {
  const problems: string[] = [];
  const entries: ImportedEntry[] = [];
  const raw: PoEntry[] = [];
  let cur: PoEntry | null = null;
  /** Which string the next continuation line extends. */
  let field: "ctxt" | "id" | "str" | null = null;
  const fresh = (line: number): PoEntry => ({ ctxt: null, id: null, plural: false, str: null, fuzzy: false, refs: [], line });
  const finish = () => {
    if (cur && (cur.id !== null || cur.ctxt !== null)) raw.push(cur);
    cur = null;
    field = null;
  };
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line === "") return finish();
    if (line.startsWith("#~")) return; // obsolete
    if (line.startsWith("#")) {
      // A comment after a string starts the next entry.
      if (cur && field !== null) finish();
      cur ??= fresh(i + 1);
      if (line.startsWith("#,")) cur.fuzzy ||= line.slice(2).split(",").some((f) => f.trim() === "fuzzy");
      else if (line.startsWith("#:")) cur.refs.push(...line.slice(2).trim().split(/\s+/).filter(Boolean));
      return;
    }
    const m = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+"(.*)"$/.exec(line);
    if (m) {
      const [, keyword, index, body] = m;
      const value = unescapePo(body);
      // An entry's msgctxt or msgid after a finished entry (no blank line between them) starts the next one.
      if (cur && (keyword === "msgctxt" ? cur.id !== null || cur.ctxt !== null : keyword === "msgid" && cur.id !== null)) finish();
      cur ??= fresh(i + 1);
      if (keyword === "msgctxt") {
        cur.ctxt = value;
        field = "ctxt";
      } else if (keyword === "msgid") {
        cur.id = value;
        field = "id";
      } else if (keyword === "msgid_plural") {
        cur.plural = true;
        field = null;
      } else if (index === undefined || index === "0") {
        cur.str = value;
        field = "str";
      } else field = null; // other plural forms
      return;
    }
    const cont = /^"(.*)"$/.exec(line);
    if (cont && cur && field !== null) {
      const c = cur as PoEntry;
      c[field] = (c[field] ?? "") + unescapePo(cont[1]);
      return;
    }
    problems.push(`Line ${i + 1} isn't PO syntax; skipped.`);
  });
  finish();
  let lang = language ?? null;
  const head = raw.find((e) => e.id === "" && e.ctxt === null);
  const named = head?.str ? /^Language:\s*(\S+)\s*$/m.exec(head.str)?.[1] : undefined;
  if (named) lang = named;
  if (lang === null) return { entries: [], problems: [...problems, "The PO names no language (no Language: header); nothing to import."] };
  for (const e of raw) {
    if (e === head) continue;
    if (e.plural) problems.push(`Line ${e.line}: msgid_plural isn't used (plurals are ICU messages inside one msgstr); reading its first form.`);
    if (e.str === null || e.str === "") continue;
    const key = e.ctxt ?? e.id;
    if (!key) continue;
    entries.push({ key, table: e.refs.find((r) => r.endsWith(".strings.json")) ?? null, language: lang, text: e.str, status: e.fuzzy ? "needsReview" : "translated", source: e.id });
  }
  return { entries, problems };
}
